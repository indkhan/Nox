# Contributing to Nox

Pre-alpha — the codebase is moving fast on `develop`; `main` is stable.

## Development setup

```bash
# prerequisites: Node 22+, pnpm 10+
cd extension
pnpm install
pnpm dev            # vite build with hot reload → load extension/dist unpacked
pnpm typecheck      # tsc --noEmit
pnpm test           # vitest unit suite (NOX_LIVE=1 adds live Notion probes)
pnpm build          # production bundle into dist/

# bridge (repo root)
node bridge/test-bridge.mjs     # deterministic integration vs fixtures/fake-codex
```

For a complete local install, run `node install.mjs` from the repository root,
then follow its **Load unpacked** prompt and restart Chrome.

## Ground rules

- **Every commit** passes typecheck, tests, and build. Commit subjects follow
  `E<epic>.<n>: <summary>` for epic work.
- Modules under `src/lib/` never touch `chrome.*` directly — side effects are
  injected so vitest can drive everything without Chrome.
- Discover, don't hardcode: tool schemas from `tools/list`, capabilities from
  `notion-fetch self`, models from `model/list`.
- Every mutation path goes through `src/lib/writes/gate.ts` (approval + guard +
  journal). No exceptions.
- Tool output is untrusted: it must pass through `wrapUntrusted()` before the
  model sees it.
- New dependencies need a reason in the PR; prefer platform features.

## Testing expectations

- Pure logic gets table-driven vitest coverage, including failure paths.
- Bridge changes must keep `bridge/test-bridge.mjs` green (fake codex, no quota).
- Live verification against production Notion/Codex is opt-in (`NOX_LIVE=1`,
  `scripts/live/*`) and read-only unless the issue explicitly calls for writes.

## Docs

Architecture decisions live in `docs/plans/E<n>.md`; verified facts in
`RESEARCH.md`. Update both when you change what was decided or learned.
