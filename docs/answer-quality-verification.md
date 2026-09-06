# Answer quality verification

Protocol reference: bridge-selected Codex **0.153.4**, generated locally with
`codex app-server generate-ts --experimental --out <temporary directory>`.
The resolver is `node bridge/resolve-codex.mjs`; do not assume PATH selects it.

Compared with [official app-server documentation](https://learn.chatgpt.com/docs/app-server)
and [configuration documentation](https://learn.chatgpt.com/docs/config-file/config-basic).
The generated types are the compatibility reference:

- `TurnStartParams.effort`; no thread-start effort field.
- `ThreadItem.agentMessage`: message ID, authoritative text, nullable
  `commentary` / `final_answer` phase.
- Notifications carry `threadId`, `turnId`, and item IDs. Turn completion carries
  `turn.status` and `turn.error`; reasoning progress uses
  `item/reasoning/summaryTextDelta`, not `item/reasoning/delta`.
- `initialized` is a client notification. Interruption requires thread and turn IDs.
- Resume supports configuration and instructions, but not dynamic-tool replacement.
  Capability checks must still reject unavailable tools at execution time.

The representative wire fixtures contain synthetic, public text, with shapes from
these generated types. They are not a claim of live capability verification.
Five expected-failure regressions record the pre-change lifecycle defects.

The 20 evaluation cases are in `scripts/live/answer-quality-cases.json`.
Create local baseline and candidate ledgers with
`node scripts/live/answer-quality-eval.mjs init <file.json> <model> <effort> live|disabled`.
Keep the same explicit settings for comparison. Record actual answers, source URLs,
elapsed milliseconds, reported usage, boolean rubric judgments, and reviewer notes.
Public research cases have three runs. Use only public questions or a dedicated test
workspace. Do not commit private outputs. `report <file.json>` fails closed on missing
reviews or safety judgments. Empty ledgers are **not** evaluated baselines.

Live baseline and complete candidate workspace evaluation: pending. Chrome visual
inspection confirmed panel/settings rendering, including Web research, but sending
was blocked by the existing Notion-connection prerequisite. Research timeline and
history visual acceptance therefore remain pending in a connected scratch profile.

## Implementation checks so far

- Lifecycle commit `7f0d985`: 331 extension tests passed; typecheck/build and
  bridge integration passed.
- Context commit `5c61a1f`: 334 extension tests passed; typecheck/build passed.
- Real 0.153.4 thread-scoped feature inspection and MCP inventory were exercised.
  Inherited `node_repl` exposed zero tools under the Nox overrides. The model can
  force `unified_exec` on; `shell_tool` remains false. Model-described orchestration
  utilities are not an authoritative inventory. Model-specific native tool isolation
  is still a release check; Nox additionally limits `agents.max_threads` to one.
- Public smoke observed simple `OK` and follow-up context on gpt-5.4-mini.
  A search request on a previously disabled loaded thread returned an unavailable
  response. Unload/resume testing did not finish within the smoke deadline.
- A later gpt-6-astra/low attempt returned `OK`, then failed with the account usage
  limit. Search/open, interruption, and the complete before/after live evaluation
  remain **unverified**. No production workspace mutation was attempted.

Local diagnostic reports are under ignored `.release/`; they are not release approval.


## Stage 6 evidence (2026-09-06)

Final extension verification: **353 passed, 7 opt-in live tests skipped**;
`pnpm typecheck` and `pnpm build` passed. All four evaluation-ledger tests passed. The complete
`node scripts/release-smoke.mjs` run passed, including bridge crash/restart and
large-message checks plus local release archive creation. Archives were not published.

Regression hardening covers cancellation with no completion (including before the
start acknowledgement), stale native-port messages, late tool success/failure,
cancelled thread setup, a completed phaseless answer followed by an unfinished
message, and journal recovery preserving commentary. Resume refuses a different
thread ID before appending any instructions. Composer model changes preserve the
separately stored research preference.

The evaluator requires the complete case set and research repetitions, settings
and prompt revision, recorded answers/timing/usage or an explicit usage limitation,
manual reviews and safety judgments. It rejects truncated ledgers and scope failures.
The ledger's four regression tests are part of `scripts/release-smoke.mjs`.

### Real resume/configuration regression

The same conversation starting with search disabled continued to say research was
disabled after `thread/resume` with live configuration. Reconnecting alone did not
resolve it. A turn-level collaboration-mode override appeared in persisted turn
metadata but did not replace the initial model-visible developer message. Inspection
was limited to the public smoke's own rollout.

The implemented path reconnects the owned server before resume, preserves the
original thread ID, verifies its restricted tool surface, and appends current
trusted developer instructions with `thread/inject_items`. This RPC and the
`message` / `developer` / `input_text` shape were checked against generated 0.153.4
types and the official app-server reference. It is an instruction refresh, not a
new chat or user-turn replay. It adds a reconnect and an instruction-history item
per resumed turn; latency and context growth remain evaluation considerations.

`node scripts/live/codex-smoke.mjs --toggle-search` passed on 2026-09-06 using
**Codex 0.153.4, gpt-6-astra, low**, prompt `answer-quality-v1`:

| Check | Observed result | Elapsed |
|---|---|---:|
| Simple, disabled | Exact OK; no search | 4.23 s |
| Follow-up | Recalled preceding token | 4.33 s |
| Enable live in same conversation | Search and official source-opening events, Markdown source link | 19.92 s |
| Stop during research | Interrupted outcome | 8.12 s |
| After interruption | Exact OK | 4.87 s |
| Disable research again | No search; explicit inability to verify current fact | 5.98 s |

Reported usage and normalized events are preserved locally in ignored timestamped
`.release/codex-smoke-*.json` reports. These are single-run smoke timings, not a
latency benchmark or an assessment of the 20-case quality criterion. A prior
live-enabled smoke on 2026-09-05 also observed search/open and clean interruption.

### Remaining release acceptance

- No complete before/after 20-case live evaluation exists, so there is no supported
  90% quality claim. The pre-change regression failures are not a numerical baseline.
- Notion is disconnected in the available Nox profile and no scratch workspace was
  identified. Live workspace summaries, mixed evidence and scratch mutation checks
  cannot be signed off from synthetic tests.
- Model-specific native tool isolation is still unverified beyond effective feature
  flags/MCP inventory; available orchestration tools vary by model.
- Connected side-panel research details, source navigation and saved outcome
  restoration still need visual acceptance. Existing automated UI/history tests
  cover rendering and restore behavior.

Do not publish this as a fully accepted answer-quality release until these checks
are completed. No production workspace changes were made during evaluation.
