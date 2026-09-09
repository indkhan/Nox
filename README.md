# Nox

**Use the Codex access you already have as a Notion AI-style assistant.**

Nox is an open-source Chrome/Chromium side panel for Notion. It can search, read, create, edit, and organize your workspace using your local Codex installation and Notion's official hosted MCP server.

**No Nox server. No Nox account. No telemetry. Your approvals and Nox data stay on your computer.**

> **Status: v0.1.0-alpha.** Nox is usable today by installing it directly from this repository.

## Why Nox

If you already use Codex, Nox lets you bring that AI access directly into Notion instead of adding another AI service in the middle.

- **Notion-native AI side panel** — works alongside the page you are viewing
- **Uses your existing Codex login** — no OpenAI API key inside the extension
- **Open source and local-first** — no Nox backend, account, or telemetry
- **Actually changes your workspace** — pages, databases, properties, relations, views, moves, and bulk updates
- **Designed around safe writes** — approvals, workspace plans, overwrite checks, an action stream, and undo where Notion makes it possible
- **Searches across your workspace** and can use web research through Codex

## Install from GitHub

### Requirements

- [Node.js 22+](https://nodejs.org/)
- [Codex CLI](https://github.com/openai/codex), signed in with `codex login`
- Chrome or another Chromium browser
- A Notion account and Notion Web

### 1. Clone and install

```bash
git clone https://github.com/indkhan/Nox.git
cd Nox
node install.mjs
```

The installer obtains pnpm when needed, installs dependencies, builds Nox, registers the local native bridge, checks for Codex and Chrome, and prints the extension folder to load.

### 2. Load Nox in Chrome

1. Restart Chrome.
2. Open `chrome://extensions`.
3. Turn on **Developer mode**.
4. Select **Load unpacked**.
5. Choose the `extension/dist` folder printed by the installer.
6. Open Notion and select the Nox extension.
7. Open **Settings**, then select **Connect Codex** and **Connect Notion**.

That's it. Nox is ready in the Chrome side panel.

> Because this alpha is distributed directly from GitHub, Chrome requires Developer mode and **Load unpacked**. A store install is not required to use Nox.

## Things you can ask Nox

- “Summarize everything related to Project X.”
- “Find the pages I haven't updated recently.”
- “Create a project database with status, owner, and priority.”
- “Add a Priority property and fill it based on the task descriptions.”
- “Move these notes into the right project pages.”
- “Search my workspace and the web, then compare the results.”

## What Nox can do

- **Notion-AI-style side panel** — the only surface, no separate popup
- **Knows the page you're on** — used as context automatically
- **Global chat with `@` mentions** for pages and databases
- **Searches your whole workspace** (and connected apps, if your Notion plan includes them)
- **Reads, creates, edits, moves and organizes pages**
- **Adapts to the task** — answers simple questions directly, handles small edits quickly, and inspects + previews structural workspace changes
- **Uses native Notion structures intentionally** — pages, databases, properties, relations, views, checkboxes and real file blocks instead of flattening everything to text
- **Full database work** — query, edit rows, create databases, edit schemas, create and update views
- **Bulk / AI autofill** with progress pinned to the top and one-click undo
- **Auto mode and Ask-before-changes mode**
- **Workspace plan approval** for database, schema, view, move and bulk changes, even in Auto mode
- **Shows every action it takes, and undoes what can be undone**
- **Web search** and **image input**, both through Codex
- **Chat history in your browser** with search and export

## How it works

```text
Notion tab ──chrome.tabs/SW──► Side panel (agent loop, MCP client, IndexedDB)
   (which page                        │                    │
    you're on)                        ▼                    ▼
                       https://mcp.notion.com/mcp    nox-bridge (native messaging)
                       OAuth 2.1 + PKCE + DCR          └─► codex app-server
                                                            └─► your Codex quota
```

Two halves, both yours:

**Notion** is fully browser-native. Notion's hosted MCP server supports OAuth with Dynamic Client Registration as a **public client**, so Nox ships **no client secret** and needs **no backend** — verified against the live endpoints ([application.md](docs/application.md)).

**Codex** runs on your machine. A small bridge starts `codex app-server` — OpenAI's own binary, with your own login — and Nox registers the Notion tools with it using Codex's `dynamicTools` API. Codex decides what to do; **Nox performs every Notion call itself**, which is what makes approval cards, the action stream and undo possible. No OpenAI credential ever exists inside the extension ([application.md](docs/application.md)).

## Known limitations

- **Creating a page cannot be undone** — Notion's MCP server has no delete tool. Nox marks creations as not-undoable and links you straight to the page.
- Full-page content undo is unavailable on structurally rich pages because Notion's markdown round trip is lossy. On simple pages, undo restores text but not block identity, so block-anchored comments and block links do not survive.
- Property undo covers safe types only (text, number, select, date, checkbox).
- Workspace search is capped by Notion at **30 requests/minute**; SQL queries and connected-app search are gated by your Notion plan. Nox disables what your plan can't do and says why.
- Closing the panel stops any running job.
- **Codex stores conversation history under `~/.codex`.** Nox's own history is browser-only, but Codex keeps its own copy — that's how prompt caching and crash recovery work.
- `dynamicTools` is an experimental Codex API and can change.
- Chrome/Chromium and Notion Web only.

## Security and privacy

- No Nox server. Outbound traffic goes only to `mcp.notion.com` and the local bridge.
- No client secrets in the bundle, and no OpenAI credential inside the extension.
- Content from your workspace is treated as **untrusted** — instructions found inside page content are never executed as commands, and writes outside the current conversation's context need your approval even in Auto mode.
- Before overwriting a page, Nox re-checks that it hasn't changed since it was read.
- Your Notion refresh token is stored in extension-private storage on disk.
- **Ask-before-changes is the default.**

## Documentation

| Doc | What's in it |
|---|---|
| [application.md](docs/application.md) | Architecture, protocols, and security boundaries |
| [Privacy policy](PRIVACY.md) | Data processing, storage, sharing, and deletion |
| [Support](SUPPORT.md) | Troubleshooting and getting help |
| [Security](SECURITY.md) | Private vulnerability reporting |
| [docs/THREAT-MODEL.md](docs/THREAT-MODEL.md) | Assets, threats (prompt injection first), and mitigations |
| [docs/PERMISSIONS.md](docs/PERMISSIONS.md) | Why every manifest permission exists |
| [docs/smoke.md](docs/smoke.md) | Manual per-release smoke checklist |

## Contributing

Nox is alpha software but fully buildable: see [CONTRIBUTING.md](CONTRIBUTING.md). Every module is testable without Chrome; bridge changes keep the fake-Codex integration suite green; live probes are opt-in.

Issues, bug reports, ideas, and pull requests are welcome.

## License

MIT — see [LICENSE](LICENSE).

Nox is not affiliated with, endorsed by, or sponsored by Notion Labs, Inc. or OpenAI.
