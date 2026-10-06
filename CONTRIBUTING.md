# Contribute to CodeSocks

Keep the change focused. Give me enough context to reproduce it on my own box.

## Toolchain

- [Bun](https://bun.sh) `1.4.2` (pinned in CI; `bun.lock` is committed).
- Node.js `>= 24`, matching `engines.node` and the `@types/node` major line.
  Do not merge an `@types/node` major bump above the runtime floor without
  also raising `engines.node`.

## Checks

```bash
bun install
bun run lint           # Markdown structure in root docs, docs/, and .github/
bun run check          # typecheck + build + full test suite
bun run smoke:opencode # real OpenCode CLI smoke (fake local origin + proxy)
bun audit              # CI blocks on any reported vulnerability
```

CI (`.github/workflows/ci.yaml`) builds, typechecks, runs tests with coverage,
and audits all dependencies. The `node-consumer` job installs the packed
tarball and imports the plugin. Run the CLI smoke locally; CI doesn't run it.

## Pull requests

- Keep one behavior per PR.
- Add tests for new behavior. Update `README.md` and `codesocks.schema.json`
  when you change the public API or `codesocks.jsonc`.
- Fill in `.github/pull_request_template.md`. State what you ran and what failed.
- **Never commit real proxy credentials, provider keys, or customer data.**
  Tests and reproductions use loopback fixtures and synthetic values only
  (`127.0.0.1`, `*.test` hostnames, placeholder secrets via `{env:NAME}`).
