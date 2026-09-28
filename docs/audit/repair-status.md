# Audit repair status

This change addresses the 31 findings in [the September 2026 audit](nox-adversarial-audit.md). The checks below are local evidence, not an authenticated Notion or Chrome release certification.

| Finding | Repair and local evidence |
|---|---|
| NOX-01 | Documented string `replace_content` arguments, classification, exact inverse serialization, and mixed-alias refusal; `writes/classify.test.ts`, `writes/gate.test.ts`. The legacy object form is exercised by local fixtures only. |
| NOX-02 | Unsupported tools and unadvertised writes stay out of the model tool surface; `capabilities.test.ts`, `agent/agent-modules.test.ts`. |
| NOX-03 | Persist accepted task IDs, resume polling without resubmission, and block conflicting work while submitted; `writes/gate.test.ts`, `history.test.ts`, `viewer.test.tsx`. |
| NOX-04 | Silent grant covers setting one checkbox to true in either known update-page command shape; string, number, false, and multi-property updates ask for consent; `writes/approvals.test.ts`. |
| NOX-05 | Native web results and external metadata taint the conversation before write consent; `codex/loop-integration.test.ts`. |
| NOX-06 | Every unplanned effect consumes the five-effect budget, including individually approved writes; `writes/gate.test.ts`. |
| NOX-07 | Workspace identity binds thread resume, conflicts, recovery, and undo; unresolved records survive ordinary chat deletion; `history.test.ts`, `viewer.test.tsx`, `writes/gate.test.ts`. |
| NOX-08 | Complete page baselines require matching identity and explicit completeness; partial, malformed, and rich content fail closed; `notion/page-content.test.ts`, `writes/classify.test.ts`. |
| NOX-09 | Linked undo needs a verified preimage and matching restoration readback; `writes/gate.test.ts`. |
| NOX-10 | Journal and activity separate provider application from readback verification; unverified changes have no Undo action; `activity-ui.test.tsx`, `viewer.test.tsx`, `writes/gate.test.ts`. |
| NOX-11 | Final content and authority check runs after scheduler admission and token acquisition, immediately before mutation fetch; `scheduler.test.ts`, `mcp-client.test.ts`, `writes/gate.test.ts`. Provider writes still lack compare-and-swap. |
| NOX-12 | Cancellation releases admitted scheduler permits; `scheduler.test.ts`. |
| NOX-13 | Concurrency waits honor deadline; OAuth metadata and token refresh bodies have bounded timeouts; `scheduler.test.ts`, `oauth-discovery.test.ts`, `token-store.test.ts`. |
| NOX-14–16 | Send reservation, mention scope, and next-draft handling; `viewer.test.tsx`. |
| NOX-17–19 | Active-page generation fence, single-flight IndexedDB open, and idempotent owner lease; `background-boundary.test.ts`, `history.test.ts`, `viewer.test.tsx`. |
| NOX-20 | Journal row changes use atomic IndexedDB read-modify-write with transition guards; `history.test.ts`. |
| NOX-21 | Production assembly carries tool call ID to journal and activity; `agent/panel-assembly.test.ts`. |
| NOX-22–24 | Login generation, OAuth metadata checks, and background RPC authorization; `token-store.test.ts`, `oauth-discovery.test.ts`, `background-boundary.test.ts`. |
| NOX-25 | Native bridge framing, process cleanup, and slow-reader handling; `node bridge/test-bridge.mjs`. |
| NOX-26 | Prefer tested Codex 0.153.4; other versions require explicit experimental opt-in; `bridge/test-bridge.mjs`, `codex/health.test.ts`. A public-only smoke passed on 0.157.1 but does not qualify it as tested. |
| NOX-27 | MCP protocol header, pagination, and session recovery; `mcp-client.test.ts`. |
| NOX-28 | Bounded workspace-keyed mention cache, incremental SSE matching, and measured history search; `mcp-client.test.ts`, `viewer.test.tsx`. IndexedDB search remains a linear scan because the measured 1,000-thread case stayed near 53 ms in fake IndexedDB. |
| NOX-29 | Diagnostic error details are private by default; `turn-trace.test.ts`. |
| NOX-30 | Production assembly regression plus built extension verification; `agent/panel-assembly.test.ts`, `pnpm build`. The built extension was not exercised against an authenticated Notion workspace in Chrome. |
| NOX-31 | Public links, architecture description, and this evidence ledger updated; repository Markdown-link check and `git diff --check`. |

Local verification for this change: `pnpm test`, `pnpm typecheck`, and `pnpm build` from `extension/`, plus `node bridge/test-bridge.mjs` from the repository root. Authenticated provider acceptance and full Chrome side-panel behavior still require release testing with a real account.
