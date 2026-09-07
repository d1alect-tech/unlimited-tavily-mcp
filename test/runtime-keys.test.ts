import assert from "node:assert/strict";
import test from "node:test";
import type { CallToolRequest, CallToolResult, ListToolsResult } from "@modelcontextprotocol/sdk/types.js";
import { TavilyProxy } from "../src/proxy.js";
import type { TavilyUpstream, UpstreamCallOptions } from "../src/upstream.js";

const tools: ListToolsResult = {
  tools: ["search", "extract", "crawl", "map", "research"].map((name) => ({
    name: `tavily_${name}`,
    inputSchema: { type: "object" as const },
  })),
};

class RuntimeUpstream implements TavilyUpstream {
  calls = 0;
  closes = 0;
  listToolsCalls = 0;
  listToolsError?: Error;

  constructor(readonly id: string) {}

  async listTools(): Promise<ListToolsResult> {
    this.listToolsCalls += 1;
    if (this.listToolsError) {
      throw this.listToolsError;
    }
    return tools;
  }

  async callTool(_params: CallToolRequest["params"], _options: UpstreamCallOptions): Promise<CallToolResult> {
    this.calls += 1;
    return { content: [{ type: "text", text: this.id }] };
  }

  takeRetryAfterMs(): number | undefined {
    return undefined;
  }

  async close(): Promise<void> {
    this.closes += 1;
  }
}

function createProxy(upstreams: RuntimeUpstream[]): TavilyProxy {
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

test("runtime upstreams join rotation and close with the proxy", async () => {
  const first = new RuntimeUpstream("a");
  const second = new RuntimeUpstream("b");
  const duplicate = new RuntimeUpstream("a");
  const proxy = createProxy([first]);
  await proxy.initialize();

  const added = proxy.addUpstreams([second, duplicate]);
  const results: string[] = [];
  for (let index = 0; index < 4; index += 1) {
    const result = await proxy.callTool(params);
    const content = result.content[0];
    assert.ok(content && content.type === "text");
    results.push(content.text);
  }
  await proxy.close();

  assert.equal(added, 1);
  assert.deepEqual(results, ["a", "b", "a", "b"]);
  assert.deepEqual([first.closes, second.closes, duplicate.closes], [1, 1, 0]);
});

test("an unauthorized runtime upstream is isolated from healthy keys", async () => {
  const healthy = new RuntimeUpstream("healthy");
  const invalid = new RuntimeUpstream("invalid");
  invalid.listToolsError = Object.assign(new Error("Unauthorized"), { code: 401 });
  const proxy = createProxy([healthy]);
  await proxy.initialize();
  proxy.addUpstreams([invalid]);

  await proxy.callTool(params);
  const result = await proxy.callTool(params);

  assert.equal(result.content[0]?.type === "text" ? result.content[0].text : undefined, "healthy");
  assert.deepEqual([healthy.calls, invalid.listToolsCalls, invalid.calls, invalid.closes], [2, 1, 0, 1]);
});
