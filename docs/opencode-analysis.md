# OpenCode V2 analysis — native hooks, loader, and proxy interception (codesocks)

> V2-only research. Do not assume V1. The community create-opencode-plugin skill targets V1 and MUST NOT override V2.
> File owned by this task. No runtime changes here.

## 1. Pin and applicability
- Repo: https://github.com/anomalyco/opencode | Branch: v2 (moving) | Parent SHA 2026-10-06: 6bffe7932efa9adc36b74e389598daecb4b17ac1
- Docs: https://opencode.ai/v2/docs/build/plugins (+/effect, /cli, /rpc, /migrate-v1), https://opencode.ai/v2/docs/plugins/, https://opencode.ai/v2/docs/network/, https://opencode.ai/v2/docs/migrate-v1/, https://opencode.ai/v2/llms.txt
- Docs intro: 2.0.6 point release. V2 package: @opencode/plugin@2.0.24 (registry /latest 2026-10-06). V1 package: @opencode-ai/plugin@1.18.34. Local CLI: 2.0.15 (local plugin MUST be a directory, not a file).
- Incompatibility: https://opencode.ai/v2/docs/build/plugins/migrate-v1 — V1 plugin implementations do not run in V2.

## 2. Minimal architecture
- TUI/CLI <-> background service (sessions, plugins, permissions, tools). Check: opencode service status + opencode api get /api/info.
- Pipeline: prompt -> context/compaction/generate/title -> model.request -> http.request (mutable Request) -> HTTP transport (Effect FetchHttpClient) or per-session WS -> http.response / experimental.ws.* -> retry.
- Real fetch is Effect FetchHttpClient (packages/ai/src/route/executor.ts fetchLayer), not the global fetch() — use RequestExecutor.middleware for overlays.
- Proxy/TLS and environment (HTTP_PROXY/HTTPS_PROXY/NO_PROXY, NODE_EXTRA_CA_CERTS), not plugin. Source: /v2/docs/network/.

## 3. Native hook + loader (pinned SHA)
### 3.1 http.request/response: packages/core/src/session/model-request.ts 321-349
- Blob: https://github.com/anomalyco/opencode/blob/v2/packages/core/src/session/model-request.ts
- hooks.trigger(session, http.request, {...scope, request: HttpClientRequest.toWeb(req)}); rebuild via fromWeb + bodyUint8Array(clone().arrayBuffer()); after handler: trigger http.response with new Response(...) and return HttpClientResponse.fromWeb.
- Types in packages/plugin/src/promise/session.ts (mutable SessionHttpRequest, SessionHttpResponse, SessionHooks without generic fetch). Blob: https://github.com/anomalyco/opencode/blob/v2/packages/plugin/src/promise/session.ts
- Docs: one-shot streams (clone/replace before reading); kind primary|compaction|title|generate. hasHttpHooks gating, otherwise http undefined.
### 3.2 Loader: plugin/module.ts 94-115 + define
- Blob: https://github.com/anomalyco/opencode/blob/v2/plugin/module.ts — scans directories, uses the default definition.
- CLI 2.0.15: local MUST be a package directory. The package server.js wrapper makes the loader pick the compiled entrypoint.
- Define: packages/plugin/src/promise/plugin.ts — Plugin.define identity; Plugin{id,setup(ctx)}; broad Context. Blob: https://github.com/anomalyco/opencode/blob/v2/packages/plugin/src/promise/plugin.ts
- Package packages/plugin/package.json: name @opencode/plugin, exports ., ./effect, ./host, ./tui, ./* (2.0.24 in the research). Shapes: @opencode/plugin, @opencode/plugin/effect, @opencode/plugin/tui, Rpc in @opencode/plugin/rpc. Auto-load .opencode/plugins/.
### 3.3 Provider filter: plugin/hooks.ts
- Blob: https://github.com/anomalyco/opencode/blob/v2/plugin/hooks.ts — provider filtering.
- Registration packages/plugin/src/promise/registration.ts ModelHooks(name,cb,{providerID}) — global or per-provider scope.

## 4. Proven vs speculative contract
- Proven: prompt, context|compaction|generate|title, model.request(+providerID), http.request|response(+kind), experimental.ws.handshake|send|receive (experimental), retry, provider.transform, tool.execute.before|after, shell.create.before, permission.*, event.subscribe(), transform+reload. Order = registration.
- No generic fetch or stable websocket: closed SessionHooks (source /effect/) has no fetch; WS streaming bypasses http.*.
- Not promised: full mid-stream MITM, swapping global fetch, TUI/layout, built-ins, keybinds outside CLI plugins, new permission types.

## 5. Transport/retries/WS
- Executor packages/ai/src/route/executor.ts; transport packages/ai/src/route/transport/http.ts, websocket.ts, websocket-channel.ts (16MiB/1009 cap); session pin packages/core/src/session/model-transport.ts (ROTATE 55min, CONNECT 15s, IDLE 30min, MAX_STREAM_FAILURES 5, affinity url+sha256(headers)); only when webSocket=session and transport=websocket.
- Retry packages/core/src/session/runner/retry.ts: recurs(10)+jitter, RETRY_AFTER_MAX 15min, MAX_TIMEOUT 3, physical attempt 1=initial; classification packages/ai/src/provider-error.ts isRetryable/classifyProviderFailure (+x-should-retry); ceiling and hard limit.

## 6. Local smoke
- Parent: build + node scripts/smoke-opencode.mjs PASS (proxy:2 upstream:2 exit 0); initial timeouts = missing child.stdin.end, not the plugin. No runtime in this doc.

## 7. Limitations
- Moving v2: cite blob/<SHA>. 2.0.24 date not observed (registry full >5MB; npmjs 403). Promise page tail truncated (~12k) — corroborated via Effect+migrate-v1. dev branch differs (V2-only). @opencode-ai/plugin/v2/* staging only.

## 8. Codesocks proxy implication
- Intercept on mutable http.request (clone before reading) + http.response (rebuild Response); providerID scope; cover WS via experimental.ws.* + fallback; respect recurs(10)/15min/3 timeouts and UnknownProvider retryable.
