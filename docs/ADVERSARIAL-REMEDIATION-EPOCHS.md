# Nox adversarial remediation: implementation epochs

Prepared 2026-09-11 against `5e49201e7a53e87de63518d4c3a3388e769d0370`.
Source: [ADVERSARIAL-REVIEW.md](ADVERSARIAL-REVIEW.md), including its browser follow-up and coherent approval policy.
Architecture reference: [application.md](application.md).

**This is an implementation specification, not a report of completed fixes. All epochs and live checks start pending.** The source review is historical evidence; preserve it. This file intentionally specifies future behavior that differs from the current architecture document. Update that document as implementation lands, never ahead of the code.

Navigation: [execution contract](#1-instructions-for-the-implementing-model) · [coverage](#2-wave-map-and-finding-coverage) · [shared decisions](#3-shared-implementation-decisions) · [Wave A](#4-wave-a--stop-unsafe-effects) · [Wave B](#5-wave-b--make-consent-precise-and-usable) · [Wave C](#6-wave-c--make-recovery-and-deletion-reliable) · [Wave D](#7-wave-d--harden-boundaries) · [Wave E](#8-wave-e--demonstrate-and-distribute-honestly) · [browser scripts](#11-computer-use-acceptance-script) · [execution record](#12-execution-record-and-definition-of-done).

The target is a smooth, defensible alpha: comprehensible consent, bounded execution, honest recovery, reliable local data handling, and reproducible evidence. No finite plan can guarantee that future adversarial review finds zero defects. Completion means every finding below has evidence of resolution or an explicitly unsupported feature, no known unresolved release blocker, and a fresh review of the final implementation.

## 1. Instructions for the implementing model

1. Read the repository's current `AGENTS.md`, `docs/application.md`, this file's execution contract, and the complete next epoch before editing. Follow any newer user instructions.
2. Check `git status --short` and `git rev-parse HEAD`. Preserve unrelated edits. At plan-writing time the source review was untracked; do not delete or overwrite it. If symbols moved, find their callers with `rg` and adapt paths; do not recreate old implementations.
3. Implement epochs in numeric order. Each wave has a gate; do not claim the wave complete while its required checks are pending. A blocked live check does not prevent independent local work on later epochs, but it does block release sign-off for the affected feature.
4. Each numbered commit below is a cohesive change boundary and suggested subject, not permission to push, publish, or touch valuable workspace data. Add the regression and fix together in a green commit; observe the regression fail before the fix while working. Split a commit further if necessary, preserving the epoch's invariant.
5. Reuse React, Zustand, `idb`, DOMPurify, Vitest, fake-indexeddb, and the existing fake-Codex harness. Keep the bridge dependency-free. No new policy framework, backend, worker architecture, queue library, or browser-testing framework is required.
6. Tests must exercise observable effects: transport call count and payload, persisted records, state transitions, rendered controls, and outbound requests. Safety words in prompts, mocked always-allow authorizers, and TypeScript casts do not prove a boundary.
7. Mock external transports, clocks, and browser APIs at test boundaries; retain real `PlanEngine`, `ApprovalEngine`, `WriteGate`, `ToolExecutor`, journal, and production wiring in cross-component regressions. Reuse current fixtures. A narrowly extracted assembly helper is acceptable only if it is also used by production.
8. Keep existing cancellation, original Codex thread resume, event correlation, Web Lock ownership, 12 dynamic calls, observed native-research limit, ten-minute deadline, and conservative undo. Do not raise these limits to make a demo pass.
9. When a provider contract is unknown, obtain a redacted real fixture and authoritative contract reference, or disable that effect with an actionable reason. Never guess upload origins, mutation schemas, response completeness, idempotency, or native-tool isolation.
10. Update `docs/application.md` in every commit that changes runtime flows, trust boundaries, or persistence. Keep small local details out of the architecture reference. Update public claims when the corresponding behavior changes.
11. Run the epoch's narrow regressions first, then its final checks, then inspect `git diff --check` and the complete diff. Do not silently remove or weaken old tests that fail: replace assertions endorsing reviewed vulnerabilities with stronger behavior tests and explain the changed contract.
12. Append a short execution record in section 12 after each epoch: commit IDs, commands and results, live evidence IDs, remaining blockers, and next epoch. A successor model must be able to resume without reading the conversation.

### Progressive implementation boundaries

Earlier epochs sometimes introduce a minimum primitive that later epochs strengthen. Implement that minimum at its first required use; never install a permissive placeholder just to satisfy a type. In epoch 04, capture immutable JSON arguments and runtime scope for the ledger; epoch 05 adds shared validated effect adapters and full consent UI. In epoch 05, record successful retrieval IDs for evidence; epoch 07 adds provider-specific completeness and baseline attribution. In epoch 08, associate the already-persisted selected attachment with its current persisted thread/turn before upload; epoch 10 replaces eager draft persistence with atomic persistence at Send. In epoch 09, cancel work and clear credentials before database deletion; epoch 11 completes cross-context credential-generation race handling. Record these intermediate limits and do not mark the dependent findings closed early.

### 1.1 Copyable implementation prompt

> Implement the next pending epoch in docs/ADVERSARIAL-REMEDIATION-EPOCHS.md. Read AGENTS.md and docs/application.md first. Follow the plan's execution contract and predecessor decisions. Trace all callers, reproduce the relevant defects with behavioral regressions, make the smallest correct changes, run the specified final checks, and review the diff. Update architecture and the execution record accurately. Preserve unrelated work. Do not implement later epochs opportunistically, replay uncertain mutations, invent provider contracts, or mark pending browser checks passed. Report exactly what now works and any blocked acceptance checks.

### 1.2 Command conventions

All paths in this file are repository-relative. Test filenames named below already exist unless marked **new**. New test names are proposed deliverables, not commands assumed to work today.

From `extension/`:

```text
pnpm exec vitest run <test paths listed by the epoch>
pnpm test
pnpm typecheck
pnpm build
```

From repository root:

```text
node bridge/test-bridge.mjs
node --test scripts/install.test.mjs scripts/live/answer-quality-eval.test.mjs
git diff --check
```

**EXT gate** means `pnpm test`, `pnpm typecheck`, and `pnpm build` from `extension/`, plus root `git diff --check`. **BRIDGE gate** adds `node bridge/test-bridge.mjs`. **ROOT gate** adds the root installer/evaluation tests. These are final epoch checks, not substitutes for the explicit adversarial cases. Record skipped live tests separately. Do not rerun unrelated expensive checks after a documentation-only correction.

## 2. Wave map and finding coverage

| Wave | Epochs | Result at the gate |
|---|---|---|
| A — stop unsafe effects | 01–04 | No passive media egress, viewer mutations, blind mutation replay, or invisible write intent |
| B — make consent precise and usable | 05–08 | Validated effects, inspectable approvals, one-use plan scope, protected baselines, deliberate uploads |
| C — make recovery and deletion reliable | 09–11 | Stable persistence, attachment ownership, sign-out that stays signed out, accurate connection/settings state |
| D — harden boundaries | 12–14 | Bounded Unicode-safe protocols, narrow DNR, validated messages, private diagnostics, verified isolation evidence |
| E — demonstrate and distribute honestly | 15–17 | Tested installation/artifacts, accurate claims, integrated browser acceptance and adversarial re-review |

| Review findings | Primary epoch | Supporting/final checks |
|---|---|---|
| H1 | 01 | 08, 13, 17 |
| H2 | 06 | 02, 05, 07, 17 |
| H3 | 05 | 06, 17 |
| H4 | 02 | 04, 09, 17 |
| H5 | 03 | 04, 07, 08, 12, 17 |
| M1, M2 | 06 | 05, 07, 17 |
| M3 | 07 | 02, 04, 17 |
| M4 | 04 | 03, 09, 17 |
| M5 | 08 | 01, 04, 10, 17 |
| M6 | 03 | 07, 12 |
| M7 | 10 | 09, 17 |
| M8 | 11 | 02, 09, 13, 17 |
| M9 | 09 | 02, 11, 17 |
| M10 | 01 | 11, 14, 17 |
| M11, M12 | 12 | 03, 04, 14 |
| M13 | 13 | 08, 11, 17 |
| M14 | 05 | 06, 07 |
| M15 | 15 | 16, 17 |
| M16 | 09 | 17 |
| L1, L4, L5 | 15 | 16, 17 |
| L2 | 14 | 16, 17 |
| L3 | 13 | 01, 11 |
| L6 | 11 | 14, 17 |
| D1 | 16 | Correct affected claims incrementally in every epoch |
| D2 | 16 | Path/claim review |
| D3 | 17 | Behavioral regressions in every epoch |
| Additional OAuth-spike concern | 15 | 16 |
| Live mutation contracts and native isolation limits | 07, 08, 14 | 17 |

## 3. Shared implementation decisions

These decisions resolve ambiguity for the implementing model. Change one only with a documented concrete reason and corresponding tests; do not silently substitute a weaker policy.

### 3.1 Effects, authority, and Auto

1. Availability, effect validation, plan necessity, consent, conflict checks, transport policy, and journaling are separate checks. Passing one does not skip another.
2. Define a small validated effect description next to `writes/classify.ts` (a new `writes/effects.ts` is appropriate if needed). It contains the canonical tool name, complete canonical execution arguments, all affected existing targets, parent/destination, affected-object count, risk category, and whether a baseline or substantial-work plan is required. Use explicit adapters for supported tool shapes, not recursive extraction of every string called `id`.
3. Freeze a JSON-compatible snapshot before showing consent. Compare the complete canonical argument structure, preserving array order and every provider field. Sort object keys for deterministic comparison; normalize only verified identifier fields. Reject non-JSON values, cycles, malformed objects, excessive nesting, and unknown effect shapes. Never use a model-generated summary as the comparison key.
4. User text, current-page metadata, mentions, and selected files are inputs, not machine-verifiable grants of arbitrary effects. In particular, being on a page or choosing Auto must not authorize a write when the user asked only for analysis.
5. Use existing Ask behavior for ungranted edits. For deterministic Auto without a natural-language authorization detector, introduce a small explicit composer option **Allow small edits this turn**, off by default and available only in Auto. It lists the current/explicitly selected target pages and explains its scope before Send. Capture that user-selected grant at Send. No model tool can set it. Auto without this grant requests ordinary action consent; switching mode does not silently set it.
6. The small-edit grant permits only fixture-verified, non-destructive single-object property updates and targeted text additions on listed pages. It excludes replacement, deletion, creation, moves, schema/view changes, upload, unknown effects, and out-of-context targets. Cap it at five successful or dispatched logical effects in the turn; a bulk call is counted by objects, never as one. Crossing the cap requires a reviewed plan before dispatch. Reserve counts synchronously, and never release them after an ambiguous dispatch.
7. Actual untrusted exposure remains tracked for diagnostics and model context. It cannot broaden the explicit grant. A read-then-write may execute without a new card only when the complete effect satisfies that independently enforced grant or an explicit exact approval. Do not claim that this proves a model's content intent or prevents all semantic injection.
8. A plan is necessary for destructive schema changes, multi-page moves, database creation, more than five created pages, or a sequence exceeding five affected-object operations. A single cosmetic view rename or one single-page move needs ordinary action approval, not a mandatory workspace plan. A single move still always needs human consent. Repeated small calls contribute to the cumulative five-effect threshold; reads and local planning do not.
9. Unknown/unvalidated tool effects are **unsupported**, not assumed reads and not fixed by requesting a vague plan. Return a specific unsupported-effect error before execution. Add read adapters only from verified contracts. Unknown provider annotations cannot grant local authority.
10. Remove future-turn-wide `approveAllUntilTurnEnd`. Initially keep Approve/Reject for individual cards and exact plan approval for batching; no need to add a separate batch UI. A previously approved operation cannot cover a changed target, content, flag, destination, count, connection, or turn.

This adds one explicit control to make Auto's authority auditable. Do not attempt a regex or another model to decide whether freeform user text authorized mutation. Tests must show this control is understandable and does not force plans for ordinary reads.

### 3.2 One operation identity from preview through recovery

Suggested contract sketch, to adapt to existing types rather than paste as a second parallel model:

```ts
type OperationScope = {
  operationId: string
  connectionGeneration: string
  workspaceId: string
  threadId: string
  turnId: string
}
type OperationStatus = 'pending' | 'applied' | 'failed' | 'unknown'
// frozenArgs are the provider arguments actually sent, after validated local
// fields are removed. Keep internal metadata outside the provider payload.
// An undo is another operation, linked to its original journal entry.
```

- Scope comes from Nox runtime and connection identity, never model fields. Refuse mutation without a persisted thread and established workspace scope; remove the production `unscoped` fallback for effects.
- Plan operation state is `available → reserved → consumed`. Reserve atomically in synchronous local code before an await; persist intent before dispatch. Release a reservation only for a proven pre-dispatch failure. Dispatch, cancellation after dispatch, and lost replies consume it. Retry requires reconciliation and new consent.
- Persist `pending` before any mutation request. A successful response establishes applied effect; failed verification changes verification/undo availability, not that fact. A lost response, parse failure after dispatch, or abort after dispatch is `unknown` unless reliable evidence proves the outcome.
- Distinguish `failed` (known not applied) from `unknown`. An HTTP status, JSON-RPC error, or tool `isError` is not universal proof of rollback, especially for bulk calls. Provider-specific known-no-effect cases require a captured contract. The safe default after dispatch is unknown.
- On startup, old pending operations become unresolved/unknown for display without replay. Successful readback can provide evidence but cannot always prove authorship. When creation cannot be identified uniquely, retain unknown and ask the user to inspect; never infer absence from one empty search result.
- A successful remote effect followed by local update failure is visibly **Applied; recovery record could not be updated** for the current session. The older pending record remains recoverable on restart. Do not promise durable information that the failing store could not save.
- Existing `applied`/`failed`/`undone` historical records remain readable. Do not give old rows invented authorization, baselines, or safe inverses. Added optional fields do not alone require an IndexedDB version bump; change version only for actual store/index migrations.

### 3.3 UI and evidence rules

- Every approval shows operation, all targets/destination, affected count, changed fields or content, and undo limitation. Full canonical payload is reachable before Approve. A collapsed preview says it is a preview.
- Prefer existing cards, native `<details>`, wrapping `<pre>`, and existing activity rows. Keyboard focus enters a new approval predictably, Escape/reject never approves, and focus returns to the composer after resolution. Avoid new modal stacks.
- No component can grant authority by hiding a button. Runtime guards are mandatory. UI disabling explains why the action is unavailable.
- Unknown, failed, stopped, applied, verified, and undone are distinct observable states. A stopped assistant can still have an applied or unknown tool operation.
- Browser acceptance checks use only disposable synthetic data and an explicitly designated scratch parent. Attaching files, editing Notion, and changing another application's permissions are not authorized merely by this plan-writing task. The executing user must designate/authorize the live test scope. Do not automate OAuth permission dialogs.
- Network, IndexedDB, and native-surface claims need instrumentation as well as Computer Use. If the computer-control tool cannot inspect them, use an approved browser/network test interface or record the check as blocked; a screenshot cannot prove zero network requests.

## 4. Wave A — stop unsafe effects

### Epoch 01 — private rendering and faithful preference startup

**Findings:** H1, M10. **Depends on:** none. **Outcome:** rendering an answer or saved history sends no passive remote resource request; saved Web research off applies before the first send.

**Read/modify:** `extension/src/lib/markdown.ts` (`renderMarkdown`), `extension/manifest.config.ts`, `extension/src/sidepanel/MessageParts.tsx`, `Composer.tsx`, `EmptyState.tsx`, `App.tsx`, `store.ts`, `extension/src/lib/settings.ts`.

**01.1 — `fix(privacy): prevent automatic resource loads from generated content`**

1. Convert Markdown image tokens into escaped text placeholders or ordinary user-clicked links before HTML insertion. Raw HTML resource tags must be removed by the sanitizer, not transformed with a broad regex over arbitrary HTML.
2. Forbid automatic sinks including `img`, `picture`, `source`, `audio`, `video`, `track`, `iframe`, `object`, `embed`, `link`, `meta`, SVG resource features, and source/style/event/ping attributes. Keep existing safe anchors and Notion UUID rewriting. Do not regress code blocks, tables, or ordinary text.
3. Stop rendering DOM-derived remote page icons as `<img src=...>`. Use a bounded emoji/text icon or packaged fallback. Do not load remote images merely because they are on a Notion hostname.
4. Add explicit production extension-page CSP: packaged scripts/fonts/resources, no media/object/frame loads, and images restricted to packaged assets (add local blob support only if actually required). Enumerate connect destinations after inspecting OAuth discovery and upload contracts; do not use a broad default merely to hide violations. Inline styles may require an explicit style policy for the existing UI; never permit inline scripts or eval in production. Verify CRXJS development separately without weakening the production CSP.

**01.2 — `fix(settings): hydrate research preference before enabling send`**

1. Remove the model/effort/tier guard around `agentLoop.setOverrides` in `App.tsx`. Apply `webSearchEnabled: false` even when all model settings are default.
2. Introduce a loaded/error readiness state at the existing startup boundary. Send and model turn setup must await settings hydration; a settings read failure shows retry/error instead of silently enabling research.
3. UI and runtime consume the same effective setting. Changing model/effort/tier preserves Web research preference. Opening another panel does not reset it.

**Regressions:** extend `tests/markdown.test.ts`, `tests/activity-ui.test.tsx`, `tests/setup-screen.test.tsx`, and `tests/codex/research.test.ts`. Cover Markdown/raw images, `srcset`, posters, SVG, CSS URL attempts, hostile icon metadata, history restoration, research-only false, delayed hydration, hydration failure, and model change. Verify ordinary links remain clickable and no source attribute survives sanitization.

**Final tests:** EXT gate; browser C01 and C02 from section 11. **Must work:** sources remain readable/clickable, packaged fonts/icons render, setup still connects, remote images do not auto-load, and research stays off across restart. A DOM-only test is not enough to close H1's live evidence requirement.

### Epoch 02 — one runtime owner for all mutations

**Finding:** H4. **Depends on:** 01. **Outcome:** forward writes, uploads, and undo share an execution boundary; viewers cannot write even through direct calls.

**Read/modify:** `extension/src/lib/history/panel.ts` (`claimWindowRole`), `extension/src/lib/agent/panel.ts`, `loop.ts`, `extension/src/lib/writes/gate.ts`, `journal.ts`, `undo.ts`, `extension/src/sidepanel/ChatPanel.tsx`, `ApprovalCards.tsx`, `MessageParts.tsx`.

**02.1 — `fix(writes): enforce runtime ownership and serialize mutations`**

1. Keep the existing long-lived `nox-agent-owner` Web Lock. Expose a read-only runtime lease/generation from the module holding the actual lock; do not trust a mutable Zustand role alone.
2. Inject an ownership assertion and a small serial mutation runner into the gate. Use the same runner for forward writes, upload effects, and undo. Check lease, connection generation, and cancellation on admission and immediately before external dispatch.
3. Serialize the critical interval encompassing final guard, durable intent, dispatch, response accounting, and journal update. Reads can retain scheduler concurrency. Do not hold an IndexedDB transaction open while awaiting network.
4. Reject undo while a turn is active instead of queuing it to run unexpectedly later. Prevent a new turn while undo is active. A queued operation from an expired lease/turn fails without transport.
5. Hold execution ownership until in-flight bookkeeping settles where possible. On panel loss, the next owner must reconcile unresolved journal intent before another conflicting effect; epoch 04 adds that durable check. A Web Lock cannot cancel a request already committed by the server.

**02.2 — `fix(undo): coordinate undo entry points and restored controls`**

1. Both `undoActivity` and `UndoBar.runUndo` use one runtime undo function. That function validates scope and status again from storage, rather than trusting a restored activity row.
2. Remove enabled undo controls in viewer/pending role and while busy. Keep the reason visible. Guard duplicate clicks and direct `writeGate.handleUndo` calls as well.
3. Fix `claimUndo` cleanup when reading storage throws: release the in-flight claim on every failure. Atomic undo status reservation is completed with epoch 04; do not treat a per-instance boolean as cross-window coordination.

**Regressions:** `tests/viewer.test.tsx`, `tests/activity-ui.test.tsx`, `tests/writes/gate.test.ts`, `tests/history.test.ts`; add **new** `tests/writes/ownership.test.ts` if needed. Restore a reversible row into a viewer, directly invoke undo and write routes, race undo with a turn, double-click undo, expire a queued lease, and fail a journal read. Count external effects; viewer count must be zero, simultaneous writes at most one.

**Final tests:** EXT gate; C03. **Must work:** owner chat remains usable, viewer history stays readable, and undo can be used once only when idle and safe. Until epoch 04, crash-time ambiguity remains an open blocker.

### Epoch 03 — safe retries and atomic scheduler admission

**Findings:** H5, M6. **Depends on:** 02. **Outcome:** one user mutation cannot silently become two; global and search budgets both apply.

**Read/modify:** `extension/src/lib/mcp/scheduler.ts` (`acquire`, `schedule`, `retryDelayFor`), `client.ts` (`send`, `parseRetryAfter`), `extension/src/lib/notion/index.ts` (`scheduleCallTool`), `extension/src/lib/writes/gate.ts`.

**03.1 — `fix(mcp): retry only operations with established retry safety`**

1. Add an explicit retry-safety option to scheduling. Determine it from trusted known read classification at `scheduleCallTool`, not an argument the model supplies. Unknown effects and every mutation default to no retry.
2. Search/fetch may retry transient failures under the existing bounded retry count. Mutations, upload tickets, blob POSTs, and undo must not retry 429, 5xx, RPC errors, lost replies, or parse errors without provider proof of non-execution. Initially implement no automatic mutation retry at all.
3. Distinguish pre-dispatch failures from uncertain post-dispatch failures so epoch 04 can record honest outcomes. Count dispatch at actual fetch invocation, after token acquisition and final abort check. Do not classify a local missing-token error as an already-sent request.
4. Cancellation after server commit is not “no changes made.” Propagate uncertainty to the gate and activity result. No reconnect path may replay the submitted mutation.

**03.2 — `fix(scheduler): reserve concurrency and both rate budgets together`**

1. Refill/recheck all needed token buckets and concurrency in one admission loop. Reserve all permits synchronously when all conditions hold. Search spends one global token and one search token.
2. On every wakeup recheck concurrency and tokens; do not reserve concurrency while sleeping for tokens. Keep a bounded/fair waiting mechanism using existing primitives. Check abort before invocation and release exactly once in `finally`.
3. Preserve the existing token-bucket burst capacities and document them; do not claim a strict rolling-window quota. Fake-clock tests measure production limits and `maxConcurrent: 1` with long tasks.
4. Positive Retry-After seconds/date is a minimum, not capped at 30 seconds. Only locally generated exponential delay has the cap. If the remaining turn deadline is shorter, stop with a rate-limit/deadline explanation. Waiting does not keep a mutation guard valid.

**Regressions:** `tests/scheduler.test.ts`, `tests/notion-facade.test.ts`, `tests/mcp-client.test.ts`, `tests/writes/gate.test.ts`. Simulate commit-then-503, lost creation response, partial bulk result, 429 after effect, plain read retry, zero dispatch on cancelled admission, shared search/global timestamps, three waiting slow tasks, 120-second/date Retry-After, deadline exhaustion, and permit release after exceptions.

**Final tests:** EXT gate. **Must work:** reads still recover from temporary failures; uncertain mutations return a visible unresolved result with exactly one dispatch. Real ambiguous-failure tests belong to a controlled fixture, not artificial disruption of valuable writes.

### Epoch 04 — durable mutation intent and honest recovery

**Finding:** M4; closes the durable portion of H4/H5. **Depends on:** 02–03. **Outcome:** every dispatched effect has a durable identity; uncertain work survives restart without automatic replay.

**Read/modify:** `extension/src/lib/writes/journal.ts`, `gate.ts`, `undo.ts`, `extension/src/lib/history/schema.ts`, `restore.ts`, `extension/src/lib/agent/activity.ts`, `panel.ts`, `extension/src/sidepanel/MessageParts.tsx`, `ApprovalCards.tsx`.

**04.1 — `feat(journal): persist intent before external effects`**

1. Evolve `JournalEntry` with operation scope, pending/unknown status, dispatch/outcome metadata, and optional linked original operation for undo. Preserve old rows and current indexes unless a demonstrated query needs another index.
2. Replace post-success-only `record` usage in mutations with begin-intent and settle-outcome operations using the same ID. Capture thread/turn/workspace/generation synchronously when enqueuing, not inside the later promise callback.
3. Persist needed pre-image and frozen execution payload before dispatch. If this fails, return a storage error and make zero external calls. A record containing only character count/hash is not a recoverable inverse.
4. Persist applied immediately after a confirmed successful response, before optional verification reads. Then store verification and safe inverse information. If the success-record write fails, retain pending and show the session's known applied/recovery-warning state.
5. Restrict default storage listing to thread/workspace scope using `by_thread`; direct lookup uses `get`. Do not scan every prior payload to assign a timestamp; keep IDs unique and a deterministic timestamp/ID tie-breaker.

**04.2 — `fix(recovery): reconcile unresolved operations and journal undo`**

1. Restore pending/unknown as prominent unresolved activity. Block conflicting mutations and undo until inspected/reconciled. Allow safe reads for investigation. Unknown creation under a parent conservatively conflicts with another matching creation there.
2. Implement narrow readback for supported uniquely identifiable updates. Display evidence with an inspect link; do not automatically replay, infer authorship, or mark an unidentifiable creation absent.
3. Undo creates its own durable intent linked to the original operation, reserves the original in one local transaction, and passes through ownership, no-retry, capability, and conflict checks. Mark the original undone only when undo is known applied. A crash cannot leave it safely clickable a second time.
4. Cancelling before dispatch settles known failure/cancelled detail; after dispatch settles unknown unless response evidence establishes applied. Do not let an abort prevent local outcome bookkeeping.
5. Keep partial assistant text and commentary during recovery merges. Add visible not-undoable reasons and a validated returned-object link where a supported creation response supplies one.

**Regressions:** `tests/writes/gate.test.ts`, `tests/history.test.ts`, `tests/history-turns.test.ts`, `tests/activity.test.ts`, `tests/activity-ui.test.tsx`. Inject failures before intent, after intent/before dispatch, after server commit/before response, after success/before local update, during verification, and after undo/before status update. Restart with each record and assert no replay. Change active thread while a queued intent waits and assert original scope is retained. Verify legacy records still restore.

**Final tests:** EXT gate; C04 and C09. **Wave A gate:** all High regressions addressed so far pass; rendering, ownership, retry and durable-outcome evidence exists. H2/H3 remain intentionally open until Wave B, so this is not public-release readiness.

## 5. Wave B — make consent precise and usable

### Epoch 05 — validated effects and complete reviewable payloads

**Findings:** H3, M14; foundation for H2/M1. **Depends on:** 04. **Outcome:** malformed proposals never reach UI/transport, and the approved payload equals the executed payload.

**Read/modify:** `extension/src/lib/writes/classify.ts`, **new if useful** `writes/effects.ts`, `approvals.ts`, `gate.ts`, `extension/src/lib/architect/plan.ts`, `tool.ts`, `plan-engine.ts`, `extension/src/sidepanel/ApprovalCards.tsx`, `PlanCards.tsx`.

**05.1 — `refactor(writes): validate supported effects before consent`**

1. Implement the small effect adapters from section 3. Inspect offered tool schemas and existing fixtures first. Support current known forms deliberately; reject shape mismatches with `UNSUPPORTED_EFFECT` or `INVALID_ARGUMENTS` before any approval or request.
2. Parse every affected target and destination once. Use that parsed effect in approval, plan comparison, guard, journaling, and transport classification. Remove inconsistent `firstString`/any-ID authorization decisions after migrating callers.
3. Reject model-supplied internal fields such as `__nox_expected_hash`; carry trusted undo hashes outside arguments. Do not advertise `injected_request` as a detector. Stripping a marker is not evidence that intent is safe.
4. Bound canonical payloads before expensive cloning/rendering: start with 512 KiB UTF-8 per operation, depth 20, and 100 entries in any effect list; the tighter per-effect/plan limits still apply. Exceeding a bound returns a size-specific refusal, never truncation followed by execution. Verify normal supported operations fit; adjust a bound only with fixtures and tests.

**05.2 — `fix(approvals): bind consent to a complete immutable payload`**

1. Replace the 2,000-character `payloadJson` slice with the full bounded canonical JSON. Show a short human summary plus labelled collapsed full details. Long content wraps and scrolls within the panel; targets/counts/destructive flags stay outside the content preview.
2. Keep a frozen private execution snapshot; components receive display data, not mutable authority. After awaiting consent, dispatch that snapshot and revalidate current scope. Editing the original request object cannot change what runs.
3. Remove future approve-all authorization and its control. Reject stale/double decisions; cancel clears pending cards and grants. Label unsupported undo accurately before consent.
4. Plan validation checks every object/array field, supported kind, real identifier type, nonempty bounded strings, duplicate operation IDs, and list count. Keep evidence at 1–20 and plan operations at 1–10, leaving room within 12 dynamic calls for the plan and retrieval; explain that reads/continuations also use the limit. Reject invalid consequences rather than quietly filtering them.
5. Evidence UI says inspected only for Nox-recorded successful retrievals in the current scope. Unknown IDs are rejected as inspection evidence or explicitly shown as unverified claims that cannot satisfy required evidence. `evidence: [null]` and numeric targets return model-readable validation errors without a pending card.

**Regressions:** `tests/writes/approvals.test.ts`, `tests/writes/classify.test.ts`, `tests/writes/gate.test.ts`, `tests/architect/plan-engine.test.ts`, `tests/plan-ui.test.tsx`; add **new** `tests/approval-ui.test.tsx`. Put long content before destructive flags and extra targets; expand full payload; mutate original args after requesting consent; submit null/primitive evidence, fabricated IDs, duplicate IDs, oversize lists, cyclic/non-JSON unit inputs, and unknown tool shapes. Assert no transport and no render crash on rejection.

**Final tests:** EXT gate; C05. **Must work:** one small Ask edit presents one readable card with complete inspectability, and approving it executes exactly that action. Plan scope matching is completed next.

### Epoch 06 — scoped plans, consistent Auto, and fewer interruptions

**Findings:** H2, M1, M2; remaining M14 and future approve-all risk. **Depends on:** 05. **Outcome:** reads need no plans, small edits need at most one consent step, and approved transformations execute only their bounded operations.

**Read/modify:** `extension/src/lib/architect/plan.ts`, `plan-engine.ts`, `tool.ts`, `extension/src/lib/writes/classify.ts`, `approvals.ts`, `gate.ts`, `extension/src/lib/agent/panel.ts`, `loop.ts`, `turn-access.ts`, `notion-architect.ts`, `instructions.ts`, `dynamic-tools.ts`, `extension/src/sidepanel/Composer.tsx`, `ChatPanel.tsx`, `PlanCards.tsx`.

**06.1 — `fix(plans): replace self-approval with one-use exact operation grants`**

1. Remove `request(args, mode === 'auto')` and the gate's Auto structural bypass. Explicit plan approval is required for substantial work in both modes.
2. Extend `PlannedOperation` from `{tool,targetId?,summary}` to a unique local operation label plus complete validated arguments/effect. Bind the approved frozen plan to runtime workspace, connection generation, persisted thread, and turn. Scope expiry includes cancel, timeout, disconnect, sign-out, workspace change, and new turn.
3. `authorize` must compare complete effects and return a reservation/operation identity, not a reusable Boolean from `.some`. Match all targets, all destinations, contents, schema fields, and counts. Never use omitted target as wildcard or accept one matching ID from a batch.
4. Consume each approved operation at dispatch, including unknown outcomes. A repeat of the same payload requires a separately listed operation. Concurrent identical requests cannot reserve the same slot.
5. For operations using IDs returned by a previous approved creation, support only a small explicit reference form, e.g. a reference to a preceding operation's validated created-object slot. Resolve via a tool-specific response adapter, not a model-provided ID or arbitrary JSON path. Reject forward/cyclic references, missing result IDs, and extra created objects. Show the relationship in the plan before consent. If a provider result shape is not verified, require a second concrete plan after creation instead of widening authorization.

**06.2 — `fix(policy): separate material plans from action approval`**

1. Implement the thresholds and exceptions in section 3.1. Reads/search/continuations bypass plan/action consent but keep capability/budget checks. Verify any newly added read classification such as meeting-note query before enabling it.
2. One view-name-only change and one single-page move use ordinary action approval. Destructive/ambiguous view/schema changes remain explicitly reviewed; deletion of schema fields and broad moves require a plan.
3. Track cumulative dispatched effects in turn access state; count each object and each repeated effect. At the sixth unplanned effect return an actionable plan-required error before dispatch. A plan containing the remaining explicit scope can authorize subsequent bounded work; do not demand reapproval of already applied effects.
4. Implement the Auto small-edit composer control specified in 3.1. Capture normalized target list, grant, mode, and turn identity at Send. Reset the grant for the next turn. No settings persistence, inferred user-intent parser, or model-controlled Boolean.
5. Fix provenance construction: an empty `prepareContext` callback is not evidence exposure; actual successful/partial Notion content is. Local plan receipts and internal status messages do not automatically taint the turn as workspace content. Preserve untrusted wrapping of real external content.
6. After exact plan approval, covered actions skip only redundant ordinary consent. Capabilities, ownership, runtime scope, guard, scheduler, ledger, and cancellation still run. Changed effects return mismatch with a clear reason and new review path. Rejected operations are not silently reproposed as a different plan without a new user request.
7. Update dynamic tool schemas, planner instructions, composer help, and architecture together. Do not leave prompts describing the deleted Auto bypass or broad approve-all behavior.

**Regressions:** extend real assembly tests in `tests/agent/agent-modules.test.ts`, `tests/codex/loop-integration.test.ts`, `tests/agent/turn-access.test.ts`, `tests/writes/gate.test.ts`, `tests/architect/plan-engine.test.ts`, `tests/plan-ui.test.tsx`. Explicit cases: omitted target; same tool/target changed content/schema; changed parent; allowed+unallowed batch; reused operation; stale connection; untrusted proposal; simultaneous duplicate; failed result reference; no-mention/read-then-write/mentioned-content turns; analysis-only Auto without grant; bounded Auto with grant; out-of-scope Auto; five versus six cumulative effects; plan rejected; ten exact covered operations after one approval without extra cards.

**Final tests:** EXT and BRIDGE gates; C06, C07, C08. **Must work:** ordinary reads have zero plan cards; small Ask edits one action card; explicitly granted small Auto edits zero redundant cards; one approved substantial plan covers its exact operations once. Count real dynamic calls in the ten-operation test so plan+reads do not accidentally exceed 12.

### Epoch 07 — real read baselines and conservative conflicts

**Finding:** M3; supports plan evidence and undo. **Depends on:** 06. **Outcome:** replacement cannot use stale/failed/partial context as a complete baseline.

**Read/modify:** `extension/src/lib/writes/guard.ts`, `gate.ts`, `inverse.ts`, `extension/src/lib/agent/panel.ts` (`fetchPageMarkdown`, `fetchMentionContext`), `context.ts`, `extension/src/lib/notion/index.ts`; add a small **new** response-normalization module under `lib/notion/` if shared.

**07.1 — `fix(guard): require successful complete baseline for content writes`**

1. Capture redacted fixture shapes for plain, rich, partial, unavailable, and tool-error fetches. Preserve structural metadata needed to determine completeness. Do not treat every concatenated text envelope as page Markdown.
2. Return structured retrieval records: normalized target, source/call identity, complete/partial/unavailable status, normalized content, hash, workspace and generation. Plan evidence uses these records. A guard-only read that the model never saw must not establish the model's edit baseline.
3. Reject tool `isError`, unrecognized wrappers, omitted subtree content, and unknown completeness as destructive-replacement baselines. A partial read can support limited analysis, not a whole-page replacement or safe whole-page inverse.
4. Require the model to re-fetch after resume/reconnect when no current valid baseline exists. Never silently bless two matching fresh guard reads against an old model proposal. Re-read and return a conflict with a new review requirement when the approved content was based on an older state.
5. Bind the baseline hash to the approved operation. Inside epoch 02's serial mutation runner, after scheduler admission and immediately before dispatch, read/check the current page against it. Avoid deadlock by not holding the sole scheduler slot while scheduling the guard read; perform guards before the final mutation slot and recheck after a material admission delay, with a bounded loop/deadline. Do not leave an unbounded delay between final check and request.
6. Retire the read hash after a write, unknown outcome, scope change, or incompatible new read. Guard failure emits no mutation. State the residual race: an external edit between final read and provider write cannot be atomically excluded without provider conditional-write support.

**07.2 — `fix(undo): require verified lossless supported inverse`**

1. Keep creations, properties, schema, views, moves, and unverified rich content not-undoable. Do not expand inverses from regex absence alone.
2. Allow content inverse only for a positively recognized complete plain-content fixture shape and attributable post-write content. Confirm the expected post-hash before undo, using internal trusted metadata.
3. Show precise conflict/not-undoable explanations and any real target link in activity and approval. Readback mismatch means applied but unverified where success was acknowledged, not a fabricated failed/no-change result.

**Regressions:** `tests/writes/gate.test.ts`, `tests/agent/agent-modules.test.ts`, `tests/history.test.ts`, `tests/codex/loop-integration.test.ts`; add redacted **new** fixtures under `tests/fixtures/notion/`. Missing target, `isError`, wrapper mismatch, partial fetch, stale resume, external edit before final read, two concurrent writes, rate wait, and edited page before undo must be covered.

**Final tests:** EXT gate; C09 and C10. **Must work:** a properly fetched small edit succeeds, stale replacement refuses with a useful reread path, safe supported undo works once, unsupported undo is visibly unavailable. Real provider normalization acceptance is mandatory before enabling replacement/undo for that shape.

### Epoch 08 — deliberate file disclosure through verified destinations

**Finding:** M5. **Depends on:** 04–07. **Outcome:** file selection alone never uploads bytes; ticket and upload outcomes use the same safety boundary.

**Read/modify:** `extension/src/lib/attachments/upload-tool.ts`, `extension/src/lib/agent/panel.ts`, `dynamic-tools.ts`, `executor.ts`, `turn-access.ts`, `extension/src/lib/notion/capabilities.ts`, `extension/manifest.config.ts`, approval/journal UI.

**08.1 — `fix(upload): require scoped consent and supported capability`**

1. Advertise `nox-upload-local-file` only when the discovered tool list and capability gate positively support the underlying upload workflow. Recheck capability at execution; a stale advertised tool must fail safely.
2. Keep current-turn selected attachment-ID validation. Validate file exists, size/type matches stored metadata, and identity belongs to the persisted turn. A model cannot name an arbitrary attachment in history.
3. Route upload through the owner/serial effect path, exact consent, and durable journal. Show name, size, MIME type, provider/destination class, and lack of automatic remote deletion. Require explicit upload consent in Ask and Auto; approved exact upload operations may inherit it. A question about a file and even Auto small-edit permission do not authorize upload.
4. Remove raw underlying ticket creation as an alternate advertised model route if it would bypass the same upload effect policy. Internal ticket creation still goes through capability/rate/no-retry checks.

**08.2 — `fix(upload): validate provider ticket contract and refuse redirects`**

1. Obtain an authoritative provider contract and synthetic/redacted live ticket/result fixture before enabling the workflow. Existing code guesses `upload_url`, `form_fields`, `field_name`, and `suggested_markdown`; do not preserve guessed fallback aliases without evidence.
2. Validate ticket is not `isError`, required field types/lengths, exact approved HTTPS origins and permitted URL shape, and absence of URL credentials. Use URL parsing and exact host/origin comparison, never suffix-only matching or generic cloud-storage wildcards.
3. Send with redirect rejection, cancellation, bounded response reading, and no Notion bearer token attached to a different upload origin. Form fields come only from the verified contract. Reject a redirect before bytes reach its destination; test this at transport level.
4. One durable upload operation can record ticket-created/bytes-dispatched/upload-confirmed stages. Stop on cancellation between stages. Unknown POST outcome is not retried. Successful upload followed by failed page insertion stays visible as uploaded but not attached to a page.
5. Add only verified required upload origins to host permissions/CSP as necessary. If the contract cannot be established, hide/disable upload with a clear unsupported reason and retain local attachment handling; do not claim the upload feature passed live acceptance.

**Regressions:** `tests/attachment-upload.test.ts`, `tests/attachments.test.ts`, `tests/capabilities.test.ts`, `tests/agent/agent-modules.test.ts`, `tests/writes/gate.test.ts`. Selected-but-not-requested, cancelled/rejected consent, missing capability, stale file ID, wrong origin, URL credentials, redirect, tool-error ticket, oversize result, abort after ticket, commit-then-network-error, and uploaded-but-insertion-failed.

**Final tests:** EXT gate; C11. **Wave B gate:** H2/H3 regressions and browser consent matrix pass; reads and small edits are smooth; every enabled effect has a verified adapter. Unsupported upload is an acceptable stated alpha limitation, not a passed upload test.

## 6. Wave C — make recovery and deletion reliable

### Epoch 09 — recoverable history and cooperative database lifecycle

**Findings:** M9, M16. **Depends on:** 04, 08. **Outcome:** one failed partial save does not poison the final answer, and other panels do not silently prevent deletion forever.

**Read/modify:** `extension/src/lib/history/schema.ts`, `turn.ts`, `panel.ts`, `repository.ts`, `restore.ts`, `extension/src/lib/writes/journal.ts`, `extension/src/sidepanel/ChatPanel.tsx`, `ApprovalCards.tsx`, `SettingsModal.tsx`.

**09.1 — `fix(history): reuse database connections and coordinate deletion`**

1. Cache one open promise/connection per panel. Reset on open rejection, termination, explicit close, and version change. Add `blocking` handling that closes promptly instead of retaining a strong set forever.
2. Add a small extension-context deletion message or BroadcastChannel. Mark storage as deleting before close; other panels cancel turns, invalidate grants, close DB connections, and stop auto-reopening. Late streaming/journal callbacks cannot recreate a deleted database.
3. Deletion state must survive a transient message miss for an already-open panel; use a shared deletion generation/tombstone or equivalent existing storage event, and test it. Do not use an unauthenticated webpage message.
4. Clear credentials promptly through epoch 11's shared invalidation path; until that exists, wire a clearly named dependency rather than waiting on DB deletion. Show “Another Nox window is keeping storage open; close it to finish” when blocked. Preserve the pending request's real lifecycle; do not declare success on timeout or auto-open a fresh database while deletion is pending.
5. Replace `UndoBar`'s every-three-second full-journal polling with updates after known journal changes and scoped hydration on thread change. Reuse `by_thread`; viewer refresh can use the same small message channel. Avoid maintaining another full copy of inverse payloads solely for a count.

**09.2 — `fix(history): recover the persistence queue and preserve final saves`**

1. In `startPersistedTurn`, give each save its own rejecting result while the internal serialization tail recovers for the next operation. Do not hide failures by returning an always-successful promise.
2. Coalesce obsolete unsent partial snapshots: at most one in-flight save and one latest waiting partial. A final/outcome snapshot supersedes waiting partials and is always attempted after the current operation settles. Earlier partials cannot overwrite a final.
3. Surface “History could not be saved” near the affected answer, with a retry of the full local snapshot and export/copy option. Do not rerun the model turn to retry persistence.
4. Capture message/thread identities before async work. New chat/thread deletion must not redirect or resurrect old saves. Preserve interrupted/failed outcome, activity, and usage in the latest successful save.

**Regressions:** `tests/db/db.test.ts`, `tests/history.test.ts`, `tests/history-turns.test.ts`, `tests/activity-ui.test.tsx`, `tests/viewer.test.tsx`. Repeated calls reuse open connection; two connections receive versionchange; blocked deletion is visible; late callbacks do not recreate DB; failed partial followed by successful final; final failure retry; rapid partials are bounded; switched thread remains isolated.

**Final tests:** EXT gate; C12 and C13. **Must work:** reopened history matches the latest saved state, temporary failure recovers, and data deletion completes with cooperative viewers or shows a specific blocker.

### Epoch 10 — attachment ownership and complete thread deletion

**Finding:** M7. **Depends on:** 08–09. **Outcome:** removed draft files do not linger on disk, and deleting a thread removes its owned file bytes.

**Read/modify:** `extension/src/sidepanel/Composer.tsx`, `ChatPanel.tsx`, `extension/src/shared/attachments.ts`, `extension/src/lib/history/attachments.ts`, `repository.ts`, `schema.ts`, `turn.ts`.

**10.1 — `fix(attachments): keep drafts ephemeral and persist ownership on send`**

1. Prefer keeping unsent `File` objects in composer memory; do not persist bytes on selection. Keep local IDs and metadata stable while editing the draft. Removing a chip/new chat releases the draft reference. On refresh, unsent files are intentionally discarded; say so if needed.
2. Before starting Codex, persist the user message, selected attachment bytes, and thread/message ownership in one bounded IndexedDB transaction (thread creation included if necessary). The tool receives only IDs committed for that turn. If persistence fails, retain the local draft and make no upload/turn request.
3. Bound selection to ten files, 20 MiB per file and 25 MiB total as initial local limits, tightened if the verified provider requires less. Display which files were rejected and why. Check aggregate size before reading all bytes; do not silently filter oversized files. Values are product limits, not assertions about provider maximums.
4. Do not reuse one attachment row across threads. If existing history references a shared legacy file, either preserve it until all references are gone or copy ownership safely before deletion. Do not accidentally delete another retained message's data.

**10.2 — `fix(history): delete thread-owned attachments atomically`**

1. Add `attachments` to the thread deletion transaction. Read keys and delete messages/journal/attachments/metadata within the same transaction, under the deletion/busy coordination from epoch 09; avoid pre-reading children outside the transaction.
2. Legacy orphan blobs cannot reliably be assigned to conversations from the current schema. Offer a clearly scoped cleanup of unlinked legacy attachments after checking retained references, or remove provably unreferenced rows in a documented migration. Never guess ownership by filename.
3. Exports contain attachment metadata and explicitly exclude bytes unless a separately requested export feature is implemented. Do not put blob content, upload tickets, or tokens into ordinary Markdown exports.

**Regressions:** `tests/attachments.test.ts`, `tests/history.test.ts`, `tests/history-turns.test.ts`, `tests/db/db.test.ts`. Remove before Send, new chat, reload draft, failed atomic send, multiple files/limits, sent file lookup, delete attached thread, retained reference, migration of legacy orphans, export disclosure.

**Final tests:** EXT gate; C11 and C12. **Must work:** attachment chips behave predictably, failed send preserves the draft, local thread deletion removes its file bytes without touching unrelated conversations.

### Epoch 11 — sign-out races and truthful connection recovery

**Findings:** M8, L6; completes M9/M10 lifecycle. **Depends on:** 09–10. **Outcome:** sign-out cannot resurrect credentials, and a disconnected bridge has a working reconnect path without replay.

**Read/modify:** `extension/src/lib/oauth/tokens.ts`, `discovery.ts`, `extension/src/lib/notion/index.ts`, `panel.ts`, `extension/src/lib/codex/panel.ts`, `client.ts`, `native.ts`, `extension/src/sidepanel/codex-connect.ts`, `notion-connect.ts`, `BridgeCard.tsx`, `ConnectionCard.tsx`, `App.tsx`, `store.ts`.

**11.1 — `fix(auth): serialize credential lifecycle and invalidate late refreshes`**

1. Scope refresh/login writes to a persisted credential generation and active authorization. Invalidate generation on sign-out, wipe, delete-all, workspace replacement, and start of a replacement login. Abort stale requests where possible.
2. A generation check before an awaited storage write is insufficient: serialize final credential writes and clear operations under a shared browser Web Lock, and recheck persisted generation inside it. Only credential persistence uses this short lock; do not hold it across network or revocation. A stale response from another panel must not overwrite a newer login.
3. Serialize refresh across permitted callers using a separate refresh lock plus a second expiry/token read after acquiring it. Scope old `invalid_grant` handling so it cannot wipe a new login. Prefer owner-only token use; direct second-instance tests still prove safety.
4. On sign-out, capture the old revocation token, invalidate/cancel active turns and grants, clear local/session tokens promptly, and update UI. Revoke the captured token best-effort with a five-second timeout independently of local completion. Storage-clear failure is visible, not reported as complete sign-out.
5. Pass validated discovered token endpoint metadata to refresh instead of the hardcoded `/token`. Preserve PKCE/state/issuer checks. Validate token response fields and expiry bounds. If rotation succeeds remotely but storage fails, show reauthentication required; do not promise atomic rotation.

**11.2 — `fix(connection): propagate disconnect and enable explicit reconnect`**

1. Subscribe once at the existing Codex panel assembly to native lifecycle events. Update connecting/connected/error/disconnected state from transport reality. Dispose subscriptions on teardown and ignore stale-generation events.
2. Reconnect clears stale transport/client state and lists models again even if stale UI formerly said connected. Preserve visible history and stored Codex thread ID. Do not resubmit the failed turn; a user explicitly sends the next message.
3. Avoid replacing a useful interrupted conversation with a blank setup screen after a connection loss. Reuse connection cards/banner within the existing layout, keeping the prior answer visible and Send disabled until ready. Initial onboarding still uses SetupScreen.
4. Reapply effective research/model settings after reconnect, and expire all old plan/Auto/upload grants and baselines. Sign-out in one panel propagates to all panels.

**Regressions:** `tests/token-store.test.ts`, `tests/notion-facade.test.ts`, `tests/codex-connect.test.ts`, `tests/setup-screen.test.tsx`, `tests/codex/client.test.ts`, `tests/codex/loop-integration.test.ts`. Late refresh after sign-out and during clear, new-login race, two stores refresh, old invalid_grant, hung revocation, storage failure after rotation, stale disconnect notification, active-turn crash, reconnect/new chat/resume, and research-off preservation.

**Final tests:** EXT and BRIDGE gates; C02, C13, C14. **Wave C gate:** deletion, attachment ownership, final-save recovery, persistent sign-out, and non-replaying reconnect all work in two-panel browser tests.

## 7. Wave D — harden boundaries

### Epoch 12 — Unicode-safe, bounded, correlated protocols

**Findings:** M11, M12. **Depends on:** 03–04, 11. **Outcome:** valid Unicode survives byte splits; malformed/unbounded provider traffic fails predictably without stale buffers or mutation replay.

**Read/modify:** `bridge/nox-bridge.mjs`, `bridge/fixtures/fake-codex.mjs`, `bridge/test-bridge.mjs`, `bridge/PROTOCOL.md`, `extension/src/lib/codex/frame.ts`, `native.ts`, `client.ts`, `extension/src/lib/mcp/client.ts`, `sse.ts`, `jsonrpc.ts`.

**12.1 — `fix(bridge): decode stdout as a stream and cap line framing`**

1. Use `proc.stdout.setEncoding('utf8')` or Node `StringDecoder` once per child process before line framing. Reset decoder/buffer on restart and treat malformed/truncated final protocol data as an explicit failure.
2. Bound pending decoded line data before concatenating unlimited chunks. Preserve the existing 32 MiB inbound native limit and Chrome's less-than-1-MiB output envelope requirement; document bytes versus UTF-16 character counts explicitly.
3. Extend fake Codex to split two-, three-, and four-byte sequences inside both arguments and answer notifications. Include large non-ASCII frames, EOF midway through a sequence, restart, and overlong unterminated lines.

**12.2 — `fix(native): validate envelopes and bounded chunk assembly`**

1. Validate exact envelope discriminants and required types before dispatch. IDs must have the protocol's expected finite/integer form; unknown method/result IDs cannot settle unrelated promises. Do not coerce malformed values.
2. Bound active assemblies, chunk count, per-chunk and aggregate memory, and age. Initial limits: 8 active assemblies, 256 chunks per assembly, 32 MiB aggregate buffered text measured conservatively in bytes, 30-second incomplete-assembly lifetime. Keep protocol-compatible total-character checks as well as byte budgets. Confirm host chunk sizes fit for multibyte content.
3. Count actual chunks and compare `chunkEnd.chunks`. Reject unknown end, malformed frame, overflow, wrong total/count, and stale assembly; release memory immediately. Expiry must run even if no more frames arrive; dispose its timer on reset/disconnect.
4. Reply with bounded correlated errors for malformed requests only when a valid request ID is available. Otherwise fail/reset the transport; never echo an entire attacker-supplied frame into an error/log.

**12.3 — `fix(mcp): bound streaming bodies and match only requested responses`**

1. Replace unconditional `response.text()` with bounded streaming reading. Check actual received bytes, including error bodies; Content-Length is only an early check. Initial MCP response/event budget is 8 MiB, with the turn deadline bounding idle streams. Oversize results fail honestly and cannot trigger a mutation retry.
2. Parse SSE using response content type. Support CRLF/LF/CR line endings, comments, blank event delimiters, and multiline `data:` joined by newline, removing only the one optional space after colon. Ignore supported non-data fields; do not `.trim()` semantic data indiscriminately.
3. Decode UTF-8 incrementally, including CR/LF and JSON tokens split across chunks. Validate JSON-RPC shape and `result` versus `error`; accept only the matching request ID. Notifications and another ID's error never complete this call.
4. Stop and cancel the stream reader when the matching complete response arrives. Abort/reset readers on deadline/disconnect. Validate initialize/tool-list/tool-result shapes before using them; unsupported content parts remain bounded untrusted data rather than unsafe casts.
5. Connect malformed-response-after-write to epoch 04's unknown status. Preserve transport diagnostics using bounded codes, not body dumps.

**Regressions:** `tests/codex/native.test.ts`, `tests/codex/client.test.ts`, `tests/mcp-client.test.ts`, plus **new** `tests/codex/frame.test.ts` and `tests/mcp-sse.test.ts` if useful. Test exact limit and limit+1, wrong types, unknown IDs, missing EOF, all SSE separators, comments first, multiline data, never-ending stream, unrelated error preceding valid result, disconnect cleanup, and Unicode round trip.

**Final tests:** EXT and BRIDGE gates. **Must work:** German/CJK/emoji titles, search text, content arguments, and large answers are byte-semantically preserved; oversized/malformed traffic yields a recoverable connection error with no automatic write replay.

### Epoch 13 — narrow DNR, verified startup, and trusted-context storage

**Findings:** M13, L3. **Depends on:** 01, 11–12. **Outcome:** Nox's Origin exception applies only to its own MCP requests; metadata cannot impersonate navigation or read credentials.

**Read/modify:** `extension/src/background/dnr.ts`, `index.ts`, `extension/src/shared/messages.ts`, `extension/src/content/index.ts`, `extension/src/sidepanel/store.ts`, `notion-connect.ts`, `ConnectionCard.tsx`, `extension/src/lib/chrome-storage.ts`, `extension/src/lib/notion/index.ts`.

**13.1 — `fix(dnr): retain initiator scope and distinguish installed from verified`**

1. Delete variants lacking the extension initiator restriction. Scope the URL to the exact HTTPS MCP endpoint, including deliberate query handling; reject other paths, hosts, and suffix lookalikes. Keep resource type as narrow as verified Chrome permits.
2. Inspect installed rule equality, not merely ID plus remove-Origin action. If unsupported installation fails, remove the known Nox rule and report compatibility failure. Do not broaden scope for availability.
3. Fix the authentication/probe circularity explicitly: before OAuth, verify narrow rule installation only and show installed/unverified. Permit credential acquisition, then use a bounded authenticated read-only MCP initialization/probe from the owner to establish an accepted protocol response. Do not send tokens in runtime diagnostic messages or use an ordinary 401 as stripping evidence.
4. Block normal workspace operation until the scoped connection's authenticated acceptance is established. 401, 403, 429, 5xx, redirect, malformed protocol, missing status, and lookup exceptions are not verification success. After failed validation remove the rule, retain an actionable retry state, and reinstall narrowly on retry.
5. Describe this as endpoint compatibility acceptance, not direct observation of a removed header. Actual header scope is a supported-Chrome integration test. Require that evidence for each claimed supported Chrome family/version.

**13.2 — `fix(messages): validate source metadata and restrict storage access`**

1. Replace prefix-only `isNoxMessage` with exact discriminant and bounded field validation. Validate page UUID, title/icon string size, tab/window IDs, and URL format at receiving boundaries. Unknown message types are rejected.
2. Background uses validated `sender.tab.url` and current navigation state for identity. Check sender extension ID/context, tab/frame as appropriate, and stale URL mismatch. Content script title/icon remain untrusted labels, never targets that authorize writes.
3. Panel accepts current-page messages only from the expected extension background context and validates the full payload again. Control/deletion messages from epoch 09 have separate exact shapes and sender rules.
4. Set local credential-bearing Chrome storage access to `TRUSTED_CONTEXTS` at background initialization before credential use; session access stays equally restricted. If API support is required but unavailable, give a compatibility error rather than silently relaxing. Test content script metadata still works without storage access.

**Regressions:** `tests/dnr.test.ts`, `tests/notion-page.test.ts`, `tests/notion-facade.test.ts`, `tests/setup-screen.test.tsx`, `tests/live/connect-preflight.test.ts`; add **new** `tests/messages.test.ts`. Verify endpoint/suffix/path boundaries, foreign initiators, unknown probe results, cleanup, pre-OAuth versus post-auth stages, forged/stale metadata, oversized title/icon, and unknown discriminants.

**Final tests:** EXT gate; C15 plus setup reconnect checks. **Must work:** supported Chrome connects through one narrow rule, unsupported cases explain the failure, viewers/content scripts cannot read refresh credentials, and current-page navigation still updates correctly.

### Epoch 14 — private diagnostics and verified Codex boundary

**Finding:** L2; live isolation and evidence limits. **Depends on:** 11–13. **Outcome:** default support logs omit content, and supported model claims identify actual tested capabilities.

**Read/modify:** `extension/src/lib/log.ts`, `extension/src/lib/mcp/errors.ts`, `client.ts`, OAuth errors, `extension/src/sidepanel/ChatPanel.tsx`, `SettingsModal.tsx`, `extension/src/lib/codex/client.ts`, `research.ts`, `scripts/live/codex-smoke.mjs`, `docs/answer-quality-verification.md`.

**14.1 — `fix(diagnostics): export useful metadata without private content`**

1. Remove prompt-prefix logging. Log bounded event category, time/duration, safe status/error code, operation ID, and connection stage. Do not log arguments, inverse Markdown, page titles, upload URLs/form fields, bearer tokens, provider body strings, or full source queries by default.
2. Console capture must not blindly retain arbitrary exceptions as strings. Convert known errors to safe structured metadata and unknown errors to a generic category. Redaction of common credential keys is defense in depth, not the primary strategy.
3. Add “Review for private content before sharing” beside Copy logs. Copy is user-initiated; introduce no telemetry or automatic submission. Do not add detailed-diagnostics mode unless a real need appears.
4. Tests seed unique prompt/token/workspace/upload sentinels through each error path and assert their absence in the exact exported text while hop/status codes remain useful.

**14.2 — `test(codex): record versioned native-tool isolation evidence`**

1. Use the existing real-Codex smoke harness with synthetic data. Record exact resolved executable/version, OS, model ID, settings, surfaced native tools, feature/MCP inspection result, and whether a turn was actually submitted.
2. Verify disabled web research, no inherited MCP/connectors/plugins, shell/computer/browser/file/image/multi-agent restrictions, turn correlation, and no automatic replay for each model/version claimed supported. Do not infer tool isolation from writable temp cwd or read-only sandbox.
3. If an unexpected powerful native surface remains, fail closed for that unsupported combination or narrow the advertised support matrix. Do not weaken config allowlists or send provider secrets to Chrome to inspect it.
4. Record non-provable limits: observed native search may exceed the boundary in flight; no model can promise semantic instruction obedience. Keep a small matrix rather than building a statistical benchmark suite.

**Final tests:** `tests/errors.test.ts`, `tests/codex/research.test.ts`, `tests/codex/client.test.ts`, `tests/codex/loop-integration.test.ts`, **new** `tests/log.test.ts`; EXT, BRIDGE and ROOT gates, then opt-in existing real-Codex harness after inspecting its documented invocation. Never invent CLI flags. C16 checks log export in UI.

**Wave D gate:** strict protocol failures recover, DNR scope is verified in Chrome, content scripts cannot read credentials, diagnostics omit sentinels, and each supported model/version has actual boundary evidence or is explicitly unsupported.

## 8. Wave E — demonstrate and distribute honestly

### Epoch 15 — portable installation, patched tooling, complete archives

**Findings:** M15, L1, L4, L5; retained OAuth-spike concern. **Depends on:** 14. **Outcome:** artifacts contain the right notices, installation respects paths, and CI tests the tooling it ships.

**Read/modify:** `install.mjs`, `bridge/install.mjs`, `bridge/resolve-codex.mjs`, `scripts/release/install.mjs`, `scripts/release/README.md`, `scripts/package-release.mjs`, `scripts/release-smoke.mjs`, `.github/workflows/ci.yml`, `extension/package.json`, `extension/pnpm-lock.yaml`, font provenance/notices, retained OAuth spike under `spikes/` (locate its actual file before editing).

**15.1 — `fix(install): resolve explicit binaries and escape supported paths`**

1. Normalize every selected Codex executable to an absolute existing path, including PATH discovery. Cache successful discovery for the host lifetime. Support an explicit local binary override with a documented name and validation; do not silently ignore an invalid override and launch another version.
2. Keep candidate version checking bounded. Record the selected path/version locally for diagnosis without leaking provider configuration. Do not equate newest installed with tested-compatible.
3. Prefer `execFile`/argument arrays over shell strings. Where Windows batch/native wrappers are unavoidable, handle `%`, `&`, parentheses, quotes, and spaces according to the actual shell; Unix wrappers must safely quote quotes, dollar signs, and backticks. Do not use JSON escaping as shell escaping.
4. Add generated-wrapper fixture assertions using sentinel fake executables in temporary directories. Never execute attack strings against the real installer/registry just to demonstrate quoting. Include missing Corepack/pnpm, no Codex, unsupported browser, moved checkout, and update selection cases.
5. Provide explicit uninstall/update instructions for registrations and generated files. Keep user Codex login/history separate from Nox cleanup. Advertise only browser/OS combinations actually tested.
6. For the retained OAuth spike, either remove it if unused with link cleanup or bind callback to loopback, bound requests/timeouts, handle invalid callbacks without killing valid flow, and write token files atomically with restrictive permissions appropriate to the platform. Use synthetic tokens in tests; keep it clearly outside production auth.

**15.2 — `chore(test): update the vulnerable development dependency`**

1. Recheck the maintainer advisory and currently supported patched Vitest version at implementation time. The review names GHSA-82fw-gwwq-j7x9 and 4.1.11; that is historical input, not a permanent latest-version instruction.
2. Upgrade the smallest compatible patched dependency set with pnpm and regenerate the lockfile normally. Resolve real runner/API changes; do not skip tests or suppress dependency errors. Do not add a publicly reachable mocker/dev endpoint.
3. Run full tests/typecheck/build and both full and production audit. Record actual advisories/severity and distinguish the single development advisory's multiple dependency paths.

**15.3 — `fix(release): ship licenses and verify archive contents`**

1. Include root `LICENSE` in both GitHub and extension-only ZIPs. Assemble applicable notices for shipped JS and fonts from installed package metadata and authoritative font source/version/license files; do not invent provenance from filenames.
2. Package into a task-specific temporary staging directory. Do not delete unrelated `.release/` contents. Clean only verified paths owned by the packaging run; preserve source/build output.
3. Add **new** `scripts/package-release.test.mjs` that builds/inspects isolated synthetic or real staged archives. Assert LICENSE/notices, needed runtime files, no credentials/machine-specific manifests/dev-token UI assets, and version agreement. Inspect contents, not only command exit.
4. Establish one version source from existing package/manifest wiring. Chrome numeric version and optional alpha display/tag label must have a documented mapping; remove divergent hardcoded export/client/release labels or derive them. Do not rename an existing published release retroactively.
5. Extend CI push paths for root installer, scripts, manifests/version/notices, and CI files. Run existing root installer/evaluation tests and archive-content tests on pull requests, not only tags. Add explicit minimal token permissions and verified immutable action revisions. Add macOS checks before calling macOS tested; otherwise mark it unverified.

**Final tests:** EXT, BRIDGE, ROOT gates; **new** package-release test; full/production audits; isolated archive build and inspection; CI configuration review. C17 uses a disposable installation/profile, with user-managed auth. **Must work:** the supported install path runs, a special-character path is handled safely, artifacts are self-contained with notices, and installer-only changes trigger relevant checks.

### Epoch 16 — accurate claims and lightweight contributor instructions

**Findings:** D1, D2; supporting L4/L5. **Depends on:** 15. **Outcome:** public documents describe the actual tested alpha, and a model can find current guidance without obsolete instructions.

**Read/modify:** `README.md`, `PRIVACY.md`, `SUPPORT.md`, `SECURITY.md`, `CONTRIBUTING.md`, `AGENTS.md`, `docs/application.md`, `docs/THREAT-MODEL.md`, `docs/PERMISSIONS.md`, `docs/store-listing.md`, `docs/smoke.md`, `docs/RELEASING.md`, `docs/answer-quality-verification.md`, `docs/how-it-works.html`, stale source comments and release templates.

**16.1 — `docs: align product and safety claims with verified behavior`**

1. Work through every row of D1's claim table individually and mark its disposition in the execution record. Remove absolute injection-proof/no-silent-write claims. State exact runtime grants and remaining semantic/model limits.
2. Disclose Nox's lack of backend/telemetry separately from Notion, Codex provider processing, optional external research, upload destinations, local browser history, and Codex's own history. Local Delete all data does not delete remote Notion effects or Codex provider/history records.
3. State actual unsupported features: image/PDF analysis, generalized property/schema/move undo, creation deletion, and nonexistent dedicated autofill/quota orchestration. Do not implement these as unrelated feature work just to rescue marketing text.
4. Document exact plan thresholds, explicit Auto grant, full payload inspection, unknown outcomes, conservative undo, and final external-editor race. Describe DNR installed versus authenticated-accepted versus live header verification accurately.
5. Reconcile manifest permission table with `.notion.site`, DOM title/icon metadata, Web Locks, actual stores, and verified upload origins. Remove non-writable-temp-cwd and atomic-refresh claims.
6. Add a compact feature table: implemented, automated tests, live tested version/model, unsupported/pending. Link the release evidence, not old passing counts. Verify private security-reporting availability through repository settings if authorized, or accurately state it unverified.

**16.2 — `docs(contributing): remove stale context and architecture rules`**

1. After following the current AGENTS instructions for this task, replace mandatory full architecture reading for every trivial task with the review's relevance rule. Keep the existing security boundaries and relevant test commands concise.
2. Explain that pure library modules avoid browser globals while existing `*/panel.ts`, storage/settings, and assembly modules deliberately perform side effects. Remove stale blanket prohibitions and historical epoch commit syntax unless actually enforced.
3. Use `rg` to find missing `RESEARCH`, `MVP`, `docs/plans/E*.md` references; replace with current relevant sections where useful. Remove empty `CLAUDE.md` only if truly unused. Do not rewrite historical review/spike evidence as if it were current policy.

**Final checks:** `git diff --check`; verify local documentation links and each D1 claim against final symbols/evidence; compare manifest permissions and version labels. No runtime rerun for prose alone. **Must work:** a fresh reader understands exactly what consent, undo, deletion, isolation, and data processing do, including limitations. No public “10/10” or “no vulnerabilities” certification.

### Epoch 17 — integrated acceptance, smoothness review, and fresh adversarial pass

**Finding:** D3 plus final closure of all findings. **Depends on:** 01–16. **Outcome:** production assembly and a known loaded release candidate meet the complete acceptance matrix.

**Read/modify:** existing test suites, `docs/smoke.md`, `docs/answer-quality-verification.md`; create **new** `docs/adversarial-remediation-evidence.md` for sanitized results. Extend existing `scripts/release-smoke.mjs` rather than creating another runner framework.

**17.1 — `test: enforce integrated adversarial acceptance`**

1. Ensure each High finding has a deterministic regression that fails for the reviewed behavior and passes now. Keep a mapping from H1–H5 to test names and assertions. For large refactors, show failure at the relevant pre-fix parent commit or a temporary isolated worktree without touching the user's working tree; document fixture incompatibilities honestly.
2. Re-run the assembled consent matrix with actual frozen scopes, journal, scheduler, and production entry points. Include direct bypass attempts through undo, local tools, unknown tools, reserved fields, restored UI, and stale approvals.
3. Validate existing strong behavior was preserved: failed resume never substitutes a new thread, no replay after submission/disconnect, early events correlate correctly, completed answer replaces streamed content, only reasoning summaries render, late dynamic calls stop, continuation handles expire, ten-minute deadline includes context preparation, and tool counts remain bounded.
4. Run the full final suite: EXT, BRIDGE, ROOT, archive-content tests and audits. Record versions and counts from this run. Skipped opt-in cases are pending, not passed. Release smoke reports separate automated success and missing live acceptance; an actual publishing gate rejects missing required live evidence for features advertised in that release.

**17.2 — `test(browser): verify the loaded candidate in a scratch workspace`**

1. Run C01–C17 below against a build whose source commit/hash is recorded and matched to the loaded extension. Record bridge binary/model/Chrome/OS/account capability information. An extension version label alone is insufficient build identity.
2. Capture before/after scratch data, approval counts, journal IDs/statuses, and sanitized screenshots/network observations. Do not store tokens, OAuth callbacks, complete upload tickets, personal page contents, or unsanitized HAR files in the repository.
3. Review at approximately 320, 400, and 600 CSS-pixel panel widths, light/dark theme, keyboard-only navigation, and a long answer/plan. No clipped approval buttons, hidden late payload fields, stuck spinner, unexplained disabled control, jump away from inspected details, or invisible partial failure.
4. Refine only concrete friction found by these checks using existing components. Re-run affected narrow tests and scenarios after changes. Do not launch an unrelated visual redesign or hide necessary consent for a lower click count.

**17.3 — `docs: close findings with evidence and residual limitations`**

1. Perform a fresh adversarial pass through actual entry points, not only this checklist: attempt to bypass each gate, exploit stale state, alter a payload after consent, crash at await boundaries, and confuse workspace/turn identity. Include every new helper/adapter introduced by remediation.
2. Document any newly found issue with severity, repro, code path, regression, and fix epoch/commit. Fix release blockers before completion; do not relabel a defect an alpha limitation merely to finish.
3. Close each original ID only with test and live evidence where applicable. Retain explicit unsupported feature decisions and residual external race/provider constraints. Update public feature matrix and release notes from evidence.
4. Report implementation complete only when all required enabled-feature checks passed, no known High or material unresolved correctness/privacy blocker remains, and remaining limitations are accurate and accepted. Publishing remains a separate authorized action.

**Final tests:** complete final suite plus C01–C17 and the fresh review. **Wave E gate:** clean supported installation, smooth real workflow, consistent docs, no known unaddressed release blocker, and traceable evidence for every closure.

## 9. Cross-epoch traps to avoid

1. Do not repair H2 by merely deleting the Auto bypass and leaving every read-then-write with duplicate cards. Epochs 05–07 deliver exact scope plus usable inherited consent together.
2. Do not introduce an “intent authorized” field supplied by Codex or derive it from page presence. That would recreate self-authorization in a different object.
3. Do not approve a summary and then compare only target IDs. Full execution arguments, all objects, destinations, and counts matter.
4. Do not classify every tool error as a clean failed mutation. Partial bulk success, provider parse error, and post-send cancellation can all require unknown status.
5. Do not add journaling only to forward writes. Undo, upload ticket creation, and byte upload each have external effects and uncertain outcomes.
6. Do not make post-write verification depend on an already-aborted signal in a way that prevents outcome persistence. Respect cancellation of external work while still recording what is known locally.
7. Do not keep an IndexedDB transaction alive across network, UI approval, or hashing work. Build data first, use a short atomic storage transaction, then dispatch.
8. Do not broaden `connect-src`, DNR initiators, tool schema acceptance, or upload hosts just because a live contract changed. Verify and support the new contract deliberately.
9. Do not accidentally deadlock scheduler admission by acquiring its only slot before scheduling a guard read. Test reduced concurrency and long rate waits.
10. Do not clear only one panel's in-memory credential generation. Cross-context late writes and delayed storage operations need serialized generation checks.
11. Do not mark all complete-looking Markdown lossless. Recognized completeness and attributable post-image are required; rich-page undo stays unavailable unless separately proven.
12. Do not run destructive packaging in the user's existing `.release/` directory to test artifact contents. Use isolated staging.
13. Do not declare browser checks passed from mocked React tests, user-reported connection, or a working side-panel startup. The review already distinguishes these evidence levels.

## 10. Reusable test fixtures and result accounting

Use synthetic fixtures with names and IDs independent of personal workspaces. Store provider shapes with secrets and identifying strings replaced consistently; preserve field types and structural/truncation markers.

Suggested scratch objects, created only after the live test scope is authorized:

- Parent `Nox acceptance <date>-<short candidate hash>`.
- Plain page A: title `Plain A`; content `alpha\nbeta\ngamma`.
- Plain page B: title `Plain B`; content `do not change without separate approval`.
- Rich page R with a verified complex block and a partial-fetch fixture equivalent.
- Database D with a few synthetic rows and cosmetic view V; record actual data-source/view IDs.
- Small text file `nox-upload-sentinel.txt`, containing only `NOX_UPLOAD_TEST_<run-id>`.
- Malicious synthetic page I containing instructions to change B, create an undisclosed object, upload the file, and render an image URL containing a synthetic sentinel. The page is test data, never instructions for the test operator.

For deterministic fault injection use the existing fake transports/fake Codex and fake-indexeddb. If a fault requires a test-only build adapter, it must be development-only, impossible to enable from model input, and absent from production artifacts. Prefer test fixtures over adding fault controls to shipped UI.

Every live evidence row records: scenario ID; candidate source/build identity; Chrome/OS/bridge/model; capability/schema version/date; setup; steps performed; expected; actual; pass/fail/blocked; sanitized artifact path; linked test/commit; residual limits. Record maximum observed mutation concurrency and exact dispatch counts in deterministic tests. Ordinary Computer Use may observe visible state while instrumentation proves hidden effects.

## 11. Computer-use acceptance script

Before starting: get an authorized scratch parent/profile, complete OAuth manually if needed, identify the loaded build, and save clean screenshots/state. Stop live writes if an unexpected object is affected. Do not use a valuable page to test failures. Clean up only objects created by this run and only with authorized supported operations; otherwise provide a precise manual cleanup list.

| ID | Steps | Required visible/instrumented result |
|---|---|---|
| C01 — passive resources | Render synthetic Markdown and raw-image/media payloads through the real assistant renderer using a disposable fixture; open the saved conversation again; show a remote page icon; inspect extension network traffic to a controlled receiver. Click a normal safe source link separately. | Zero automatic requests to the receiver on render/history/icon display. Packaged icons work. Source navigation occurs only on the deliberate click. Do not require a live model to reproduce a known rendering sink. |
| C02 — research preference | Leave model/effort/tier at defaults; turn Web research off; close/reopen panel; send a harmless question; reconnect and change model; repeat. Also delay settings hydration in a fixture. | UI remains off, outgoing thread config requests disabled search, no send before hydration; actual research activity absent for the tested supported model. A config assertion and a model observation are recorded separately. |
| C03 — owner and viewer | Open Nox in two Chrome windows with a restored safely reversible entry. Try viewer timeline undo, owner undo during an active turn, and fast duplicate undo. Close owner, establish a new owner, and retry when safe. | Viewer cannot mutate; owner busy state explains undo refusal; one safe undo dispatch at most. New ownership does not replay work or inherit stale grants. |
| C04 — uncertain write | In controlled transport fixture, commit one creation then lose the response; restore panel. Separately fail storage before intent and after confirmed effect. | Exactly one creation dispatch; durable unknown on restart; no automatic retry/undo. Before-intent failure makes zero calls. After-success local failure shows applied/recovery warning in the live session. |
| C05 — complete approval | Ask for a fixture edit with >2,000 characters followed by an additional significant field/target. Open full details, keyboard-scroll to the end, reject once, then submit a fresh valid request and approve. | All relevant fields visible before approval; rejection makes zero effects; approved execution equals displayed canonical payload; no clipped Approve/Reject controls. |
| C06 — ordinary work | Search and fetch several synthetic pages. Ask for one small edit in Ask; one cosmetic view rename; one isolated move. Count cards and inspect exact changes. | Reads have zero plan/action cards. Small Ask edit has one action card. Cosmetic rename/single move use one action review without a workspace-plan ceremony. |
| C07 — scoped transformation | Propose a bounded multi-object plan on D; reject first. On a new request approve a concrete plan, then exercise covered actions and a fixture deviation with changed schema/destination or extra target. | Rejected plan writes nothing. Approved exact actions run once without redundant cards. Deviation/reuse is refused pending new review. Plan evidence links to actually retrieved items. |
| C08 — Auto and injection | In Auto, ask only to summarize I without enabling small edits. Then enable the explicit small-edit grant for A and request a supported small edit; simulate a write to B and an upload proposal from the malicious page. | No model-created plan grants consent. Analysis has no unapproved mutation. Granted A edit works without a redundant card; B/structural/upload effects need explicit review or are refused. Synthetic remote-image sentinel never auto-loads. Model refusal alone is not the deterministic boundary test. |
| C09 — cancel and outcome | Cancel while awaiting plan, action, guard read, scheduler wait, and after dispatch using fixtures; interrupt a real harmless scratch turn once. | Prompt Stop response; no later dispatch for pre-send cases; after-send effects remain applied/unknown as evidence dictates; partial answer survives; reconnect never replays. Missing interruption completion follows existing five-second disconnect behavior. |
| C10 — conflict and undo | Fetch A, edit it independently in Notion, then attempt the stale replacement. Perform a fresh supported plain edit, undo safely once. Edit after another Nox write and try undo. Try rich-page undo. | Stale write refused; fresh edit succeeds; one verified plain undo restores expected content; later human edit blocks undo; rich/unsupported inverse is clearly unavailable. Residual final external race remains documented. |
| C11 — file consent | Select sentinel file, remove it, select again, ask about it, reject upload, then explicitly approve upload if supported. Test a wrong-origin/redirect ticket in a fixture and fail insertion after successful upload. | Selection/removal causes no upload; no draft bytes persist; consent identifies file/destination; one supported upload only; wrong origin/redirect never receives bytes; uploaded-but-not-inserted state is visible. If contract unsupported, UI honestly disables upload. |
| C12 — history and attachments | Send two attached conversations, delete one, inspect its attachment rows, export the other; inject a partial-save failure followed by healthy storage and reopen. | Only deleted thread's owned blobs disappear; retained files remain; export explains metadata-only behavior; final save recovers and reopened answer/outcome matches latest successful state. |
| C13 — sign-out and deletion | With two panels, pause a refresh response, sign out, release it; repeat with Delete all data and a blocking DB fixture. Reopen. | No old credential resurrection; other panels close DB and stop writes; deletion completes or displays a specific blocker; never hangs with false success. Codex/Notion remote data is accurately outside local deletion. |
| C14 — disconnect recovery | Disconnect the native port during a harmless turn; reconnect through UI; start a new chat and resume an old one with a new user message. | Connection label matches transport, prior content remains visible, reconnect works, original Codex thread IDs preserved on resume, old submitted turn never repeats. |
| C15 — DNR and metadata | Inspect narrow dynamic rule and authenticated acceptance in supported Chrome; use browser instrumentation to compare own/foreign initiators and MCP/non-MCP paths; test malformed/stale metadata and content-script storage access. | Only Nox's intended endpoint requests lose Origin. 401/5xx/missing status do not falsely verify. Page navigation remains correct; content scripts cannot retrieve refresh tokens. Do not send actual tokens to a test receiver. |
| C16 — logs and layout | Seed synthetic prompt/error sentinels; copy logs; inspect them. At narrow/normal/wide widths and both themes review long answer, expanded payload, plan, unknown result and reconnect UI with keyboard. | No private sentinels/tickets/tokens in default export, useful status metadata present, sharing reminder adjacent. All critical controls readable/reachable; focus and scrolling stable. |
| C17 — clean candidate | Install the packaged candidate into disposable supported environment, verify identity/notices, connect manually, run read → Ask edit → scoped Auto edit → approved plan → supported undo → reopen history → sign out. | No undocumented reload workaround, duplicate effect/card, missing notice, misleading state, or hidden failure. Record unsupported OS/model cases instead of claiming universal support. |

## 12. Execution record and definition of done

Initial status: **planning only; no implementation or test execution claimed by this document**.

| Epoch | Code status | Commits | Automated evidence | Browser evidence | Blockers / next step |
|---|---|---|---|---|---|
| 01 | Locally implemented | `4d88919`, `050a8c6` | EXT gate passed: 372 passed, 7 opt-in skips | C01–C02 BLOCKED | Live Chrome/network and supported-model evidence still required |
| 02 | Locally implemented | `7c9c4a1`, `e10adc9` | EXT gate passed: 388 passed, 7 opt-in skips | C03 BLOCKED | Crash-time ambiguity open until epoch 04; start epoch 03 only |
| 03 | Locally implemented | `2ee12b6`, `a76628b` | EXT gate passed: 410 passed, 7 opt-in skips | Fixture evidence only | Durable intent still open until epoch 04; start epoch 04 only |
| 04 | Locally implemented | `70e0958`, `d90ad26` | EXT gate passed: 439 passed, 7 opt-in skips | C04/C09 BLOCKED | Wave A gate: High regressions have deterministic cover; H2/H3 open until Wave B |
| 05 | Locally implemented | `a913b7d`, `a00dd66` | EXT gate passed: 471 passed, 7 opt-in skips | C05 BLOCKED | Plan scope matching still open until epoch 06; start epoch 06 only |
| 06 | Locally implemented | `201772c`, `7737f2a` | EXT+BRIDGE gates passed: 512 passed, 7 opt-in skips | C06–C08 BLOCKED | Wave B continues with epoch 07; start epoch 07 only |
| 07 | Locally implemented | `adc2a35`, `3c5f309` | EXT gate passed: 534 passed, 7 opt-in skips | C09–C10 BLOCKED | Real provider normalization acceptance still required; start epoch 08 only |
| 08 | Locally implemented | `1be8a3c`, `4d05e54` | EXT gate passed: 550 passed, 7 opt-in skips | C11 BLOCKED | Upload disabled pending a live ticket fixture; start epoch 09 only |
| 09 | Locally implemented | `4d8eb62`, `c6c4722` | EXT gate passed: 580 passed, 7 opt-in skips | C12–C13 BLOCKED | Cross-context races need live two-panel proof; start epoch 10 only |
| 10 | Locally implemented | `61be414`, `4b3efb4` | EXT gate passed: 589 passed, 7 opt-in skips | C11–C12 BLOCKED | Cross-context races need live two-panel proof; start epoch 11 only |
| 11 | Locally implemented | `a3b326b`, `623221a` | EXT+BRIDGE gates passed: 606 passed, 7 opt-in skips | C02/C13/C14 BLOCKED | Wave C gate: local deletion/ownership/recovery/sign-out/reconnect cover; live two-panel proof still required; start epoch 12 only |
| 12 | Locally implemented | `507642c`, `8b4437d`, `931670e` | EXT+BRIDGE gates passed: 642 passed, 7 opt-in skips | Protocol fixture evidence only | Depends on 11; live Chrome/Codex/Notion proof still required; start epoch 13 only |
| 13 | Locally implemented | `57442a1`, `4b05463` | EXT gate passed: 686 passed, 7 opt-in skips | C15 BLOCKED | Supported Chrome evidence required; start epoch 14 only |
| 14 | Locally implemented | `4273ece`, `5692723` | EXT+BRIDGE+ROOT gates passed: 694 passed, 7 opt-in skips | C16 BLOCKED; native matrix pending live run | Live Chrome/Codex proof still required; start epoch 15 only |
| 15 | Locally implemented | `a101010`, `f7a6b3c`, `22d9562` | EXT+BRIDGE+ROOT gates passed: 694 passed, 7 opt-in skips; root 17 passed; full/prod audits clean | C17 BLOCKED | Live disposable-install evidence still required; start epoch 16 only |
| 16 | Locally implemented | `5c2021d`, `8c01e8e` | Docs-only: `pnpm typecheck` passed; `git diff --check`, doc-link, manifest/version checks passed; no runtime rerun per spec | Claim review complete locally; all C-IDs BLOCKED | Depends on 15; start epoch 17 only |
| 17 | Locally implemented | `486f04d`, `27ed656` | EXT+BRIDGE+ROOT gates passed: 714 passed, 7 opt-in skips; root 17 passed; full/prod audits clean | C01–C17 BLOCKED | Live scratch-workspace acceptance still required; publishing gate refuses without it |

After each epoch, add a concise dated entry here using this template:

```text
Epoch NN / date / candidate commit(s):
Implemented behavior:
Regressions observed failing before fix:
Commands actually run and results (include skips):
Browser scenario IDs, versions, actual observations:
Architecture/public claims updated:
Remaining defects, unsupported features, and acceptance blockers:
Next epoch and any contract changes the successor must know:
```

Epoch 01 / 2026-09-12 / candidate commits: `4d88919`, `050a8c6`
Implemented behavior: Markdown images render as clicked source links; raw media/resource HTML and resource attributes are removed; remote page-icon URLs use local fallbacks; the production extension CSP permits packaged assets and the verified Notion MCP/upload origins only. Chat and turn setup wait for settings hydration, report a retryable failure, apply research-only opt-out with default model settings, and preserve the effective research preference on model changes.
Regressions observed failing before fix: hostile current-page icon rendered a remote `<img>`; no extension-page CSP existed; chat rendered before delayed settings completed; a settings read failure still enabled chat; research-only false was omitted from `setOverrides`; model changes omitted the effective research preference. The Markdown renderer and its initial regression cases were already uncommitted when work began, so their pre-fix failure was not observed in this run.
Commands actually run and results (include skips): `pnpm exec vitest run tests/setup-screen.test.tsx tests/manifest.test.ts` initially failed 4 expected regressions; focused six-file suite passed 50 tests; `pnpm test` passed 372 tests with 7 opt-in live tests skipped; `pnpm typecheck` passed; `pnpm build` passed and emitted a manifest with the CSP; `pnpm dev` reached CRXJS ready state; `git diff --check` passed before this record update and is rerun below.
Browser scenario IDs, versions, actual observations: C01 BLOCKED — no loaded disposable Chrome extension plus controlled receiver/network instrumentation. C02 BLOCKED — no supported Codex/Notion session or designated live test scope. The CRXJS development server started, but no browser-side behavior is claimed.
Architecture/public claims updated: `docs/application.md` now describes non-loading rendering/page-icon behavior, the restrictive extension-page CSP, and hydration-gated settings startup.
Remaining defects, unsupported features, and acceptance blockers: H1 live network evidence and C01 remain pending; C02 remains pending. No browser/live check is counted as passed.
Next epoch and any contract changes the successor must know: Epoch 01's locally implementable work is complete. Start Epoch 02 only; do not treat C01/C02 as closed.

Epoch 02 / 2026-09-12 / candidate commits: `7c9c4a1`, `e10adc9`
Implemented behavior: `claimWindowRole` now exposes a read-only owner lease/generation; `WriteGate` denies mutations without that lease (deny by default), captures owner/connection generations on admission, and re-checks lease, connection generation, and cancellation immediately before dispatch inside one serial mutation runner shared by forward writes, upload effects (`runEffectExclusive`), and undo. `Notion` bumps a connection generation on connect/identity-refresh/sign-out. Undo is refused while a turn is active and new turns are refused while undo holds the runner. Both timeline undo and Undo-bar undo use the single `requestRuntimeUndo` path, which re-reads the journal entry from storage and lets the gate re-validate status/scope before dispatch; viewer/busy panels show a reason instead of an enabled undo control. `claimUndo` releases its claim when a storage read throws.
Regressions observed failing before fix: viewer writes/undo dispatched transport; queued mutations dispatched a second time after lease expiry and after connection change; three concurrent writes overlapped (max in-flight 3); `runEffectExclusive`/`isUndoActive`/`requestRuntimeUndo` did not exist; undo resolved during an active turn; `claimUndo` wedged after a storage throw (second claim returned null); restored viewer `ChatPanel` rendered an enabled “Undo this change” button with no reason text.
Commands actually run and results (include skips): new `tests/writes/ownership.test.ts` (11 tests) failed 10 before the fix and passes after; `pnpm exec vitest run` on the six touched suites passes 89 tests; full `pnpm test` passes 388 tests with 7 opt-in live tests skipped; `pnpm typecheck` passes; `pnpm build` passes; `git diff --check` passes.
Browser scenario IDs, versions, actual observations: C03 BLOCKED — no two-window live Chrome session with a designated scratch scope in this environment, so owner/viewer behavior is proven only by deterministic tests (viewer transport count zero, single in-flight dispatch). No browser/live check is counted as passed.
Architecture/public claims updated: `docs/application.md` change-safety paragraph now describes the single-owner serial runner, lease/connection/cancellation re-checks, turn/undo mutual exclusion, the single storage-validated undo path, and viewer/busy reason messaging.
Remaining defects, unsupported features, and acceptance blockers: crash-time ambiguity stays open until epoch 04 (a Web Lock cannot cancel an already-committed request; the next owner reconciles unresolved intent there). Cross-window undo reservation is still per-instance plus gate re-validation, not atomic. C03 remains pending. No browser/live check is counted as passed.
Next epoch and any contract changes the successor must know: Epoch 02's locally implementable work is complete. Start Epoch 03 only; do not treat C01/C02/C03 as closed. `WriteGate` construction without `ownership` now denies mutations — future tests must wire explicit owner fakes.

Epoch 03 / 2026-09-12 / candidate commits: `2ee12b6`, `a76628b`
Implemented behavior: `Scheduler.schedule` takes an explicit retry-safety option defaulting to no retry; `scheduleCallTool` derives it from the trusted local taxonomy (known reads recover, mutations/upload tickets/unknown run once) and `listTools` opts into read retry. A non-retryable post-dispatch failure throws `UncertainDispatchError` (original preserved as `cause`) unless it is a provable pre-dispatch failure (`isPreDispatchFailure`: local missing-token error) or a declared provider rejection (non-429/5xx HTTP, malformed-request RPC codes), which propagate as-is. `McpClient.send` checks abort after token acquisition so dispatch counts at fetch invocation. Admission reserves concurrency plus every applicable budget (search spends global and search) synchronously in one loop, rechecks on every wakeup, and releases exactly once; explicit `Retry-After` (seconds/date) is an uncapped minimum while generated backoff stays capped; waits past a caller deadline throw `SchedulerDeadlineError` before (re)dispatch.
Regressions observed failing before fix: search spent no global token (0 ms instead of ~1 s); mutations retried 503/429 with raw errors; 120-second `Retry-After` capped at 30 s; no deadline support (`deadline` unknown); `parseRetryAfter` unexported; fetch invoked when aborted pre-dispatch; `UncertainDispatchError` missing. The 03.1 set (11 failures) and 03.2 set (8 failures) were each observed red before their fix.
Commands actually run and results (include skips): focused four-file suites pass 87 tests; full `pnpm test` passes 410 tests with 7 opt-in live tests skipped; `pnpm typecheck` passes; `pnpm build` passes; `git diff --check` passes. One new test expectation was corrected during the run (`parseRetryAfter('-5')` coerces to 0 via `Date.parse` leniency — pre-existing, harmless short wait; not a production change).
Browser scenario IDs, versions, actual observations: none required — Final tests specify the EXT gate only. Ambiguous-failure evidence is deterministic fixture evidence (commit-then-503, 429-after-effect, lost-response shapes at scheduler/facade level). No browser/live check is counted as passed.
Architecture/public claims updated: `docs/application.md` Notion-connection paragraph now states reads-only retry, exactly-once mutations with uncertain outcomes, dual-budget search, atomic admission, minimum `Retry-After`, and deadline-bounded waits.
Remaining defects, unsupported features, and acceptance blockers: durable pending/unknown journal states still open until epoch 04 (uncertainty is currently a visible error, not a persisted record). Turn-deadline wiring into `scheduleCallTool` is not yet connected — the deadline mechanism is scheduler-tested but has no production caller; guard revalidation across waits belongs to epoch 07. Token-store internal throws conservatively surface as uncertain. `classifyError` was deliberately untouched, so `UncertainDispatchError` classifies as unknown with its UNCERTAIN message (and does not inherit the transient "retry" advice).
Next epoch and any contract changes the successor must know: Epoch 03's locally implementable work is complete. Start Epoch 04 only. `Scheduler.schedule` now defaults to no retry — future tests must pass `{ retryable: true }` for read-recovery paths. No reconnect path replays submitted mutations (verified by inspection: resume-never-replays, scheduler is the only retry mechanism, blob POST is single-attempt).

Epoch 04 / 2026-09-12 / candidate commits: `70e0958`, `d90ad26`
Implemented behavior: `JournalEntry` carries scope, pending/unknown status, frozen args, full pre-image, undo linkage (`undoOf`, `reservedByUndoOpId`), review marks, and outcome detail with no store/index migration; intent is persisted before dispatch (storage failure means zero calls) and settled to applied/failed/unknown under the same id, with applied recorded before verification and a visible applied-with-recovery-warning when the success record fails. Mutations require a persisted thread and workspace scope (the `unscoped` fallback is removed); unresolved entries block new writes/undo until marked reviewed; undo reserves its original in one local transaction and completes only when known applied. Restart restores pending/unknown/locked rows as prominent Needs-review activity with inspect links, narrow readback evidence (match never proves authorship), and no replay; cancellation before dispatch settles failed, after dispatch settles unknown, without abort breaking bookkeeping.
Regressions observed failing before fix: 26 failures across gate/history/history-turns/activity suites (no intent records, no scope refusal, silent journal-failure success, no conflict block, completed-looking unknowns, wedged reservations), plus repaired scaffolding (history.test.ts brace balance, ownership scope ordering). Each 04.1/04.2 half was verified green in isolation (430 and 439 passed respectively).
Commands actually run and results (include skips): focused six-file suites pass 110+ tests; full `pnpm test` passes 439 tests with 7 opt-in live tests skipped; `pnpm typecheck` passes; `pnpm build` passes; `git diff --check` passes. One outdated assertion replaced per the review itself (successful output after journal failure is now a storage error); one test expectation corrected (`parseRetryAfter('-5')` leniency, Epoch 03 run).
Browser scenario IDs, versions, actual observations: C04/C09 BLOCKED — no controlled transport fixture in live Chrome plus no designated scratch scope in this environment; crash/restart evidence is deterministic (fault-injected stores, fake-indexeddb atomicity race, scope-retention switch). No browser/live check is counted as passed.
Architecture/public claims updated: `docs/application.md` change-safety paragraph now describes pending intents, scope requirements, recovery warnings, Needs-review restore with readback, conflict blocking, and atomic undo reservation.
Remaining defects, unsupported features, and acceptance blockers: validated returned-object links are intentionally absent — no creation response shape is verified, and scanning untrusted result text for UUIDs would risk linking the wrong object (Epoch 07 provider contracts). Per-object bulk accounting awaits validated effects (Epoch 05/06). H2/H3 remain intentionally open until Wave B. No browser/live check is counted as passed.
Next epoch and any contract changes the successor must know: Epoch 04's locally implementable work is complete. Start Epoch 05 only; do not treat C01–C04/C09 as closed. `WriteGate` now requires `getWorkspaceId` and a threaded journal for mutations — future tests must wire both. `JournalStore` has optional `get`/`listForThread`/`reserveUndo` (memory + IDB implement all three); timestamps are local high-water with a deterministic (ts, id) tie-breaker instead of full-store scans.

Epoch 05 / 2026-09-12 / candidate commits: `a913b7d`, `a00dd66`
Implemented behavior: every mutation proposal is parsed once into a validated effect (canonical frozen args, targets, parents, count, risk, plan/baseline flags) within a 512 KiB / depth-20 / 100-entry budget; unknown shapes are unsupported, malformed ones invalid, and model-supplied `__nox_expected_hash` is refused before any card or transport. Approval cards show the complete canonical payload with targets, count, and destructive flags outside the collapsible details; approving dispatches the frozen snapshot (never the live request object); approve-all is removed and stale/double answers return false. Plans validate every field with 1–10 operations, and evidence must be ledger-recorded retrievals in the current thread — unknown ids fail with model-readable errors before any card. A fixed undo-transport leak now strips internal hashes before provider bytes.
Regressions observed failing before fix: 05.1 (6 failures: missing effects module, ask-mode hangs on unvalidated proposals, oversize dispatch, uncanonical journal, hash reaching transport) and 05.2 (11 failures plus a plan-sutie load error: sliced payloads, resolve-leaking cards, approve-all present, fabricated/null/numeric/duplicate/oversize evidence accepted, uninspected plans creating cards).
Commands actually run and results (include skips): focused suites pass 99 tests; full `pnpm test` passes 471 tests with 7 opt-in live tests skipped; `pnpm typecheck` passes; `pnpm build` passes; `git diff --check` passes. Two test-side corrections during the run (normalized-id expectation, static-markup zustand blindness); one outdated test reshaped to a well-formed move (targetless moves are now invalid by design).
Browser scenario IDs, versions, actual observations: C05 BLOCKED — no loaded disposable extension plus designated scratch scope in this environment, so the one-card Ask flow is proven only deterministically (frozen-dispatch identity, full-payload rendering). No browser/live check is counted as passed.
Architecture/public claims updated: `docs/application.md` change-safety paragraph now describes validated effects with size budgets, refusal before consent, complete inspectable payloads with frozen dispatch, no approve-all, 1–10 validated plan operations, and ledger-backed evidence.
Remaining defects, unsupported features, and acceptance blockers: plan scope matching (exact operation grants, consumption, Auto grant, thresholds) is intentionally Epoch 06; readback normalization and provider-specific completeness stay Epoch 07; upload consent hardening stays Epoch 08. No browser/live check is counted as passed.
Next epoch and any contract changes the successor must know: Epoch 05's locally implementable work is complete. Start Epoch 06 only; do not treat C01–C05 as closed. `ApprovalEngine.request` now resolves `{ approved, frozenArgs }`, `answer` returns boolean with no approve-all path, and plan validation requires an evidence scope — future tests must wire all three.

Epoch 06 / 2026-09-13 / candidate commits: `201772c`, `7737f2a`
Implemented behavior: plans carry complete validated arguments with unique labels and bind approval to one-use exact-effect reservations scoped to workspace/connection/thread/turn (consumed at dispatch, revalidated before it); omitted targets match nothing, repeats and concurrent duplicates are refused, stale scopes fail closed, and creation references resolve only through verified exact-count slots (none verified yet, so follow-ups need a second concrete plan). Auto self-approval is gone in both modes; silent Auto edits happen only under the explicit per-turn small-edit composer grant for listed pages (property updates and text additions, five effects), with view renames and single moves on ordinary approval, reads free of consent, and provenance based on actual content rather than callback presence.
Regressions observed failing before fix: 06.1 (18 failures: wildcard/omitted/reusable matching, auto self-approval, missing args/refs/scope plumbing) and 06.2 (23 failures: silent Auto without grant, unscoped/excluded/untrusted grant escapes, uncapped effects, plan-gated reads, callback-presence taint, bypass prompts, missing grant control). Each half was verified green before its commit (487 and 512 passed respectively).
Commands actually run and results (include skips): full `pnpm test` passes 512 tests with 7 opt-in live tests skipped; `pnpm typecheck` passes; `pnpm build` passes; `node bridge/test-bridge.mjs` passes (all bridge checks); `git diff --check` passes. Replaced assertions that enshrined removed behavior (Auto structural bypass, approve-all, auto plan continuation) with stronger boundary tests; test-only bugs fixed during the run (harness property redefinition, unscoped test fixtures).
Browser scenario IDs, versions, actual observations: C06–C08 BLOCKED — no loaded disposable extension, scratch workspace, or supported-model session in this environment; the consent matrix (reads zero cards, one Ask card, granted Auto zero redundant cards, one plan covering ten exact ops within 11 of 12 dynamic calls) is proven deterministically only. No browser/live check is counted as passed.
Architecture/public claims updated: `docs/application.md` now describes exact one-use plan coverage with creation references, consent-free reads, rename/move exceptions, and the per-turn Auto grant with its five-effect cap.
Remaining defects, unsupported features, and acceptance blockers: provider result-shape verification stays Epoch 07 (all creation slots unverifiable until then); upload consent hardening stays Epoch 08; H2/H3 regressions now pass deterministically with live-model confirmation deferred to Epoch 17. No browser/live check is counted as passed.
Next epoch and any contract changes the successor must know: Epoch 06's locally implementable work is complete. Start Epoch 07 only; do not treat C01–C08 as closed. `PlanEngine.request/authorize` now take scope/effect with reservation lifecycle (`checkReservation`/`consume`/`invalidateApproval`); `WriteGate` needs `getSmallEditGrant`/`recordUnplannedEffects`; `requiresWorkspacePlan` takes the tool name; `evaluateApproval` takes the grant; `prepareAgentTurn`/`Composer.onSend` carry the grant flag.

Epoch 07 / 2026-09-13 / candidate commits: `adc2a35`, `3c5f309`
Implemented behavior: new `lib/notion/page-content.ts` normalizes every `notion-fetch` envelope (never raw concatenated text) into complete/partial/unavailable records preserving `truncated`/`unknown_block_ids`; redacted fixtures cover plain, rich, partial, unavailable, and tool-error shapes. Content replacement needs a complete model-observed baseline scoped to thread/workspace/connection — tool-error, partial, unavailable, and wrapper payloads never authorize it, guard-only reads never populate it, and a missing baseline (resume/reconnect/scope change) forces a re-fetch. The frozen baseline hash binds approval; the gate re-checks it at guard time and again immediately before dispatch (no scheduler slot held across reads), retiring it after a write or unknown outcome. Content inverses additionally require a verified complete plain baseline plus attributable post-write state with the trusted post-hash confirmed before undo; creations, properties, schema, views, moves, and rich content stay not-undoable with precise reasons and target links in activity/history, and unverifiable readback reports applied-but-unverified. Mention context labels provider-partial reads partial.
Regressions observed failing before fix: 6 pre-existing content-write tests failed once baselines were required (replacement without any observed read reached dispatch — the reviewed M3 branches); new normalization tests caught a JSON fallback swallowing `WRAPPER_MISMATCH`/`UNAVAILABLE` refusals into plain-text completeness. Updated tests now establish baselines before dispatch; replaced contract assertions are documented in the test names. Each half verified green before its commit.
Commands actually run and results (include skips): focused suites (`tests/writes/gate.test.ts`, `tests/notion/page-content.test.ts`, `tests/agent/agent-modules.test.ts`, `tests/history-turns.test.ts`, `tests/history.test.ts`, `tests/codex/loop-integration.test.ts`, activity/viewer suites) pass; full `pnpm test` passes 534 tests with 7 opt-in live tests skipped; `pnpm typecheck` passes; `pnpm build` passes; `git diff --check` passes. No test was weakened: the 6 updated tests assert strictly more (baseline + original guard behavior).
Browser scenario IDs, versions, actual observations: C09–C10 BLOCKED — no loaded disposable extension, scratch workspace, or supported-model session in this environment; cancel/conflict/undo behavior (stale refusal with reread path, one verified plain undo, rich not-undoable, unverifiable readback) is proven deterministically only. No browser/live check is counted as passed.
Architecture/public claims updated: `docs/application.md` change-safety paragraph now describes complete-baseline-gated replacement with frozen approval binding, dual guard rechecks, baseline retirement, the documented final external race, verified plain-only inverses with post-hash confirmation, precise not-undoable reasons with target links, and honest unverifiable readback.
Remaining defects, unsupported features, and acceptance blockers: real provider normalization acceptance is still mandatory before enabling replacement/undo for any shape beyond the documented synthetic fixtures (C10 live); scheduler-internal rate waits after the final recheck remain a documented residual alongside the final race; upload consent hardening stays Epoch 08. No browser/live check is counted as passed.
Next epoch and any contract changes the successor must know: Epoch 07's locally implementable work is complete. Start Epoch 08 only; do not treat C01–C10 as closed. `WriteGate` baselines are per-instance memory (`rememberPageRead`/`rememberNormalizedRead`); `fetchPageMarkdown` deps must throw (never return) tool-error text; `WriteGateDeps.callTool` results now carry `isError`; `buildInverse` needs `baselineComplete: true` for content inverses; `ActivityItem` tool rows may carry `notUndoableReason`.

Epoch 08 / 2026-09-13 / candidate commits: `1be8a3c`, `4d05e54`
Implemented behavior: `nox-upload-local-file` is advertised only when the discovered list carries the ticket tool, the capability gate allows it, AND the ticket envelope is verified — the envelope is unverified, so the tool stays hidden and the raw `notion-create-file-upload` route is never advertised and is refused as an unsupported effect at the gate. Upload calls fail closed with `UPLOAD_UNSUPPORTED` after turn-membership, existence, metadata-integrity, thread-mismatch, and capability checks, with zero ticket creation, transport, or journal rows. Ticket validation is fail-closed against the authoritative REST file-upload reference (developers.notion.com, API 2026-03-11): `file_upload` object with `id`/`upload_url`, exact-origin comparison (never suffixes), no URL credentials, verified path shape, single `file` multipart field, `redirect: manual` with redirect refusal before bytes reach the target, no bearer outside MCP, bounded response reading, single-part only, `uploaded`-status attribution to the ticket id, and uploaded-but-unattached outcomes since attachment is a separate step. The guessed `form_fields`/`field_name`/`suggested_markdown`/`url` aliases are removed. CSP drops the unverified `uploads.notion.com` origin; instructions, architect rules, composer default text, smoke checklist, and architecture docs state the unsupported limitation.
Regressions observed failing before fix: the pre-fix suite enshrined the reviewed defects (unconditional advertisement, any-HTTPS POST, guessed aliases, CSP upload origin) — those assertions were replaced with the refusal/validation matrix. Each half verified green before its commit.
Commands actually run and results (include skips): focused suites (`tests/attachment-upload.test.ts`, `tests/attachments.test.ts`, `tests/capabilities.test.ts`, `tests/agent/agent-modules.test.ts`, `tests/writes/gate.test.ts`, `tests/manifest.test.ts`, `tests/writes/ownership.test.ts`) pass; full `pnpm test` passes 550 tests with 7 opt-in live tests skipped; `pnpm typecheck` passes; `pnpm build` passes; `git diff --check` passes. No test was weakened.
Browser scenario IDs, versions, actual observations: C11 BLOCKED — no loaded disposable extension, scratch workspace, or supported-model session in this environment; selection-without-upload, refusal paths, wrong-origin/redirect rejection, staged outcomes, and the narrowed CSP are proven deterministically only (transport-level fetch fakes). No browser/live check is counted as passed.
Architecture/public claims updated: `docs/application.md` now states the upload-unsupported limitation with its reason, the advertisement/identity/raw-route boundaries, fail-closed validation rules, uploaded-but-unattached outcomes, and the MCP-only CSP; `docs/smoke.md` no longer claims upload works; model instructions, architect rules, mention context, and the composer default text describe local-only files.
Remaining defects, unsupported features, and acceptance blockers: file upload into Notion is an explicitly unsupported alpha limitation until a redacted live MCP ticket fixture verifies the envelope (then advertisement, consent-card, staged-journal, and CSP work can be enabled in a later epoch — the hardened validator is ready for that fixture); `host_permissions` still contains the pre-existing broad `*.notion.com` entry (Epoch 13 scope); attachment thread-ownership migration stays Epoch 10. No browser/live check is counted as passed. Wave B gate: H2/H3 deterministic regressions pass; reads/small edits unaffected (full suite green); every enabled effect has a verified adapter, with upload explicitly disabled rather than passed.
Next epoch and any contract changes the successor must know: Epoch 08's locally implementable work is complete. Start Epoch 09 only; do not treat C01–C11 as closed. `toDynamicTools` no longer emits upload tools (expectation changes in `tests/agent/agent-modules.test.ts`); `uploadLocalAttachment` now requires a `VerifiedUploadContract` and returns `UploadResult` (no markdown string); `isUploadTicketContractVerified()` is the single enablement switch (false); CSP `connect-src` is MCP-only.

Epoch 09 / 2026-09-13 / candidate commits: `4d8eb62`, `c6c4722`
Implemented behavior: one cached IndexedDB connection per panel with prompt close on versionchange/blocking/termination instead of an ever-growing set; cooperative deletion via a session tombstone plus live storage events (other panels cancel turns, close, and refuse to reopen while it stands; missed events repair from the mark; stale crashed-deleter marks clear); credentials clear before database deletion through a named Epoch-11 seam; blocked deletions surface "Another Nox window is keeping storage open; close it to finish" while preserving the real request lifecycle; the UndoBar shows an event-driven thread-scoped count (journal changes, thread switches, deletion notices) instead of 3-second full-journal polls. Turn persistence uses a recoverable queue (one in-flight plus latest waiting partial; finals supersede partials and are never overwritten; each save settles individually; identities captured up front), with "History could not be saved" plus snapshot retry (never a model rerun) and copy near the affected answer.
Regressions observed failing before fix: new lifecycle tests fail against the old connection-per-call factory (reuse/blocking); new queue tests fail against the old poison-on-first-failure tail (M16 core); old tests calling `db.close()` directly on the now-cached connection were updated to the managed close. Each half verified green before its commit.
Commands actually run and results (include skips): focused suites (`tests/db/db.test.ts`, `tests/history.test.ts`, `tests/history/deletion.test.ts`, `tests/history-turns.test.ts`, `tests/activity-ui.test.tsx`, `tests/viewer.test.tsx`) pass; full `pnpm test` passes 580 tests with 7 opt-in live tests skipped; `pnpm typecheck` passes; `pnpm build` passes; `git diff --check` passes. One process note: an intermediate file operation reverted `tests/history.test.ts` mid-epoch; the affected edits were redone and re-verified before committing, and the final diff was re-inspected.
Browser scenario IDs, versions, actual observations: C12–C13 BLOCKED — no two-panel live Chrome session, scratch workspace, or supported-model turn in this environment; connection reuse, versionchange-close, blocked-then-completing deletion, queue recovery, and retry are proven deterministically only (real fake-indexeddb versionchange/blocked events, transport-free fakes). No browser/live check is counted as passed.
Architecture/public claims updated: `docs/application.md` local-data section now describes the single cached connection with prompt close, cooperative deletion ordering with credentials first, the UndoBar event-driven count, and the recoverable persistence queue with its save-failure banner.
Remaining defects, unsupported features, and acceptance blockers: cross-panel races (missed-event timing, hung revocation-adjacent hangs) need live two-window proof in C13; a panel that completes deletion while another stays open leaves the other on a fresh empty database on next open (accepted, documented); attachment thread-ownership migration stays Epoch 10; serialized credential-generation races stay Epoch 11. No browser/live check is counted as passed.
Next epoch and any contract changes the successor must know: Epoch 09's locally implementable work is complete. Start Epoch 10 only; do not treat C01–C13 as closed. `openNoxDB` is cached per panel and throws DELETION_PENDING while deleting (tests must use `closeNoxDBConnections()` instead of raw `db.close()`, plus `__resetConnectionCacheForTests`/`__resetDeletionStateForTests` for isolation); `deleteAllData` takes `{ deletionStore, clearCredentials, onBlocked, deleteDatabase }`; `MutationJournal` has `onChange`/`undoableCount`; `startPersistedTurn` returns `{ threadId, persistAssistant, retryFinal, onSaveError }`; `TurnView` may carry `historyError`.

Epoch 10 / 2026-09-13 / candidate commits: `61be414`, `4b3efb4`
Implemented behavior: file selection writes nothing — drafts (stable ids, `File` handles) live only in composer memory, so removing a chip, starting a new chat, or refreshing leaves no rows; selection is bounded to ten files, 20 MiB per file, 25 MiB total with every rejected file named plus its reason, checked from `File.size` before any bytes are read. Send stages bytes, then commits thread creation, the user message, and attachment rows with thread ownership in one bounded transaction (`ThreadRepository.beginTurn`, attachments via `add` so an id is never reused across threads); only those committed ids reach `prepareAgentTurn` and the model context, and a persistence failure sends nothing (no Codex/upload request) while the composer retains its draft with the reason. `deleteThread` reads message/journal/attachment keys inside the same four-store transaction that deletes them, preserving other threads and unlinked legacy rows; startup runs `removeUnlinkedAttachments` (no-thread or dangling-thread rows only, retained ids excluded, never filename guessing); exports carry attachment metadata scalars and exclude bytes/blob content, tickets, and tokens.
Regressions observed failing before fix: 10.1 set failed 5 (missing draft/validation/beginTurn surface); 10.2 set failed 4 (owned bytes survived thread deletion, exports carried no attachment metadata, no orphan cleanup). Each half verified green before its commit. One test-side correction during the run (export test used `listThreads()[0]` in a shared fake-indexeddb database and grabbed a foreign thread; it now uses the returned thread id).
Commands actually run and results (include skips): focused suites (`tests/attachments.test.ts`, `tests/history.test.ts`, `tests/history-turns.test.ts`, `tests/viewer.test.tsx`, `tests/activity-ui.test.tsx`) pass; full `pnpm test` passes 589 tests with 7 opt-in live tests skipped (585 after 10.1, 589 after 10.2); `pnpm typecheck` passes; `pnpm build` passes; `git diff --check` passes. No test was weakened (`tests/db/db.test.ts` covers unrelated query helpers and was left untouched).
Browser scenario IDs, versions, actual observations: C11–C12 BLOCKED — no loaded disposable extension, scratch workspace, or supported-model session in this environment; chip/draft behavior, failed-send draft retention, thread-deletion byte removal, and export disclosure are proven deterministically only (fake-indexeddb, transport-free fakes). No browser/live check is counted as passed.
Architecture/public claims updated: `docs/application.md` now describes ephemeral in-memory drafts with limits, the atomic send (committed ids only, failure sends nothing), thread-atomic attachment deletion, startup orphan cleanup without filename guessing, and metadata-only exports.
Remaining defects, unsupported features, and acceptance blockers: file upload into Notion stays explicitly unsupported (Epoch 08 — atomic ownership is the boundary the enabled flow must use); `attachmentRepository.removeForThread` is retained but no longer on the thread-deletion path (covered by the atomic transaction); a second panel mounting during another panel's in-flight legacy turn could clean rows that turn references, failing safe as `ATTACHMENT_UNAVAILABLE` (new code never creates such rows). C11/C12 remain pending. No browser/live check is counted as passed.
Next epoch and any contract changes the successor must know: Epoch 10's locally implementable work is complete. Start Epoch 11 only; do not treat C01–C13 as closed. `Composer.onSend` now takes `DraftAttachment[]` and returns `Promise<void> | void`, clearing only on success; `ChatPanel.send` persists before `prepareAgentTurn`/Codex and rethrows attachment failures; `startPersistedTurn` takes optional owned attachments via `repo.beginTurn` (repositories without it fail closed on attachments); `ThreadRepository` has `beginTurn` and metadata-only `exportThread`; `removeUnlinkedAttachments(db, retainedIds?)` is the only orphan path.

Epoch 11 / 2026-09-13 / candidate commits: `a3b326b`, `623221a`
Implemented behavior: credential generations persist (`notion.credGen`); `beginLogin`/new logins, sign-out, wipe, and delete-all invalidate the generation first under a short shared Web Lock (`nox-credential-write`, never across network); refresh serializes across panels under a separate refresh lock with an atomic generation+token snapshot and an inside-the-lock recheck, so late responses cannot resurrect and old `invalid_grant` cannot wipe a newer login; refresh uses the validated discovered HTTPS token endpoint (fail-closed, no hardcoded fallback when discovery exists); token responses validate access/refresh/expiry bounds; rotation that succeeds remotely but cannot be persisted returns reauth-required with UI signal. Sign-out captures the revocation token, cancels turns/grants, clears promptly, revokes best-effort with a five-second abort, and reports storage failure as incomplete; re-auth signals surface as connection errors; sign-out in one panel propagates via storage events; delete-all wipes through the shared generation path. Codex disconnects/exited statuses downgrade the store (stale generations ignored); explicit reconnect clears stale transport, lists models again even when the UI said connected, preserves history/thread ID, never replays turns, reapplies research/model settings, and expires plan/Auto/upload grants plus baselines; post-loss panels keep the conversation with a reconnect banner and disabled Send (initial onboarding still uses SetupScreen).
Regressions observed failing before fix: unfinished prior work left `validateTokenResponse`/`wipeLocked` undefined (all token-store tests failed); forced-refresh early-return skipped network (9 failures); nested same-name test lock deadlocked (4 timeouts); cross-instance snapshot race resurrected stale tokens (3 failures); invalid non-HTTPS endpoint fell back to hardcoded (1 failure). Each was observed failing, then fixed; old sequential-refresh and test-lock expectations were updated to the stronger serialized-generation contract with per-name locks and in-flight waits.
Commands actually run and results (include skips): narrow `tests/token-store.test.ts` (22), `tests/notion-facade.test.ts` (14), `tests/codex-connect.test.ts` (6), `tests/setup-screen.test.tsx` (11), `tests/codex/client.test.ts` + `tests/codex/loop-integration.test.ts` + `tests/codex/native.test.ts` pass (98 across the six Epoch-11 files); full `pnpm test` passes 606 tests with 7 opt-in live skips; `pnpm typecheck` passes; `pnpm build` passes; `node bridge/test-bridge.mjs` passes; `git diff --check` passes. No test was weakened (old refresh/serializer assertions replaced with generation-scoped equivalents plus new in-flight coverage).
Browser scenario IDs, versions, actual observations: C02/C13/C14 BLOCKED — no loaded disposable extension, designated scratch workspace, supported Codex/Notion session, or two-panel live Chrome in this environment; persistent sign-out, non-replaying reconnect, research-off reapply, and banner/Send-disabled behavior are proven deterministically only (shared-lock fakes, deferred-gate races, jsdom banner). No browser/live check is counted as passed.
Architecture/public claims updated: `docs/application.md` now describes generation-scoped rotation with shared locks and the discovered endpoint, prompt sign-out with timeout revocation and visible storage failure, cross-panel sign-out propagation, delete-all via the shared path, transport-reality Codex labels, explicit non-replaying reconnect with settings reapply and grant/baseline expiry, and the post-loss banner with disabled Send.
Remaining defects, unsupported features, and acceptance blockers: live two-panel sign-out timing, real-bridge disconnect/reconnect with a supported model, and research-off observation still need C02/C13/C14 in a designated live scope; no model-semantic intent guarantee is claimed (explicit grant only); residual external-editor race from Epoch 07 remains documented. No browser/live check is counted as passed. Wave C gate: deletion, attachment ownership, final-save recovery, persistent sign-out, and non-replaying reconnect have deterministic cover; live two-panel proof stays pending.
Next epoch and any contract changes the successor must know: Epoch 11's locally implementable work is complete. Start Epoch 12 only; do not treat C01–C14 as closed. `TokenStore` now takes `{ lock, getTokenEndpoint }` with `validateTokenResponse`, `beginLogin`, generation-scoped `signOut`/`wipe`, and `REVOCATION_TIMEOUT_MS`; `Notion.connect` calls `beginLogin` and supplies the discovered endpoint; `deleteAllData` callers must pass `clearCredentials: () => notion.tokens.wipe()`; `WriteGate.expireBaselines()`, `turn-access.invalidate()`/`expireAgentGrants()`, `ensureCodexLifecycleSubscribed`/`reconnectCodexAction`/`__resetCodexConnectForTests`, `watchCredentialSignout`/`wireNotionReauthHandler`, and `Composer sendDisabledReason` are the reconnect/sign-out seams; test `serialLock` helpers must be per-name (matching Web Locks) with in-flight waits for deferred races.

Epoch 12 / 2026-09-14 / candidate commits: `507642c`, `8b4437d`, `931670e`
Implemented behavior: Codex stdout decodes as a UTF-8 stream with a per-process StringDecoder and an 8 MiB line cap; truncated/malformed lines are discarded with bounded diagnostics and never cross a restart. The extension validates every native envelope without coercion (finite-integer rids, `cN` cids, string methods, record params), reassembles at most 8 chunked envelopes with 256 chunks/512 KiB per-chunk/32 MiB aggregate/30-second expiry plus exact `chunks`/`totalChars` checks, answers malformed Codex requests with a bounded correlated error only on a valid rid, and drops stale traffic without settling unrelated promises. MCP bodies stream through an 8 MiB budget with Content-Length early checks, content-type-driven SSE (CRLF/LF/CR, comments, newline-joined data with single-space stripping), incremental UTF-8, strict request-id matching, early reader cancel on match, and validated initialize/tool-list/tool-result shapes; oversize/malformed failures are honest errors that become unknown outcomes after dispatch via the existing no-retry path.
Regressions observed failing before fix: bridge split-`€` round trip corrupted to replacement chars (`2-byte split delta corrupted`); `ChunkAssembler` ignored `chunks` counts, accepted wrong types, and grew without active/chunk/byte/age bounds (6 new frame tests failed); `NativeBridge` coerced `rid`/`method`/`params` and forwarded 4 malformed req shapes plus a numeric-`method` notif (3 new native tests failed); `CodexClient` emitted tool calls for numeric tool/string arguments and corrupted answers with numeric deltas (`12345hello`, 2 tests failed); `parseSseOrJson` failed CRLF/CR/comment-first inputs and `pickResponse` adopted unrelated/null-id errors (5 new SSE tests failed); `McpClient` buffered unbounded bodies so 9 MiB and lying Content-Length both resolved instead of rejecting (2 tests failed). Each set was observed red before its fix.
Commands actually run and results (include skips): narrow `tests/codex/frame.test.ts` (9), `tests/codex/native.test.ts` (22), `tests/codex/client.test.ts` (33), `tests/mcp-client.test.ts` (26), `tests/mcp-sse.test.ts` (11) pass (101 across the five Epoch-12 files); full `pnpm test` passes 642 tests with 7 opt-in live skips; `pnpm typecheck` passes (after one test-side type correction for the caught-error union); `pnpm build` passes; `node bridge/test-bridge.mjs` passes (unicode 2/3/4-byte splits, unicode tool args, 512K-char large frame under cap, overlong discard, EOF restart, crash budget); `git diff --check` passes. One outdated assertion replaced per the review itself (`pickResponse` unrelated-error fallback is now undefined); no test was weakened.
Browser scenario IDs, versions, actual observations: no C-IDs required by Epoch 12 beyond fixture evidence — Final tests specify EXT and BRIDGE gates only. German/CJK/emoji titles, search text, content arguments, and large answers are byte-preserved deterministically (fake-Codex byte-split fixtures plus jsdom chunk reassembly). No loaded disposable Chrome/Codex/Notion session in this environment; no browser/live check is counted as passed.
Architecture/public claims updated: `docs/application.md` Notion-connection paragraph now states the 8 MiB streaming budget, content-type SSE grammar, strict id matching, and unknown-after-dispatch mapping; Codex-connection paragraph now states streaming UTF-8 decode with 8 MiB line cap, truncated-line discard on restart, and the 8/256/32 MiB/30-second assembly bounds with strict envelope validation; `bridge/PROTOCOL.md` documents byte-versus-UTF-16 counts for line/chunk/inbound/outbound budgets.
Remaining defects, unsupported features, and acceptance blockers: live Chrome/Codex/Notion proof still required (German/CJK/emoji in a real turn, oversized/malformed traffic yielding recoverable connection errors with no write replay); DNR scoping/probe and diagnostics/isolation stay Epochs 13–14. No browser/live check is counted as passed.
Next epoch and any contract changes the successor must know: Epoch 12's locally implementable work is complete. Start Epoch 13 only. `ChunkAssembler` now enforces `MAX_ACTIVE_ASSEMBLIES`/`MAX_CHUNKS_PER_ASSEMBLY`/`MAX_CHUNK_CHARS`/`MAX_CHUNK_BYTES`/`MAX_AGGREGATE_BYTES`/`ASSEMBLY_TTL_MS` with `reset()` disposing timers (tests must use fake timers for expiry); `NativeBridge` validates without coercion and posts bounded `MALFORMED_REQUEST` tool-responses only on valid rids; `McpClient` exposes `MCP_RESPONSE_BUDGET_BYTES`/`McpBodyTooLargeError`/`McpMalformedResponseError` and `pickResponse` never falls back; `parseSseOrJson` joins data with newline and strips one space. Bridge `test-bridge.mjs` crash-budget loop now crashes until dead to tolerate the prior unicode-EOF restart.

Epoch 13 / 2026-09-14 / candidate commits: `57442a1`, `4b05463`
Implemented behavior: one narrow DNR rule (own-extension initiator, exact `https://mcp.notion.com/mcp` regex with deliberate query handling, `xmlhttprequest` only) with installation-equality verification; pre-OAuth reports installed/unverified and permits credential acquisition, while only the owner's authorized MCP initialize establishes acceptance (401/403/429/5xx/redirect/malformed/missing/lookup all non-verifying, with rule removal and narrow reinstall on retry); lookup failures block instead of continuing. Extension messages use exact discriminants with bounded UUID/URL/title/icon validation; background accepts page-meta only from the owning tab context with stale-URL checks and identity from navigation state (title/icon stay untrusted labels); the panel accepts current-page only from the background context; credential storage is restricted to `TRUSTED_CONTEXTS` at background startup with a compatibility error when unavailable.
Regressions observed failing before fix: new `tests/dnr.test.ts` (18 failures: missing exact-scope helpers, broad requestDomains rule, unauthenticated probe treating 401/5xx as stripped, variants without initiators, last-rule-left-installed on failure); `tests/messages.test.ts` (13 failures: prefix-wildcard acceptance, missing validators, missing storage restriction); replaced one setup-screen assertion that enshrined the reviewed continue-on-lookup-failure behavior with block-on-failure plus installed/unverified and storage-error cases. Each half verified green before its commit.
Commands actually run and results (include skips): narrow `tests/dnr.test.ts` (26), `tests/messages.test.ts` (15), `tests/notion-facade.test.ts` (22), `tests/setup-screen.test.tsx` (14), `tests/notion-page.test.ts` (15) pass (92 across the five Epoch-13 files); full `pnpm test` passes 686 tests with 7 opt-in live skips; `pnpm typecheck` passes; `pnpm build` passes; `git diff --check` passes. One test-side type correction (explicit DNR status union for the storage-error case). No test was weakened.
Browser scenario IDs, versions, actual observations: C15 BLOCKED — no supported-Chrome live session with browser/network instrumentation or designated scratch scope in this environment; narrow-rule header scope, foreign-initiator isolation, and content-script credential isolation are proven deterministically only (regex boundary fixtures, sender fakes, setAccessLevel fakes). Setup reconnect checks are covered deterministically (blocked restore with retry, installed/unverified restore). No browser/live check is counted as passed.
Architecture/public claims updated: `docs/application.md` now describes the single narrow rule with initiator/exact-URL/type scope, installed-vs-verified acceptance via the authorized initialize, rule removal with narrow reinstall, exact validated messages with sender/stale checks, untrusted title/icon labels, and `TRUSTED_CONTEXTS` storage restriction.
Remaining defects, unsupported features, and acceptance blockers: live Chrome evidence still required for each claimed supported family/version (narrow rule actually strips only its own requests; content scripts cannot read refresh tokens in a real profile); upload stays unsupported (Epoch 08); diagnostics/isolation stay Epoch 14. No browser/live check is counted as passed.
Next epoch and any contract changes the successor must know: Epoch 13's locally implementable work is complete. Start Epoch 14 only; do not treat C01–C15 as closed. DNR status is now `{installed, verified, active, reason?, storageError?}` (pre-OAuth installed/unverified; `nox/clear-dnr` removes on acceptance failure); `originStripRuleIsActive` requires the extension id for strict equality; `Notion.verifyEndpointAcceptance()` is the explicit acceptance probe (called by `refreshIdentity`); `isNoxMessage` is exact with bounded payload checks plus `isExpectedContentSender`/`isExpectedBackgroundSender`; `ensureTrustedStorageAccess()` must run at background startup before credential use.

Epoch 14 / 2026-09-14 / candidate commits: `4273ece`, `5692723`
Implemented behavior: default diagnostics log bounded event categories, hop/stage, safe status codes, operation IDs, and connection stages only — no prompt bodies, page titles, tokens, provider bodies, upload URLs/form fields, or queries. `ChatPanel` Send logs turn ID/mode instead of prompt text; Notion/Codex connect, restore, disconnect, reconnect, turn, history, and cleanup logs use `safeErrorDetail` (MCP status/RPC code plus kind, OAuth `[stage]` plus status, unknown as generic) with credential/URL redaction and a 500-char bound. Console capture converts known errors to safe metadata and unknown errors/rejections to a generic category; uncaught window errors are generic; reassembly failures log a category without envelope preview; the raw `console.error` with the full Notion error object is removed. Copy stays user-initiated with “Review for private content before sharing” and no telemetry. The live smoke harness records versioned isolation evidence (`resolveCodex` path/version, OS, model/effort/settings, userAgent, thread ID, turn-submitted/start counts, thread-scoped feature/MCP inspection with fail-closed on unexpected surfaces, disabled-research observation, replay count) with synthetic prompts only, plus documented non-provable limits; deterministic research tests now cover MCP fail-closed and the shell/computer/browser/file/image/multi-agent allowlist with `agents.max_threads: 1`.
Regressions observed failing before fix: new `tests/log.test.tsx` failed all 6 (missing `safeErrorDetail`, console capture retained prompt/token/workspace/body sentinels, credential objects retained Bearer/token/upload sentinels, unhandled rejection retained sentinels, export-usefulness blocked on the missing helper, SettingsModal lacked the review notice). The two new research assertions are fail-closed cover for the existing implementation (they pass; they would fail if `RESTRICTED_FEATURES` lost entries or MCP inventory were ignored).
Commands actually run and results (include skips): narrow `tests/errors.test.ts` (10), `tests/codex/research.test.ts` (5), `tests/codex/client.test.ts` (33), `tests/codex/loop-integration.test.ts` (14), `tests/log.test.tsx` (6) pass (68 across the five Epoch-14 files); full `pnpm test` passes 694 tests with 7 opt-in live skips; `pnpm typecheck` passes; `pnpm build` passes; `node bridge/test-bridge.mjs` passes; `node --test scripts/install.test.mjs scripts/live/answer-quality-eval.test.mjs` passes 7 tests; `node --check scripts/live/codex-smoke.mjs` passes; `git diff --check` passes. One production type fix during the run (restored UI `message` variable kept for display while logs use the safe summary); two test-mock syncs (added `safeErrorDetail` to log mocks); one test-file isolation fix (chrome stub plus agent/notion/history/card mocks for the SettingsModal case, `promise` field for the rejection event). No test was weakened.
Browser scenario IDs, versions, actual observations: C16 BLOCKED — no loaded disposable Chrome extension with network/layout instrumentation in this environment, so log-export privacy plus narrow/normal/wide layout/keyboard review is proven deterministically only (exact exported-text sentinel assertions, review-notice rendering). Native isolation matrix BLOCKED — no supported Codex session, designated scratch scope, or quota in this environment; the opt-in harness invocation (`node scripts/live/codex-smoke.mjs [--search] [--toggle-search]`, `NOX_LIVE_MODEL`/`NOX_LIVE_EFFORT`) was inspected and syntax-checked but not run live. No browser/live check is counted as passed.
Architecture/public claims updated: `docs/application.md` security boundaries now state metadata-only diagnostics with safe console capture, credential redaction, user-initiated copy with review reminder, no telemetry, and category-only reassembly failures. `docs/answer-quality-verification.md` gains the Epoch 14 isolation-evidence section (recorded fields, fail-closed rule, small per-model/version matrix currently pending, non-provable in-flight/semantic limits, no sandbox-inferred isolation). `scripts/live/codex-smoke.mjs` persists the `isolation` block to ignored `.release/` reports.
Remaining defects, unsupported features, and acceptance blockers: live Chrome evidence still required for each claimed supported family/version (narrow log-export plus layout/keyboard in C16); live Codex evidence still required for each claimed supported model/version (disabled research, no inherited MCP/connectors/plugins, shell/computer/browser/file/image/multi-agent restrictions, turn correlation, no replay); upload stays unsupported (Epoch 08); installer/release/claims work stays Epochs 15–16. No browser/live check is counted as passed. Wave D gate: protocol failures recover deterministically, DNR scope is deterministically verified, content-script credential isolation is deterministically verified, diagnostics omit sentinels deterministically, and each supported model/version is explicitly pending live evidence rather than claimed supported.
Next epoch and any contract changes the successor must know: Epoch 14's locally implementable work is complete. Start Epoch 15 only; do not treat C01–C16 or the native matrix as closed. `lib/log.ts` now exports `safeErrorDetail`, `redactCredentials`, `sanitizeLogMessage`, and `MAX_LOG_MESSAGE_CHARS` (tests mocking `../src/lib/log` must include `safeErrorDetail`); `logInfo`/`logError` sanitize (redact plus 500-char bound) at push; `ChatPanel` Send logs `starting turn <turnId> (mode=<mode>)`; Notion connected/restored logs are stage-only; `native.ts` never logs envelope previews; `SettingsModal` carries the review reminder; smoke reports carry `isolation` with fail-closed feature/MCP checks.

Epoch 15 / 2026-09-14 / candidate commits: `a101010`, `f7a6b3c`, `22d9562`
Implemented behavior: `resolveCodex` normalizes every selection to an absolute existing path (bare PATH names via filesystem search, never returned bare), caches successful discovery per `CODEX_BIN` key, fails closed on an invalid `CODEX_BIN` override with no fallback version, bounds probes at 20 candidates, and reports `testedCompatible` against `TESTED_CODEX_VERSIONS` (0.153.4) with an unverified-version warning in the installer. Windows `cmd` quoting handles `%` (doubled), `&`, parentheses, quotes, and spaces; POSIX wrappers use single-quote escaping for quotes/`$`/backticks; `bridge/install.mjs` exports pure wrapper builders plus `--uninstall` that leaves `~/.codex` login/history untouched. The OAuth spike binds its callback to 127.0.0.1, bounds callback bytes, keeps the listener open across invalid callbacks, and writes tokens atomically with owner-only permissions (synthetic tokens in tests; spike stays outside production auth). Vitest moves 3.2.7 → 4.1.11 (smallest patched; vite 6.4.3 satisfies its peer range) with no runner/API changes and no mocker endpoint added. Both release ZIPs now carry root `LICENSE` plus assembled `THIRD-PARTY-NOTICES.txt` (runtime JS from installed package metadata; fonts from the checked-in family/license file with versions explicitly unverified); packaging stages in an isolated temp directory, removes only its two output ZIPs plus its staging dirs, and never wipes `.release/` or build output. One version source (`extension/package.json`): `manifest.config.ts` reads it and `codex/client.ts` imports it (`resolveJsonModule`), with display mapping `v<version>-alpha` and existing `nox-v<version>.zip` names kept. CI push paths cover installer/scripts/manifests/notices, a new `release-tools` job runs installer/eval/archive tests on push and PR, actions are SHA-pinned with minimal `contents: read` (plus `actions: write` for the tag-only artifact upload), and macOS stays explicitly unverified.
Regressions observed failing before fix: 4 new installer assertions failed pre-fix (invalid `CODEX_BIN` fell through to the real binary instead of null+error; `resolveBareExecutable`/`buildShWrapper`/`buildBatWrapper` missing; invalid-override dry-run printed no Codex guidance); the POSIX wrapper assertion needed a quote-bearing sentinel to prove `'"'"'` escaping; one new archive assertion failed pre-fix (PowerShell `Compress-Archive` emits backslash entry names, so the forward-slash-only manifest check missed `extension\dist\manifest.json`). Each was observed red, then fixed; the pre-existing 3 installer tests kept passing throughout.
Commands actually run and results (include skips): `node --test scripts/install.test.mjs` passes 10; `node --test scripts/install.test.mjs scripts/live/answer-quality-eval.test.mjs scripts/package-release.test.mjs` passes 17; full `pnpm test` passes 694 with 7 opt-in live skips; `pnpm typecheck` passes (one manifest typo fixed during the run: stray quote); `pnpm build` passes with dist manifest `0.1.0` derived from package.json; `node bridge/test-bridge.mjs` passes; `node scripts/package-release.mjs` builds both ZIPs to an isolated out dir with `.release/` left intact; `pnpm audit --json` reports 0 advisories (was 2 moderate entries for the single GHSA-82fw-gwwq-j7x9 dev advisory via `vitest` and `vitest>@vitest/mocker` paths); `pnpm audit --prod --json` reports 0; `git diff --check` passes. One manifest-config typo and one ZIP-separator test expectation were corrected during the run; no test was weakened.
Browser scenario IDs, versions, actual observations: C17 BLOCKED — no disposable supported installation/profile with user-managed auth in this environment, so clean-install → read → Ask edit → scoped Auto edit → approved plan → supported undo → reopen history → sign-out is proven deterministically only (isolated staging, ZIP central-directory inspection, sentinel-path wrapper assertions). No browser/live check is counted as passed.
Architecture/public claims updated: `docs/application.md` Codex-connection paragraph now states absolute-path resolution with caching, fail-closed `CODEX_BIN`, and newest-vs-tested distinction; Build-and-verify notes the installer override, licensed/notice-carrying temp-staged archives, and single version source. `scripts/release/README.md` now documents the tested matrix (Chrome on Windows/Ubuntu; macOS and other Chromiums unverified), `CODEX_BIN`, move/update (re-run installer), and uninstall that preserves Codex login/history. `extension/src/sidepanel/fonts/NOTICES.md` records Inter/JetBrains Mono OFL 1.1 family attribution with versions/sources explicitly unverified (no provenance invented from filenames).
Remaining defects, unsupported features, and acceptance blockers: C17 live evidence still required before any release sign-off; macOS and non-Chrome Chromium stay unverified (no CI job claims them); vendored font file versions/sources stay unverified; Codex versions newer than 0.153.4 run with an unverified warning; upload stays unsupported (Epoch 08). No browser/live check is counted as passed.
Next epoch and any contract changes the successor must know: Epoch 15's locally implementable work is complete. Start Epoch 16 only; do not treat C01–C17 as closed. `resolveCodex` results now carry `error`/`testedCompatible` with per-`CODEX_BIN` caching (`clearResolveCodexCacheForTests` for isolation); `install.mjs`/`bridge/install.mjs` main execution is `isMain`-guarded (safe to import `quoteCmdArg`/`hasChrome`/`buildShWrapper`/`buildBatWrapper`/`uninstallBridge` in tests); `package-release.mjs` exports `readReleaseVersion`/`collectThirdPartyNotices`/`stageRelease`/`FORBIDDEN_ARCHIVE_PATTERNS` with `NOX_RELEASE_OUT_DIR` for isolated runs; `scripts/package-release.test.mjs` parses ZIP central directories (backslash-tolerant); CI pins actions to SHAs with `contents: read` minimum.

Epoch 16 / 2026-09-14 / candidate commits: `5c2021d`, `8c01e8e` (+ this record commit)
Implemented behavior: public documents now describe the tested alpha. (16.1) Removed absolute injection-proof/no-silent-write claims: workspace content is untrusted data with advisory markers, enforced by deterministic gates, with explicit residual model-semantic limits and the final external-editor race. Stated exact plan thresholds (destructive schema, multi-page moves, database creation, >5 created pages, >5 affected objects; single cosmetic view rename / single-page move on ordinary approval), the explicit per-turn Auto small-edit grant (listed pages, property updates + text additions, five effects), full bounded canonical payload inspection, unknown/applied-with-recovery-warning outcomes, conservative undo limits, and installed-vs-authenticated-accepted DNR status with C15 live verification pending. Corrected egress copy everywhere (Nox-operated none vs extension MCP/bridge vs Codex provider/research processing; upload unsupported so no upload origin), creation deep-link qualification (verified existing targets only), property/schema/view/move undo unavailable, no dedicated autofill/quota-estimate/image-analysis, local-only deletion scope, exact manifest permission table (with `.notion.site`, content-script title/icon labels, Web-Lock ownership, no page cache), single version source (`extension/package.json` → manifest, display `v<version>-alpha`), and unverified private-reporting availability. Added the README alpha-scope feature table linking the remediation log, verification doc, and smoke checklist instead of old passing counts. (16.2) `AGENTS.md` now uses the relevance rule (full architecture read only for runtime/boundary/persistence/cross-component changes); `CONTRIBUTING.md` drops the unenforced `E<epic>.<n>` convention and blanket `chrome.*` prohibition (panel/storage/assembly side effects documented with test seams) and points archive `RESEARCH`/`MVP`/`E*.md` references at `docs/old_planning.md` with `docs/application.md` as current authority; empty unreferenced `CLAUDE.md` removed; three stale source comments relinked (`gate.ts` E6 chain, DNR `RESEARCH §2.1` headers, bridge non-writable-cwd comment corrected to writable-tmpdir plus extension-configured sandbox).
D1 row dispositions (verified against final symbols/evidence): plans-even-in-Auto — true post-epoch-06, now stated with exact thresholds (README/THREAT-MODEL/application.md corrected, including the stale Auto-self-approval paragraph in application.md); `injected_request` guard — corrected to strip-plus-provenance-approval (effects.ts:61-64, approvals.ts:76, application.md executor list); never-executed/cannot-silently-write — absolutes removed; MCP-and-bridge-only egress — distinguished in README/PERMISSIONS/store-listing/PRIVACY; image input — removed (context.ts:70, dynamic-tools advertisement gate); property-undo safe types — corrected to unavailable (inverse.ts:34-36, SAFE_PROPERTY_TYPES unused); bulk autofill/quota/one-click undo — removed as a feature, scoped to inspected tool calls (rowCount unwired: approvals.ts:77 vs gate.ts:694-697, so no >25-row boundary is claimed); creation deep links — qualified to verified targets (gate.ts:761 yields undefined for brand-new objects); atomic rotation — corrected to durable-first plus re-authentication-required; non-writable cwd / bare binary — corrected (absolute path verified in resolve-codex, tmpdir writable, sandbox extension-configured); schema-checked/validated reassembly — replaced with actual epoch-12 bounds; PERMISSIONS table — reconciled row by row with manifest.config.ts (8 permissions, 4 host entries); store-listing history claim — Codex `~/.codex` plus provider processing disclosed.
Regressions observed failing before fix: docs epoch — no red/green unit regressions by design. Verification was a claim-vs-symbol audit: the stale Auto-self-approval paragraph in `docs/application.md` and the unwired `rowCount` confirmation (claimed in README/smoke, never supplied per gate.ts:694-697) were found and corrected during the run.
Commands actually run and results (include skips): `git diff --check` passed; relative-link sweep across all touched docs passed (0 broken); manifest permission/host comparison passed (matches PERMISSIONS.md exactly); version-label comparison passed (`extension/package.json` 0.1.0 → manifest numeric, `v0.1.0-alpha` display); `pnpm typecheck` from `extension/` passed (comment-only `.ts` touches). No test-suite rerun for prose alone per the epoch spec; no test was weakened.
Browser scenario IDs, versions, actual observations: no C-IDs required — Final tests specify docs checks only. All C01–C17 remain BLOCKED/pending for Epoch 17. No browser/live check is counted as passed.
Architecture/public claims updated: `docs/application.md` executor list (strip-plus-provenance instead of smuggled-request refusal) and structural-work paragraph (explicit plan approval in both modes, no model self-approval); all other public-claim edits listed above; no runtime flow changed.
Remaining defects, unsupported features, and acceptance blockers: private-reporting enablement unverified; macOS/non-Chrome Chromium unverified; per-model native-isolation matrix pending live runs; upload unsupported pending a live ticket fixture; the `BULK_CONFIRM_ROWS` approval rule exists but no production path supplies `rowCount` (documented as not-a-boundary; wiring or removal belongs to a future runtime epoch, not this docs epoch). Historical `old_planning.md`/`spikes/` claims (autofill, atomic rotation, non-writable cwd) intentionally left as archived evidence per the spec. No browser/live check is counted as passed.
Next epoch and any contract changes the successor must know: Epoch 16's locally implementable work is complete. Start Epoch 17 only; do not treat any C-ID as closed. `AGENTS.md` relevance rule is now the contributor contract; `docs/application.md` remains the architecture authority; historical materials resolve via `docs/old_planning.md`.

Epoch 17 / 2026-09-14 / candidate commits: `486f04d`, `27ed656` (+ this record commit)
Implemented behavior: (17.1) new `extension/tests/adversarial-acceptance.test.ts` (20 tests) re-proves H1–H5 together over production assembly — real `PlanEngine`, `ApprovalEngine`, `WriteGate`, `MutationJournal`, `Scheduler`, `ToolExecutor` with faked transports — plus the assembled consent matrix (reads zero cards, one Ask card with complete payload, granted-Auto zero redundant cards, out-of-scope/untrusted still carded, unknown/raw-ticket/reserved/stale bypasses fail closed) and strong-behavior locks (12-call ceiling, continuation expiry, grant scoping). `scripts/release-smoke.mjs` now runs the full final suite (typecheck, tests, build, evaluation ledger, installer tests, archive-content tests, bridge, archives, full + production audits), prints a versions prologue, reports automated success separately from live acceptance, and adds a fail-closed `--publish-gate`/`--require-live-evidence` check that refuses unless every C01–C17 row in the evidence log reads PASS plus an explicit marker. (17.2) No code commit by design: C01–C17 need a loaded candidate, scratch workspace, and supported-model sessions unavailable here. (17.3) New `docs/adversarial-remediation-evidence.md` holds the sanitized H/M/L/D closure table, consent/strong-behavior maps, final-suite record, all-BLOCKED C01–C17 table, fresh-pass notes, and residual limits; README alpha-scope and `docs/smoke.md` link it. No runtime behavior changed.
Regressions observed failing before fix: one fixture red during development (a Markdown link assertion placed after raw HTML blocks without a blank line parsed as literal text; the fixture was corrected with blank-line separation, not the implementation). H-level pre-fix failures are the per-epoch red observations cited in the evidence log; the integrated file was not backported to the reviewed revision because its fixtures depend on post-remediation APIs (ownership-scoped `WriteGate`, scoped `PlanEngine`, frozen `ApprovalDecision`) that do not exist there.
Commands actually run and results (include skips): `pnpm typecheck` passed; new suite passed 20/20; full `pnpm test` passed 714 tests with 7 opt-in live skips (45 files passed, 2 skipped; prior baseline 694 + 20 new); `pnpm build` passed; `node bridge/test-bridge.mjs` passed; `node --test scripts/install.test.mjs scripts/live/answer-quality-eval.test.mjs scripts/package-release.test.mjs` passed 17; `pnpm audit --json` and `pnpm audit --prod --json` clean (0 advisories both); `git diff --check` passed. Publish-gate matching verified against the evidence log: all 17 C-IDs missing PASS and no marker, so the gate refuses as designed. One production type fix during the run (unused test-helper parameter removed); no test was weakened.
Browser scenario IDs, versions, actual observations: C01–C17 all BLOCKED — no disposable Chrome extension, controlled receiver/network instrumentation, supported Codex/Notion session, two-panel live Chrome, or authorized scratch scope in this environment (Node v22.23.2, pnpm 11.10.0, Windows). Candidate for any future live run: source `27ed656`, extension 0.1.0 (`v0.1.0-alpha`), vitest 4.1.11. Layout review (320/400/600 px, themes, keyboard-only) is BLOCKED with C05/C16. No browser/live check is counted as passed.
Architecture/public claims updated: no runtime flow changed, so `docs/application.md` is untouched. README alpha-scope paragraph and `docs/smoke.md` header now link `docs/adversarial-remediation-evidence.md`; the feature-matrix stance is unchanged (implemented with live acceptance pending; upload explicitly unsupported). Release smoke documents that automated success never implies live verification.
Remaining defects, unsupported features, and acceptance blockers: all live acceptance pending (C01–C17 BLOCKED); publishing a release advertising live-verified behavior is refused by `--publish-gate` until every row is PASS. Upload into Notion stays unsupported by design; PDF/image analysis, bulk autofill, quota estimates, and generalized undo do not exist and are not claimed. Residual limits stand: final external-editor race (no provider conditional writes), observed native-search in-flight boundary, no model-semantic guarantees, unverified macOS/non-Chrome Chromium and newer-than-0.153.4 Codex, local-only deletion scope. No known unresolved High or material correctness/privacy blocker remains deterministically; no new release blocker was found in the fresh pass. No browser/live check is counted as passed.
Next epoch and any contract changes the successor must know: Epoch 17's locally implementable work is complete; there is no next epoch. Remediation is locally complete with live acceptance pending. Publishing remains a separate authorized action: complete `docs/smoke.md` C01–C17 against a recorded candidate build, update `docs/adversarial-remediation-evidence.md` rows to PASS with sanitized artifacts, add the `Publish gate: PASS` marker only when true, and run `node scripts/release-smoke.mjs --publish-gate`. `checkPublishGate` matches `| Cxx ... | PASS` rows; evidence tables must keep that shape.

Final acceptance requires all of the following:

- Every H/M/L/D identifier has a closure entry with code/test evidence or an explicit unsupported-feature disposition consistent with the review. A disabled feature must be unavailable in every execution path, not merely hidden in UI.
- All enabled mutation paths share owner, capability, validated effect, exact consent, conflict where applicable, no-unsafe-retry, durable-intent, and cancellation checks.
- Real supported Chrome/Codex/Notion combinations pass relevant C01–C17 cases; blocked infrastructure is not counted as product success or product failure.
- No known unresolved High finding, data-loss/privacy blocker, or misleading public guarantee remains. New adversarial findings are triaged and material blockers fixed.
- Reads, bounded edits, one approved plan, safe supported undo, reconnect, history restore, deletion, and sign-out work without redundant consent or misleading status.
- Release artifacts carry license/notices, match the tested candidate, pass content checks, and have an accurate support matrix.
- The final report states residual limitations and evidence boundaries. It does not promise a vulnerability-free application, provider atomicity, universal model isolation, or unsupported undo.
