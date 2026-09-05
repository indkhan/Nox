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

Live baseline, candidate evaluation, and side-panel visual checks: pending.

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
