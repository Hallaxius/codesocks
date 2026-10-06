# CodeSocks: proxy interceptor for OpenCode V2

[![CI](https://github.com/Hallaxius/codesocks/actions/workflows/ci.yaml/badge.svg)](https://github.com/Hallaxius/codesocks/actions/workflows/ci.yaml)
[![npm version](https://img.shields.io/npm/v/@hallaxius/codesocks.svg)](https://www.npmjs.com/package/@hallaxius/codesocks)
[![license: Apache-2.0](https://img.shields.io/badge/License-Apache--2.0-yellow.svg)](./LICENSE)
[![Node.js >= 24](https://img.shields.io/badge/node-%3E%3D24-brightgreen.svg)](https://nodejs.org)

Built by [Hallaxius](https://github.com/Hallaxius).

I built CodeSocks to pick a proxy per provider without changing `baseURL`. It's a native OpenCode V2 plugin (`@opencode/plugin` 2.x). You choose the providers and the proxy. Request bodies, provider credentials, and SSE streaming stay intact.

Route: `prompt → provider http.request hook → local 127.0.0.1 relay → your proxy → original baseURL`.

> A proxy changes your egress IP. It doesn't erase account or plan quotas. CodeSocks paces requests per provider with `maxConcurrent`, `minIntervalMs`, and `429` cooldowns honoring `Retry-After`.

## Compatibility

- OpenCode V2 (`>=2.0.15 <3`). Tested against CLI `2.0.15` and the `anomalyco/opencode` `v2` branch (SHA `6bffe79`, pinned in `docs/opencode-analysis.md`).
- Stable local-directory entrypoint: `server.js` re-exports `dist/index.js`. The V2 loader wants a directory, not a file.
- `Plugin.define({ id: "codesocks" })` registers the plugin. `ctx.provider.transform` forces `settings.transport = "http"` on selected providers. The provider-scoped `http.request` hook rewrites requests. `experimental.ws.handshake` fails closed; WebSocket doesn't go through the relay.

## Installation

```bash
bun install
bun run build
```

Register the package directory in the project (or global) `opencode.jsonc`:

```jsonc
{
  "plugins": [{ "package": "file:///path/to/codesocks" }]
}
```

## Configuration: `codesocks.jsonc`

The file lives next to `opencode.jsonc`/`opencode.json` (directly or inside `.opencode/`). Lookup order is fixed, no merging:

1. Plugin option `configPath` (relative to `ctx.location.directory`). Must exist.
2. `$CODESOCKS_CONFIG`. Must exist.
3. Nearest sibling walking up from `directory` to the root: `codesocks.jsonc` next to `opencode.json/jsonc`, directly or in `.opencode/`.
4. Global: `dirname($OPENCODE_CONFIG)` / `$OPENCODE_CONFIG_DIR` / `$XDG_CONFIG_HOME/opencode` / `<home>/.config/opencode`.
5. Nothing found → plugin stays disabled (empty maps), no error.

Minimal example (`examples/codesocks.example.jsonc`):

```jsonc
{
  "$schema": "https://raw.githubusercontent.com/Hallaxius/codesocks/main/codesocks.schema.json",
  "enabled": false, // switch to true after configuring a real proxy
  "proxies": {
    // "socks5h://{env:PROXY_USER}:{env:PROXY_PASS}@127.0.0.1:1080"
    "local": "socks5h://127.0.0.1:1080"
  },
  "providers": {
    "openai": {
      "proxy": "local",
      "allowedOrigins": ["https://api.openai.com"],
      "maxConcurrent": 2,
      "minIntervalMs": 0,
      "timeoutMs": 120000,
      "maxQueueWaitMs": 120000
    }
  }
}
```

Fail-closed rules (error text never includes URLs):

- `proxies`: `http`, `https`, `socks4`, `socks4a`, `socks5`, `socks5h`. No path, query, fragment, or PAC. Secrets only via `{env:NAME}` inside proxy URLs. A missing or empty variable is an error.
- `providers.<id>`: `proxy` must name an entry in `proxies` (own-key comparison). `allowedOrigins` is required and non-empty. Origins must be exact `http(s)`, normalized to `origin` (case, default port, and trailing slash folded). No credentials, no path.
- Unknown fields, `__proto__`, invalid JSONC, or an unreadable selected file → `ConfigError`.
- The `__proto__` key gets rejected by scanning the raw text before parsing. Internal maps use null prototypes.

## Relay security

- The relay binds `127.0.0.1` only, on an ephemeral port. Rewrites use random 32-byte single-use tickets: 60 s expiry, 1024 pending cap, method checked. Bad or replayed ticket → `403`.
- Only `allowedOrigins` get through. An unapproved origin errors before any network happens. Credentials never leave for the wrong destination.
- Upstream `3xx` gets blocked with a generic `502`. The relay doesn't follow redirects. `429` sets a per-provider `cooldown` from `Retry-After` (seconds or date, 1 s default, never shortens a wait already in effect).
- Hop-by-hop and `proxy-*` headers get stripped. Status, body, and SSE pass through untouched. Abort and timeout kill the upstream socket. Egress uses explicit agents (`http-proxy-agent` / `https-proxy-agent` / `socks-proxy-agent`). No `HTTP_PROXY` / `HTTPS_PROXY` / `NO_PROXY` involved.
- `socks5h` resolves DNS at the proxy (domain ATYP). TLS stays verified end to end. Verification never gets disabled.

## Verification

```bash
bun run lint           # Markdown in root docs and GitHub templates
bun run check          # typecheck + build + 37 tests (bun test tests)
bun run smoke:opencode # fake local SSE origin + proxy, then `opencode run --standalone` with temporary config
bun audit --production # check production dependencies
npm pack --dry-run     # tarball: dist + server.js + schema + examples + README + LICENSE
```

Expected smoke output: `{"result":"PASS","proxyHits":2,"upstreamHits":2,"marker":"CODESOCKS_SMOKE_OK"}`.

The transport smoke disables automatic compaction: the mock returns a marker, not a summary.
See the [test record](docs/opencode-analysis.md#test-record). Matching request counts alone aren't a pass.

The live rotating-proxy check returned HTTP `200` on 3 HTTPS requests, with 3 distinct egress IPs. That confirms rotation for that run, not a guarantee about your proxy.

## Honest limits

- WebSocket on selected providers gets refused. Use HTTP. `ctx.generate.text` outside a session never sees session hooks.
- Queue caps at 256 per provider. `503` when the queue is unavailable, generic `502` on transport failure.
- Audit snapshot (2026-10-06): `bun audit --production` reported 0 vulnerabilities. Run it again before shipping. CodeSocks uses explicit proxy agents instead of the `proxy-agent` umbrella.
