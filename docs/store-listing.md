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
- **Conservative undo** — supported plain-page edits restore verified prior content
  once; creations, rich pages, properties, schemas, views, and moves are marked
  not-undoable with the reason, and a target link appears only when the effect
  carries a verified existing target
- **Ask before changes** — approval cards show the complete bounded payload before any write
- **Full database work** — queries, rows, schemas, board/table/calendar views
- **Your model, always current** — pick from every model your account exposes
- **Local-first** — no Nox account, no Nox server, no Nox telemetry. Nox chat history
  stays in your browser; the AI runs through your own local Codex install, which keeps
  its own history under `~/.codex` and processes prompts under your provider's terms

Requires: a free Notion connection, plus a one-script local bridge install
(Google Chrome on Windows 10/11 or Ubuntu 22.04/24.04; macOS and other Chromium
browsers are unverified in this alpha) so Nox can drive the official Codex CLI already on your
machine with your own login.

Nox is not affiliated with Notion Labs, Inc. or OpenAI.

## Privacy justifications

- Single purpose: Notion workspace assistance via MCP + local Codex.
- No data sold; no data used for ads; no unrelated purposes.
- User content (workspace text) is sent to `mcp.notion.com` (Notion's own
  server) and to the user's locally-installed bridge process, where it is
  processed by the user's Codex provider under that provider's terms — nowhere
  else by Nox. Optional web research retrieves external sources; file upload is
  unavailable in this alpha, so attachments never leave the browser.
- Storage use documented in-repo (`docs/PERMISSIONS.md`, `docs/THREAT-MODEL.md`).
