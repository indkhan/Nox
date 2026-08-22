# Release notes — v{VERSION}

Nox is an open-source Notion AI-style side panel that runs on **your** Notion
workspace and **your** local Codex subscription. No Nox server exists.

## Highlights

- Knows which Notion page you're on and uses it as context automatically
- Workspace search, page reads/creates/edits/moves through Notion's official MCP server
- Full database support: query, rows, schemas, views (DSL authored by the model against Notion's own spec)
- Every action shown in a collapsible stream; reversible changes undo in one click
- Ask-before-changes by default; approval cards with exact payloads; write guard prevents clobbering concurrent edits
- Model picker built live from your account (`model/list`) — new OpenAI models appear without a Nox update

## Install

1. Unzip and load `dist/` via `chrome://extensions` → Load unpacked
2. `node bridge/install.mjs` (Windows/macOS/Linux) → restart Chrome
3. `codex login` if you haven't already
4. Click the Nox icon on any Notion page → Connect Notion → Connect Codex

## Known limitations

- Created pages/databases cannot be undone (Notion's MCP has no delete)
- Undo restores text, not block identity; block comments/links don't survive
- Codex stores conversation history under `~/.codex`
