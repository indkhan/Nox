# Nox agent UI

Nox renders a turn as streamed answer text plus an ordered activity timeline.

## Activity states

- `reasoning`: a short, user-readable trace captured before an action.
- `search`: web search in progress.
- `tool`: a Notion action with `running`, `completed`, or `failed` status.
- Tool calls are correlated by `callId` and may include duration, error, and a truncated result preview.
- Model-facing tool output remains security-wrapped; UI previews use a separate local-only display field.

## Presentation rules

1. Lead with a plain-language action label; keep internal tool names out of the primary UI.
2. Show only the current action while collapsed. Completed turns summarize their action count.
3. Put result previews, errors, and timing inside the expanded timeline.
4. Ask approvals as decisions: consequence, target, and reversibility first; technical payload under details. Approval labels must exactly match their authorization scope.
5. Use indigo for active work, green for success, rose for failure, and amber only for risk.

## Adding a tool

Add its running, completed, and failure wording to `toolActivityLabel` and
`failedToolActivityLabel`. Unknown tools use a readable fallback automatically.
Only add a custom result component when the generic text preview is materially unclear.

## Theme

System theme is the automatic default. A user can explicitly select Light or Dark to match Notion.
Nox does not claim to detect Notion's theme because its no-content-script architecture cannot
observe Notion's DOM or application preferences.
