#!/usr/bin/env node

import { watch, type FSWatcher } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type Progress,
} from "@modelcontextprotocol/sdk/types.js";
import { keyFingerprint, parseKeys } from "./key-pool.js";
import { TavilyProxy, redactSecrets } from "./proxy.js";
import { RemoteTavilyUpstream } from "./upstream.js";

const CONNECT_TIMEOUT = 30_000;
const DEFAULT_TIMEOUT = 120_000;
const RESEARCH_TIMEOUT = 960_000;
const RATE_LIMIT_COOLDOWN = 60_000;
const CONNECTION_COOLDOWN = 30_000;
const DEFAULT_KEYS_FILE = join(homedir(), ".config", "opencode", "secrets", "tavily.keys");

async function main(): Promise<void> {
  const keysFile = (process.env["TAVILY_API_KEYS_FILE"] ?? DEFAULT_KEYS_FILE).replace(/^~(?=[/\\]|$)/u, homedir());

  const keys = parseKeys(await readFile(keysFile, "utf8"));
  if (keys.length === 0) {
    throw new Error(`No Tavily API keys found in ${keysFile}`);
  }

  const upstreamUrl = new URL(process.env["TAVILY_MCP_URL"] ?? "https://mcp.tavily.com/mcp/");
  if (upstreamUrl.protocol !== "https:") {
    throw new Error("TAVILY_MCP_URL must use HTTPS");
  }
  const upstreams = keys.map(
    (key) => new RemoteTavilyUpstream(keyFingerprint(key), key, upstreamUrl, CONNECT_TIMEOUT),
  );
  const proxy = new TavilyProxy(upstreams, {
    connectTimeout: CONNECT_TIMEOUT,
    defaultTimeout: DEFAULT_TIMEOUT,
    researchTimeout: RESEARCH_TIMEOUT,
    rateLimitCooldown: RATE_LIMIT_COOLDOWN,
    connectionCooldown: CONNECTION_COOLDOWN,
  });
  const loadedKeyIds = new Set(keys.map(keyFingerprint));
  const server = new Server(
    { name: "unlimited-tavily-mcp", version: "1.0.0" },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => proxy.listTools());
  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const progressToken = request.params._meta?.progressToken;
    const onprogress = progressToken === undefined
      ? undefined
      : (progress: Progress) => {
          void extra.sendNotification({
            method: "notifications/progress",
            params: { ...progress, progressToken },
          }).catch(() => console.error("[tavily-proxy] failed to forward a progress notification"));
        };

    return proxy.callTool(request.params, { signal: extra.signal, onprogress });
  });

  let shuttingDown = false;
  let keysWatcher: FSWatcher | undefined;
  let reloadTimer: ReturnType<typeof setTimeout> | undefined;
  let reloadPromise = Promise.resolve();
  const scheduleKeyReload = () => {
    if (reloadTimer) {
      clearTimeout(reloadTimer);
    }
    reloadTimer = setTimeout(() => {
      reloadTimer = undefined;
      reloadPromise = reloadPromise.then(async () => {
        const currentKeys = parseKeys(await readFile(keysFile, "utf8"));
        const additions = currentKeys.filter((key) => !loadedKeyIds.has(keyFingerprint(key)));
        if (additions.length === 0) {
          return;
        }
        const added = proxy.addUpstreams(additions.map(
          (key) => new RemoteTavilyUpstream(keyFingerprint(key), key, upstreamUrl, CONNECT_TIMEOUT),
        ));
        for (const key of additions) {
          loadedKeyIds.add(keyFingerprint(key));
        }
        console.error(`[tavily-proxy] loaded ${added} new key(s); ${loadedKeyIds.size} total`);
      }).catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`[tavily-proxy] failed to reload keys: ${redactSecrets(message)}`);
      });
    }, 100);
  };
  let shutdownPromise: Promise<void> | undefined;
  const shutdown = () => {
    shuttingDown = true;
    keysWatcher?.close();
    if (reloadTimer) {
      clearTimeout(reloadTimer);
      reloadTimer = undefined;
    }
    shutdownPromise ??= reloadPromise
      .then(() => Promise.allSettled([proxy.close(), server.close()]))
      .then(() => undefined);
    return shutdownPromise;
  };
  process.once("SIGINT", () => void shutdown());
  process.once("SIGTERM", () => void shutdown());
  process.stdin.once("end", () => void shutdown());
  process.stdin.once("close", () => void shutdown());

  try {
    await proxy.initialize();
    if (shuttingDown) {
      return;
    }
    keysWatcher = watch(keysFile, { persistent: false }, (eventType) => {
      if (eventType === "change" && !shuttingDown) {
        scheduleKeyReload();
      }
    });
    keysWatcher.on("error", (error) => {
      console.error(`[tavily-proxy] key watcher failed: ${redactSecrets(error.message)}`);
    });
    await server.connect(new StdioServerTransport());
    console.error(`[tavily-proxy] ready with ${keys.length} configured key(s)`);
  } catch (error) {
    const wasShuttingDown = shuttingDown;
    await shutdown();
    if (wasShuttingDown) {
      return;
    }
    throw error;
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[tavily-proxy] fatal: ${redactSecrets(message)}`);
  process.exitCode = 1;
});
