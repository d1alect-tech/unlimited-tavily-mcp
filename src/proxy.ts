import { ErrorCode, McpError, type CallToolRequest, type CallToolResult, type ListToolsResult } from "@modelcontextprotocol/sdk/types.js";
import { KeyPool, type PoolEntry } from "./key-pool.js";
import type { TavilyUpstream, UpstreamCallOptions } from "./upstream.js";

const REQUIRED_TOOLS = ["tavily_search", "tavily_extract", "tavily_crawl", "tavily_map", "tavily_research"];
const KEY_PATTERN = /tvly-[A-Za-z0-9_-]+/gu;

export interface ProxyOptions {
  connectTimeout: number;
  defaultTimeout: number;
  researchTimeout: number;
  rateLimitCooldown: number;
  connectionCooldown: number;
  log?: (message: string) => void;
}

type FailureKind = "unauthorized" | "rate-limited" | "transient" | "other";

export function redactSecrets(message: string): string {
  return message.replace(KEY_PATTERN, "[REDACTED]");
}

export function classifyFailure(error: unknown): FailureKind {
  const message = error instanceof Error ? error.message : String(error);
  const code = getNumericCode(error) ?? getTextualStatusCode(message);
  if (code === 401 || code === 403) {
    return "unauthorized";
  }
  if (code === 429) {
    return "rate-limited";
  }
  if (code === 408 || code === ErrorCode.ConnectionClosed || code === ErrorCode.RequestTimeout || (code !== undefined && code >= 500 && code < 600)) {
    return "transient";
  }

  if (/unauthori[sz]ed|invalid api key|api key.{0,30}(?:invalid|wrong|missing)|authentication failed|account.{0,80}deactivated/iu.test(message)) {
    return "unauthorized";
  }
  if (/too many requests|rate[ -]?limit|usage limit exceeded|quota.{0,20}(?:exceeded|exhausted)|credits?.{0,20}(?:exhausted|depleted)/iu.test(message)) {
    return "rate-limited";
  }
  if (/fetch failed|network error|socket hang up|connection (?:closed|reset|refused)|upstream is closed|\b(?:ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN)\b|timed? out|service unavailable|bad gateway|gateway timeout|internal server error/iu.test(message)) {
    return "transient";
  }
  return "other";
}

export class TavilyProxy {
  private readonly pool: KeyPool<TavilyUpstream>;
  private readonly validated = new Set<string>();
  private tools?: ListToolsResult;
  private readonly log: (message: string) => void;

  constructor(upstreams: TavilyUpstream[], private readonly options: ProxyOptions) {
    this.pool = new KeyPool(upstreams.map((value) => ({ id: value.id, value })));
    this.log = options.log ?? ((message) => console.error(`[tavily-proxy] ${message}`));
  }

  async initialize(): Promise<void> {
    const results = await Promise.all(
      this.pool.entries.map(async (entry) => {
        try {
          const tools = await this.listAllTools(entry);
          this.ensureRequiredTools(tools);
          this.validated.add(entry.id);
          this.pool.markReady(entry);
          return tools;
        } catch (error) {
          await this.handleFailure(entry, classifyFailure(error), entry.value.takeRetryAfterMs());
          this.log(`upstream ${entry.id} initialization failed: ${redactSecrets(errorMessage(error))}`);
          return undefined;
        }
      }),
    );

    this.tools = results.find((result): result is ListToolsResult => result !== undefined);
    if (!this.tools) {
      throw new Error("No Tavily upstream accepted a configured API key");
    }
  }

  listTools(): ListToolsResult {
    if (!this.tools) {
      throw new McpError(ErrorCode.InternalError, "Tavily proxy is not initialized");
    }
    return this.tools;
  }

  async callTool(
    params: CallToolRequest["params"],
    options: Pick<UpstreamCallOptions, "signal" | "onprogress"> = {},
  ): Promise<CallToolResult> {
    const attempted = new Set<string>();

    while (attempted.size < this.pool.entries.length) {
      options.signal?.throwIfAborted();
      const entry = this.pool.next(attempted);
      if (!entry) {
        break;
      }
      attempted.add(entry.id);

      try {
        if (!this.validated.has(entry.id)) {
          try {
            const tools = await this.listAllTools(entry, options.signal);
            this.ensureRequiredTools(tools);
            this.validated.add(entry.id);
          } catch (error) {
            if (options.signal?.aborted) {
              throw error;
            }
            const kind = classifyFailure(error);
            await this.handleFailure(entry, kind, entry.value.takeRetryAfterMs());
            continue;
          }
        }

        const result = await entry.value.callTool(params, {
          ...options,
          timeout: params.name === "tavily_research" ? this.options.researchTimeout : this.options.defaultTimeout,
        });

        const errorText = toolErrorText(result);
        if (!result.isError && getTextualStatusCode(errorText) === undefined) {
          return result;
        }

        const kind = classifyFailure(errorText);
        if (kind === "other") {
          return result;
        }

        await this.handleFailure(entry, kind, entry.value.takeRetryAfterMs());
      } catch (error) {
        if (options.signal?.aborted) {
          throw error;
        }

        const kind = classifyFailure(error);
        if (kind === "other") {
          throw new McpError(ErrorCode.InternalError, `Tavily upstream request failed: ${redactSecrets(errorMessage(error))}`);
        }

        await this.handleFailure(entry, kind, entry.value.takeRetryAfterMs());
      }
    }

    const retryAfterMs = this.pool.retryAfterMs();
    const retryMessage = retryAfterMs === undefined ? "" : ` Retry after approximately ${Math.ceil(retryAfterMs / 1000)} seconds.`;
    return {
      content: [{ type: "text", text: `All configured Tavily API keys are unavailable.${retryMessage}` }],
      isError: true,
    };
  }

  async close(): Promise<void> {
    await Promise.allSettled(this.pool.entries.map((entry) => entry.value.close()));
  }

  addUpstreams(upstreams: TavilyUpstream[]): number {
    return this.pool.add(upstreams.map((value) => ({ id: value.id, value })));
  }

  private ensureRequiredTools(result: ListToolsResult): void {
    const names = new Set(result.tools.map((tool) => tool.name));
    const missing = REQUIRED_TOOLS.filter((name) => !names.has(name));
    if (missing.length > 0) {
      throw new Error(`Tavily upstream is missing required tools: ${missing.join(", ")}`);
    }
  }

  private async listAllTools(entry: PoolEntry<TavilyUpstream>, signal?: AbortSignal): Promise<ListToolsResult> {
    const tools: ListToolsResult["tools"] = [];
    let cursor: string | undefined;
    const seenCursors = new Set<string>();

    do {
      const page = await entry.value.listTools(cursor, this.options.connectTimeout, signal);
      tools.push(...page.tools);
      cursor = page.nextCursor;
      if (cursor && seenCursors.has(cursor)) {
        throw new Error("Tavily upstream returned a repeated tools cursor");
      }
      if (cursor) {
        seenCursors.add(cursor);
      }
    } while (cursor);

    return { tools };
  }

  private async handleFailure(entry: PoolEntry<TavilyUpstream>, kind: FailureKind, retryAfterMs?: number): Promise<void> {
    if (kind === "unauthorized") {
      this.pool.markDisabled(entry);
      this.validated.delete(entry.id);
      await entry.value.close();
      this.log(`upstream ${entry.id} disabled after an authentication error`);
      return;
    }

    const duration = retryAfterMs ?? (kind === "rate-limited" ? this.options.rateLimitCooldown : this.options.connectionCooldown);
    if (kind === "other" || kind === "transient") {
      this.validated.delete(entry.id);
    }
    this.pool.markCooldown(entry, duration);
    this.log(`upstream ${entry.id} cooling down for ${Math.ceil(duration / 1000)} seconds`);
  }
}

function getNumericCode(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return undefined;
  }
  const code = (error as { code?: unknown }).code;
  return typeof code === "number" ? code : undefined;
}

function getTextualStatusCode(message: string): number | undefined {
  const match = /"(?:status|code)"\s*:\s*(\d{3})\b/u.exec(message);
  return match?.[1] === undefined ? undefined : Number(match[1]);
}

function toolErrorText(result: CallToolResult): string {
  return result.content
    .filter((item): item is Extract<(typeof result.content)[number], { type: "text" }> => item.type === "text")
    .map((item) => item.text)
    .join("\n");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
