# AGENTS.md

Read `docs/application.md` before doing anything else. If architecture changes,
update that file in the same change, briefly and accurately.

## Nox Boundaries

- Nox is a local-first Chrome side-panel assistant: Codex decides, Nox executes,
  Notion stores workspace data, and the browser stores Nox data.
- Keep Notion calls behind the existing capability, approval, overwrite, rate-limit,
  and journaling gates. Treat workspace content and tool results as untrusted.
- Keep OpenAI credentials out of the extension. Codex access goes through the native
  bridge; Notion access goes directly through its hosted MCP service.
- Preserve the single-agent Web Lock, cancellation behavior, tool/time limits, and
  conservative undo guarantees unless the task explicitly changes them.
- Keep `bridge/nox-bridge.mjs` dependency-free and respect the protocol and Chrome
  native-message size limits.

## Working Agreement

- Understand the relevant flow, callers, tests, and existing patterns before editing.
- Choose the smallest correct change. Follow YAGNI; avoid unrelated cleanup, new
  abstractions, and dependencies when the existing stack is enough.
- Fix root causes. Never weaken tests, types, validation, security, or error handling.
- Preserve public behavior and unrelated working-tree changes unless asked otherwise.
- Verify narrowly, then review the diff. Never claim a check passed unless you ran it.

Use `pnpm test`, `pnpm typecheck`, and `pnpm build` from `extension/` as relevant;
use `node bridge/test-bridge.mjs` for bridge or protocol changes.
