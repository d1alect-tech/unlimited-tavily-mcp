# unlimited-tavily-mcp

A local [Model Context Protocol](https://modelcontextprotocol.io) server that fronts the official [Tavily remote MCP](https://mcp.tavily.com) and spreads your tool calls across **multiple API keys**.

One Tavily key hits its rate limit? The proxy moves to the next one, transparently.

## How it works

- **Round-robin** — each call goes to the next ready key in the pool.
- **Rate-limited keys (429)** enter a cooldown and rejoin automatically. A `Retry-After` header from Tavily is honored when present.
- **Invalid keys (401/403)** are disabled for the lifetime of the process.
- **No blind retries** — ambiguous network and server errors are returned as-is so paid operations (search, extract, crawl) are never duplicated.
- **Live key reload** — add a key to the keys file while the server runs; it joins the pool without a restart. Keys are identified only by a short SHA-256 fingerprint; they are never logged.
- **Full tool pass-through** — `tavily_search`, `tavily_extract`, `tavily_crawl`, `tavily_map`, `tavily_research`, including progress notifications for long research calls.

## Requirements

- [Bun](https://bun.sh) — it runs the TypeScript source directly, no build step needed.
- One or more Tavily API keys.

## Setup

```sh
git clone https://github.com/d1alect-tech/unlimited-tavily-mcp.git
cd unlimited-tavily-mcp
bun install
```

Create the keys file (default location: `~/.config/opencode/secrets/tavily.keys`):

```sh
mkdir -p ~/.config/opencode/secrets
cp tavily.keys.example ~/.config/opencode/secrets/tavily.keys
```

Put one key per line. Blank lines and `#` comments are ignored. Duplicates are dropped.

## Use with OpenCode

Add the block from [`opencode.example.jsonc`](opencode.example.jsonc) to your `opencode.jsonc`, pointing the second command argument at your checkout:

```jsonc
"mcp": {
  "tavily": {
    "type": "local",
    "command": ["bun", "/absolute/path/to/unlimited-tavily-mcp/src/index.ts"],
    "enabled": true,
    "timeout": 970000
  }
}
```

## Configuration

| Environment variable | Default | Purpose |
|---|---|---|
| `TAVILY_API_KEYS_FILE` | `~/.config/opencode/secrets/tavily.keys` | Path to the key pool file |
| `TAVILY_MCP_URL` | `https://mcp.tavily.com/mcp/` | Upstream MCP endpoint (HTTPS enforced) |

Run standalone (speaks MCP over stdio, so any MCP client works):

```sh
bun src/index.ts
```

## Development

```sh
bun run test   # type-checks and runs the node:test suite (27 tests)
```

## Security

Keys are read from a file outside the repo and never appear in logs — a `tvly-*` redactor guards every error path. See [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE)
