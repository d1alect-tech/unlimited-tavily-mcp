import assert from "node:assert/strict";
import test from "node:test";
import { ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import type { CallToolRequest, CallToolResult, ListToolsResult } from "@modelcontextprotocol/sdk/types.js";
import { TavilyProxy, redactSecrets } from "../src/proxy.js";
import type { TavilyUpstream, UpstreamCallOptions } from "../src/upstream.js";

const tools: ListToolsResult = {
  tools: ["search", "extract", "crawl", "map", "research"].map((name) => ({
    name: `tavily_${name}`,
    inputSchema: { type: "object" as const },
  })),
};

class FakeUpstream implements TavilyUpstream {
  calls = 0;
  listToolsCalls = 0;
  retryAfter: number | undefined;
  listToolsErrors: Error[] = [];
  responses: Array<CallToolResult | Error | Promise<CallToolResult>> = [];

  constructor(readonly id: string) {}

  async listTools(): Promise<ListToolsResult> {
    this.listToolsCalls += 1;
    const error = this.listToolsErrors.shift();
    if (error) {
      throw error;
    }
    return tools;
  }

  async callTool(_params: CallToolRequest["params"], _options: UpstreamCallOptions): Promise<CallToolResult> {
    this.calls += 1;
    const response = this.responses.shift();
    if (response instanceof Error) {
      throw response;
    }
    return await (response ?? { content: [{ type: "text", text: this.id }] });
  }

  takeRetryAfterMs(): number | undefined {
    const value = this.retryAfter;
    this.retryAfter = undefined;
    return value;
  }

  async close(): Promise<void> {}
}

function createProxy(upstreams: FakeUpstream[]): TavilyProxy {
  return new TavilyProxy(upstreams, {
    connectTimeout: 100,
    defaultTimeout: 100,
    researchTimeout: 200,
    rateLimitCooldown: 60_000,
    connectionCooldown: 30_000,
    log: () => {},
  });
}

const params: CallToolRequest["params"] = { name: "tavily_search", arguments: { query: "test" } };

test("proxy distributes successful calls across every key", async () => {
  const upstreams = [new FakeUpstream("a"), new FakeUpstream("b"), new FakeUpstream("c")];
  const proxy = createProxy(upstreams);
  await proxy.initialize();

  for (let index = 0; index < 6; index += 1) {
    await proxy.callTool(params);
  }

  assert.deepEqual(upstreams.map((upstream) => upstream.calls), [2, 2, 2]);
});

test("proxy retries another key after a rate-limit result", async () => {
  const first = new FakeUpstream("a");
  const second = new FakeUpstream("b");
  first.retryAfter = 10_000;
  first.responses.push({ content: [{ type: "text", text: "Rate limit exceeded" }], isError: true });
  const proxy = createProxy([first, second]);
  await proxy.initialize();

  const result = await proxy.callTool(params);
  assert.equal(result.isError, undefined);
  assert.deepEqual([first.calls, second.calls], [1, 1]);
});

test("proxy disables unauthorized keys and retries", async () => {
  const first = new FakeUpstream("a");
  const second = new FakeUpstream("b");
  const unauthorized = Object.assign(new Error("Unauthorized"), { code: 401 });
  first.responses.push(unauthorized);
  const proxy = createProxy([first, second]);
  await proxy.initialize();

  await proxy.callTool(params);
  await proxy.callTool(params);
  assert.deepEqual([first.calls, second.calls], [1, 2]);
});

test("proxy disables keys after a textual Tavily status 401 result", async () => {
  const first = new FakeUpstream("a");
  const second = new FakeUpstream("b");
  first.responses.push({
    content: [{
      type: "text",
      text: JSON.stringify({
        error: "Map failed",
        status: 401,
        detail: { error: "The account associated with this API key has been deactivated." },
      }),
    }],
  });
  const proxy = createProxy([first, second]);
  await proxy.initialize();

  const result = await proxy.callTool(params);
  const nextResult = await proxy.callTool(params);

  assert.equal(result.content[0]?.type === "text" ? result.content[0].text : undefined, "b");
  assert.equal(nextResult.content[0]?.type === "text" ? nextResult.content[0].text : undefined, "b");
  assert.deepEqual([first.calls, second.calls], [1, 2]);
});

test("proxy returns ordinary tool errors without retrying", async () => {
  const first = new FakeUpstream("a");
  const second = new FakeUpstream("b");
  first.responses.push({ content: [{ type: "text", text: "Invalid query" }], isError: true });
  const proxy = createProxy([first, second]);
  await proxy.initialize();

  const result = await proxy.callTool(params);
  assert.equal(result.isError, true);
  assert.deepEqual([first.calls, second.calls], [1, 0]);
});

test("proxy retries the next key after an HTTP 503 exception", async () => {
  const first = new FakeUpstream("a");
  const second = new FakeUpstream("b");
  first.responses.push(Object.assign(new Error("Service unavailable"), { code: 503 }));
  const proxy = createProxy([first, second]);
  await proxy.initialize();

  const result = await proxy.callTool(params);
  const nextResult = await proxy.callTool(params);

  assert.equal(result.content[0]?.type, "text");
  assert.equal(result.content[0]?.type === "text" ? result.content[0].text : undefined, "b");
  assert.equal(nextResult.content[0]?.type === "text" ? nextResult.content[0].text : undefined, "b");
  assert.deepEqual([first.calls, second.calls], [1, 2]);
});

test("proxy retries the next key after a network exception", async () => {
  const first = new FakeUpstream("a");
  const second = new FakeUpstream("b");
  first.responses.push(new TypeError("fetch failed"));
  const proxy = createProxy([first, second]);
  await proxy.initialize();

  const result = await proxy.callTool(params);

  assert.equal(result.content[0]?.type === "text" ? result.content[0].text : undefined, "b");
  assert.deepEqual([first.calls, second.calls], [1, 1]);
});

test("proxy does not retry invalid params exceptions", async () => {
  const first = new FakeUpstream("a");
  const second = new FakeUpstream("b");
  first.responses.push(Object.assign(new Error("Invalid params"), { code: ErrorCode.InvalidParams }));
  const proxy = createProxy([first, second]);
  await proxy.initialize();

  await assert.rejects(proxy.callTool(params), /Invalid params/u);
  assert.deepEqual([first.calls, second.calls], [1, 0]);
});

test("redactSecrets removes Tavily keys from errors", () => {
  assert.equal(redactSecrets("failed for tvly-super-secret"), "failed for [REDACTED]");
});

test("a concurrent success does not cancel another call's cooldown", async () => {
  const upstream = new FakeUpstream("a");
  let resolveRateLimit!: (result: CallToolResult) => void;
  let resolveSuccess!: (result: CallToolResult) => void;
  upstream.responses.push(
    new Promise((resolve) => { resolveRateLimit = resolve; }),
    new Promise((resolve) => { resolveSuccess = resolve; }),
  );
  const proxy = createProxy([upstream]);
  await proxy.initialize();

  const limitedCall = proxy.callTool(params);
  const successfulCall = proxy.callTool(params);
  resolveRateLimit({ content: [{ type: "text", text: "Rate limit exceeded" }], isError: true });
  await limitedCall;
  resolveSuccess({ content: [{ type: "text", text: "ok" }] });
  await successfulCall;

  const unavailable = await proxy.callTool(params);
  assert.equal(unavailable.isError, true);
  assert.equal(upstream.calls, 2);
});

test("initialize succeeds with one healthy key when another key fails", async () => {
  // Given
  const failed = new FakeUpstream("failed");
  failed.listToolsErrors.push(Object.assign(new Error("Unauthorized"), { code: 401 }));
  const healthy = new FakeUpstream("healthy");
  const proxy = createProxy([failed, healthy]);

  // When
  await proxy.initialize();
  const result = await proxy.callTool(params);

  // Then
  assert.equal(proxy.listTools().tools.length, 5);
  const content = result.content[0];
  assert.ok(content && content.type === "text");
  assert.equal(content.text, "healthy");
  assert.deepEqual([failed.calls, healthy.calls], [0, 1]);
});

test("concurrent rate limits preserve the longest retry-after", async (t) => {
  // Given
  t.mock.method(Date, "now", () => 1_000);
  const upstream = new FakeUpstream("a");
  let resolveLongLimit: ((result: CallToolResult) => void) | undefined;
  let resolveShortLimit: ((result: CallToolResult) => void) | undefined;
  upstream.responses.push(
    new Promise((resolve) => { resolveLongLimit = resolve; }),
    new Promise((resolve) => { resolveShortLimit = resolve; }),
  );
  const proxy = createProxy([upstream]);
  await proxy.initialize();

  // When
  const longLimitedCall = proxy.callTool(params);
  const shortLimitedCall = proxy.callTool(params);
  upstream.retryAfter = 30_000;
  assert.ok(resolveLongLimit);
  resolveLongLimit({ content: [{ type: "text", text: "Rate limit exceeded" }], isError: true });
  await longLimitedCall;
  upstream.retryAfter = 10_000;
  assert.ok(resolveShortLimit);
  resolveShortLimit({ content: [{ type: "text", text: "Rate limit exceeded" }], isError: true });
  const shortLimitedResult = await shortLimitedCall;
  const nextResult = await proxy.callTool(params);

  // Then
  for (const result of [shortLimitedResult, nextResult]) {
    assert.equal(result.isError, true);
    const content = result.content[0];
    assert.ok(content && content.type === "text");
    assert.match(content.text, /approximately 30 seconds/u);
  }
  assert.equal(upstream.calls, 2);
});

test("a pre-aborted call makes zero upstream calls", async () => {
  // Given
  const upstream = new FakeUpstream("a");
  const proxy = createProxy([upstream]);
  await proxy.initialize();
  const listToolsCalls = upstream.listToolsCalls;
  const controller = new AbortController();
  controller.abort(new Error("aborted before dispatch"));

  // When / Then
  await assert.rejects(
    proxy.callTool(params, { signal: controller.signal }),
    /aborted before dispatch/u,
  );
  assert.equal(upstream.calls, 0);
  assert.equal(upstream.listToolsCalls, listToolsCalls);
});
