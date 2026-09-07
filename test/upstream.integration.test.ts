import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import test from "node:test";
import type { AddressInfo } from "node:net";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { RemoteTavilyUpstream } from "../src/upstream.js";

const toolList = ["search", "extract", "crawl", "map", "research"].map((name) => ({
  name: `tavily_${name}`,
  inputSchema: { type: "object" as const },
}));

test("RemoteTavilyUpstream completes the Streamable HTTP MCP handshake", async (t) => {
  const authorizationHeaders: Array<string | undefined> = [];
  const server = createServer(async (request, response) => {
    authorizationHeaders.push(request.headers.authorization);
    await handleMcpRequest(request, response);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));

  const address = server.address() as AddressInfo;
  const upstream = new RemoteTavilyUpstream(
    "test-key",
    "tvly-integration-secret",
    new URL(`http://127.0.0.1:${address.port}/mcp`),
    2_000,
  );
  t.after(() => upstream.close());

  const tools = await upstream.listTools(undefined, 2_000);
  const result = await upstream.callTool(
    { name: "tavily_search", arguments: { query: "test" } },
    { timeout: 2_000 },
  );

  assert.deepEqual(tools.tools.map((tool) => tool.name), toolList.map((tool) => tool.name));
  assert.equal(result.content[0]?.type, "text");
  assert.ok(authorizationHeaders.length >= 3);
  assert.ok(authorizationHeaders.every((header) => header === "Bearer tvly-integration-secret"));
});

test("cancelling one waiter does not cancel a shared connection", async (t) => {
  const server = createServer(async (request, response) => {
    if (request.method === "POST") {
      const body = await readBody(request);
      const message = JSON.parse(body) as { id?: number; method: string; params?: Record<string, unknown> };
      if (message.method === "initialize") {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      await handleParsedMcpRequest(request, response, message);
      return;
    }
    await handleMcpRequest(request, response);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));

  const address = server.address() as AddressInfo;
  const upstream = new RemoteTavilyUpstream(
    "test-key",
    "tvly-shared-connect",
    new URL(`http://127.0.0.1:${address.port}/mcp`),
    2_000,
  );
  t.after(() => upstream.close());

  const controller = new AbortController();
  const cancelled = upstream.listTools(undefined, 2_000, controller.signal);
  const successful = upstream.listTools(undefined, 2_000);
  controller.abort(new Error("cancel only this waiter"));

  await assert.rejects(cancelled, /cancel only this waiter/u);
  assert.equal((await successful).tools.length, 5);
});

test("valid tool result is not parsed twice", async (t) => {
  const server = createServer(async (request, response) => {
    await handleMcpRequest(request, response);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));

  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const upstream = new RemoteTavilyUpstream(
    "test-key",
    "tvly-no-reparse",
    new URL(`http://127.0.0.1:${address.port}/mcp`),
    2_000,
  );
  t.after(() => upstream.close());

  t.mock.method(CallToolResultSchema, "parse", () => {
    throw new Error("redundant CallToolResultSchema.parse invoked");
  });

  const result = await upstream.callTool(
    { name: "tavily_search", arguments: { query: "test" } },
    { timeout: 2_000 },
  );

  assert.equal(result.content[0]?.type, "text");
});

test("invalid tool result is rejected by SDK validation", async (t) => {
  let sawToolsCall = false;
  const server = createServer(async (request, response) => {
    if (request.method === "POST") {
      const body = await readBody(request);
      const message = JSON.parse(body) as { id?: number; method: string; params?: Record<string, unknown> };
      if (message.method === "tools/call" && message.id !== undefined) {
        sawToolsCall = true;
        response.setHeader("content-type", "application/json");
        sendResult(response, message.id, { content: "not-an-array" });
        return;
      }
      await handleParsedMcpRequest(request, response, message);
      return;
    }
    await handleMcpRequest(request, response);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));

  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const upstream = new RemoteTavilyUpstream(
    "test-key",
    "tvly-invalid-result",
    new URL(`http://127.0.0.1:${address.port}/mcp`),
    2_000,
  );
  t.after(() => upstream.close());

  await assert.rejects(
    upstream.callTool({ name: "tavily_search", arguments: { query: "test" } }, { timeout: 2_000 }),
    (error: unknown) => typeof error === "object" && error !== null && "issues" in error,
  );
  assert.equal(sawToolsCall, true);
});

test("sequential tool calls reuse one MCP session", async (t) => {
  let initializeCount = 0;
  const server = createServer(async (request, response) => {
    if (request.method === "POST") {
      const body = await readBody(request);
      const message = JSON.parse(body) as { id?: number; method: string; params?: Record<string, unknown> };
      if (message.method === "initialize") {
        initializeCount += 1;
      }
      await handleParsedMcpRequest(request, response, message);
      return;
    }
    await handleMcpRequest(request, response);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));

  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const upstream = new RemoteTavilyUpstream(
    "test-key",
    "tvly-session-reuse",
    new URL(`http://127.0.0.1:${address.port}/mcp`),
    2_000,
  );
  t.after(() => upstream.close());

  const first = await upstream.callTool(
    { name: "tavily_search", arguments: { query: "one" } },
    { timeout: 2_000 },
  );
  const second = await upstream.callTool(
    { name: "tavily_search", arguments: { query: "two" } },
    { timeout: 2_000 },
  );

  assert.equal(first.content[0]?.type, "text");
  assert.equal(second.content[0]?.type, "text");
  assert.equal(initializeCount, 1);
});

async function handleMcpRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
  if (request.method === "GET") {
    response.writeHead(405).end();
    return;
  }
  if (request.method === "DELETE") {
    response.writeHead(200).end();
    return;
  }

  const body = await readBody(request);
  const message = JSON.parse(body) as { id?: number; method: string; params?: Record<string, unknown> };
  await handleParsedMcpRequest(request, response, message);
}

async function handleParsedMcpRequest(
  _request: IncomingMessage,
  response: ServerResponse,
  message: { id?: number; method: string; params?: Record<string, unknown> },
): Promise<void> {
  if (message.id === undefined) {
    response.writeHead(202).end();
    return;
  }

  response.setHeader("content-type", "application/json");
  if (message.method === "initialize") {
    response.setHeader("mcp-session-id", "integration-session");
    sendResult(response, message.id, {
      protocolVersion: (message.params as { protocolVersion: string }).protocolVersion,
      capabilities: { tools: {} },
      serverInfo: { name: "fake-tavily", version: "1.0.0" },
    });
    return;
  }
  if (message.method === "tools/list") {
    sendResult(response, message.id, { tools: toolList });
    return;
  }
  if (message.method === "tools/call") {
    sendResult(response, message.id, { content: [{ type: "text", text: "proxied" }] });
    return;
  }

  response.writeHead(404).end();
}

function sendResult(response: ServerResponse, id: number, result: unknown): void {
  response.end(JSON.stringify({ jsonrpc: "2.0", id, result }));
}

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => { body += chunk; });
    request.on("end", () => resolve(body));
    request.on("error", reject);
  });
}
