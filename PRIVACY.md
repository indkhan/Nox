# Nox privacy policy

Effective: 1 September 2026

Nox is a local-first Chrome extension. Nox operates no backend, account,
analytics, advertising, or telemetry service.

## Data Nox processes

- Notion content you ask Nox to read or change.
- The current Notion page URL, visible title, and icon for page context.
- Prompts, responses, attachments, settings, and the local change journal.
- Notion OAuth tokens needed to access your workspace.

## Where data goes

Workspace requests go directly to Notion's hosted MCP service at
`mcp.notion.com`. Prompts and relevant workspace content go through the local
Nox bridge to your installed OpenAI Codex app-server under your own account.
Nox does not send data elsewhere. Notion and OpenAI process data under their
own terms.

## Storage and deletion

Nox stores chat data and attachments in Chrome IndexedDB, settings and the
Notion refresh token in extension-private Chrome storage, and the access token
in session storage. Codex may retain conversations in its normal local
`~/.codex` storage.

Delete Nox history from its history menu, disconnect Notion to remove its
tokens, or uninstall the extension to remove Chrome-managed Nox data. Remove
Codex history separately using Codex's controls.

Nox does not sell personal data, share it for advertising, or retain a
server-side copy. Browser data remains until you delete it or uninstall Nox.

Privacy questions may be filed at https://github.com/indkhan/Nox/issues without
including private workspace content.
