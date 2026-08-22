# Chrome Web Store listing draft

## Name

Nox — Notion AI assistant for your workspace

## Short description (132 chars max)

A Notion-AI-style side panel that knows your current page, searches and edits
your workspace, and undoes what it changes. Local-first.

## Category

Productivity → Tools

## Detailed description

Open any Notion page, click Nox, and get a workspace-aware assistant in the
side panel.

- **Knows where you are** — the page you're viewing becomes context automatically
- **Searches everything** — pages, databases, and connected apps your plan allows
- **Reads, creates, edits, moves** — with every action shown as it happens
- **Undo you can trust** — reversible changes restore the prior state; creations
  are marked not-undoable and deep-linked instead
- **Ask before changes** — approval cards show the exact payload before any write
- **Full database work** — queries, rows, schemas, board/table/calendar views
- **Your model, always current** — pick from every model your account exposes
- **Local-first** — no Nox account, no Nox server, no telemetry. Chat history
  stays in your browser; the AI runs through your own local Codex install

Requires: a free Notion connection, plus a one-script local bridge install
(Windows/macOS/Linux) so Nox can drive the official Codex CLI already on your
machine with your own login.

Nox is not affiliated with Notion Labs, Inc. or OpenAI.

## Privacy justifications

- Single purpose: Notion workspace assistance via MCP + local Codex.
- No data sold; no data used for ads; no unrelated purposes.
- User content (workspace text) is sent to `mcp.notion.com` (Notion's own
  server) and to the user's locally-installed bridge process — nowhere else.
- Storage use documented in-repo (`docs/PERMISSIONS.md`, `docs/THREAT-MODEL.md`).
