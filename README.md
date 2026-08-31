# Nox

Open-source AI sidebar for Notion, powered by the Codex subscription you already pay for.

Nox is a Chrome/Chromium extension. It connects to **your** Notion workspace through Notion's
official hosted MCP server, and drives **your local Codex install** through OpenAI's own
`app-server`. There is no Nox server, no account, and no telemetry.

## Prerequisites

- Chrome or a Chromium browser, and Notion Web
- A Notion account (some database features are gated by Notion's own plan limits)
- **The `codex` CLI installed and logged in** (`codex login`) with an active ChatGPT Plus/Pro plan
- The Nox bridge installed — one script, Windows / macOS / Linux

## Install from GitHub

After cloning the repository, run this once from its root:

```bash
node install.mjs
```

The installer downloads dependencies, builds Nox, and registers its local bridge. It
then prints the `extension/dist` folder to select in Chrome's **Load unpacked** dialog.

> **Status: v0.1.0-alpha — all epics E0–E9 implemented.** Architecture research,
> spikes, and the full epic plan are complete on `develop`; automated suite green
> (unit + integration + opt-in live smokes). Manual smoke checklist and Web Store
> submission remain. Start with [RESEARCH.md](RESEARCH.md), [MVP.md](MVP.md) and
> [PLAN.md](PLAN.md).

---

## What it does (V1)

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
verified against the live endpoints ([RESEARCH.md §2](RESEARCH.md)).

**Codex** runs on your machine. A small bridge starts `codex app-server` — OpenAI's own binary,
with your own login — and Nox registers the Notion tools with it using Codex's `dynamicTools` API.
Codex decides what to do; **Nox performs every Notion call itself**, which is what makes approval
cards, the action stream and undo possible. No OpenAI credential ever exists inside the extension
([RESEARCH.md §3.3](RESEARCH.md)).

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
| [RESEARCH.md](RESEARCH.md) | Verified findings: Notion MCP OAuth/CORS/DCR probes, tool surface, rate limits, Codex/ChatGPT options and their risks, MV3 constraints, and an honest impossible/risky list |
| [MVP.md](MVP.md) | V1 scope, architecture, agent behaviour, UI spec, data model, acceptance criteria |
| [PLAN.md](PLAN.md) | Spikes, 9 epics with acceptance criteria, dependency graph, milestones, risk register |
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
