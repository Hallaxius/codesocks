# How CodeSocks fits OpenCode V2

I use V2's provider-scoped HTTP hooks, not a global `fetch` patch. These notes
record the source snapshot behind that choice. V1 plugin implementations don't
run in V2; don't use V1 examples as a substitute for this contract.

## Source snapshot

- Repository: <https://github.com/anomalyco/opencode>
- Branch: `v2`, which moves. Snapshot dated 2026-10-06:
  `6bffe7932efa9adc36b74e389598daecb4b17ac1`.
- Local CLI tested: `2.0.15`. Local plugins must be package directories, not files.
- The docs introduction referenced `2.0.6`. The research notes referenced
  `@opencode/plugin@2.0.24` and V1's `@opencode-ai/plugin@1.18.34`.
  The release date for `2.0.24` wasn't verified. CodeSocks currently develops
  against `@opencode/plugin@2.0.22`; those are separate observations.

Documentation used:

- [Build plugins](https://opencode.ai/v2/docs/build/plugins), including its
  `/effect`, `/cli`, `/rpc`, and `/migrate-v1` pages.
- [Plugin loading](https://opencode.ai/v2/docs/plugins/)
- [Networking](https://opencode.ai/v2/docs/network/)
- [V1 migration](https://opencode.ai/v2/docs/migrate-v1/)
- [Documentation index](https://opencode.ai/v2/llms.txt)

## Follow the request

The TUI/CLI talks to a background service that owns sessions, plugins,
permissions, and tools. The inspection commands were `opencode service status`
and `opencode api get /api/info`.

```text
prompt → context/compaction/generate/title → model.request
       → http.request → HTTP transport → http.response → retry
```

Session WebSocket transport takes a separate path through `experimental.ws.*`.
It bypasses `http.*` hooks.

The real HTTP executor uses Effect's `FetchHttpClient`, not global `fetch()`.
See `fetchLayer` in `packages/ai/src/route/executor.ts` and
`RequestExecutor.middleware` for overlays. OpenCode's own proxy and TLS setup
uses environment variables such as `HTTP_PROXY`, `HTTPS_PROXY`, `NO_PROXY`,
and `NODE_EXTRA_CA_CERTS`. That setup is separate from CodeSocks' explicit agents.

## Hook and loader contract

### HTTP requests and responses

[Session model request source](https://github.com/anomalyco/opencode/blob/6bffe7932efa9adc36b74e389598daecb4b17ac1/packages/core/src/session/model-request.ts),
lines 321–349 in the snapshot:

- `hooks.trigger(session, http.request, {...scope, request: HttpClientRequest.toWeb(req)})`
  exposes a mutable request.
- The executor rebuilds it through `fromWeb` and
  `bodyUint8Array(clone().arrayBuffer())`.
- After the handler, `http.response` receives a new `Response(...)`.
  The executor returns `HttpClientResponse.fromWeb`.

[Session hook types](https://github.com/anomalyco/opencode/blob/6bffe7932efa9adc36b74e389598daecb4b17ac1/packages/plugin/src/promise/session.ts)
define mutable `SessionHttpRequest` and `SessionHttpResponse`. `SessionHooks`
has no generic `fetch` hook. Request kinds are `primary`, `compaction`, `title`,
and `generate`. `hasHttpHooks` gates the HTTP overlay; otherwise `http` is undefined.

Bodies are one-shot streams. Clone or replace them before reading.

### Package loading

[Loader source](https://github.com/anomalyco/opencode/blob/6bffe7932efa9adc36b74e389598daecb4b17ac1/plugin/module.ts),
lines 94–115, scans directories and uses the default definition.
CLI `2.0.15` requires a local package directory. CodeSocks' `server.js` wrapper
points the loader at the compiled entrypoint.

[Plugin definition source](https://github.com/anomalyco/opencode/blob/6bffe7932efa9adc36b74e389598daecb4b17ac1/packages/plugin/src/promise/plugin.ts)
provides `Plugin.define`, an identity helper, and the `Plugin{id,setup(ctx)}` shape.

The research recorded package exports `.`, `./effect`, `./host`, `./tui`, and
`./*` in `packages/plugin/package.json`. Import paths include `@opencode/plugin`,
`@opencode/plugin/effect`, `@opencode/plugin/tui`, and RPC via `@opencode/plugin/rpc`.
OpenCode also auto-loads `.opencode/plugins/`.

### Provider filtering

[Hook dispatch](https://github.com/anomalyco/opencode/blob/6bffe7932efa9adc36b74e389598daecb4b17ac1/plugin/hooks.ts)
supports provider filtering. Registration in
`packages/plugin/src/promise/registration.ts` uses
`ModelHooks(name, cb, {providerID})` for global or per-provider scope.

## What the snapshot supports

Observed hooks and registration points:

- `prompt`, `context`, `compaction`, `generate`, `title`
- `model.request` with `providerID`; `http.request` and `http.response` with `kind`
- `experimental.ws.handshake`, `send`, and `receive` — experimental, not stable
- `retry`, `provider.transform`, `tool.execute.before` and `after`
- `shell.create.before`, `permission.*`, `event.subscribe()`, transform and reload

Hooks run in registration order. The closed `SessionHooks` type in the Effect
source has no generic `fetch` hook. This snapshot doesn't promise full mid-stream
MITM, global fetch replacement, TUI/layout control, built-in replacement,
keybinds outside CLI plugins, or new permission types.

## Transport and retry limits

These are OpenCode snapshot values, not CodeSocks configuration defaults.

| Area | Source | Recorded limits |
| --- | --- | --- |
| HTTP executor | `packages/ai/src/route/executor.ts`, `route/transport/http.ts` | Effect HTTP transport |
| WebSocket | `route/transport/websocket.ts`, `websocket-channel.ts` | 16 MiB cap; close code `1009` |
| Session transport | `packages/core/src/session/model-transport.ts` | Rotate: 55 min; connect: 15 s; idle: 30 min; `MAX_STREAM_FAILURES`: 5 |
| Retry | `packages/core/src/session/runner/retry.ts` | `recurs(10)` plus jitter; `RETRY_AFTER_MAX`: 15 min; `MAX_TIMEOUT`: 3; physical attempt 1 is the initial request |

Session WebSockets require `webSocket=session` and `transport=websocket`.
Affinity uses URL plus `sha256(headers)`. Retry classification lives in
`packages/ai/src/provider-error.ts`: `isRetryable`, `classifyProviderFailure`,
and `x-should-retry`, with a ceiling and hard limit.

## Test record

The earlier local `build` plus `node scripts/smoke-opencode.mjs` run passed:
2 proxy requests, 2 origin requests, exit `0`. Initial timeout investigation
found a missing `child.stdin.end()`.

A later run on 2026-10-06 failed with `compaction.failed`:
`Compaction summary did not match the required template`. It reached the proxy
and origin 3 times each, then exited `1`. Routing counts don't make that run a pass.

The mock always returns `CODESOCKS_SMOKE_OK`, so it can't satisfy OpenCode's
compaction template. The transport smoke now sets `compaction.auto` to `false`
in its temporary CLI config. The next run passed: 2 proxy requests, 2 origin
requests, marker present, exit `0`. This tests HTTP routing, not compaction.
The host's skill directories still appeared in Windows CLI logs; overriding
`HOME`, `USERPROFILE`, or `OPENCODE_TEST_HOME` didn't isolate that discovery.

## Evidence limits

- The `v2` branch moves. Source links above use the pinned SHA.
- The full registry response exceeded 5 MB; npmjs returned `403`.
  The `2.0.24` release date wasn't observed.
- The Promise documentation tail was truncated at roughly 12k characters.
  Effect and V1 migration pages corroborated the hook contract.
- The `dev` branch differs. `@opencode-ai/plugin/v2/*` paths were staging-only.

## CodeSocks' choice

I rewrite the mutable `http.request` through a provider-scoped hook and clone
before reading the body. The relay preserves the upstream response stream.
Selected providers use HTTP; the experimental WebSocket handshake fails closed.
There is no WebSocket proxy fallback.

OpenCode owns its retry policy, including retryable `UnknownProvider` failures.
CodeSocks' pacing and cooldowns don't replace the recorded `recurs(10)`,
15 min retry ceiling, or 3-timeout limit.
