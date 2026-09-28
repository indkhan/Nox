# Nox adversarial engineering review and repair backlog

**Repository:** indkhan/Nox  
**Reviewed commit:** `a222ff23b0debd649f70903264af651903f01cc6`  
**Review date:** September 20, 2026  
**Deliverable:** 31 prioritized repair packages, with source locations, remediation, and acceptance criteria. No repository changes were made.

## Verdict

There is meaningful engineering in this project: scoped/frozen approvals, durable mutation intent, explicit unknown outcomes, retry restrictions, credential generations, restricted rendering, and pinned CI actions. The main weakness is disagreement between these components and the live integration contracts. Preserve the architecture; repair the operation model, lifecycle boundaries, and evidence before adding features or changing frameworks.

This is a source-led adversarial review, not a certificate that all defects have been found. Critical production paths across the Chrome extension, native bridge, OAuth/MCP integration, consent, persistence, recovery, UI, installation, and CI were inspected; tests were sampled rather than every assertion independently validated. Repository files and metadata were read through the connected GitHub integration. Local cloning failed because the execution environment could not resolve the repository host. The full project build/test suite and authenticated Notion/Codex/browser workflows were **not independently executed** here. Dependency vulnerability scans, secret-history scans, browser accessibility audits, and empirical performance profiling remain unperformed. No speculative CVEs or live compromise claims are included.

GitHub reports a successful CI run for this exact commit: [run 35372322817](https://github.com/indkhan/Nox/actions/runs/35372322817), completed September 18, 2026. That is remote CI evidence, not a locally reproduced test result. The accompanying control-flow probes were executed with Node v22.16.0 and reproduced four isolated behaviors (NOX-01, NOX-08, NOX-12, NOX-18). They are explicitly separate demonstrations with reduced I/O, not repository tests or live exploit reproductions.

### Priority and evidence vocabulary

- **P1:** Fix before encouraging broader use of writes or presenting the safety/recovery behavior as dependable.
- **P2:** Fix for a credible, reliable engineering showcase and a supported alpha release.
- **P3:** Improve scaling, privacy defaults, documentation, and long-term maintainability after the safety-critical repairs.

“Source-confirmed” means the relevant branch, missing check, or inconsistent state flow is visible in the reviewed source. It does not mean a live exploit or production incident was reproduced. Compatibility findings compare the source with current primary documentation; the authenticated provider contract still needs to be captured and tested. Hardening/assurance/performance items are labeled separately and are not counted as proven external vulnerabilities.

## Findings index

| ID | Priority | Repair package |
|---|---|---|
| NOX-01 | P1 | Unify the Notion request contract before trusting classification or undo |
| NOX-02 | P2 | Advertise only tools the local policy and adapters really support |
| NOX-03 | P1 | Represent accepted asynchronous writes separately from completed writes |
| NOX-04 | P1 | Make the small-edit grant small by semantics, not just by operation name |
| NOX-05 | P1 | Track all untrusted model exposure, including native web research and metadata |
| NOX-06 | P2 | Apply the aggregate operation budget to individually approved writes too |
| NOX-07 | P1 | Bind history, recovery conflicts, and undo to workspace identity rather than only chat identity |
| NOX-08 | P1 | Require positive evidence for complete, safely reversible page baselines |
| NOX-09 | P1 | Do not declare undo successful before verifying the inverse operation |
| NOX-10 | P1 | Separate application evidence from verification evidence throughout the UI |
| NOX-11 | P1 | Move final content and authority checks to the actual dispatch boundary |
| NOX-12 | P1 | Release scheduler permits when cancellation lands after admission |
| NOX-13 | P2 | Carry a real end-to-end deadline through every asynchronous stage |
| NOX-14 | P1 | Reserve a send synchronously before staging attachments or history |
| NOX-15 | P1 | Make visible mentions and submitted consent scope one source of truth |
| NOX-16 | P2 | Do not erase the next draft when the previous answer finishes |
| NOX-17 | P2 | Fence asynchronous active-page updates by navigation generation |
| NOX-18 | P2 | Make IndexedDB opening truly single-flight and close the right connection |
| NOX-19 | P2 | Make the document ownership lease idempotent under repeated setup |
| NOX-20 | P2 | Use atomic read-modify-write transactions and guarded journal transitions |
| NOX-21 | P1 | Preserve tool-call identity through the actual production assembly |
| NOX-22 | P1 | Fence restore completions and replace initial-login credentials atomically |
| NOX-23 | P2 | Validate OAuth metadata and discovered endpoints explicitly |
| NOX-24 | P2 | Authorize privileged background RPCs and await storage readiness |
| NOX-25 | P2 | Harden native bridge process, framing, and backpressure failure paths |
| NOX-26 | P2 | Gate Codex compatibility by a verified profile, not newest-binary selection |
| NOX-27 | P2 | Complete MCP negotiation, pagination, and session recovery |
| NOX-28 | P3 | Bound growing history, mention caches, and incremental parsing work |
| NOX-29 | P3 | Make shareable diagnostic exports private by default |
| NOX-30 | P2 | Test the actual assembly and built extension, not only local harnesses |
| NOX-31 | P3 | Repair public documentation and make engineering claims traceable to evidence |

## Detailed findings

### NOX-01 — Unify the Notion request contract before trusting classification or undo

**Priority:** P1  
**Evidence class:** Source-confirmed contract inconsistency; live provider acceptance not tested

**Existing source locations:**
- [`extension/src/lib/writes/classify.ts`](https://github.com/indkhan/Nox/blob/a222ff23b0debd649f70903264af651903f01cc6/extension/src/lib/writes/classify.ts)
- [`extension/src/lib/writes/effects.ts`](https://github.com/indkhan/Nox/blob/a222ff23b0debd649f70903264af651903f01cc6/extension/src/lib/writes/effects.ts)
- [`extension/src/lib/writes/inverse.ts`](https://github.com/indkhan/Nox/blob/a222ff23b0debd649f70903264af651903f01cc6/extension/src/lib/writes/inverse.ts)
- [`extension/src/lib/writes/gate.ts`](https://github.com/indkhan/Nox/blob/a222ff23b0debd649f70903264af651903f01cc6/extension/src/lib/writes/gate.ts)

**Problem and consequence.** Classification inspects command.type, the inverse builder emits an object command with content and a separate data.page_id wrapper, and intended-result detection recognizes that same local shape. Current official Notion MCP examples instead use a string command and new_str. A string update_content command falls through to content-replace. Effect validation bounds and canonicalizes JSON, but does not validate a complete command-specific argument schema. Separate interpretations therefore disagree about the same operation.

**What to change.** Add a versioned provider adapter, for example extension/src/lib/notion/adapters/update-page.ts (new). Parse unknown input into one discriminated domain operation. Derive classification, affected IDs, destructive flags, consent, expected post-state, and inverse from that operation. Serialize through the same adapter. Reject conflicting aliases and unsupported fields. Capture the actual authenticated tools/list schema and sanitized request/response fixtures before enabling each adapter. Do not replace one guessed wrapper with another.

**Acceptance test.** Add extension/tests/notion/provider-contract.test.ts (new). For each supported command, test provider fixture -> domain operation -> serialized request, plus wrong types, mixed aliases, destructive flags, and the documented string-command shape. Assert the exact wire request, not merely that a fake transport was called.

### NOX-02 — Advertise only tools the local policy and adapters really support

**Priority:** P2  
**Evidence class:** Source-confirmed capability-routing gap

**Existing source locations:**
- [`extension/src/lib/agent/dynamic-tools.ts`](https://github.com/indkhan/Nox/blob/a222ff23b0debd649f70903264af651903f01cc6/extension/src/lib/agent/dynamic-tools.ts)
- [`extension/src/lib/notion/capabilities.ts`](https://github.com/indkhan/Nox/blob/a222ff23b0debd649f70903264af651903f01cc6/extension/src/lib/notion/capabilities.ts)
- [`extension/src/lib/writes/classify.ts`](https://github.com/indkhan/Nox/blob/a222ff23b0debd649f70903264af651903f01cc6/extension/src/lib/writes/classify.ts)

**Problem and consequence.** toDynamicTools publishes almost every discovered tool that passes the capability gate. This is broader than the read taxonomy and write adapters. Unrecognized access states are discarded, and missing states are treated as allowed. The current documented plan_required state is not represented. An unsupported tool can be advertised and then refused or misclassified locally. Remote Notion permissions still apply; this is not a demonstrated server authorization bypass.

**What to change.** Build a supported-tool registry and intersect discovery, local adapter support, effective connection capabilities, and the selected safety profile. Represent unknown capability states explicitly. Unknown writes must not become authorized by omission. Keep unsupported discovered tools visible in diagnostics without offering them to the model. Refresh the registry on connection changes.

**Acceptance test.** Extend capability and dynamic-tool tests with an unknown tool, an unsupported read, plan_required, an omitted capability map, and a tool removed between connections. Assert unsupported tools never reach the advertised execution surface.

### NOX-03 — Represent accepted asynchronous writes separately from completed writes

**Priority:** P1  
**Evidence class:** Source-confirmed lifecycle gap against documented provider behavior

**Existing source locations:**
- [`extension/src/lib/writes/gate.ts`](https://github.com/indkhan/Nox/blob/a222ff23b0debd649f70903264af651903f01cc6/extension/src/lib/writes/gate.ts)
- [`extension/src/lib/writes/journal.ts`](https://github.com/indkhan/Nox/blob/a222ff23b0debd649f70903264af651903f01cc6/extension/src/lib/writes/journal.ts)
- [`extension/src/lib/mcp/client.ts`](https://github.com/indkhan/Nox/blob/a222ff23b0debd649f70903264af651903f01cc6/extension/src/lib/mcp/client.ts)
- [`extension/src/lib/agent/activity.ts`](https://github.com/indkhan/Nox/blob/a222ff23b0debd649f70903264af651903f01cc6/extension/src/lib/agent/activity.ts)

**Problem and consequence.** The gate settles non-error mutation results as applied without a tool-specific interpretation of asynchronous task handles. Official Notion MCP documentation permits asynchronous outcomes. An accepted task is not evidence that the requested mutation completed successfully; later validation or execution can fail.

**What to change.** Parse outcomes into rejected, submitted(taskId), applied, partial, or unknown. Persist the remote task ID and original scope before polling. Poll the existing task with bounded backoff, persist terminal evidence, and resume observation after reload. Block dependent operations until their prerequisites are actually satisfied. Never resubmit the mutation merely because polling or the panel failed.

**Acceptance test.** Use queued -> running -> succeeded and queued -> failed fixtures; crash the panel after acceptance and restart it. Assert the original mutation is dispatched once, only task observation resumes, and no success or undo control appears before completion evidence.

### NOX-04 — Make the small-edit grant small by semantics, not just by operation name

**Priority:** P1  
**Evidence class:** Source-confirmed consent-policy gap

**Existing source locations:**
- [`extension/src/lib/writes/approvals.ts`](https://github.com/indkhan/Nox/blob/a222ff23b0debd649f70903264af651903f01cc6/extension/src/lib/writes/approvals.ts)
- [`extension/src/lib/writes/effects.ts`](https://github.com/indkhan/Nox/blob/a222ff23b0debd649f70903264af651903f01cc6/extension/src/lib/writes/effects.ts)
- [`extension/src/lib/agent/turn-access.ts`](https://github.com/indkhan/Nox/blob/a222ff23b0debd649f70903264af651903f01cc6/extension/src/lib/agent/turn-access.ts)
- [`extension/src/sidepanel/Composer.tsx`](https://github.com/indkhan/Nox/blob/a222ff23b0debd649f70903264af651903f01cc6/extension/src/sidepanel/Composer.tsx)

**Problem and consequence.** Grant eligibility checks operation categories and target scope, but not changed text size, affected fields or blocks, value clearing, or destructive patch semantics. A low-impact label does not establish a low-impact payload. The five-operation/object budget is not a size bound on each operation.

**What to change.** After command parsing, implement an explicit small-edit predicate: allowed property types and transitions, bounded changed bytes and fields, append-only or precisely bounded non-destructive text changes, and no deletion flags, broad replacement, moves, or structural effects. Fall back to an ordinary approval card for every uncertain case. Make the UI description match the actual limits.

**Acceptance test.** Extend approval tests with a large patch, empty/null property clearing, replace-all behavior, multiple field changes, destructive flags, and a benign bounded edit. Assert only the last case uses the small-edit grant without another approval.

### NOX-05 — Track all untrusted model exposure, including native web research and metadata

**Priority:** P1  
**Evidence class:** Source-confirmed provenance gap; no live prompt-injection exploit demonstrated

**Existing source locations:**
- [`extension/src/lib/agent/loop.ts`](https://github.com/indkhan/Nox/blob/a222ff23b0debd649f70903264af651903f01cc6/extension/src/lib/agent/loop.ts)
- [`extension/src/lib/agent/context.ts`](https://github.com/indkhan/Nox/blob/a222ff23b0debd649f70903264af651903f01cc6/extension/src/lib/agent/context.ts)
- [`extension/src/lib/codex/client.ts`](https://github.com/indkhan/Nox/blob/a222ff23b0debd649f70903264af651903f01cc6/extension/src/lib/codex/client.ts)
- [`extension/src/lib/writes/approvals.ts`](https://github.com/indkhan/Nox/blob/a222ff23b0debd649f70903264af651903f01cc6/extension/src/lib/writes/approvals.ts)

**Problem and consequence.** The loop taints a conversation after dynamic tool results and fetched mention Markdown. Built-in Codex web-search events are forwarded to listeners without equivalent trust-state updates. Reference-only page titles and attachment metadata are wrapped as untrusted prompt content, but do not necessarily update the runtime provenance flag. Thus prompt-level labels and the authorization system can disagree.

**What to change.** Create one exposure recorder covering every externally sourced item delivered to the model. Conservatively taint a research-enabled turn before execution when delivery cannot be observed reliably. Include DOM-derived labels and external metadata. Preserve taint across resumed conversations. Keep deterministic approval requirements outside the model; delimiters are not authorization.

**Acceptance test.** Add a real-loop test that delivers a native search result, then requests a write under an otherwise eligible grant. Repeat with a malicious page title and a restored conversation. Assert provenance is untrusted before the write decision.

### NOX-06 — Apply the aggregate operation budget to individually approved writes too

**Priority:** P2  
**Evidence class:** Source-confirmed mismatch with the documented plan threshold

**Existing source locations:**
- [`extension/src/lib/writes/gate.ts`](https://github.com/indkhan/Nox/blob/a222ff23b0debd649f70903264af651903f01cc6/extension/src/lib/writes/gate.ts)
- [`extension/src/lib/agent/turn-access.ts`](https://github.com/indkhan/Nox/blob/a222ff23b0debd649f70903264af651903f01cc6/extension/src/lib/agent/turn-access.ts)
- [`extension/src/lib/writes/approvals.ts`](https://github.com/indkhan/Nox/blob/a222ff23b0debd649f70903264af651903f01cc6/extension/src/lib/writes/approvals.ts)

**Problem and consequence.** The cumulative unplanned-effect count is advanced on the small-edit grant path, rather than consistently for all unplanned effects. A sequence of individually approved operations can avoid the aggregate threshold that is meant to require a workspace plan. Those operations still have individual approval; this is not an absence-of-consent finding.

**What to change.** Define whether the budget counts distinct affected objects, operation attempts, or both, then enforce that definition at one shared reservation/dispatch boundary for every unplanned write. Do not reset it on approval retries. Keep structural-plan authorization and individual approval as distinct concepts.

**Acceptance test.** Approve enough separate writes to cross the configured budget, including repeated targets and batch operations. Assert the next out-of-budget operation requires a plan regardless of whether earlier writes used grant-based or explicit approval.

### NOX-07 — Bind history, recovery conflicts, and undo to workspace identity rather than only chat identity

**Priority:** P1  
**Evidence class:** Source-confirmed isolation and recovery-policy gap

**Existing source locations:**
- [`extension/src/lib/writes/journal.ts`](https://github.com/indkhan/Nox/blob/a222ff23b0debd649f70903264af651903f01cc6/extension/src/lib/writes/journal.ts)
- [`extension/src/lib/writes/gate.ts`](https://github.com/indkhan/Nox/blob/a222ff23b0debd649f70903264af651903f01cc6/extension/src/lib/writes/gate.ts)
- [`extension/src/lib/history/repository.ts`](https://github.com/indkhan/Nox/blob/a222ff23b0debd649f70903264af651903f01cc6/extension/src/lib/history/repository.ts)
- [`extension/src/sidepanel/ChatPanel.tsx`](https://github.com/indkhan/Nox/blob/a222ff23b0debd649f70903264af651903f01cc6/extension/src/sidepanel/ChatPanel.tsx)

**Problem and consequence.** Unresolved-write checks are thread-scoped, so opening a new chat avoids an unresolved entry affecting the same workspace. Normal thread creation does not consistently populate workspace identity. Ordinary thread deletion also removes journal records. Undo does not establish a durable, original-workspace binding as a prerequisite in the reviewed path. Server object permissions reduce some consequences but do not repair these local invariants.

**What to change.** Persist account/workspace identity on threads and operations. Query unresolved conflicts by workspace plus affected objects, not chat alone; do not block unrelated objects unnecessarily. Refuse to resume old model context or undo a different workspace without an explicit transition. Separate conversation deletion from unresolved-operation reconciliation. A deliberate privacy wipe may erase records, but must disclose the resulting loss of recovery evidence rather than silently claiming safe resolution.

**Acceptance test.** Create an unknown write, start a new chat, and target the same page; the conflict must remain. Switch accounts/workspaces and attempt old-thread resume and undo. Delete a chat with an unresolved operation and verify the recovery policy is explicit and enforced.

### NOX-08 — Require positive evidence for complete, safely reversible page baselines

**Priority:** P1  
**Evidence class:** Source-confirmed parser inconsistencies

**Existing source locations:**
- [`extension/src/lib/notion/page-content.ts`](https://github.com/indkhan/Nox/blob/a222ff23b0debd649f70903264af651903f01cc6/extension/src/lib/notion/page-content.ts)
- [`extension/src/lib/writes/classify.ts`](https://github.com/indkhan/Nox/blob/a222ff23b0debd649f70903264af651903f01cc6/extension/src/lib/writes/classify.ts)
- [`extension/src/lib/agent/panel.ts`](https://github.com/indkhan/Nox/blob/a222ff23b0debd649f70903264af651903f01cc6/extension/src/lib/agent/panel.ts)
- [`extension/src/lib/writes/inverse.ts`](https://github.com/indkhan/Nox/blob/a222ff23b0debd649f70903264af651903f01cc6/extension/src/lib/writes/inverse.ts)

**Problem and consequence.** The normalizer can treat arbitrary non-empty plain text as complete when a small set of partial markers is absent. Malformed JSON-looking text can fall back to that path. Nested page content is accepted while several completeness flags are checked only at the outer level. Empty strings are rejected as missing. The rich-page blacklist misses structural representations such as <columns>. The panel also reduces structured fetch results to concatenated text in the baseline path.

**What to change.** Preserve the structured fetch result and normalize only verified envelopes with target identity and completeness evidence. Unknown shape or malformed envelope may support an explicitly uncertain read, never a destructive replacement baseline. Distinguish an empty, fully read page from an unavailable page. Use a positively supported reversible subset or structural parser instead of a handful of blacklist regexes; do not infer that every rich block is necessarily lossy.

**Acceptance test.** Add fixtures for empty complete content, malformed JSON, nested truncation, omitted-block metadata, wrong target identity, plain ambiguous wrappers, and rich structural content. Assert uncertain reads cannot authorize whole-page replacement or a whole-page inverse.

### NOX-09 — Do not declare undo successful before verifying the inverse operation

**Priority:** P1  
**Evidence class:** Source-confirmed recovery gap

**Existing source locations:**
- [`extension/src/lib/writes/inverse.ts`](https://github.com/indkhan/Nox/blob/a222ff23b0debd649f70903264af651903f01cc6/extension/src/lib/writes/inverse.ts)
- [`extension/src/lib/writes/gate.ts`](https://github.com/indkhan/Nox/blob/a222ff23b0debd649f70903264af651903f01cc6/extension/src/lib/writes/gate.ts)
- [`extension/src/lib/writes/journal.ts`](https://github.com/indkhan/Nox/blob/a222ff23b0debd649f70903264af651903f01cc6/extension/src/lib/writes/journal.ts)

**Problem and consequence.** The inverse serializer uses the inconsistent request shape described in NOX-01. Intended-result recognition is narrow, making content-update reversibility unavailable or unverifiable. The undo path can mark the original entry undone following a non-error response without checking the restored postcondition. A response acknowledgment alone is insufficient evidence of restoration.

**What to change.** Generate inverses through the same validated provider adapter as forward operations. Record expected before/after fingerprints and the subset of state being restored. Run undo through its own durable lifecycle, including asynchronous completion and readback. Only set the original operation to undone after matching restoration evidence; otherwise retain a visible unknown or unverified outcome. Continue refusing unsupported property/schema/move/create undo instead of inventing it.

**Acceptance test.** Test an accepted undo task that later fails, a provider success with mismatched readback, a concurrent external edit, an empty original page, and an interrupted undo. Assert no case is labeled undone prematurely.

### NOX-10 — Separate application evidence from verification evidence throughout the UI

**Priority:** P1  
**Evidence class:** Source-confirmed outcome-model gap

**Existing source locations:**
- [`extension/src/lib/writes/gate.ts`](https://github.com/indkhan/Nox/blob/a222ff23b0debd649f70903264af651903f01cc6/extension/src/lib/writes/gate.ts)
- [`extension/src/lib/writes/journal.ts`](https://github.com/indkhan/Nox/blob/a222ff23b0debd649f70903264af651903f01cc6/extension/src/lib/writes/journal.ts)
- [`extension/src/lib/agent/activity.ts`](https://github.com/indkhan/Nox/blob/a222ff23b0debd649f70903264af651903f01cc6/extension/src/lib/agent/activity.ts)
- [`extension/src/sidepanel/ChatPanel.tsx`](https://github.com/indkhan/Nox/blob/a222ff23b0debd649f70903264af651903f01cc6/extension/src/sidepanel/ChatPanel.tsx)

**Problem and consequence.** After a reported write success, verification failure can leave status applied with a notUndoableReason. There is no equivalent first-class verification state in the journal status model. This mixes “the provider reported an effect” with “Nox verified the intended result,” and makes the documented applied-but-unverified distinction depend on secondary display logic.

**What to change.** Use explicit application and verification fields or a well-defined combined state machine. Derive timeline text, model receipts, follow-up suggestions, and undo availability from that state. Treat malformed responses, partial batches, task acceptance, lost acknowledgments, and readback failure separately. Persist the evidence needed to reproduce the same display after reopening history.

**Acceptance test.** Create each outcome state and restore the conversation. Assert the UI and model receipt never upgrade unknown, partial, submitted, or applied-unverified into verified success.

### NOX-11 — Move final content and authority checks to the actual dispatch boundary

**Priority:** P1  
**Evidence class:** Source-confirmed avoidable stale-check window

**Existing source locations:**
- [`extension/src/lib/writes/gate.ts`](https://github.com/indkhan/Nox/blob/a222ff23b0debd649f70903264af651903f01cc6/extension/src/lib/writes/gate.ts)
- [`extension/src/lib/agent/panel.ts`](https://github.com/indkhan/Nox/blob/a222ff23b0debd649f70903264af651903f01cc6/extension/src/lib/agent/panel.ts)
- [`extension/src/lib/mcp/scheduler.ts`](https://github.com/indkhan/Nox/blob/a222ff23b0debd649f70903264af651903f01cc6/extension/src/lib/mcp/scheduler.ts)
- [`extension/src/lib/mcp/client.ts`](https://github.com/indkhan/Nox/blob/a222ff23b0debd649f70903264af651903f01cc6/extension/src/lib/mcp/client.ts)

**Problem and consequence.** Content guards can run before scheduler admission and token acquisition. Queueing and refresh therefore extend the time during which a checked page or authorization scope can become stale. The scheduler beforeInvoke hook rechecks authority but is not an equivalent fresh-content check at the last possible dispatch point.

**What to change.** Restructure preparation so blocking admission and credential readiness do not follow the final safety decision unnoticed. Recheck workspace/credential generation and the relevant content precondition immediately before dispatch, using a reservation-aware design that cannot deadlock by recursively acquiring the same scheduler. Prefer provider-side exact-match edits when supported. Document the remaining read/write race where the provider lacks conditional writes; no local hash can create remote compare-and-swap.

**Acceptance test.** Pause a write in the queue, modify its target or replace credentials, then release the queue. Assert it is refused or requires renewed approval, with zero mutation dispatches under the stale precondition.

### NOX-12 — Release scheduler permits when cancellation lands after admission

**Priority:** P1  
**Evidence class:** Source-confirmed deterministic control-flow defect

**Existing source locations:**
- [`extension/src/lib/mcp/scheduler.ts`](https://github.com/indkhan/Nox/blob/a222ff23b0debd649f70903264af651903f01cc6/extension/src/lib/mcp/scheduler.ts)

**Problem and consequence.** In Scheduler.schedule, acquire increments inFlight. The next signal.throwIfAborted occurs before the try/finally that releases the permit. Cancellation between the await and that check leaks the slot. Repeating the sequence can exhaust MAX_CONCURRENT and stall future work.

**What to change.** Place every post-acquire action, including the abort check and beforeInvoke, inside one release-owning try/finally. Preserve the distinction between pre-dispatch refusal, declared provider failure, and uncertain post-dispatch failure. Release exactly once, and perform retry backoff without holding capacity.

**Acceptance test.** Call schedule with a fresh AbortController, abort synchronously before its admitted continuation resumes, and repeat for every available permit. Assert all promises reject as cancelled, no transport is invoked, in-flight count returns to zero, and a subsequent normal read completes.

### NOX-13 — Carry a real end-to-end deadline through every asynchronous stage

**Priority:** P2  
**Evidence class:** Source-confirmed incomplete timeout coverage

**Existing source locations:**
- [`extension/src/lib/mcp/scheduler.ts`](https://github.com/indkhan/Nox/blob/a222ff23b0debd649f70903264af651903f01cc6/extension/src/lib/mcp/scheduler.ts)
- [`extension/src/lib/mcp/client.ts`](https://github.com/indkhan/Nox/blob/a222ff23b0debd649f70903264af651903f01cc6/extension/src/lib/mcp/client.ts)
- [`extension/src/lib/oauth/discovery.ts`](https://github.com/indkhan/Nox/blob/a222ff23b0debd649f70903264af651903f01cc6/extension/src/lib/oauth/discovery.ts)
- [`extension/src/lib/oauth/tokens.ts`](https://github.com/indkhan/Nox/blob/a222ff23b0debd649f70903264af651903f01cc6/extension/src/lib/oauth/tokens.ts)
- [`extension/src/lib/notion/index.ts`](https://github.com/indkhan/Nox/blob/a222ff23b0debd649f70903264af651903f01cc6/extension/src/lib/notion/index.ts)

**Problem and consequence.** The scheduler deadline is checked for token/backoff waits but not all concurrency waits or immediately available admission. Production call paths do not consistently supply it. OAuth and metadata work lack comprehensive timeouts. Refresh clears its abort-controller reference after response headers, before body consumption completes, and can hold a shared refresh lock during unbounded network work. Outer turn cancellation does not automatically cover all these stages.

**What to change.** Create a deadline-aware request context at the user action and pass its signal/deadline through queue admission, discovery, refresh, request dispatch, body reading, polling, and retry delays. Keep abort ownership until the body has settled. A waiter needs its own deadline wakeup. Abort or expiration before dispatch must prove no mutation was sent; after dispatch, preserve uncertainty.

**Acceptance test.** Use a never-resolving concurrency wait, token refresh, metadata response, and response body. Expire the deadline in each stage. Assert no held lock/permit remains and no late callback resurrects an operation or credentials.

### NOX-14 — Reserve a send synchronously before staging attachments or history

**Priority:** P1  
**Evidence class:** Source-confirmed UI concurrency defect

**Existing source locations:**
- [`extension/src/sidepanel/ChatPanel.tsx`](https://github.com/indkhan/Nox/blob/a222ff23b0debd649f70903264af651903f01cc6/extension/src/sidepanel/ChatPanel.tsx)
- [`extension/src/lib/agent/panel.ts`](https://github.com/indkhan/Nox/blob/a222ff23b0debd649f70903264af651903f01cc6/extension/src/lib/agent/panel.ts)
- [`extension/src/sidepanel/Composer.tsx`](https://github.com/indkhan/Nox/blob/a222ff23b0debd649f70903264af651903f01cc6/extension/src/sidepanel/Composer.tsx)

**Problem and consequence.** ChatPanel.send checks busyRef, then awaits draft staging and persisted-turn creation before setting busyRef. Two quick invocations can both pass the guard and alter persistent or shared turn state before the lower-level loop rejects one. Mode/current-page state is also read after asynchronous work, rather than captured at the send action. The readiness check allows some non-connected Codex states.

**What to change.** Reserve a unique send transaction and set busy state before the first await. Capture text, mentions, attachments, grant, mode, workspace, connection generation, and current page in one immutable snapshot. Only the reservation owner may clear busy state in finally. Return explicit accepted/rejected status. Require the intended connected readiness state and release cleanly on preparation failure.

**Acceptance test.** Race keyboard/button/follow-up sends while attachment reads and IndexedDB are delayed. Assert one accepted transaction, one history header, one grant scope, and one model turn. Navigate or change mode while staging and verify the captured send remains unchanged.

### NOX-15 — Make visible mentions and submitted consent scope one source of truth

**Priority:** P1  
**Evidence class:** Source-confirmed editor/state divergence

**Existing source locations:**
- [`extension/src/sidepanel/Composer.tsx`](https://github.com/indkhan/Nox/blob/a222ff23b0debd649f70903264af651903f01cc6/extension/src/sidepanel/Composer.tsx)

**Problem and consequence.** Mention chips exist in the contenteditable DOM while a separate React array supplies submitted mentions. The remove button updates both, but keyboard deletion and onInput do not reconcile the array. A page removed visually can still be fetched and included in the turn. The new-chat reset clears file drafts and rejections but not the full editor, mention state, or small-edit selection.

**What to change.** Use a canonical editor document or reliably reconcile DOM chips before any submission. Derive text and mention IDs from the same snapshot, never independently maintained representations. Reset editor content, mention state, picker state, and transient consent when creating a new chat. Reconcile duplicate chips and caret offset behavior as part of the same change.

**Acceptance test.** Add a mention, delete it with Backspace or a selection, and send. Assert no fetch or grant target remains. Start a new chat and assert previous text, mentions, and the small-edit grant are absent.

### NOX-16 — Do not erase the next draft when the previous answer finishes

**Priority:** P2  
**Evidence class:** Source-confirmed editor lifecycle defect

**Existing source locations:**
- [`extension/src/sidepanel/Composer.tsx`](https://github.com/indkhan/Nox/blob/a222ff23b0debd649f70903264af651903f01cc6/extension/src/sidepanel/Composer.tsx)
- [`extension/src/sidepanel/ChatPanel.tsx`](https://github.com/indkhan/Nox/blob/a222ff23b0debd649f70903264af651903f01cc6/extension/src/sidepanel/ChatPanel.tsx)

**Problem and consequence.** Composer.handleSend awaits onSend, which represents the whole model turn, and then clears the editor. The editor remains editable while busy. Text typed while the answer streams can therefore be deleted when the earlier send resolves. A void return also does not distinguish an accepted submission from an early refusal.

**What to change.** Split submission acceptance from turn completion. Once the original draft is safely accepted, clear only that exact draft/version and allow a new independent draft to accumulate. Alternatively make the editor deliberately read-only until acceptance, not until completion. Preserve unsent text after rejection, disconnection, or local persistence failure.

**Acceptance test.** Submit draft A, type draft B while A streams, then complete or fail A. Assert B remains intact. Reject A before dispatch and assert its draft is retained with an actionable error.

### NOX-17 — Fence asynchronous active-page updates by navigation generation

**Priority:** P2  
**Evidence class:** Source-confirmed stale-context race

**Existing source locations:**
- [`extension/src/background/index.ts`](https://github.com/indkhan/Nox/blob/a222ff23b0debd649f70903264af651903f01cc6/extension/src/background/index.ts)
- [`extension/src/sidepanel/store.ts`](https://github.com/indkhan/Nox/blob/a222ff23b0debd649f70903264af651903f01cc6/extension/src/sidepanel/store.ts)
- [`extension/src/sidepanel/ChatPanel.tsx`](https://github.com/indkhan/Nox/blob/a222ff23b0debd649f70903264af651903f01cc6/extension/src/sidepanel/ChatPanel.tsx)

**Problem and consequence.** setActiveTab performs several asynchronous reads and writes without a latest-generation check. An older tab activation can finish after a newer one and publish stale current-page state. Tab activation events across windows also need a consistent focused-window policy. This is especially important because the current page participates in prompt context and grant scope.

**What to change.** Track focused window, tab, and a monotonically increasing navigation generation. Before persisting or broadcasting, confirm the result belongs to the latest navigation. Treat metadata as display-only and preserve the existing URL-based identity validation. Combine with the send snapshot in NOX-14.

**Acceptance test.** Delay the lookup for tab A, activate tab B, and then resolve A. Assert B remains current. Repeat across windows and with a stale content-script metadata message.

### NOX-18 — Make IndexedDB opening truly single-flight and close the right connection

**Priority:** P2  
**Evidence class:** Source-confirmed database lifecycle race

**Existing source locations:**
- [`extension/src/lib/history/schema.ts`](https://github.com/indkhan/Nox/blob/a222ff23b0debd649f70903264af651903f01cc6/extension/src/lib/history/schema.ts)

**Problem and consequence.** openNoxDB checks cachedOpen, awaits deletion-state refresh, and only then assigns the pending open promise. Two first callers can both cross that await and create separate connections. Global cachedConnection bookkeeping tracks only one; a blocking callback can then close the wrong connection or leave an earlier connection alive during upgrade/deletion.

**What to change.** Assign the shared opening promise synchronously, including all asynchronous prechecks inside it. Have every connection own its version-change/close handling. Fence opens against deletion generations and clear caches only when they still refer to that opening attempt. Preserve refusal while deletion is pending.

**Acceptance test.** Start multiple cold opens before releasing the deletion precheck. Assert one physical connection. Request upgrade and delete-all during opening; assert no leaked handle blocks either operation and no late open recreates deleted data.

### NOX-19 — Make the document ownership lease idempotent under repeated setup

**Priority:** P2  
**Evidence class:** Source-confirmed lifecycle defect; StrictMode manifestation is development-only

**Existing source locations:**
- [`extension/src/lib/history/panel.ts`](https://github.com/indkhan/Nox/blob/a222ff23b0debd649f70903264af651903f01cc6/extension/src/lib/history/panel.ts)
- [`extension/src/sidepanel/App.tsx`](https://github.com/indkhan/Nox/blob/a222ff23b0debd649f70903264af651903f01cc6/extension/src/sidepanel/App.tsx)
- [`extension/src/sidepanel/main.tsx`](https://github.com/indkhan/Nox/blob/a222ff23b0debd649f70903264af651903f01cc6/extension/src/sidepanel/main.tsx)

**Problem and consequence.** claimWindowRole can issue a second ifAvailable Web Lock request while the same document already holds the first. That second request can fail and set the shared role to viewer without releasing the owner lock. App calls this from an effect and main enables StrictMode, which deliberately repeats effect setup in development.

**What to change.** Model ownership as a document-scoped, single-flight lease. Repeated claims in the same document return the same result and cannot demote an existing owner. Handle lock-request errors, teardown, and owner generation explicitly. Do not remove StrictMode to hide the defect.

**Acceptance test.** Mount App inside StrictMode, unmount/remount, and call claimWindowRole concurrently. Assert exactly one owner lease, stable owner role, and correct release/handover to a second document.

### NOX-20 — Use atomic read-modify-write transactions and guarded journal transitions

**Priority:** P2  
**Evidence class:** Source-confirmed persistence concurrency gaps

**Existing source locations:**
- [`extension/src/lib/history/repository.ts`](https://github.com/indkhan/Nox/blob/a222ff23b0debd649f70903264af651903f01cc6/extension/src/lib/history/repository.ts)
- [`extension/src/lib/writes/journal.ts`](https://github.com/indkhan/Nox/blob/a222ff23b0debd649f70903264af651903f01cc6/extension/src/lib/writes/journal.ts)

**Problem and consequence.** Several thread metadata updates read a row and later put a modified copy outside one encompassing transaction. Message persistence and thread metadata updates can also be split. Journal settlement similarly performs read/replace logic, and a missing entry can return null without a sufficiently strong caller response. Interleavings can lose fields or leave ambiguous persistence state.

**What to change.** Move each related read-modify-write into one IndexedDB readwrite transaction. Use explicit expected-state/revision guards for operation transitions. Keep thread and message updates atomic where their consistency is required. A missing durable intent after possible dispatch must become a recovery error, not a silently ignored null.

**Acceptance test.** Race rename, pin, setCodexThreadId, appendMessage, and deletion with controlled barriers. Assert all nonconflicting updates survive and deleted rows do not resurrect. Attempt competing journal transitions and assert only valid expected-state changes commit.

### NOX-21 — Preserve tool-call identity through the actual production assembly

**Priority:** P1  
**Evidence class:** Source-confirmed end-to-end wiring defect

**Existing source locations:**
- [`extension/src/lib/agent/executor.ts`](https://github.com/indkhan/Nox/blob/a222ff23b0debd649f70903264af651903f01cc6/extension/src/lib/agent/executor.ts)
- [`extension/src/lib/agent/panel.ts`](https://github.com/indkhan/Nox/blob/a222ff23b0debd649f70903264af651903f01cc6/extension/src/lib/agent/panel.ts)
- [`extension/src/sidepanel/ChatPanel.tsx`](https://github.com/indkhan/Nox/blob/a222ff23b0debd649f70903264af651903f01cc6/extension/src/sidepanel/ChatPanel.tsx)

**Problem and consequence.** ToolExecutor receives req.callId, but its callTool dependency accepts only name, args, signal, and provenance. The panel reconstructs a new request without callId. ChatPanel later associates journal entries with visible activity by matching entry.callId to activity.id. This breaks the identity chain used for undo and uncertain-outcome display. Error paths also need consistent journal attachment.

**What to change.** Pass an immutable execution context containing callId and the relevant thread/turn/workspace/connection scope through every layer. Preserve the same identifier in durable intent, model event, and UI activity. Bind journal records to activity on both success and failure, and restore the same mapping from disk.

**Acceptance test.** Add extension/tests/agent/production-wiring.test.ts (new) using the real executor and panel assembly. Execute a normal write and an ambiguous failure; assert the visible action has its actual journal ID and the correct undo/review controls before and after reload.

### NOX-22 — Fence restore completions and replace initial-login credentials atomically

**Priority:** P1  
**Evidence class:** Source-confirmed auth lifecycle gaps; omission case depends on provider response

**Existing source locations:**
- [`extension/src/lib/notion/index.ts`](https://github.com/indkhan/Nox/blob/a222ff23b0debd649f70903264af651903f01cc6/extension/src/lib/notion/index.ts)
- [`extension/src/sidepanel/notion-connect.ts`](https://github.com/indkhan/Nox/blob/a222ff23b0debd649f70903264af651903f01cc6/extension/src/sidepanel/notion-connect.ts)
- [`extension/src/lib/oauth/tokens.ts`](https://github.com/indkhan/Nox/blob/a222ff23b0debd649f70903264af651903f01cc6/extension/src/lib/oauth/tokens.ts)

**Problem and consequence.** The explicit connect flow has useful login-generation checks, but the restore path is weaker: after refreshIdentity it checks whether any refresh token exists, which does not prove the same authorization is still current. A delayed restore or its catch handler can overwrite newer connection state. Initial-login persistence also preserves an older refresh token/workspace when a replacement token response omits those fields, despite allowing that response shape.

**What to change.** Capture and compare the same authorization generation throughout restore, identity/capability updates, and success/error UI completion. Treat initial authorization as replacement of a complete credential record; do not reuse an older account’s refresh token when the new login omits it. Keep “refresh response omitted a rotated token” as a separate, intentional renewal rule. Invalidate workspace-bound grants and context on identity replacement.

**Acceptance test.** Pause restore A, complete login B, then resolve or reject A; B must remain authoritative. Save an initial login without a refresh token over an existing account and assert the old refresh token/workspace cannot be reused. Test sign-out and wipe at each asynchronous boundary.

### NOX-23 — Validate OAuth metadata and discovered endpoints explicitly

**Priority:** P2  
**Evidence class:** Hardening and compatibility gap; no demonstrated credential exfiltration

**Existing source locations:**
- [`extension/src/lib/oauth/discovery.ts`](https://github.com/indkhan/Nox/blob/a222ff23b0debd649f70903264af651903f01cc6/extension/src/lib/oauth/discovery.ts)
- [`extension/src/lib/oauth/tokens.ts`](https://github.com/indkhan/Nox/blob/a222ff23b0debd649f70903264af651903f01cc6/extension/src/lib/oauth/tokens.ts)
- [`extension/src/lib/notion/index.ts`](https://github.com/indkhan/Nox/blob/a222ff23b0debd649f70903264af651903f01cc6/extension/src/lib/notion/index.ts)

**Problem and consequence.** Discovery casts JSON to metadata types, selects the first advertised authorization server, constructs a well-known URL by concatenation, and catches diverse failures into a fallback. It does not establish all issuer/resource/endpoint invariants at runtime. Token endpoint validation is principally HTTPS. The restrictive extension CSP is meaningful defense-in-depth and limits reachable destinations.

**What to change.** Validate metadata shapes, expected resource and issuer relationships, supported PKCE/auth methods, and trusted endpoint origins. Use standards-compliant well-known resolution for issuers with paths. Reject unsafe redirects and distinguish missing metadata from malformed or contradictory metadata. Retain existing state and S256 protections, and apply the deadline/body budgets from NOX-13.

**Acceptance test.** Test wrong issuer/resource, a path-bearing issuer, HTTP or unexpected-origin endpoints, malformed metadata, redirect responses, and failed PKCE capability checks. Assert no token or authorization code is sent to an unvalidated endpoint.

### NOX-24 — Authorize privileged background RPCs and await storage readiness

**Priority:** P2  
**Evidence class:** Source-confirmed trust-boundary/startup gaps

**Existing source locations:**
- [`extension/src/background/index.ts`](https://github.com/indkhan/Nox/blob/a222ff23b0debd649f70903264af651903f01cc6/extension/src/background/index.ts)
- [`extension/src/shared/messages.ts`](https://github.com/indkhan/Nox/blob/a222ff23b0debd649f70903264af651903f01cc6/extension/src/shared/messages.ts)
- [`extension/src/lib/chrome-storage.ts`](https://github.com/indkhan/Nox/blob/a222ff23b0debd649f70903264af651903f01cc6/extension/src/lib/chrome-storage.ts)

**Problem and consequence.** The page-meta branch validates its sender, but get-current-page, get-recent-pages, get-dnr-status, and clear-dnr do not establish an equivalent privileged panel context. A compromised extension content-script context has a broader control/read surface than intended. Separately, storageAccessError starts as null while the restriction check runs asynchronously, so null is not proof initialization finished. This is not a demonstrated arbitrary external webpage attack.

**What to change.** Use a typed message dispatcher with per-message sender policy. Only approved extension pages should invoke control RPCs; content scripts should send their narrow metadata message. Establish a shared storageReady promise and await it in every readiness/credential-dependent response. Keep the existing narrow DNR rule; do not broaden it for availability.

**Acceptance test.** Invoke each control RPC from a simulated content-script sender and assert refusal. Delay storage access initialization and request DNR status; assert the response cannot falsely report a ready credential boundary.

### NOX-25 — Harden native bridge process, framing, and backpressure failure paths

**Priority:** P2  
**Evidence class:** Source-confirmed robustness gaps

**Existing source locations:**
- [`bridge/nox-bridge.mjs`](https://github.com/indkhan/Nox/blob/a222ff23b0debd649f70903264af651903f01cc6/bridge/nox-bridge.mjs)
- [`bridge/test-bridge.mjs`](https://github.com/indkhan/Nox/blob/a222ff23b0debd649f70903264af651903f01cc6/bridge/test-bridge.mjs)

**Problem and consequence.** The spawned Codex process lacks a dedicated spawn-error handler. Parsed stdout JSON is used without a complete envelope/record check, so a valid JSON null is not a safe protocol message. Oversized-line recovery does not maintain a discard-until-newline state across chunks. Writable-stream backpressure and total pending request counts are not bounded merely by the existing per-frame size limits.

**What to change.** Handle process and pipe errors as explicit lifecycle transitions; reject pending work once. Validate envelopes before property access. For an overlong line, discard through its terminating delimiter or terminate the transport rather than parsing an arbitrary tail as a fresh frame. Bound pending requests and output queues, pause/resume on backpressure, and make restart ownership explicit.

**Acceptance test.** Extend bridge tests with executable disappearance between probe and spawn, JSON null, malformed envelopes, a split overlong line followed by valid traffic, an EPIPE, and a slow reader. Assert bounded memory, no uncaught error, no phantom response, and deterministic pending-request failure.

### NOX-26 — Gate Codex compatibility by a verified profile, not newest-binary selection

**Priority:** P2  
**Evidence class:** Safety assurance gap for untested versions; not a proven sandbox escape

**Existing source locations:**
- [`bridge/resolve-codex.mjs`](https://github.com/indkhan/Nox/blob/a222ff23b0debd649f70903264af651903f01cc6/bridge/resolve-codex.mjs)
- [`install.mjs`](https://github.com/indkhan/Nox/blob/a222ff23b0debd649f70903264af651903f01cc6/install.mjs)
- [`extension/src/lib/codex/client.ts`](https://github.com/indkhan/Nox/blob/a222ff23b0debd649f70903264af651903f01cc6/extension/src/lib/codex/client.ts)
- [`extension/src/lib/codex/research.ts`](https://github.com/indkhan/Nox/blob/a222ff23b0debd649f70903264af651903f01cc6/extension/src/lib/codex/research.ts)

**Problem and consequence.** The resolver selects the newest discovered Codex and only warns outside the tested 0.153.4 version. Research isolation disables and verifies a fixed set of known feature names; it does not by itself prove that an unrecognized newly enabled tool cannot appear. Several integration behaviors and dynamic-tool APIs are version-sensitive.

**What to change.** Introduce tested compatibility profiles with binary version, generated protocol schema, feature expectations, and real acceptance evidence. Prefer a known-compatible installed binary, or require a clearly labeled experimental profile for another version. Unknown effective tool surfaces should fail closed or enter a restricted diagnostic mode. Generate schemas from the actual binary rather than maintaining ad hoc request/response casts.

**Acceptance test.** Use a fake server with a changed schema, an additional enabled tool feature, or a missing isolation capability. Assert safe refusal before a model turn. Exercise each supported real binary against start, resume, dynamic tool calls, cancellation, and inherited-tool isolation.

### NOX-27 — Complete MCP negotiation, pagination, and session recovery

**Priority:** P2  
**Evidence class:** Source-confirmed protocol-completeness gaps

**Existing source locations:**
- [`extension/src/lib/mcp/client.ts`](https://github.com/indkhan/Nox/blob/a222ff23b0debd649f70903264af651903f01cc6/extension/src/lib/mcp/client.ts)
- [`extension/src/lib/notion/index.ts`](https://github.com/indkhan/Nox/blob/a222ff23b0debd649f70903264af651903f01cc6/extension/src/lib/notion/index.ts)

**Problem and consequence.** Initialization does not validate the full negotiated protocol result, subsequent HTTP calls omit the negotiated MCP-Protocol-Version header, tools/list reads only one page, and an expired session does not have a clear reinitialization path. These are compatibility and lifecycle issues; the existing response-size bound and no-blind-write-retry policy should be preserved.

**What to change.** Validate the supported negotiated version and required server fields, attach it consistently, page through tool discovery with cursor-cycle/size bounds, and reset expired sessions according to the protocol. Distinguish safe session recovery from replaying an ambiguous mutation. Consider the official SDK only after checking extension bundling and policy hooks; protocol correctness does not require a framework migration.

**Acceptance test.** Use protocol fixtures that negotiate another supported version, return an unsupported version, paginate tools, repeat a cursor, and expire a session with 404. Assert safe reads can recover while an already-dispatched mutation is never automatically replayed.

### NOX-28 — Bound growing history, mention caches, and incremental parsing work

**Priority:** P3  
**Evidence class:** Source-confirmed scaling patterns; latency and memory not benchmarked

**Existing source locations:**
- [`extension/src/lib/history/repository.ts`](https://github.com/indkhan/Nox/blob/a222ff23b0debd649f70903264af651903f01cc6/extension/src/lib/history/repository.ts)
- [`extension/src/lib/history/schema.ts`](https://github.com/indkhan/Nox/blob/a222ff23b0debd649f70903264af651903f01cc6/extension/src/lib/history/schema.ts)
- [`extension/src/sidepanel/Composer.tsx`](https://github.com/indkhan/Nox/blob/a222ff23b0debd649f70903264af651903f01cc6/extension/src/sidepanel/Composer.tsx)
- [`extension/src/lib/mcp/client.ts`](https://github.com/indkhan/Nox/blob/a222ff23b0debd649f70903264af651903f01cc6/extension/src/lib/mcp/client.ts)

**Problem and consequence.** History search loads broad thread/message collections, with per-thread message reads. The mention cache is unbounded and not clearly workspace-keyed; remote search is skipped whenever cached matches exist, potentially hiding other results. SSE matching repeatedly scans accumulated text. These patterns are acceptable only under small-data assumptions that should be measured rather than treated as proven performance.

**What to change.** Add indexed cursor pagination and a deliberate search index or bounded search strategy. Use workspace-keyed bounded caches with request generations and appropriate remote refresh. Parse stream events incrementally. Retain the current explicit response/memory bounds. Establish representative data and latency budgets before introducing more infrastructure.

**Acceptance test.** Benchmark large histories, many cached pages, and a long SSE response delivered in small chunks. Assert capped cache size, correct cross-workspace separation, no stale-result overwrite, and predictable scaling. Record measured results instead of claiming an unmeasured speedup.

### NOX-29 — Make shareable diagnostic exports private by default

**Priority:** P3  
**Evidence class:** Optional hardening; current code already warns about detailed errors

**Existing source locations:**
- [`extension/src/lib/log.ts`](https://github.com/indkhan/Nox/blob/a222ff23b0debd649f70903264af651903f01cc6/extension/src/lib/log.ts)
- [`extension/src/sidepanel/ChatPanel.tsx`](https://github.com/indkhan/Nox/blob/a222ff23b0debd649f70903264af651903f01cc6/extension/src/sidepanel/ChatPanel.tsx)

**Problem and consequence.** detailedErrorText appends a redacted, truncated raw exception message. Such text can still contain workspace titles or other content not recognizable as a credential. The implementation explicitly warns that detailed logs may name workspace content, and copying is user-initiated; this is not an automatic telemetry leak.

**What to change.** Keep safe structured event codes, stages, counts, and correlation IDs as the default export. Make raw detailed diagnostics an explicit advanced option with preview and a content warning. Use allowlisted keys and status categories; regex credential redaction remains defense-in-depth rather than a guarantee of removing private content.

**Acceptance test.** Supply exceptions containing arbitrary private titles, unrecognized credential-like strings, URLs, and provider bodies. Assert the default export contains only the allowed structured summary and advanced detail is clearly opt-in.

### NOX-30 — Test the actual assembly and built extension, not only local harnesses

**Priority:** P2  
**Evidence class:** Source-confirmed assurance gap; existing CI is green

**Existing source locations:**
- [`extension/tests/adversarial-acceptance.test.ts`](https://github.com/indkhan/Nox/blob/a222ff23b0debd649f70903264af651903f01cc6/extension/tests/adversarial-acceptance.test.ts)
- [`.github/workflows/ci.yml`](https://github.com/indkhan/Nox/blob/a222ff23b0debd649f70903264af651903f01cc6/.github/workflows/ci.yml)
- [`extension/package.json`](https://github.com/indkhan/Nox/blob/a222ff23b0debd649f70903264af651903f01cc6/extension/package.json)
- [`bridge/test-bridge.mjs`](https://github.com/indkhan/Nox/blob/a222ff23b0debd649f70903264af651903f01cc6/bridge/test-bridge.mjs)

**Problem and consequence.** The adversarial test suite constructs its own gate harness with synthetic argument shapes and a successful fake transport. This is useful unit/integration coverage, but is not equivalent to the actual executor -> panel -> gate -> journal -> UI wiring. The reviewed CI builds and runs substantial tests, yet does not exercise the installed extension in a real browser or authenticate provider contracts. GitHub reports success for the audited commit.

**What to change.** Keep existing tests, add production-assembly tests and schema-validated provider fixtures, then a persistent-context Chromium suite loading the built extension with a fake native host and fake Notion endpoint. Add deliberate crash/cancellation/storage-failure scenarios. Run live acceptance only in an explicitly disposable workspace and supported Codex profile. Add a documented runtime/package-manager policy, dependency audit triage, and lint/type boundaries without blindly upgrading every dependency.

**Acceptance test.** The release gate should cover install, restore, send, approve, reject, stop, unknown outcome, reopen, undo, account switch, second window, and delete-all using the built artifact. Record exact browser/OS/Codex versions, test commands, and limitations. A unit-test pass alone must not count as live acceptance.

### NOX-31 — Repair public documentation and make engineering claims traceable to evidence

**Priority:** P3  
**Evidence class:** Source-confirmed documentation defects plus presentation improvement

**Existing source locations:**
- [`README.md`](https://github.com/indkhan/Nox/blob/a222ff23b0debd649f70903264af651903f01cc6/README.md)
- [`docs/legacy/THREAT-MODEL.md`](https://github.com/indkhan/Nox/blob/a222ff23b0debd649f70903264af651903f01cc6/docs/legacy/THREAT-MODEL.md)
- [`docs/legacy/PERMISSIONS.md`](https://github.com/indkhan/Nox/blob/a222ff23b0debd649f70903264af651903f01cc6/docs/legacy/PERMISSIONS.md)
- [`docs/legacy/smoke.md`](https://github.com/indkhan/Nox/blob/a222ff23b0debd649f70903264af651903f01cc6/docs/legacy/smoke.md)
- [`docs/legacy/answer-quality-verification.md`](https://github.com/indkhan/Nox/blob/a222ff23b0debd649f70903264af651903f01cc6/docs/legacy/answer-quality-verification.md)
- [`.github/workflows/ci.yml`](https://github.com/indkhan/Nox/blob/a222ff23b0debd649f70903264af651903f01cc6/.github/workflows/ci.yml)

**Problem and consequence.** Several README links point to docs/ paths although their targets are under docs/legacy/. The README is appropriately candid about alpha scope and unverified live acceptance, but a reviewer cannot easily map every safety promise to the invariant, production implementation, regression test, and validated runtime combination.

**What to change.** Fix or relocate the broken links, then write a short current architecture/threat-model document rather than presenting legacy plans as current proof. Add a claim-to-evidence table, a supported-version matrix, explicit experimental limitations, reproducible install/release instructions, and a prioritized known-issues page. Check relative documentation links in CI. Do not claim production readiness while provider contracts and end-to-end acceptance remain unverified.

**Acceptance test.** From the repository root, resolve every internal documentation link. Have a clean-machine reviewer install the release and follow the demo/recovery instructions. Each strong README guarantee should point to a current implementation and a named acceptance test or be labeled an unverified goal.

## Implementation order

### PR 1 — Provider contract and operation model

Implement NOX-01, NOX-02, NOX-08, and the parsing part of NOX-27 together. Keep unsupported mutations disabled until their verified adapters exist. Add fixture provenance: source, captured date, supported tool schema, sanitized fields, and binary/provider version where available. Unknown input must not silently acquire a familiar risk label.

### PR 2 — Durable outcomes, scope, and recovery

Implement NOX-03, NOX-07, NOX-09, NOX-10, NOX-20, and NOX-21. Introduce explicit transitions before rewriting the UI. Preserve crash-consistent intent, remote task identity, and ambiguous outcomes. Treat undo as another controlled mutation, not a shortcut around the write pipeline. Migration tests must cover existing journal/history rows with missing workspace or verification information; legacy unknown scope must not be guessed.

### PR 3 — Consent, provenance, and final dispatch

Implement NOX-04, NOX-05, NOX-06, and NOX-11. Bind authorization to the exact typed operation and its immutable scope. Count effects consistently. Require renewed consent when operation content, targets, or identity changes. Keep model-proposed plans as proposals: authority originates with the human decision and checked local state.

### PR 4 — Cancellation, database, UI, and auth lifecycle

Implement NOX-12 through NOX-19, plus NOX-22 through NOX-24. These can be split into small independently tested commits: scheduler permit ownership; deadline propagation; send reservation; editor state; navigation; database open; window lease; credential restoration. Avoid a simultaneous UI rewrite that obscures regression causes.

### PR 5 — Native/protocol compatibility and real acceptance

Implement NOX-25 through NOX-27 and NOX-30. Exercise the built artifact through a real browser with deterministic transport faults, then run an opt-in live acceptance against a disposable workspace. Do not reuse a personal workspace as the destructive-test fixture. Record the exact supported profile and preserve failing fixtures as regression cases.

### PR 6 — Scaling and public presentation

Implement NOX-28, NOX-29, and NOX-31. Publish known limitations, a reproducible demo, the threat model, and acceptance evidence. The most convincing engineering story is a small set of explicit guarantees with reproducible tests, not an assertion that the code is perfect.

## Recommended internal design

Keep the current TypeScript/React/Vite/IndexedDB/native-bridge architecture. A new orchestration framework, microservice deployment, or additional agent layer is not a prerequisite for these repairs.

The key improvement is one provider-adapted domain operation that carries its validated payload, affected objects, risk classification, scope, preconditions, expected outcome, and reversibility. This single representation should feed approvals, plan matching, transport serialization, journal records, and the UI. Do not use separate regular expressions or casts to decide what the same write means at each layer.

The durable lifecycle must distinguish at least:

```text
prepared -> authorized -> dispatching
                         |-> rejected-before-effect
                         |-> submitted(remote task) -> terminal observation
                         |-> reported-applied -> verification
                         |-> unknown

verification -> verified-applied | applied-unverified | mismatch
undo         -> separate authorized operation -> verified restoration
```

Model application state and verification state independently where that is clearer than adding many combined status values. Record partial batch results explicitly. A cancellation request does not prove the remote operation stopped. A local operation ID helps correlate records but does not create server-side idempotency or exactly-once execution.

### Example of the scheduler ownership repair

This is a control-flow sketch, not a drop-in replacement for the existing retry implementation:

```ts
await acquire(bucket, signal, deadline);
try {
  signal?.throwIfAborted();
  beforeInvoke?.();
  return await invoke();
} finally {
  release();
}
```

Place retry classification around the invocation without losing the single release owner, and perform retry waiting only after capacity is released. Preserve the existing rule that ambiguous mutations are not automatically retried.

## Current primary guidance consulted

These links support the specific compatibility and test-design recommendations above; they are not a generic “latest tools” shopping list. Retrieved September 20, 2026.

1. [Notion: Working with markdown content](https://developers.notion.com/guides/data-apis/working-with-markdown-content) — current MCP request examples and asynchronous write outcomes. The MCP-specific section matters; do not assume REST and MCP request wrappers or response timing are interchangeable.
2. [Notion: Supported MCP tools](https://developers.notion.com/guides/mcp/mcp-supported-tools) — effective capability states and tool discovery.
3. [Notion: Enhanced markdown](https://developers.notion.com/guides/data-apis/enhanced-markdown) — structural content and the need for an explicitly supported reversible subset.
4. [MCP 2025-11-25: Transports](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports) — negotiated protocol headers and session lifecycle.
5. [MCP 2025-11-25: Authorization](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization) — discovery and authorization validation.
6. [OpenAI: Codex app-server](https://developers.openai.com/codex/app-server) — version-specific generated schemas and experimental integration surfaces.
7. [Playwright: Chrome extensions](https://playwright.dev/docs/chrome-extensions) — persistent browser contexts and built-extension testing with supported Chromium configuration.
8. [React: StrictMode](https://react.dev/reference/react/StrictMode) — repeated development effect setup that exposes non-idempotent resource ownership.
9. [Chrome: Native messaging](https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging) — framing, registration, supported browser integration, and host boundaries.

## Release acceptance checklist

Each item below needs an actual named test and recorded result; this document does not claim they currently pass.

- One accepted send creates one turn; simultaneous submissions cannot overwrite each other’s scope or draft.
- The same validated operation, exact targets, and authorization scope reach every layer from proposal to transport.
- Unknown/disallowed tools and unsupported provider shapes fail closed before mutation dispatch.
- Untrusted native research, tool content, and metadata cannot silently retain user-only provenance.
- No permit, lock, database connection, or pending request is leaked by cancellation, timeout, reload, or disconnect.
- Task acceptance and provider success never masquerade as verified application or verified undo.
- Unknown effects remain discoverable across chats, reloads, and identity transitions, with deliberate deletion semantics.
- Workspace/account changes invalidate stale context, approvals, baselines, callbacks, and incompatible undo.
- The built extension passes browser/native-host acceptance under every advertised OS/browser/Codex profile.
- Public claims, documentation links, and installation instructions match that evidence.

## What not to change merely for appearances

Do not replace React or Vite simply to look modern. Do not add a second persistence engine to mask transaction bugs. Do not infer vulnerabilities from dependency version numbers without running a verified advisory check. Do not label the public extension key a leaked secret. Do not broaden host permissions or the narrowly scoped Origin compatibility rule to avoid integration failures. Do not remove StrictMode, disable guards, or add automatic mutation retries just to make a flaky demo finish.

The existing controls around sanitization, exact native-host allowed origins, credential generation, frozen authorization payloads, and no blind mutation replay are valuable. Strengthen their integration and demonstrate their boundaries rather than discarding them.
