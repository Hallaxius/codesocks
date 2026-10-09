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

## Proxy failover and TUI update (2026-10-09)

The follow-up inspection pinned the `v2` branch at
`eefe85d2572363b62d131128bd4bdb70294632ac`. The default `dev` branch is a different
code line and was not used as the V2 API contract. Context7 could not return
documentation because its monthly quota was exhausted; official V2 documentation
and source were used instead.

Sources checked:

- [CLI plugin API](https://opencode.ai/v2/docs/build/plugins/cli): keymap command
  registration, palette/slash discovery, select dialogs, toasts, lifecycle.
- [RPC API](https://opencode.ai/v2/docs/build/plugins/rpc): server registration and
  calls through the TUI's connected client, without direct loopback admin access.
- [TUI context source](https://github.com/anomalyco/opencode/blob/eefe85d2572363b62d131128bd4bdb70294632ac/packages/plugin/src/tui/context.ts):
  `keymap.layer`, `ui.dialog.select`, optional plugin `location`, client RPC.
- [Server loader](https://github.com/anomalyco/opencode/blob/eefe85d2572363b62d131128bd4bdb70294632ac/packages/core/src/plugin/module.ts):
  `Host.resolve` returns server and TUI entrypoints.
- [TUI discovery](https://github.com/anomalyco/opencode/blob/eefe85d2572363b62d131128bd4bdb70294632ac/packages/tui/src/plugin/discovery.ts):
  local plugin targets are directories.

The installed `@opencode/plugin@2.0.22` declarations require RPC `input` and
`events`, even when empty; the implementation supplies explicit empty schemas
and an empty events map. Typechecking uses those installed declarations.

CodeSocks exposes names-only `status` and `select` RPC methods. Manual selection
is server runtime state scoped to the plugin location, not a client filesystem
edit. Global CLI plugins use the open session's location. Commands use that same
location on both calls. No proxy credentials cross
the RPC boundary. Automatic failover uses a provider-local cooldown pool;
generation checks prevent late failures from overwriting newer manual choices.

Failover intentionally affects subsequent requests, including OpenCode retries.
It does not replay a failed POST or restart a stream. Transport errors cannot
always distinguish a bad proxy from a failed origin. HTTP provider statuses are
not failover signals, except proxy authentication status `407`. No retry hook
overrides OpenCode's policy, and pool exhaustion never permits direct egress.

The current workspace's config, example, and README already used the GitHub raw
schema URL before this change. No occurrence of the reported `node_modules` path
was found in their available Git history. A local schema path is useful offline
and tracks an installed package version, but can be absent when OpenCode uses
its own plugin cache. The GitHub `main` URL can run ahead of installed releases.

## Missing slash/palette commands in CodeSocks 0.1.1

The installed OpenCode CLI reports version 2.0.24. CodeSocks 0.1.1 registers its
TUI command layer without a `mode`. This defaults to `base`, not `global`.
OpenCode's slash autocomplete pushes `autocomplete`; dialogs push `modal`.
Both autocomplete and the command palette read reachable commands, so the
base-only layer is filtered out even when the plugin successfully loads.

Version-matched source evidence:

- [Keymap defaults and reachable command query](https://github.com/anomalyco/opencode/blob/v2.0.24/packages/tui/src/context/keymap.tsx#L204-L216)
- [Autocomplete mode](https://github.com/anomalyco/opencode/blob/v2.0.24/packages/tui/src/component/prompt/autocomplete.tsx#L94-L100)
- [Palette command query](https://github.com/anomalyco/opencode/blob/v2.0.24/packages/tui/src/component/command-palette.tsx#L14-L18)
- [Dialog modal mode](https://github.com/anomalyco/opencode/blob/v2.0.24/packages/tui/src/ui/dialog.tsx#L88-L96)

Fix: register the CodeSocks layer with `mode: "global"`. The regression in
`tests/tui.test.ts` failed with `undefined` before the change and passes after it.
It tests the registration contract, not rendered terminal interaction. The
published/cache copies of 0.1.1 remain unchanged; rebuilding this checkout does
not update a configuration pinned to the npm version. Release a patched version
or explicitly load the built local checkout before verifying the visible menu.
