import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  CallToolResultSchema,
  ErrorCode,
  McpError,
  type CallToolRequest,
  type CallToolResult,
  type ListToolsResult,
} from "@modelcontextprotocol/sdk/types.js";

export interface UpstreamCallOptions {
  signal?: AbortSignal;
  timeout: number;
  onprogress?: (progress: { progress: number; total?: number; message?: string }) => void;
}

export interface TavilyUpstream {
  readonly id: string;
  listTools(cursor: string | undefined, timeout: number, signal?: AbortSignal): Promise<ListToolsResult>;
  callTool(params: CallToolRequest["params"], options: UpstreamCallOptions): Promise<CallToolResult>;
  takeRetryAfterMs(): number | undefined;
  close(): Promise<void>;
}

export function parseRetryAfter(value: string | null, now = Date.now()): number | undefined {
  if (!value) {
    return undefined;
  }

  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return seconds * 1000;
  }

  const date = Date.parse(value);
  return Number.isNaN(date) ? undefined : Math.max(0, date - now);
}

export class RemoteTavilyUpstream implements TavilyUpstream {
  private client?: Client;
  private connecting?: Promise<Client>;
  private transport?: StreamableHTTPClientTransport;
  private connectController?: AbortController;
  private closePromise?: Promise<void>;
  private retryAfterMs?: number;
  private closed = false;

  constructor(
    readonly id: string,
    private readonly key: string,
    private readonly url: URL,
    private readonly connectTimeout: number,
  ) {}

  async listTools(cursor: string | undefined, timeout: number, signal?: AbortSignal): Promise<ListToolsResult> {
    const startedAt = Date.now();
    const client = await this.getClient(signal, timeout);
    const remaining = remainingTimeout(timeout, startedAt);
    return client.listTools(cursor ? { cursor } : undefined, {
      timeout: remaining,
      maxTotalTimeout: remaining,
      signal,
    });
  }

  async callTool(params: CallToolRequest["params"], options: UpstreamCallOptions): Promise<CallToolResult> {
    const startedAt = Date.now();
    const client = await this.getClient(options.signal, options.timeout);
    const remaining = remainingTimeout(options.timeout, startedAt);
    const result = await client.callTool(params, CallToolResultSchema, {
      signal: options.signal,
      timeout: remaining,
      maxTotalTimeout: remaining,
      onprogress: options.onprogress,
    });
    // The SDK validates before resolving; only its legacy compatibility branch
    // needs narrowing to satisfy Client.callTool's union return type.
    return "toolResult" in result ? CallToolResultSchema.parse(result) : result;
  }

  takeRetryAfterMs(): number | undefined {
    const value = this.retryAfterMs;
    this.retryAfterMs = undefined;
    return value;
  }

  close(): Promise<void> {
    this.closePromise ??= this.closeInternal();
    return this.closePromise;
  }

  private async closeInternal(): Promise<void> {
    this.closed = true;
    this.connectController?.abort("Tavily upstream is closing");

    if (this.connecting) {
      await settleWithin(this.connecting, 1_000);
    }

    const transport = this.transport;
    this.client = undefined;
    this.transport = undefined;
    this.connecting = undefined;
    if (transport) {
      await settleWithin(transport.terminateSession(), 1_000);
      await transport.close();
    }
  }

  private async getClient(signal: AbortSignal | undefined, timeout: number): Promise<Client> {
    if (this.closed) {
      throw new Error("Tavily upstream is closed");
    }
    if (this.client) {
      return this.client;
    }
    if (!this.connecting) {
      const connecting = this.connect();
      this.connecting = connecting;
      void connecting.finally(() => {
        if (this.connecting === connecting) {
          this.connecting = undefined;
        }
      }).catch(() => {
        // The caller observes the original connection failure.
      });
    }

    return waitFor(this.connecting, signal, timeout);
  }

  private async connect(): Promise<Client> {
    const trackedFetch: typeof fetch = async (input, init) => {
      const response = await fetch(input, init);
      if (response.status === 429) {
        const retryAfterMs = parseRetryAfter(response.headers.get("retry-after"));
        if (retryAfterMs !== undefined) {
          this.retryAfterMs = Math.max(this.retryAfterMs ?? 0, retryAfterMs);
        }
      }
      return response;
    };

    const transport = new StreamableHTTPClientTransport(this.url, {
      fetch: trackedFetch,
      requestInit: {
        headers: {
          Authorization: `Bearer ${this.key}`,
        },
      },
    });
    const client = new Client({ name: "unlimited-tavily-mcp", version: "1.0.0" });
    const controller = new AbortController();
    this.connectController = controller;

    client.onclose = () => {
      if (this.client === client) {
        this.client = undefined;
      }
    };

    await client.connect(transport, {
      timeout: this.connectTimeout,
      maxTotalTimeout: this.connectTimeout,
      signal: controller.signal,
    });
    if (this.closed) {
      await client.close();
      throw new Error("Tavily upstream closed while connecting");
    }
    this.client = client;
    this.transport = transport;
    this.connectController = undefined;
    return client;
  }
}

function remainingTimeout(timeout: number, startedAt: number): number {
  const remaining = timeout - (Date.now() - startedAt);
  if (remaining <= 0) {
    throw new McpError(ErrorCode.RequestTimeout, "Tavily upstream request timed out");
  }
  return remaining;
}

function waitFor<T>(promise: Promise<T>, signal: AbortSignal | undefined, timeout: number): Promise<T> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      callback();
    };
    const onAbort = () => finish(() => reject(signal?.reason ?? new Error("Request cancelled")));
    const timer = setTimeout(
      () => finish(() => reject(new McpError(ErrorCode.RequestTimeout, "Tavily upstream connection timed out"))),
      timeout,
    );

    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) {
      onAbort();
      return;
    }
    promise.then(
      (value) => finish(() => resolve(value)),
      (error: unknown) => finish(() => reject(error)),
    );
  });
}

async function settleWithin(promise: Promise<unknown>, timeout: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    promise.catch(() => undefined),
    new Promise<void>((resolve) => { timer = setTimeout(resolve, timeout); }),
  ]);
  if (timer) {
    clearTimeout(timer);
  }
}
