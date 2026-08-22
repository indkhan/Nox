# Nox agent UI

Nox renders a turn as streamed answer text plus an ordered activity timeline.

## Activity states

- `reasoning`: a short, user-readable trace captured before an action.
- `search`: web search in progress.
- `tool`: a Notion action with `running`, `completed`, or `failed` status.
- Tool calls are correlated by `callId` and may include duration, error, and a truncated result preview.

## Presentation rules

1. Lead with a plain-language action label; keep internal tool names out of the primary UI.
2. Show only the current action while collapsed. Completed turns summarize their action count.
3. Put result previews, errors, and timing inside the expanded timeline.
4. Ask approvals as decisions: consequence first, technical payload under details.
5. Use indigo for active work, green for success, rose for failure, and amber only for risk.

## Adding a tool

Add its running, completed, and failure wording to `toolActivityLabel` and
`failedToolActivityLabel`. Unknown tools use a readable fallback automatically.
Only add a custom result component when the generic text preview is materially unclear.
