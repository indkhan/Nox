> **Superseded assessment — 2026-09-16:** This file preserves historical Epoch 17
> evidence. The new [adversarial review](ADVERSARIAL-REVIEW.md) confirms seven
> remaining defects (R1–R7); its findings override the older “no new release
> blocker” and complete-closure statements below. The current work plan is
> [follow-up epochs F1–F5](ADVERSARIAL-REMEDIATION-EPOCHS.md). Original epoch
> execution records are in Git at `0eb4234`. C01–C17 remain BLOCKED; their full
> steps are preserved in [smoke.md](smoke.md#live-acceptance-scenarios-c01c17).
> Do not reuse the historical closure claims as current acceptance evidence.

# Nox adversarial remediation: evidence log (Epoch 17)

This is the sanitized results record required by Epoch 17. It maps every
review finding to deterministic evidence or an explicit unsupported-feature
disposition, and records live acceptance separately. All fixtures below are
synthetic (redacted shapes, sentinel URLs, generated UUIDs). No tokens,
OAuth callbacks, upload tickets, personal page contents, or HAR files are
stored here. Skipped opt-in cases are pending, never passed.

## 1. Candidate identity

- Source: `develop` at `486f04d` (`test: enforce integrated adversarial acceptance`) plus this documentation commit.
- Extension version: `0.1.0` (single source `extension/package.json`, display `v0.1.0-alpha`).
- Toolchain: Node `v22.23.2`, pnpm `11.10.0`, vitest `4.1.11`, vite `6.4.3`.
- Reference Codex: `0.153.4` (tested-compatible label; newer versions run with an unverified warning).
- Build identity for any live run must be the source commit hash matched to the loaded extension (a version label alone is insufficient). No live run is recorded here, so no loaded-extension match exists yet.

## 2. High-finding regression map (deterministic)

Each row failed for the reviewed behavior in its original epoch (see the
execution record in `ADVERSARIAL-REMEDIATION-EPOCHS.md` for the observed red
runs) and passes now. The Epoch 17 integrated suite re-proves them together
over production assembly (real `PlanEngine`, `ApprovalEngine`, `WriteGate`,
`MutationJournal`, `Scheduler`, `ToolExecutor`).

| Finding | Integrated cover (`tests/adversarial-acceptance.test.ts`) | Original suites |
|---|---|---|
| H1 — passive image egress | image-to-link with sentinel URL; raw `img/picture/source/video` sinks removed, ordinary links clickable | `tests/markdown.test.ts`, `tests/activity-ui.test.tsx`, `tests/setup-screen.test.tsx` |
| H2 — plan self-authorization | exact-effect approval consumed once; deviation/reuse/stale-scope refused; omitted target invalid; plan-covered gate run without redundant card, repeat refused | `tests/architect/plan-engine.test.ts`, `tests/agent/agent-modules.test.ts` (ten exact ops, deviation), `tests/writes/gate.test.ts` (structural block, stale reservation) |
| H3 — truncated consent | frozen-snapshot dispatch after live-object mutation; full payload past 2,000 chars; stale/double answer false; reserved/unknown/oversize refused pre-card | `tests/writes/approvals.test.ts`, `tests/approval-ui.test.tsx`, `tests/writes/gate.test.ts` (frozen dispatch, oversize, canonical journal) |
| H4 — viewer/undo races | viewer write/undo zero transport; undo refused while turn active; turn work refused while undo holds the runner | `tests/writes/ownership.test.ts` (viewer zero, lease expiry, double undo once), `tests/viewer.test.tsx` |
| H5 — mutation replay | non-retryable commit-then-503 yields `UncertainDispatchError` with exactly one dispatch; gate settles `unknown` with one journal row, no retry | `tests/scheduler.test.ts`, `tests/notion-facade.test.ts` (429-after-effect, deadline), `tests/mcp-client.test.ts`, `tests/writes/gate.test.ts` (unknown vs failed) |

Pre-fix failure for the integrated file itself was observed once during
development (a Markdown link assertion failed because the link followed raw
HTML blocks without a blank line; the fixture was corrected, not the
implementation). The H-level red runs are the per-epoch observations cited
above; the integrated file was not backported to the reviewed revision
because its fixtures depend on post-remediation APIs (ownership-scoped
`WriteGate`, scoped `PlanEngine`, frozen `ApprovalDecision`), which do not
exist there.

## 3. Consent matrix (deterministic re-run, production entry points)

- Reads (`notion-fetch`) pass with zero plan/approval cards and zero journal rows.
- One small Ask edit presents one card with the complete bounded payload; rejection writes nothing.
- Auto without the grant requests ordinary consent; granted in-context small edits skip the redundant card; out-of-context targets still require a card even with the grant.
- Untrusted-context edits stay on the card path even with the grant.
- Direct bypass attempts fail closed with zero transport: unknown tools, the raw `notion-create-file-upload` / `nox-upload-local-file` routes, reserved `__nox_expected_hash` fields, stale approval ids, and plan-gated local tools through `ToolExecutor` (`TOOL_UNAVAILABLE`).
- One approved structural plan covers its exact operation once with no redundant card; repeats and deviations return `PLAN_MISMATCH`/`PLAN_REQUIRED` with no dispatch.

## 4. Strong-behavior locks

Sampled directly in the integrated suite: 12-call ceiling with no extra
dispatch; continuation handles expire on the next turn. The remainder is
covered by existing suites, all green in the final run: failed resume never
substitutes a new thread, no replay after submission/disconnect, early
events correlate, completed answers replace streamed text, only reasoning
summaries render, late dynamic calls stop, ten-minute deadline includes
context preparation (`tests/codex/loop-integration.test.ts`,
`tests/codex/client.test.ts`, `tests/agent/agent-modules.test.ts`,
scheduler/facade deadline tests).

## 5. Final automated suite (this candidate)

- `pnpm typecheck` (extension): PASS.
- `pnpm test` (extension): **714 passed, 7 opt-in live skipped** (45 files passed, 2 skipped). Prior baseline was 694 passed; the +20 are the integrated suite.
- `pnpm build` (extension): PASS (vite 6.4.3 production bundle).
- `node bridge/test-bridge.mjs`: all bridge checks passed (tool round trip, chunking, Unicode splits, overlong/EOF handling, crash budget).
- `node --test scripts/install.test.mjs scripts/live/answer-quality-eval.test.mjs scripts/package-release.test.mjs`: **17 passed**.
- `pnpm audit --json` (full) and `pnpm audit --prod --json`: **0 advisories** in both.
- `git diff --check`: PASS.
- `node scripts/release-smoke.mjs` now runs all of the above (typecheck, tests, build, ledger, installer, archive-content, bridge, archives, both audits) and reports automated success separately from live acceptance. `--publish-gate` / `--require-live-evidence` rejects unless every C01–C17 row below reads PASS plus an explicit marker (currently BLOCKED, so the gate refuses).

## 6. Live acceptance C01–C17 (scratch workspace, loaded candidate)

Status: **all BLOCKED** — no disposable Chrome/Codex/Notion session or
authorized scratch scope exists in this environment. Nothing below is
counted as passed. Computer Use cannot be used to automate OAuth dialogs;
workspace writes need an explicitly designated scratch parent first.

| ID | Live result | Note |
|---|---|---|
| C01 | BLOCKED | Needs loaded extension + controlled receiver/network instrumentation |
| C02 | BLOCKED | Needs supported Codex/Notion session; deterministic config cover only |
| C03 | BLOCKED | Needs two-window live Chrome; deterministic ownership cover only |
| C04 | BLOCKED | Needs controlled transport fixture in live Chrome; deterministic fault-injection cover only |
| C05 | BLOCKED | Needs loaded extension + scratch scope; deterministic frozen-payload cover only |
| C06 | BLOCKED | Needs scratch workspace + supported model; deterministic consent-matrix cover only |
| C07 | BLOCKED | Needs scratch workspace; deterministic plan-scope cover only |
| C08 | BLOCKED | Needs supported model + malicious synthetic page; deterministic grant/injection cover only |
| C09 | BLOCKED | Needs live turn + fixtures; deterministic cancel/outcome cover only |
| C10 | BLOCKED | Needs scratch pages + independent edits; deterministic baseline/undo cover only |
| C11 | BLOCKED | Upload is explicitly unsupported; consent-matrix refusal is deterministic only |
| C12 | BLOCKED | Needs live panels; deterministic history/attachment cover only |
| C13 | BLOCKED | Needs two live panels; deterministic sign-out/deletion cover only |
| C14 | BLOCKED | Needs real bridge disconnect; deterministic reconnect cover only |
| C15 | BLOCKED | Needs supported-Chrome instrumentation; deterministic DNR/message cover only |
| C16 | BLOCKED | Needs loaded extension layout/keyboard review; deterministic log-export cover only |
| C17 | BLOCKED | Needs disposable install/profile with user-managed auth; deterministic archive cover only |

Layout review (320/400/600 px, light/dark, keyboard-only, long answer/plan)
is part of C05/C16 and is likewise BLOCKED pending a loaded candidate.

## 7. Fresh adversarial pass (Epoch 17.3, static + deterministic)

Probed through actual entry points (`WriteGate.handle`/`handleUndo`,
`PlanEngine.request`/`authorize`/`consume`, `ApprovalEngine.request`/`answer`,
`Scheduler.schedule`, `ToolExecutor.execute`, `renderMarkdown`,
`validateEffect`): payload mutation after consent, stale/double approvals,
reused/consumed reservations, scope changes (workspace, connection, thread,
turn), viewer/owner transitions, turn/undo interlocks, unknown tools,
reserved fields, raw ticket routes, commit-then-failure crashes, and the new
`checkPublishGate` marker parsing (fail-closed: any non-PASS row or missing
file blocks publishing; the marker cannot be set by model input since it
lives in a committed doc).

Result: **no new release blocker found**. The integrated suite locks each
probe above. Known residual limits stay as documented (external-editor race
without provider conditional writes; observed native-search boundary;
model-semantic limits) rather than being relabeled to close live items.

## 8. Finding closures

- H1: closed deterministically (01 + integrated); live C01 pending.
- H2: closed deterministically (06 + integrated); live C06–C08 pending.
- H3: closed deterministically (05 + integrated); live C05 pending.
- H4: closed deterministically (02 + 04 + integrated); live C03 pending.
- H5: closed deterministically (03 + 04 + integrated); live C04/C09 pending.
- M1, M2, M14: closed deterministically (05 + 06 + integrated); live C06–C08 pending.
- M3: closed deterministically (07 + integrated); live C09–C10 pending. Residual: final external-editor race, no provider conditional writes.
- M4: closed deterministically (04 + integrated); live C04/C09 pending.
- M5: **explicitly unsupported** — upload into Notion stays disabled (08 + integrated refusal matrix); files are local-only. No live ticket fixture exists, so C11 upload has no pass path by design.
- M6: closed deterministically (03 + integrated scheduler/ToolExecutor bounds).
- M7: closed deterministically (10 + integrated); live C11–C12 pending.
- M8: closed deterministically (11 + integrated ownership); live C02/C13/C14 pending.
- M9, M16: closed deterministically (09 + integrated); live C12–C13 pending.
- M10: closed deterministically (01 + integrated); live C02 pending.
- M11, M12: closed deterministically (12 + bridge harness + integrated H5/scheduler bounds); live behavior pending real traffic.
- M13: closed deterministically (13 + integrated DNR/message suites); live C15 pending per Chrome family/version.
- M15: closed deterministically (15 + archive-content tests in the smoke gate).
- L1: closed (vitest 4.1.11; both audits 0 advisories in this run).
- L2: closed deterministically (14 + integrated); live C16 pending.
- L3: closed deterministically (13); live C15 pending.
- L4, L5: closed deterministically (15; installer fixture assertions, CI `release-tools` job).
- L6: closed deterministically (11); live C14 pending.
- D1, D2: closed as docs (16); public claims link this log instead of old passing counts.
- D3: closed as process (17): integrated suite, extended `release-smoke.mjs` with a publishing gate, and this log. Live C01–C17 remain pending by design, not by omission.

## 9. Residual limitations and release stance

- Upload into Notion is unavailable by design; PDF/image analysis, bulk autofill, quota estimates, and generalized undo (creation/property/schema/view/move, rich pages) do not exist and are not claimed.
- An external edit between the final guard read and the provider write cannot be excluded (no provider conditional writes).
- Observed native search may exceed the 12-item boundary in flight; no model promises semantic obedience; per-model isolation matrices need live runs.
- macOS, non-Chrome Chromium, and Codex versions newer than 0.153.4 are unverified.
- Local Delete all data removes local Nox data only, not remote Notion effects or Codex history.
- **No release is certified vulnerability-free and no live check is counted as passed.** Publishing a release advertising live-verified behavior is blocked until C01–C17 pass against a recorded candidate build: `node scripts/release-smoke.mjs --publish-gate` enforces this.

## 10. Follow-up epochs F1–F5 fresh evidence (2026-09-17)

This section is the F5 deterministic closure for R1–R7. It does not replace
the historical Epoch 17 record above and does not claim live acceptance.
Live C01–C17 below are BLOCKED in this environment: no disposable
Chrome/Codex/Notion session or authorized scratch scope exists here.
BLOCKED is honesty, never PASS. Upload stays disabled by design.

### 10.1 Candidate identity

- Source: `develop` at `e9dda40` (F5.1 integrated suite + F5.2 publish-gate
  lock on top of F1–F4) plus this documentation commit.
- Extension version: `0.1.0` (single source `extension/package.json`,
  display `v0.1.0-alpha`).
- Toolchain: Node `v22.23.2`, pnpm `11.10.0`, vitest `4.1.11`, vite `6.4.3`.
- Reference Codex: `0.153.4`.
- F5 code commits: `a7c4f19` (F5.1 integrated R1–R7 suite),
  `e9dda40` (F5.2 publish-gate fail-closed lock).

### 10.2 Automated results (this candidate, observed)

- `pnpm typecheck` (extension): PASS.
- `pnpm test` (extension): **785 passed, 7 opt-in live skipped**
  (50 files passed, 2 skipped). Baseline at F4 was 774 passed; the +11 are
  the F5 integrated suite.
- `pnpm build` (extension): PASS (via `node scripts/release-smoke.mjs`).
- `node bridge/test-bridge.mjs`: all bridge checks passed.
- `node --test scripts/install.test.mjs scripts/live/answer-quality-eval.test.mjs scripts/package-release.test.mjs scripts/publish-gate.test.mjs`: **23 passed**
  (prior baseline 17; the +6 are the F5 publish-gate lock).
- `pnpm audit --json` (full) and `pnpm audit --prod --json`: **0 advisories** in both.
- `node scripts/release-smoke.mjs`: automated checks PASS
  (typecheck, tests, build, ledger, installer, archive-content, bridge,
  archives, both audits).
- `node scripts/release-smoke.mjs --publish-gate`: automated PASS, then
  **Publish gate: BLOCKED** — missing required live evidence for
  C01–C17. The gate refuses as designed; automated success alone never
  publishes live-verified behavior.
- `git diff --check`: PASS.

### 10.3 R1–R7 deterministic closures (production assembly)

Each row passes now in `extension/tests/writes/epoch-f5.test.ts` (11 tests)
over real `WriteGate`, `MutationJournal`, `ToolExecutor`, `AgentLoop`,
`TokenStore`, and `McpClient` with transports faked only at the boundary.
Exact transport counts, journal states, and approval behavior are asserted.
Focused F1–F4 suites remain green alongside.

| Finding | F5 integrated cover | Original F-epoch cover |
|---|---|---|
| R1 — authority revalidation at dispatch | revoked owner during intent persistence settles `failed` with zero transport and one journal row | F1.1–F1.2 in `epoch-f1.test.ts` |
| R4 — queued work stops behind ambiguity | second mutation stops with exactly one transport, `CONFLICT_UNRESOLVED`, one `unknown` row until review | F1.3 in `epoch-f1.test.ts` |
| R6 — restored undo without a new turn | restored `scopeThread` panel undoes one verified inverse via `requestRuntimeUndo` before any new chat turn; entry becomes `undone` | F1.4 in `epoch-f1.test.ts` |
| R2 — truncated model reads refuse replacement | 30k-char fetch truncated before Codex refuses `replace_content` with `PARTIAL_BASELINE` pre-card and zero dispatch; fully delivered continuation restores completeness and reaches approval | F2.1–F2.3 in `epoch-f2.test.ts` |
| R3 — retained untrusted exposure | turn-two keeps `untrusted-context` provenance, reload restores conservatively, fresh chats stay clean; granted turn-two small edit still requires one confirmation | F2.4 in `epoch-f2.test.ts` |
| R5 — stale login never resurrects | late save after wipe throws `STALE_LOGIN_ATTEMPT` with zero credentials; older login cannot replace newer login | F1–F3 in `epoch-f3.test.ts` |
| R7 — MCP byte budget | 3 MiB ASCII JSON resolves; truly oversized body fails `MCP_OVERSIZE` bounded | F4.1–F4.3 in `mcp-epoch-f4.test.ts` |
| Upload-disabled + clean Auto | raw `notion-create-file-upload` / `nox-upload-local-file` refuse with zero transport; fresh granted in-context Auto small edit still runs silently | F5 integrated + `scripts/publish-gate.test.mjs` honesty lock |

### 10.4 Live acceptance C01–C17 (scratch workspace, loaded candidate)

Status: **all BLOCKED** — same reason as the historical table above. No
scratch parent, disposable profile, or user-managed auth exists in this
environment. Nothing below is counted as passed. The F5 additions
(cross-turn injection on a subsequent turn plus reload, late-login
original-authorization as well as refresh, queued-outcome stop, restored
undo) are covered deterministically above and remain to be witnessed live
under `docs/smoke.md` when a scratch scope is authorized.

| ID | Live result | Note |
|---|---|---|
| C01 | BLOCKED | Needs loaded extension + controlled receiver/network instrumentation |
| C02 | BLOCKED | Needs supported Codex/Notion session; deterministic config cover only |
| C03 | BLOCKED | Needs two-window live Chrome; deterministic ownership cover only |
| C04 | BLOCKED | Needs controlled transport fixture in live Chrome; deterministic fault-injection cover only |
| C05 | BLOCKED | Needs loaded extension + scratch scope; deterministic frozen-payload cover only |
| C06 | BLOCKED | Needs scratch workspace + supported model; deterministic consent-matrix cover only |
| C07 | BLOCKED | Needs scratch workspace; deterministic plan-scope cover only |
| C08 | BLOCKED | Needs supported model + malicious synthetic page; deterministic grant/injection cover only, including subsequent-turn and reload cases |
| C09 | BLOCKED | Needs live turn + fixtures; deterministic cancel/outcome cover only |
| C10 | BLOCKED | Needs scratch pages + independent edits; deterministic baseline/undo cover only, including restored-undo case |
| C11 | BLOCKED | Upload is explicitly unsupported; consent-matrix refusal is deterministic only |
| C12 | BLOCKED | Needs live panels; deterministic history/attachment cover only |
| C13 | BLOCKED | Needs two live panels; deterministic sign-out/deletion cover only, including original-authorization late-login case |
| C14 | BLOCKED | Needs real bridge disconnect; deterministic reconnect cover only |
| C15 | BLOCKED | Needs supported-Chrome instrumentation; deterministic DNR/message cover only |
| C16 | BLOCKED | Needs loaded extension layout/keyboard review; deterministic log-export cover only |
| C17 | BLOCKED | Needs disposable install/profile with user-managed auth; deterministic archive cover only |

Publish gate: BLOCKED — live C01–C17 have no PASS rows in this environment.
Do not mark `Publish gate: PASS` until every required C row really passes
against a recorded candidate build. No release is claimed
vulnerability-free.
