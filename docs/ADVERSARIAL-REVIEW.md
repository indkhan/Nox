# Nox adversarial engineering re-review

Review date: 2026-09-16. Reviewed `develop` and freshly fetched `origin/develop`:
`0eb4234febc8c34b15c76ec78e98f38d7abc8b35`. The working tree was initially clean.

**Result: seven confirmed remaining findings — two High and five Medium.**
The 17 original epochs substantially improved the code, but the current candidate
is not fully remediated. The standard suite passes; targeted probes expose gaps
between individually tested components and their combined runtime behavior.

This document replaces the 2026-09-10 review. The old review and completed
17-epoch plan remain available in Git at the reviewed commit. The active work is
now [the follow-up epochs](ADVERSARIAL-REMEDIATION-EPOCHS.md). The
[old evidence log](adversarial-remediation-evidence.md) is historical evidence,
not a current assertion that no material defects remain.

## Scope and evidence

Compared the original review and remediation requirements with the implementation
changes since `5e49201`, read the current architecture, and traced authorization,
model context, mutation serialization, durable intent, undo restoration,
OAuth, MCP, native transport, and their production callers. Parallel standards
and specification reviews were independently checked before aggregation.

| Check run against this candidate | Observed result |
|---|---|
| `pnpm test` in `extension/` | 714 passed; 7 opt-in live tests skipped; 45 files passed, 2 skipped |
| `pnpm typecheck` | Passed |
| `pnpm build` | Passed; Vite reports existing static/dynamic import chunk warnings |
| `node bridge/test-bridge.mjs` | All bridge checks passed |
| `node --test scripts/install.test.mjs scripts/live/answer-quality-eval.test.mjs scripts/package-release.test.mjs` | 17 passed, including isolated archive creation/content inspection |
| `pnpm audit --json` and `pnpm audit --prod --json` | Zero reported advisories in both |
| Five temporary write/undo probes asserting defective behavior | All five reproduced the behavior described in R1, R2, R4, R6 |
| Three temporary safety-expectation probes | All three failed as expected, demonstrating R3, R5, R7 |

The temporary probes used synthetic strings, in-memory storage and mocked
transports around real production classes. They were removed after execution;
no implementation or existing test was changed. Reproduction recipes and required
regression assertions appear below. Passing a probe that asserts a defect is
**evidence of the defect**, not a successful safety check.

No real Notion mutations, live OAuth flow, loaded-extension browser verification,
or live model prompt-injection campaign was performed in this re-review.
C01–C17 remain pending in the historical evidence log; their complete instructions
are now preserved in [smoke.md](smoke.md#live-acceptance-scenarios-c01c17).
Severity reflects likely consequence, while confidence describes deterministic
code behavior. No Critical issue was established and no vulnerability-free claim
is made.

Line references below refer to the reviewed commit, under `extension/src/`.

## Standards findings

These violate the existing ownership, provenance, credential lifecycle, or
protocol-boundary requirements. Generic refactoring preferences are omitted.

### R1 — High: authority can change after the last mutation check

**Confidence: High for the boundary defect; live transition timing unverified.**

Evidence: `lib/writes/gate.ts:718` rechecks the owner/connection before calling
`executeMutation`. That method awaits guard reads and durable intent persistence,
then dispatches at line 804 without rechecking the owner or connection snapshot.
Undo has the same ordering: recheck at line 243, asynchronous reservation/guard,
then dispatch at line 309. Ordinary cancellation checks are not a substitute for
checking the authority snapshot.

**Reproduction:** use real `WriteGate` and `MutationJournal`, a valid in-context
Auto property edit, and a store whose pending-intent append changes the owner
callback to false. One provider call still occurs. A second probe changes the
connection generation from `first` to `replacement` during that append: one call
still occurs, and its journal scope retains `first`.

**Consequence:** an approved operation can execute under authority different from
that captured for approval and recovery. Production supplies these callbacks from
the owner lease and Notion facade (`lib/agent/panel.ts`); UI cancellation helps
some transitions but does not establish the gate's claimed invariant. This is a
local enforcement gap, distinct from the unavoidable provider-side external-edit
race after a final read.

**Required fix/check:** revalidate captured ownership, connection/workspace,
capability and cancellation after asynchronous preparation and at actual dispatch,
including scheduler delay where relevant. Do the same for undo. A pre-dispatch
refusal must settle its durable intent as not applied and release undo reservations.
Delay guard, persistence and scheduler admission independently; revoke authority
at each boundary and assert zero mutation transport.

Original coverage reopened: epochs 02/04/07, H4/M3.

### R3 — Medium: resumed untrusted history becomes user-only again

**Confidence: High for provenance loss; exploitation depends on model behavior
and an enabled small-edit grant.**

Evidence: `lib/agent/loop.ts:146` resets `untrustedContextThisTurn` from only the
new turn's mentions. The same Codex conversation is resumed with its previous
workspace content. Tool dispatch uses this flag at lines 39–44;
`lib/writes/approvals.ts:76` relies on it to require untrusted-context confirmation.

**Reproduction:** run real `AgentLoop` and `ToolExecutor` over a scripted persistent
Codex client. Turn one fetches synthetic untrusted workspace text. Turn two has
no new mention and immediately requests a mutation. Its forwarded provenance is
`user-only`, not `untrusted-context`. The probe asserted the latter and failed.

**Consequence:** a first in-scope property edit or small addition on the next turn
can take the silent Auto path when the user enabled a small-edit grant, despite
retained untrusted instructions. It does not bypass target/count limits or grant
structural authority, and the probe did not demonstrate a live model attack.

**Required fix/check:** retain exposure for the conversation lifetime; restore it
conservatively when resuming history, including after reload. Clear only when the
model context is genuinely fresh. Test a real gate with a granted in-scope small
edit on turn two: one confirmation must still be required. Test fresh clean
conversations separately so ordinary Auto behavior is preserved.

Original coverage reopened: epoch 06, H2/M14.

### R5 — Medium: late initial login restores credentials after deletion/sign-out

**Confidence: High.**

Evidence: `lib/oauth/tokens.ts:119` invalidates a generation at `beginLogin`, but
`saveFromTokenResponse` at lines 127–134 creates a new generation unconditionally.
`lib/notion/index.ts:98–135` awaits discovery, consent and token exchange without
binding the eventual save to the login's starting generation. Generation checks
protect refresh responses, but not the original authorization response.

**Reproduction:** with real `TokenStore` and memory stores, call `beginLogin()`,
then `wipe()`, then deliver the delayed authorization result with
`saveFromTokenResponse()`. `getAccessToken()` returns the late access token instead
of null, and refresh credentials are written again. Settings' data deletion has
its own busy state and can run while connection work is pending.

**Consequence:** completing already-started login work can reconnect an extension
after the user erased its authorization, or let an older login replace a newer
one. This requires overlapping operations; it is not unauthenticated access.

**Required fix/check:** capture an authorization-attempt generation before the
first await and compare it under the credential write lock before committing.
Deletion, sign-out and a newer login must invalidate it. Check the facade/UI
completion too so a rejected late result cannot restore a Connected label. Test
deferred token exchange across both wipe and replacement login.

Original coverage reopened: epoch 11, M8.

### R7 — Medium: valid MCP bodies are rejected below the advertised byte limit

**Confidence: High.**

Evidence: `lib/mcp/client.ts` already counts actual incoming stream bytes, then
line 357 checks decoded text again through `byteLengthOf` (lines 369–371), which
returns `text.length * 3`. The fallback path at line 317 uses the same estimate.

**Reproduction:** real `McpClient.callTool` with a streamed `Response` containing
valid correlated JSON and a 3 MiB ASCII text field throws `MCP_OVERSIZE` claiming
the response exceeded 8,388,608 bytes. The actual body is only slightly over 3 MiB.
The expectation that the call resolves fails.

**Consequence:** legitimate large reads fail at roughly 2.67 MiB of ASCII instead
of the stated 8 MiB transport limit. A similarly sized mutation response could
also be lost after its effect, requiring unknown-outcome recovery unnecessarily.
This is excessive rejection, not an unbounded-memory bypass.

**Required fix/check:** enforce actual received bytes for streams and an exact
UTF-8 count for supported non-stream fallback. Keep cancellation, declared-length
and over-limit checks. Add below/exact/above-boundary tests for ASCII and multibyte
JSON/SSE; do not weaken the cap to make tests pass.

Original coverage reopened: epoch 12, M12.

## Specification findings

These contradict explicit remediation outcomes or leave a normal workflow broken.

### R2 — High: truncated model-visible reads authorize whole-page replacement

**Confidence: High.**

Evidence: `lib/writes/gate.ts:591` remembers the complete provider result as a
model-observed baseline before `lib/agent/executor.ts:101` truncates it for Codex.
Mention fetching does the same at `lib/agent/panel.ts:179`, before
`lib/agent/context.ts` applies its 8,000-character per-page/24,000 combined budget.

**Reproduction:** fetch a 30,000-character plain synthetic page followed by
`UNSEEN TAIL` through real `ToolExecutor` and `WriteGate`. The model-facing result
contains a continuation handle but no tail. Without consuming that continuation,
request `replace_content` with shorter text. The gate presents an approval card
and, when approved, dispatches the replacement. Both guard reads can be unchanged
and complete, so they do not catch missing model context.

**Consequence:** the model can propose a replacement that silently omits unseen
sections. Complete inspection of the proposed new payload does not reveal omitted
old text. The remediation contract explicitly required the model to have observed
a complete baseline; provider completeness alone does not satisfy that contract.

**Required fix/check:** distinguish fetched content from content actually supplied
to the model. Locally omitted/truncated context must not establish a complete edit
baseline. Permit replacement only after the required content has been delivered,
or fail closed when it cannot fit within supported limits. Cover dynamic fetch,
mentions, combined budgets, continuation reads and exhausted continuation storage.
The initial replacement must be refused before approval and transport.

Original coverage reopened: epoch 07, M3.

### R4 — Medium: queued mutations proceed after an earlier outcome becomes unknown

**Confidence: High.**

Evidence: `lib/writes/gate.ts:624` calls `requireNoConflict` before admission to
the serial runner. The queued callback at line 718 does not repeat it. Conflict
inspection excludes actively executing intent IDs. Concurrent dynamic requests
are reachable: `lib/codex/client.ts:115–116` starts independent async handlers,
and each awaits its own tool call at lines 366–367.

**Reproduction:** start one granted property update and hold its transport promise.
Admit a second update while the first intent is active. Reject the first transport
with an ambiguous connection error. The first journal row becomes `unknown`, but
the second provider call still runs. The probe observes two calls and an unresolved
entry together.

**Consequence:** already-queued work defeats the promised stop-until-reviewed
recovery rule, potentially applying dependent changes while the preceding result
is unknown. Each operation still needs its own consent/grant; this is not a bypass
of all approval checks.

**Required fix/check:** check unresolved outcomes inside the serial boundary after
previous work settles, before preparing/dispatching the next effect. Cover forward
writes and other enabled mutation paths, including settlement-storage failure.
Queue several calls behind an ambiguous write and assert one provider mutation
total until explicit review. Successful prior work must still allow the queue to
progress normally.

Original coverage reopened: epoch 04, M4.

### R6 — Medium: restored Undo requires an unrelated new chat turn

**Confidence: High.**

Evidence: `sidepanel/ChatPanel.tsx:93,121` restores the journal using
`scopeThread(threadId)`. `lib/writes/journal.ts:185–188` leaves a newly constructed
journal's `turnId` null. `lib/writes/gate.ts:545` requires both thread and turn IDs
for undo, before validating/reserving the original entry.

**Reproduction:** construct a fresh journal as on panel reopen, call
`scopeThread('persisted-thread')`, then request undo as owner with an established
workspace. It throws `NO_PERSISTED_THREAD` even though the restored thread ID is
present. Starting a subsequent normal turn calls `setThread`, which creates the
missing ID; that unrelated action should not be required for history undo.

**Consequence:** a restored applied, reversible journal entry can display Undo but
cannot execute immediately after reopening the panel. This breaks a central
recovery workflow rather than weakening its safety checks.

**Required fix/check:** give undo its own durable operation scope attached to the
restored persisted thread, without requiring a model turn or relaxing owner,
conflict, pre-image or reservation checks. Test through restored UI and
`requestRuntimeUndo` with a real applied entry; one safe inverse should execute
before any new chat turn, while viewers and stale inverses remain blocked.

Original coverage reopened: epochs 02/04, H4/M4.

## Release stance and remaining limitations

Standards: four findings (worst: R1, High). Specification: three findings (worst:
R2, High). All seven need regression coverage and fixes before claiming full
remediation. The original high-level improvements remain useful: private image
rendering, frozen full-payload approvals, exact plan grants, non-replaying writes,
and durable intents are present and their existing regressions pass.

Live acceptance is a separate unfinished requirement, not an eighth confirmed
product defect. Upload remains deliberately unsupported. Do not implement upload,
weaken undo, or remove safety checks merely to close this report. The provider-side
final-write race and model-specific isolation limits remain documented limitations.
