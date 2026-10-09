# CodeSocks for OpenCode V2

[![CI](https://github.com/Hallaxius/codesocks/actions/workflows/ci.yaml/badge.svg)](https://github.com/Hallaxius/codesocks/actions/workflows/ci.yaml)
[![npm version](https://img.shields.io/npm/v/@hallaxius/codesocks.svg)](https://www.npmjs.com/package/@hallaxius/codesocks)
[![license: Apache-2.0](https://img.shields.io/badge/License-Apache--2.0-yellow.svg)](./LICENSE)

Route selected OpenCode providers through HTTP, HTTPS, or SOCKS proxies without changing `baseURL`. CodeSocks preserves request bodies, provider authentication, and Server-Sent Events (SSE) streaming. It supports per-provider pacing, automatic proxy failover, and manual selection in the terminal UI.

Requires OpenCode V2 (`>=2.0.15 <3`) and Node.js 24 or newer. A proxy changes your egress IP, not your account quotas.

## Install with Bun or npm

Install the published package in your project with either package manager.

With [Bun](https://bun.com/docs/pm/cli/add):

```bash
bun add @hallaxius/codesocks
```

With [npm](https://docs.npmjs.com/cli/v11/commands/npm-install):

```bash
npm install @hallaxius/codesocks
```

Add the installed directory to your project's `opencode.jsonc`, preserving any existing plugins:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [{ "package": "./node_modules/@hallaxius/codesocks" }]
}
```

> The published `0.1.0` package does not include the TUI entrypoint. Use a local checkout for the menu and unreleased features described below.

### Use a local checkout

In the CodeSocks repository, install dependencies and build with one of these alternatives.

With Bun:

```bash
bun install
bun run build
```

With npm:

```bash
npm install
npm run build
```

Register the repository directory, not `server.js`, in your project's or global `opencode.jsonc`:

```jsonc
{
  "plugins": [{ "package": "file:///absolute/path/to/codesocks" }]
}
```

On Windows, use a URL such as `file:///C:/Projects/codesocks`. Restart OpenCode after registering the plugin.

## Configure your proxies

Create `codesocks.jsonc` next to `opencode.jsonc` or `opencode.json`. Replace the example proxy address, set the environment variables on the OpenCode server, then change `enabled` to `true`.

```jsonc
{
  "$schema": "https://raw.githubusercontent.com/Hallaxius/codesocks/main/codesocks.schema.json",
  "enabled": false,
  "proxies": {
    "primary": "socks5h://{env:PROXY_USER}:{env:PROXY_PASS}@proxy.example:1080"
  },
  "providers": {
    "openai": {
      "proxy": "primary",
      "allowedOrigins": ["https://api.openai.com"]
    }
  }
}
```

Use provider IDs from your OpenCode configuration. Each route needs a named proxy and exact HTTP or HTTPS `allowedOrigins`, without paths or credentials. Supported proxy schemes are `http`, `https`, `socks4`, `socks4a`, `socks5`, and `socks5h`; `socks5h` resolves DNS at the proxy. Missing environment variables, unknown fields, and invalid configuration stop loading.

Optional controls apply per provider:

| Setting | Default | Purpose |
| --- | --- | --- |
| `maxConcurrent` | `2` | Limit active requests, including streams |
| `minIntervalMs` | `0` | Space request starts |
| `timeoutMs` | `120000` | Limit upstream request duration |
| `maxQueueWaitMs` | `120000` | Limit waiting for a provider slot |

Configuration lookup uses the first match, without merging: plugin option `configPath`, `CODESOCKS_CONFIG`, the nearest sibling configuration up the directory tree, then OpenCode's global configuration directories. Set `options.configPath` in the plugin registration when you need an explicit file. Without a configuration file, CodeSocks stays disabled.

The schema URL enables editor validation only. For offline use, set `$schema` to `./node_modules/@hallaxius/codesocks/codesocks.schema.json` if that file exists. The GitHub `main` schema tracks development; pin a tag or commit to match a release.

## Enable automatic failover

Add another named proxy to `proxies`, then add `rotation` to the provider route:

```jsonc
"rotation": {
  "enabled": true,
  "proxies": ["backup"],
  "cooldownMs": 30000,
  "failureThreshold": 2
}
```

The pool starts with the provider's `proxy`, followed by the ordered fallback names. Rotation defaults to off; cooldown defaults to 30 seconds and `failureThreshold` defaults to 1. Set the threshold to 2 or 3 to tolerate isolated transport failures.

Transport errors, timeouts, interrupted upstream streams, and HTTP `407` count toward failover. A completed non-`429` response resets the failure count. Provider HTTP errors (`401`, `5xx`), redirects, queue failures, and client cancellation do not trigger rotation. Network failures can originate at either the proxy or the provider.

For HTTP `429`, set `"rotateOnRateLimit": true` inside an enabled `rotation` block. This opt-in defaults to false and switches the proxy for subsequent requests immediately, independently of `failureThreshold`. The limited proxy stays excluded for at least the longer of `cooldownMs` and `Retry-After`. Provider-wide `Retry-After` backoff still applies, including after manual selection or reload; changing an IP does not prove that an account or model limit has cleared. Missing or invalid `Retry-After` uses a one-second backoff. The original `429` response, headers, and body are forwarded unchanged.

**CodeSocks never replays a failed request or restarts an SSE stream.** Rotation affects subsequent requests, including retries initiated by OpenCode. An exhausted pool returns `503`, never a direct connection. IP rotation behind a single proxy gateway remains the proxy service's responsibility.

## Select a proxy or reload configuration

Run `/codesocks`, or open the command palette with `Ctrl+P` and choose **CodeSocks: choose provider proxy**. The menu shows the selected proxy, consecutive failures, cooldowns, and pool exhaustion. Reopen it to refresh those values; URLs and credentials stay hidden.

After choosing a provider and proxy, select one of these options:

- **Use temporarily**: apply the choice until configuration or plugin reload
- **Save as default**: update the selected JSONC file and reload it, preserving comments and `{env:...}` references

Escape cancels without changes. Manual selection clears the chosen proxy's cooldown; automatic rotation remains enabled if configured. Active streams keep their original proxy.

Use `/codesocks-reload` or **Reload configuration** in the menu after editing the file. Reload is explicit, not automatic. Invalid configuration or a deleted selected file leaves previous routing in place. Successful reload resets temporary choices and failure counters, while active streams, provider concurrency limits, and `429` cooldowns remain intact.

Saving writes to the connected OpenCode **server**, including inherited files shared with other projects. Avoid editing the file during a save. If saving succeeds but applying it fails, fix the cause and reload; the file remains saved. Remove a stale `.codesocks-lock` only after confirming no writer is active.

## Routing limits and security

CodeSocks routes session HTTP requests through a loopback relay with single-use tickets and verified TLS:

- Only configured origins are allowed; upstream redirects are blocked
- Selected providers use HTTP; WebSocket requests are refused
- Provider `429` responses respect `Retry-After` across proxy changes and reloads
- Transport failures return `502` or close an active stream; unavailable queues return `503`
- Calls to `ctx.generate.text` outside a session are not intercepted

## Development checks

Run these checks from the repository. The test and smoke scripts require Bun; the smoke also requires an installed OpenCode V2 CLI.

```bash
bun run lint
bun run check
bun run smoke:opencode
```

See the [OpenCode integration analysis](docs/opencode-analysis.md) for source references and test records.
