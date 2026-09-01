# Nox

Nox is an open-source AI side panel for Notion, powered by the Codex subscription you
already have. It can search, read, create, and organize Notion content while keeping
approvals and your data on your computer.

It runs as a Chrome/Chromium extension, connects to Notion's official hosted MCP server,
and uses your local Codex installation. There is no Nox server, Nox account, or telemetry.

> **Status: v0.1.0-alpha.** Nox is fully buildable, but Chrome Web Store submission and
> final manual release checks remain.

## Quick start

### Before you start

- Install [Node.js 22 or newer](https://nodejs.org/) and [pnpm 10 or newer](https://pnpm.io/installation).
- Install the [Codex CLI](https://github.com/openai/codex), then sign in with `codex login`.
- Have Chrome (or another Chromium browser), a Notion account, and Notion Web ready.

### Option 1: Download Nox

1. On the [Nox GitHub page](https://github.com/indkhan/Nox), select **Code → Download ZIP**.
2. Extract the ZIP.
3. Open the extracted folder in a terminal and run:

```bash
node install.mjs
```

### Option 2: Clone Nox

Run:

```bash
git clone https://github.com/indkhan/Nox.git
cd Nox
node install.mjs
```

### Finish in Chrome

The installer installs dependencies, builds Nox, registers the local bridge, and prints
the extension folder you need next.

1. Restart Chrome.
2. Open `chrome://extensions`.
3. Turn on **Developer mode**.
4. Select **Load unpacked** and choose the printed `extension/dist` folder.
5. Open Notion, select the Nox extension, then open **Settings**.
6. Select **Connect Codex** and **Connect Notion**.

Nox is now ready to use from the Chrome side panel.

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

```
Notion tab ──chrome.tabs/SW──► Side panel (agent loop, MCP client, IndexedDB)
   (which page                        │                    │
    you're on)                        ▼                    ▼
                       https://mcp.notion.com/mcp    nox-bridge (native messaging)
                       OAuth 2.1 + PKCE + DCR          └─► codex app-server
                                                            └─► your Codex quota
```

Two halves, both yours:

**Notion** is fully browser-native. Notion's hosted MCP server supports OAuth with Dynamic Client
Registration as a **public client**, so Nox ships **no client secret** and needs **no backend** —
verified against the live endpoints ([application.md](docs/application.md)).

**Codex** runs on your machine. A small bridge starts `codex app-server` — OpenAI's own binary,
with your own login — and Nox registers the Notion tools with it using Codex's `dynamicTools` API.
Codex decides what to do; **Nox performs every Notion call itself**, which is what makes approval
cards, the action stream and undo possible. No OpenAI credential ever exists inside the extension
([application.md](docs/application.md)).

## Known limitations

- **Creating a page cannot be undone** — Notion's MCP server has no delete tool. Nox marks
  creations as not-undoable and links you straight to the page.
- Full-page content undo is unavailable on structurally rich pages because Notion's markdown
  round trip is lossy. On simple pages, undo restores text but not block identity, so block-anchored
  comments and block links do not survive.
- Property undo covers safe types only (text, number, select, date, checkbox).
- Workspace search is capped by Notion at **30 requests/minute**; SQL queries and connected-app
  search are gated by your Notion plan. Nox disables what your plan can't do and says why.
- Closing the panel stops any running job.
- **Codex stores conversation history under `~/.codex`.** Nox's own history is browser-only, but
  Codex keeps its own copy — that's how prompt caching and crash recovery work.
- `dynamicTools` is an experimental Codex API and can change.
- Chrome/Chromium and Notion Web only.

## Security and privacy

- No Nox server. Outbound traffic goes only to `mcp.notion.com` and the local bridge.
- No client secrets in the bundle, and no OpenAI credential inside the extension.
- Content from your workspace is treated as **untrusted** — instructions found inside page content
  are never executed as commands, and writes outside the current conversation's context need your
  approval even in Auto mode.
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
| [docs/PERMISSIONS.md](docs/PERMISSIONS.md) | Why every manifest permission exists — review-ready |
| [docs/smoke.md](docs/smoke.md) | Manual per-release smoke checklist |

## Contributing

Pre-alpha but fully buildable: see [CONTRIBUTING.md](CONTRIBUTING.md). Every
module is testable without Chrome; bridge changes keep the fake-codex
integration suite green; live probes are opt-in.

## License

MIT — see [LICENSE](LICENSE).

Nox is not affiliated with, endorsed by, or sponsored by Notion Labs, Inc. or OpenAI.
