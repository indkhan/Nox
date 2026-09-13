# Manual smoke checklist (per release)

Run `node scripts/release-smoke.mjs` first. It must pass typecheck, unit and
integration tests, the production build, bridge protocol checks, and release
archive creation. The checklist below remains mandatory because it exercises
real Chrome, Codex quota, OAuth, and a scratch Notion workspace.

Record the release tag, tester, OS/Chrome version, Notion plan, and date in the
GitHub release notes. Never mark an account-dependent item complete from unit
test results alone.

## Adaptive workspace architecture

- [ ] Ask a simple question about the current page: Nox answers without a workspace-plan card.
- [ ] Request one explicit local edit: Nox uses normal write approval without a structural plan.
- [ ] Request a new database: Nox inspects likely existing structures and shows a plan before mutation.
- [ ] Reject the plan: no structural tool runs.
- [ ] Approve a plan, then attempt a different target: Nox returns `PLAN_MISMATCH` and makes no change.
- [ ] Attach a file: Nox states that upload into Notion is unavailable in this alpha and keeps the file local-only (no bytes leave the browser).
- [ ] Request an unsupported embed or bookmark: Nox states the limitation instead of claiming a plain link is native.

Automated coverage is unit/integration level; these steps need a real browser,
a real Notion workspace, and Codex quota. Use a **scratch page/database** for
every write test — creations cannot be undone.

## 0. Install (fresh profile)

- [ ] `node bridge/install.mjs` succeeds; Chrome restarted
- [ ] Load `extension/dist` unpacked; extension id matches `mocebdbngeojcjenigojedapolmpafeo`
- [ ] Panel opens on toolbar click, on any tab

## 1. Notion connection (AC: <60 s)

- [ ] Connect Notion → consent → "Connected" card shows workspace + user
- [ ] Plan limitations panel lists what this account can't do (if anything)
- [ ] Disconnect → reconnect works; expired token self-heals on next use

## 2. Codex connection

- [ ] Connect Codex → "Connected — codex/x.y.z", model count > 0
- [ ] Settings ⚙ lists every account model with display names; effort options filter per model

## 3. Read path (M1)

- [ ] Open a Notion page → context pill appears; changing tabs updates it
- [ ] Ask about the current page → answer cites the page chip
- [ ] Workspace search question returns source chips
- [ ] Progress row collapses/expands showing tool steps

## 4. Writes & safety (M2) — scratch page only

- [ ] Ask-mode: "Add a Risks section to this page" → approval card shows exact payload → Approve → change lands in the open tab
- [ ] Reject leaves the page untouched and tells the model
- [ ] Edit the page in Notion mid-turn → write guard stops the write ("PAGE_CHANGED_SINCE_READ")
- [ ] Undo latest restores prior content (simple page)
- [ ] Rich page edit is marked not-undoable with the structural-block reason
- [ ] Move pages requires approval even in Auto mode

## 5. Databases

- [ ] Query an existing database → results table renders with row count
- [ ] Create database + board view grouped by Status from one chat message
- [ ] Bulk autofill preview shows quota estimate; >25 rows asks to confirm
- [ ] Cancel mid-run stops cleanly; journal intact for undo

## 6. History & multi-window

- [ ] Restart Chrome → threads, messages, journal intact
- [ ] Thread search finds message text; export .md/.json downloads
- [ ] Second window shows "Nox is open in another window" and cannot start turns
- [ ] Close panel mid-turn → reopen shows the interrupted state; undo still offered

## 7. Failure states

- [ ] Stop the bridge (`taskkill` the node process) → next turn reconnects once transparently or shows install hint
- [ ] `codex` missing → actionable empty state with the exact command
- [ ] Quota/login errors map to their dedicated messages


## Answer quality (Codex 0.153.4 compatibility)

Use the binary selected by `node bridge/resolve-codex.mjs`, not necessarily PATH.
The protocol assumptions and actual observations are recorded in
[answer-quality-verification.md](answer-quality-verification.md).

- Run `node scripts/live/codex-smoke.mjs --search` for public-only native research,
  opening a source, interruption, and follow-up checks using the production client
  and loop. Set `NOX_LIVE_MODEL` and `NOX_LIVE_EFFORT` explicitly for comparisons.
- Run `node scripts/live/codex-smoke.mjs --toggle-search` to start with research
  disabled and enable it on the same persisted conversation. A live source-opening
  event is required; the model saying search is available is insufficient.
- Reports stay under ignored `.release/`. Failed runs retain timing, events and
  errors. These smoke checks never supply workspace tools.
- Create baseline and candidate ledgers with
  `node scripts/live/answer-quality-eval.mjs init <local.json> <model> <effort> live`.
  Run all 20 prompts in public contexts or a connected scratch workspace, repeating
  current/mixed research three times. Record actual output, sources, elapsed time,
  usage (or `usageUnavailableReason`), rubric judgments and failure reviews.
  Run `report <local.json>` for each ledger; the candidate must meet the release
  criterion. Retain baseline failures and do not fabricate missing historical runs.
- [ ] Compare baseline/candidate correctness, supporting evidence and latency.
- [ ] Confirm zero unauthorized changes, invented citations, hidden conversation
  resets, or failed/partial turns labeled successful.
- [ ] Inspect model-specific native tool isolation; read-only sandbox and prompt
  prohibitions alone do not establish absence of native tools.
- [ ] In the actual side panel, expand search/open details and commentary, follow
  source links, stop a streaming answer, and reopen history to check text/outcomes.
- [ ] Repeat with both Web research settings and change model/effort afterward;
  model settings must preserve the separately saved research preference.

The current panel requires Notion connection before sending, including public-only
questions. A disconnected-panel screenshot is not a successful live answer check.
