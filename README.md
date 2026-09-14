# Nox

**Use the Codex access you already have as a Notion AI-style assistant.**

Nox is an open-source Chrome/Chromium side panel for Notion. It can search, read, create, edit, and organize your workspace using your local Codex installation and Notion's official hosted MCP server.

**No Nox server. No Nox account. No telemetry. Your approvals and Nox data stay on your computer.**

Prompts and relevant workspace content are still processed by your Codex provider
under your own login, and — only when you enable it — by live web research.
See the [Privacy policy](PRIVACY.md) for exactly where data goes.

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
- Chrome on Windows 10/11 or Ubuntu 22.04/24.04 (other Chromium browsers and
  macOS are unverified in this alpha — they may work but are not claimed as
  supported; see the [install notes](scripts/release/README.md))
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
- **Visible action stream** — every tool call is shown as it happens with its outcome
- **Auto mode and Ask-before-changes mode**
- **Workspace plan approval** for substantial changes — destructive schema edits,
  multi-page moves, database creation, more than five created pages, or more than
  five affected objects — with explicit approval in both Ask and Auto modes.
  A single cosmetic view rename or a single-page move uses one ordinary approval card.
- **Auto needs your per-turn grant for silent edits** — “Allow small edits this turn”
  (off by default, Auto only) permits property updates and small text additions on
  the listed pages, up to five effects. Everything else asks.
- **Shows every action it takes, and undoes what can be undone**
- **Optional web search** through Codex; file attachments stay local-only
  (PDF/image analysis is unavailable, and upload into Notion is unavailable in this alpha)
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

- **Creating a page cannot be undone** — Notion's MCP server has no delete tool.
  Nox marks creations as not-undoable with the reason; a link to the affected page
  is shown only when the effect carries a verified existing target, which brand-new
  objects do not have.
- Content undo works only for simple pages with a verified complete read baseline
  and confirmed post-write state. A later edit blocks undo, and readback that cannot
  verify reports applied-but-unverified rather than success or failure. Structurally
  rich pages stay not-undoable because Notion's Markdown round-trip is lossy, and
  undo restores text but not block identity, so block-anchored comments and block
  links do not survive.
- Property, schema, view, and move changes cannot be undone in this alpha.
- File upload into Notion is unavailable in this alpha: selected files never leave
  the browser, and Nox says so instead of uploading.
- There is no dedicated bulk-autofill orchestration, quota estimate, or image/PDF
  understanding. Bulk work runs as ordinary inspected tool calls, bounded by the
  plan threshold (more than five affected objects needs an approved plan) and the
  12-call turn ceiling.
- **Delete all data removes local Nox data only** — remote Notion changes and Codex's
  own history (`~/.codex` sessions and provider records) remain; remove those
  separately.
- Workspace search is capped by Notion at **30 requests/minute**; SQL queries and connected-app search are gated by your Notion plan. Nox disables what your plan can't do and says why.
- Closing the panel stops any running job.
- **Codex stores conversation history under `~/.codex`.** Nox's own history is browser-only, but Codex keeps its own copy — that's how prompt caching and crash recovery work.
- `dynamicTools` is an experimental Codex API and can change.
- Chrome/Chromium and Notion Web only.

## Security and privacy

- No Nox server, account, or telemetry. Extension-initiated network goes to
  `mcp.notion.com` and the local bridge; your prompts and relevant workspace content
  are additionally processed by your Codex provider and — only when enabled — by live
  web sources (see the [Privacy policy](PRIVACY.md)).
- No client secrets in the bundle, and no OpenAI credential inside the extension.
- Content from your workspace is treated as **untrusted data** — prompt rules tell the
  model it is data, never commands, and deterministic gates (validated effects, exact
  approval scope, read baselines, owner-only execution) bound what can run. Markers
  alone cannot force model obedience: a convincing page can still influence what the
  model *says*; approval and provenance checks decide what it may *write*.
- Out-of-context, untrusted-context, move, schema/view, unknown, and bulk
  effects always need your confirmation; Ask mode confirms every mutation.
- Before replacing page content, Nox requires a complete read baseline the model
  actually observed and re-checks the page hash immediately before dispatch. Residual
  race: Notion MCP offers no conditional writes, so an edit landing between the last
  check and the provider write cannot be excluded.
- Your Notion refresh token is stored in extension-private storage restricted to
  trusted extension contexts; content scripts cannot read it.
- A same-user process, or a deliberately loaded modified extension, is outside the
  webpage threat boundary: it can read local extension data and `~/.codex`.
- **Ask-before-changes is the default.**

## Alpha scope

| Capability | Automated cover | Live evidence | Status |
|---|---|---|---|
| Reads, small edits, scoped plans, owner-only execution, durable unknown outcomes | Full extension suite plus the bridge harness (latest counts live in the [remediation log](docs/ADVERSARIAL-REMEDIATION-EPOCHS.md)) | Scratch-workspace runs C01–C17 | Implemented; live acceptance pending |
| Plain-page undo with a verified baseline | Deterministic gate/history suites | C10 | Supported within the stated limits; rich, property, schema, view, move, and creation undo unavailable |
| File upload into Notion | Fail-closed refusal/validation matrix | No live ticket fixture | Explicitly unsupported — files stay local-only |
| PDF/image analysis, bulk autofill, quota estimates | — | — | Not implemented and not claimed |
| Native-tool isolation per Codex version and model | Fail-closed feature/MCP inspection tests | Per-model matrix in [answer-quality-verification.md](docs/answer-quality-verification.md); reference Codex 0.153.4 | Pending live runs; a newer-than-tested Codex runs with an unverified warning |

Skipped opt-in cases are pending, never passed. No release is certified
vulnerability-free; see the [smoke checklist](docs/smoke.md) for the per-release gate.

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
