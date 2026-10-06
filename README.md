# CodeSocks — proxy interceptador para OpenCode V2

[![CI](https://github.com/Hallaxius/codesocks/actions/workflows/ci.yaml/badge.svg)](https://github.com/Hallaxius/codesocks/actions/workflows/ci.yaml)
[![npm version](https://img.shields.io/npm/v/@hallaxius/codesocks.svg)](https://www.npmjs.com/package/@hallaxius/codesocks)
[![license: Apache-2.0](https://img.shields.io/badge/License-Apache--2.0-yellow.svg)](./LICENSE)
[![Node.js >= 24](https://img.shields.io/badge/node-%3E%3D24-brightgreen.svg)](https://nodejs.org)

Mantido por [Hallaxius](https://github.com/Hallaxius).

Plugin nativo OpenCode V2 (`@opencode/plugin` 2.x) que envia o tráfego HTTP de provedores selecionados por um proxy HTTP/HTTPS/SOCKS explícito, preservando `baseURL`, corpo, credenciais e streaming (SSE).

Fluxo: `prompt → hook http.request do provedor → relay local 127.0.0.1 → proxy configurado → baseURL original`.

> Não elimina rate limit do provedor. O que o plugin faz é trocar o IP de origem e aplicar ritmo/fila por provedor (`maxConcurrent`, `minIntervalMs`, backoff em `429` com `Retry-After`). Limites da conta/plano continuam valendo.

## Compatibilidade

- OpenCode V2 (`>=2.0.15 <3`), testado contra CLI `2.0.15` e repositório `anomalyco/opencode` branch `v2` (SHA `6bffe79` em `docs/opencode-analysis.md`).
- Entrada estável para diretório local: `server.js` reexporta `dist/index.js` (o loader V2 exige diretório, não arquivo).
- `Plugin.define({ id: "codesocks" })`, `ctx.provider.transform` força `settings.transport = "http"` nos provedores selecionados, `ctx.session.hook("http.request", …, { providerID })` reescreve, `experimental.ws.handshake` falha fechado (WebSocket não passa pelo relay).

## Instalação

```bash
bun install
bun run build
```

No `opencode.jsonc` do projeto (ou global), registre o diretório do pacote:

```jsonc
{
  "plugins": [{ "package": "file:///caminho/para/codesocks" }]
}
```

## Configuração — `codesocks.jsonc`

Fica ao lado do `opencode.jsonc`/`opencode.json` (direto ou dentro de `.opencode/`) para facilitar manutenção. Precedência determinística, sem merge:

1. `configPath` da opção do plugin (relativo a `ctx.location.directory`) — deve existir.
2. `$CODESOCKS_CONFIG` — deve existir.
3. Sibling mais próximo subindo de `directory` até a raiz: `codesocks.jsonc` ao lado de `opencode.json/jsonc`, direto ou em `.opencode/`.
4. Global: `dirname($OPENCODE_CONFIG)` / `$OPENCODE_CONFIG_DIR` / `$XDG_CONFIG_HOME/opencode` / `<home>/.config/opencode`.
5. Ausente → plugin desativado (mapas vazios), sem erro.

Exemplo mínimo (`examples/codesocks.example.jsonc`):

```jsonc
{
  "$schema": "../codesocks.schema.json",
  "enabled": false, // troque para true após configurar um proxy real
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

Regras (falha fechada, sem vazar URL nos erros):

- `proxies`: esquemas `http`, `https`, `socks4`, `socks4a`, `socks5`, `socks5h`; sem caminho/query/fragmento/PAC. Segredos só via `{env:NOME}` em URLs de proxy; variável ausente/vazia = erro.
- `providers.<id>`: `proxy` deve existir em `proxies` (comparação por chave própria), `allowedOrigins` não vazio, origens `http(s)` exatas normalizadas para `origin` (caixa/porta-padrão/barra normalizadas), sem credenciais/caminho.
- Campos desconhecidos, `__proto__`, JSONC inválido ou arquivo selecionado ilegível = `ConfigError`.
- Chave `__proto__` é rejeitada na varredura do texto antes do parse; mapas internos usam protótipo nulo.

## Segurança do relay

- Relay HTTP só em `127.0.0.1`, porta efêmera; reescrita por ticket aleatório de 32 bytes, uso único, expiração 60 s, limite 1024 pendentes, método conferido; ticket inválido/reutilizado = `403`.
- Só origens de `allowedOrigins`; origem não aprovada = erro antes de qualquer rede (credenciais nunca saem para destino errado).
- Upstream `3xx` é bloqueado com `502` genérico (nunca segue redirect fora do proxy); `429` aplica `cooldown` por `Retry-After` (segundos/data, padrão 1 s, nunca encurta espera existente).
- Cabeçalhos hop-by-hop e `proxy-*` removidos; status/corpo/SSE preservados; abort/timeout cancelam socket upstream; agentes explícitos (`http-proxy-agent`/`https-proxy-agent`/`socks-proxy-agent`) sem `HTTP_PROXY/HTTPS_PROXY/NO_PROXY`.
- `socks5h` resolve DNS no proxy (ATYP domínio); TLS verificado de ponta a ponta, sem desabilitar verificação.

## Verificação

```bash
bun run check          # typecheck + build + 37 testes (bun test tests)
bun run smoke:opencode # sobe origem SSE + proxy fakes locais e roda `opencode run --standalone` isolado
bun audit --production # 1 moderado transitivo conhecido: @opentelemetry/core 2.6.1 via @opencode/plugin (fora do range corrigível)
npm pack --dry-run     # tarball: dist + server.js + LICENSE + schema + examples + README
```

Smoke esperado: `{"result":"PASS","proxyHits":2,"upstreamHits":2,"marker":"CODESOCKS_SMOKE_OK"}`.

## Limites honestos

- WebSocket dos provedores selecionados é recusado (use HTTP). `ctx.generate.text` fora de sessão não passa pelos hooks de sessão.
- Fila limitada a 256 por provedor; `503` com fila indisponível, `502` genérico em falha de transporte.
- Auditoria atual: resta 1 vulnerabilidade moderada transitiva do SDK (`@opentelemetry/core 2.6.1`, `bun audit fix` bloqueado pelo range do dependente). Sem dependência alta direta após troca do `proxy-agent` guarda-chuva por agentes explícitos.
