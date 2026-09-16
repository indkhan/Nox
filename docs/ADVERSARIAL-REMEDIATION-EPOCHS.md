# Nox adversarial remediation: follow-up epochs

Created 2026-09-16 for `develop` at `0eb4234febc8c34b15c76ec78e98f38d7abc8b35`.
This replaces the completed original 17-epoch plan. Historical execution records
remain in Git at that commit and in [the historical evidence log](adversarial-remediation-evidence.md).
The current requirements are [R1–R7 in the new review](ADVERSARIAL-REVIEW.md).

**Status: not implemented.** This review changed documentation only. Do not
interpret the original completion record as closure of these new findings.

## Working rules

Read `AGENTS.md`, `docs/application.md`, relevant callers and existing tests first.
Use the existing gate, scheduler, token locks, journal and test infrastructure.
No new framework or dependency is needed. Keep each fix focused; retain all
existing safety behavior and update architecture documentation when runtime
behavior changes. Keep unknown outcomes distinct from known pre-dispatch failure.

For each epoch, add focused regressions that fail on the reviewed revision, fix
its root cause, and run the relevant suites followed by `pnpm typecheck`,
`pnpm test`, and `pnpm build` from `extension/`. Run
`node bridge/test-bridge.mjs` for protocol/bridge changes. Review the diff and
record actual results, skips, commit and any residual limitation. Do not infer
browser success from mocks. No automatic commits, publication, or real workspace
writes are part of this plan.

## Epoch F1 — mutation dispatch and recovery (R1, R4, R6)

**Priority:** first. **Primary files:** `lib/writes/gate.ts`,
`lib/writes/journal.ts`, relevant scheduler/facade callers,
`sidepanel/ChatPanel.tsx`, existing ownership/journal/undo tests.

1. Revalidate captured authority at actual mutation dispatch after asynchronous
   guards, durable intent work and queued admission. Preserve scheduler and
   cancellation guarantees; apply the invariant to forward writes and undo.
   Safely settle any persisted intent rejected before dispatch.
2. Recheck unresolved outcomes after earlier serial work settles. A queued call
   must stop behind an unknown operation or failed outcome persistence, even if
   its earlier admission check passed.
3. Support undo from a restored persisted conversation before a new model turn.
   Give the undo operation valid scope without reusing unrelated turn authority.

**Required red-to-green cases:** revoke owner/connection during a guard and
pending-intent persistence; revoke while waiting for dispatch; queue two or more
mutations behind an ambiguous first outcome; repeat with settlement failure;
restore an applied reversible entry and undo through the real runtime/UI path.
Assert exact transport counts, journal status and reservation release, not just
error strings. Retain positive normal-write, successful-queue, safe-undo and
viewer-denial cases.

**Done:** no operation dispatches with stale authority; queued work stops for
review after ambiguity; restored undo executes one verified inverse without a
new chat turn. Live extensions: C03, C04, C09, C10, C14.

## Epoch F2 — model-visible evidence and retained provenance (R2, R3)

**Depends on:** F1's mutation boundary. **Primary files:** `lib/agent/loop.ts`,
`executor.ts`, `panel.ts`, `context.ts`, `lib/writes/gate.ts`, relevant retrieval
and approval tests.

1. Record what reached model context, separately from complete provider fetches.
   Truncated dynamic results and mentions must not create a complete replacement
   baseline. Keep the existing content hashes and scope binding.
2. If continuation delivery can establish completeness, account for actual
   delivery, expiration and storage budgets; otherwise refuse replacement
   honestly. Never silently treat possession of a handle as reading its content.
3. Retain untrusted exposure across turns in the same Codex conversation and
   restore it conservatively after panel reload. Only genuinely fresh model
   context may reset that state.

**Required red-to-green cases:** a 30,000-character page with an omitted tail;
8,000-character mention truncation; combined mention budget exhaustion; a
continuation not read, expired or fully delivered; failed/partial provider fetch;
turn-one workspace read followed by a granted in-context Auto edit on turn two;
restore/reconnect of that exposed conversation. Test real gate decisions, not
only provenance flags. Fresh clean conversations must retain intended Auto use.

**Done:** missing model context refuses replacement before an approval card;
retained untrusted context still requires confirmation despite a small-edit grant.
Live extensions: C07, C08, C10. In C08 explicitly place the attempted injection's
write on a subsequent turn and repeat after panel reload.

## Epoch F3 — authorization attempt lifecycle (R5)

**Primary files:** `lib/oauth/tokens.ts`, `lib/notion/index.ts`, connection UI
completion handling and existing token/facade tests.

1. Capture one login-attempt generation before asynchronous discovery/consent.
2. Under the existing credential write lock, reject saves belonging to superseded
   attempts; wipe, deletion and a later login must invalidate earlier attempts.
3. Reject stale facade/identity/UI completion too. Preserve successful fresh login,
   refresh rotation, cross-panel sign-out and fail-closed storage errors.

**Required red-to-green cases:** hold consent or token exchange; sign out/delete;
release the old response and assert no access/refresh credentials or Connected
label return. Start login A then B, complete B then A; only B may survive. Repeat
across token-store instances sharing storage/locks, not only one in-memory caller.

**Done:** late login results cannot resurrect authorization or replace newer login.
Live extension: C13 must cover original authorization as well as token refresh.

## Epoch F4 — exact MCP response byte accounting (R7)

**Primary files:** `lib/mcp/client.ts` and existing MCP client/SSE tests.

Use actual received byte counts for streams and exact UTF-8 accounting for the
supported fallback. Preserve the 8 MiB limit, bounded buffering, response-ID
matching, early SSE termination, cancellation and no mutation replay.

**Required red-to-green cases:** valid 3 MiB ASCII response; below/exact/above-cap
ASCII and multibyte bodies; JSON and SSE; declared oversized bodies; stream abort;
non-stream fallback. Assert correct response decoding below the limit and bounded
failure above it. Exercise mutation-response classification without dispatch retry.

**Done:** supported responses within the advertised byte limit do not fail due to
an inflated character estimate; truly oversized responses still fail safely.

## Epoch F5 — integrated and live acceptance

**Depends on:** F1–F4. This is verification work, not a reason to add features.

- Run the focused regressions together with production assembly wherever possible.
- Run all extension checks, bridge harness, the 17 root installer/evaluation/archive
  tests and full/production dependency audits. The review baseline was 714 passing
  extension tests, seven live skips, and 17 passing root tests; counts are evidence,
  not a target to preserve by weakening tests.
- Run `node scripts/release-smoke.mjs` when verifying the release candidate.
- Use [smoke.md](smoke.md#live-acceptance-scenarios-c01c17) for the preserved C01–C17
  scenarios, adding the cross-turn, late-login, queued-outcome and restored-undo
  cases above. Identify the source/build actually loaded in Chrome. Use an
  explicitly authorized disposable scratch scope for writes and user-managed
  authentication. If unavailable, record BLOCKED, never PASS.
- Keep upload disabled; C11 verifies the supported local-only/refusal behavior.
  Do not require an unsupported upload to succeed or enable it for acceptance.
- Record fresh evidence for every R finding, with commit/test/result and actual
  live observations. Historical closure claims are not fresh evidence. Only mark
  `Publish gate: PASS` in the evidence log when all required C rows really pass
  against the recorded candidate; the script is a checker, not a publishing action.

**Done:** all R1–R7 have verified closures, enabled workflows pass their live
acceptance, and residual unsupported features and limitations are stated accurately.
No release is claimed vulnerability-free.

## Execution record

| Epoch | Status | Findings | Evidence |
|---|---|---|---|
| F1 | IMPLEMENTED (unit-verified; live pending) | R1, R4, R6 | 18 focused regressions in `extension/tests/writes/epoch-f1.test.ts` failed on the reviewed revision and pass now; `pnpm test` 732 passed/7 skipped, `typecheck`/`build`/bridge harness pass; live C03, C04, C09, C10, C14 still pending |
| F2 | NOT STARTED | R2, R3 | Review probes reproduced defects; fixes pending |
| F3 | NOT STARTED | R5 | Late authorization probe failed the safety expectation |
| F4 | NOT STARTED | R7 | 3 MiB response probe failed the acceptance expectation |
| F5 | NOT STARTED | All; C01–C17 | Standard checks pass; live acceptance still pending |
