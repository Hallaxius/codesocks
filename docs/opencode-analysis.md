# Analise OpenCode V2 — hooks nativos, loader e interceptacao proxy (codesocks)

> Pesquisa somente V2. Nao assumir V1. Skill comunitaria create-opencode-plugin mira V1 e NAO deve sobrepor V2.
> Arquivo owned por esta tarefa. Sem alteracao de runtime aqui.

## 1. Pin e aplicabilidade
- Repo: https://github.com/anomalyco/opencode | Branch: v2 (movel) | SHA parent 2026-10-06: 6bffe7932efa9adc36b74e389598daecb4b17ac1
- Docs: https://opencode.ai/v2/docs/build/plugins (+/effect, /cli, /rpc, /migrate-v1), https://opencode.ai/v2/docs/plugins/, https://opencode.ai/v2/docs/network/, https://opencode.ai/v2/docs/migrate-v1/, https://opencode.ai/v2/llms.txt
- Docs intro: 2.0.6 pontual. Pacote V2: @opencode/plugin@2.0.24 (registry /latest 2026-10-06). Pacote V1: @opencode-ai/plugin@1.18.34. CLI local: 2.0.15 (plugin local MUST diretorio, nao arquivo).
- Incompatibilidade: https://opencode.ai/v2/docs/build/plugins/migrate-v1 — V1 plugin implementations do not run in V2.

## 2. Arquitetura minima
- TUI/CLI <-> servico background (sessoes, plugins, permissoes, tools). Checar: opencode service status + opencode api get /api/info.
- Pipeline: prompt -> context/compaction/generate/title -> model.request -> http.request (Request mutavel) -> transporte HTTP (Effect FetchHttpClient) ou WS por sessao -> http.response / experimental.ws.* -> retry.
- Fetch real e Effect FetchHttpClient (packages/ai/src/route/executor.ts fetchLayer), nao fetch() global — usar RequestExecutor.middleware p/ overlay.
- Proxy/TLS e ambiente (HTTP_PROXY/HTTPS_PROXY/NO_PROXY, NODE_EXTRA_CA_CERTS), nao plugin. Fonte: /v2/docs/network/.

## 3. Hook nativo + loader (SHA pinado)
### 3.1 http.request/response: packages/core/src/session/model-request.ts 321-349
- Blob: https://github.com/anomalyco/opencode/blob/v2/packages/core/src/session/model-request.ts
- hooks.trigger(session, http.request, {...scope, request: HttpClientRequest.toWeb(req)}); rebuild via fromWeb + bodyUint8Array(clone().arrayBuffer()); apos handler: trigger http.response com new Response(...) e retorno HttpClientResponse.fromWeb.
- Tipos em packages/plugin/src/promise/session.ts (SessionHttpRequest mutavel, SessionHttpResponse, SessionHooks sem fetch generico). Blob: https://github.com/anomalyco/opencode/blob/v2/packages/plugin/src/promise/session.ts
- Docs: one-shot streams (clone/replace antes de ler); kind primary|compaction|title|generate. Gating hasHttpHooks senao http undefined.
### 3.2 Loader: plugin/module.ts 94-115 + define
- Blob: https://github.com/anomalyco/opencode/blob/v2/plugin/module.ts — varre diretorios, usa definicao default.
- CLI 2.0.15: local MUST diretorio de pacote. Wrapper server.js do pacote faz loader selecionar compilado.
- Define: packages/plugin/src/promise/plugin.ts — Plugin.define identidade; Plugin{id,setup(ctx)}; Context amplo. Blob: https://github.com/anomalyco/opencode/blob/v2/packages/plugin/src/promise/plugin.ts
- Package packages/plugin/package.json: name @opencode/plugin, exports ., ./effect, ./host, ./tui, ./* (2.0.24 na pesquisa). Formas: @opencode/plugin, @opencode/plugin/effect, @opencode/plugin/tui, Rpc em @opencode/plugin/rpc. Auto-load .opencode/plugins/.
### 3.3 Filtro por provider: plugin/hooks.ts
- Blob: https://github.com/anomalyco/opencode/blob/v2/plugin/hooks.ts — filtragem provider.
- Registro packages/plugin/src/promise/registration.ts ModelHooks(name,cb,{providerID}) — escopo global ou por provider.

## 4. Contrato provado vs especulativo
- Provado: prompt, context|compaction|generate|title, model.request(+providerID), http.request|response(+kind), experimental.ws.handshake|send|receive (experimental), retry, provider.transform, tool.execute.before|after, shell.create.before, permission.*, event.subscribe(), transform+reload. Ordem = registro.
- Sem fetch generico nem websocket estavel: SessionHooks fechada (fonte /effect/) nao tem fetch; WS-streaming desvia de http.*.
- Nao prometido: MITM total mid-stream, troca de fetch global, TUI/layout, built-ins, keybinds fora CLI-plugin, permission types novos.

## 5. Transporte/retries/WS
- Executor packages/ai/src/route/executor.ts; transporte packages/ai/src/route/transport/http.ts, websocket.ts, websocket-channel.ts (cap 16MiB/1009); pin sessao packages/core/src/session/model-transport.ts (ROTATE 55min, CONNECT 15s, IDLE 30min, MAX_STREAM_FAILURES 5, affinity url+sha256(headers)); so quando webSocket=session e transport=websocket.
- Retry packages/core/src/session/runner/retry.ts: recurs(10)+jitter, RETRY_AFTER_MAX 15min, MAX_TIMEOUT 3, attempt fisico 1=inicial; classificacao packages/ai/src/provider-error.ts isRetryable/classifyProviderFailure (+x-should-retry); teto e hard limit.

## 6. Smoke local
- Parent: build + node scripts/smoke-opencode.mjs PASS (proxy:2 upstream:2 exit 0); timeouts iniciais = missing child.stdin.end, nao plugin. Sem runtime neste doc.

## 7. Limitacoes
- v2 movel: citar blob/<SHA>. Data 2.0.24 nao observada (registry full >5MB; npmjs 403). Cauda pagina Promise truncada (~12k) — corroborada via Effect+migrate-v1. dev branch difere (V2-only). @opencode-ai/plugin/v2/* so staging.

## 8. Implicacao proxy codesocks
- Interceptar em http.request mutavel (clone antes de ler) + http.response (reconstruir Response); escopo providerID; cobrir WS via experimental.ws.* + fallback; respeitar recurs(10)/15min/3 timeouts e UnknownProvider retryable.
