# Contributing to codesocks

## Toolchain

- [Bun](https://bun.sh) `1.4.2` (pinned in CI; `bun.lock` is committed).
- Node.js `>= 24`, matching `engines.node` and the `@types/node` major line.
  Do not merge an `@types/node` major bump above the runtime floor without
  also raising `engines.node`.

## Checks

```bash
bun install
bun run check          # typecheck + build + full test suite
bun run smoke:opencode # real OpenCode CLI smoke (fake local origin + proxy)
bun audit --production # CI gates on high+; a new high/critical blocks the PR
```

CI (`.github/workflows/ci.yaml`) runs the same steps on Bun plus a
`node-consumer` job that installs the packed tarball and imports the plugin
exactly as a user would.

## Pull requests

- Keep PRs focused; one behavior per PR.
- New behavior needs tests; public API or `codesocks.jsonc` changes need
  `README.md` + `codesocks.schema.json` updates.
- Fill in `.github/pull_request_template.md`.
- **Never commit real proxy credentials, provider keys, or customer data.**
  Tests and reproductions use loopback fixtures and synthetic values only
  (`127.0.0.1`, `*.test` hostnames, placeholder secrets via `{env:NAME}`).
