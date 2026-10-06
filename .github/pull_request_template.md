## Summary

<!-- Tell me what changed and why. Link related issues. -->

## Verification

- [ ] `bun run lint` passes

<!-- Check only what you verified. Note failed or skipped checks below. -->

- [ ] `bun run build` passes
- [ ] `bun run typecheck` passes
- [ ] `bun test tests` passes (with coverage when touching runtime code)
- [ ] `bun run smoke:opencode` passes (when touching the relay, agents, or plugin wiring)
- [ ] New behavior is covered by tests

## Review notes

- [ ] Public API or `codesocks.jsonc` changes are reflected in `README.md` and `codesocks.schema.json`
- [ ] No real proxy credentials, tokens, customer data, or provider keys are included
- [ ] Changes to egress, allow-lists, or failure modes include threat-model notes
