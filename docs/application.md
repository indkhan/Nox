# Nox — how the application works

Nox is a Chrome side-panel assistant for Notion. It uses the user's local Codex
installation to decide what to do and Notion's hosted MCP service to read or change the
workspace. Nox has no backend, account, or telemetry service.

For the short visual version, open [how-it-works.html](how-it-works.html).

## The whole system

```text
 Notion tab                         User's computer
┌────────────┐   page id/title    ┌───────────────────────────────────────┐
│ notion.com │ ─────────────────► │ Chrome extension                     │
└────────────┘                    │  service worker ─► side panel        │
                                  │                         │             │
                                  │                  agent + safety gate  │
                                  └───────────┬─────────────┬─────────────┘
                                              │             │
                                   HTTPS/MCP  │             │ native messaging
                                              ▼             ▼
                                     ┌──────────────┐  ┌──────────┐  stdio  ┌─────────────┐
                                     │ Notion MCP   │  │ Nox      │ ──────► │ Codex       │
                                     │ hosted API   │  │ bridge   │         │ app-server  │
                                     └──────────────┘  └──────────┘         └─────────────┘
```

The important split is:

- **Codex decides.** It receives the conversation and the available tool descriptions.
- **Nox executes.** Every Notion tool call returns to the extension, where Nox can ask
  for approval, prevent unsafe overwrites, rate-limit requests, record changes, and undo
  changes that have a safe inverse.
- **Notion stores workspace data.** The extension talks directly to Notion MCP using the
  user's Notion authorization.
- **The browser stores Nox data.** Threads, messages, attachments, and the change journal
  live in IndexedDB; settings and tokens use Chrome extension storage.

No OpenAI credential is placed in the extension. The local `codex app-server` uses the
user's existing Codex login. There is no Nox cloud service between these parts.

## What happens after the user presses Send

```text
1  Panel saves the user's message
             │
2  Panel adds the current Notion page and explicit @mentions
             │
3  Local Codex starts/resumes a thread and streams its answer
             │
4  If Codex needs Notion, it requests a tool
             │
5  Nox classifies it: read or change?
             │
             ├── read ───────────────► rate limit ─► Notion MCP
             │
             └── change ─► plan/approval ─► overwrite guard ─► Notion MCP
                                                        │
6  Result returns to Codex and is shown in the activity timeline
                                                        │
7  Answer and change journal are saved locally ◄────────┘
```

A turn is limited to 12 tool calls and 10 minutes. Cancelling a turn aborts pending
Notion work, dismisses pending approvals, and interrupts Codex.

## Runtime parts

### Chrome extension

The extension is MV3 and has three runtime pieces.

| Part | Location | Responsibility |
|---|---|---|
| Service worker | `extension/src/background/` | Tracks the active Notion page from tab URLs, keeps recent-page metadata, opens the side panel, and installs/verifies the Notion Origin-strip rule. |
| Content script | `extension/src/content/` | Reads only the visible page title and icon. Page identity comes from the tab URL, not the DOM. |
| Side panel | `extension/src/sidepanel/` | Owns the UI and long-running runtime: connections, agent loop, approvals, streaming, history, and settings. |

The panel is the only product surface. A Web Lock named `nox-agent-owner` lets one browser
window run turns; another open panel becomes a read-only viewer. This avoids duplicate
agents writing into the same thread.

The UI is React with a single Zustand store. Model output is rendered through `marked`
and DOMPurify. The composer supports the current page, explicit `@` page mentions, local
attachments, Ask/Auto mode, model, reasoning effort, and service tier.

### Notion connection

`extension/src/lib/notion/` composes the OAuth token store, MCP client, scheduler, and
capability gate.

1. Nox discovers Notion's OAuth endpoints.
2. It registers itself as a public client and uses Authorization Code + PKCE.
3. The access token stays in session storage; the refresh token is durable in local
   extension storage and is rotated safely.
4. Nox initializes MCP, fetches the user's identity, and asks for the current tool list.
5. Tools unavailable on the user's Notion plan are not offered to Codex.

All workspace calls go to `https://mcp.notion.com/mcp` using MCP protocol `2025-06-18`.
Responses may be JSON or server-sent events. The scheduler allows at most three calls at
once, limits general traffic to 3 requests/second and search to 0.5 requests/second, and
retries temporary failures with `Retry-After` support.

Chrome adds an extension `Origin` header that Notion MCP rejects. The background worker
therefore installs one narrow declarativeNetRequest rule that removes that header only
for the Notion MCP endpoint. It probes the rule before connection; a failed probe stops
the connection instead of silently producing authorization errors.

### Codex connection

The extension cannot start a local process directly, so it uses Chrome native messaging:

```text
side panel ⇄ com.nox.bridge ⇄ codex app-server
  JSON          framed JSON       newline JSON-RPC
```

`bridge/nox-bridge.mjs` is a dependency-free Node host. It finds the newest usable Codex
binary, starts `codex app-server` in a temporary working directory, relays requests and
notifications, and reports health. It retries crashes up to five times. Large messages
are split into 256 KiB chunks because Chrome caps native-host output messages at 1 MiB.

The Codex client initializes the app server, lists the models available to the user's
account, and starts or resumes a persistent thread with:

- `sandbox: "read-only"`
- `approvalPolicy: "never"`
- Notion tools converted at runtime to Codex dynamic tools
- Nox's workspace-plan and local-file-upload tools
- Nox safety instructions

`approvalPolicy: "never"` applies to Codex's own computer actions. Notion changes still
pass through Nox's separate write gate.

### Agent and tool execution

`extension/src/lib/agent/` owns the thread and turn lifecycle. The current page is sent as
a reference; page contents are included only for explicit `@` mentions. Codex events are
normalized into reasoning, activity, tool-result, and answer updates for the panel.

Every tool request passes through `ToolExecutor`, which:

- enforces the per-turn step limit;
- handles Nox-only tools locally;
- rejects tool requests smuggled inside untrusted workspace content;
- routes Notion calls through the write gate and scheduler;
- wraps tool results as untrusted text before returning them to Codex;
- truncates oversized results and records activity timing.

Structural work—database/schema/view changes, moves, and large page creation—first needs
an approved workspace plan.

## Change safety

All Notion calls are classified. Known reads pass through; unknown tools are treated as
structural changes, which is the safer default.

```text
change requested
      │
      ▼
classify ─► require a workspace plan when structural
      │
      ▼
approval ─► Ask mode: ask for changes
      │       Auto mode: allow only low-risk, in-context changes
      │       untrusted/out-of-context/bulk changes: always ask or refuse
      ▼
guard ─────► fetch + hash page; refuse if it changed since Nox read it
      │
      ▼
execute ───► call Notion MCP and verify content writes
      │
      ▼
journal ───► store an inverse when the change can be restored safely
```

Undo is deliberately conservative. Creating an object cannot be undone because the MCP
surface has no delete tool. Rich-page replacement is not considered safely reversible
because Notion's Markdown round-trip can lose structure. Nox labels such changes as not
undoable rather than promising a partial restore.

## Local data

IndexedDB database `nox` is currently version 2.

| Store | Contains |
|---|---|
| `threads` | Conversation metadata and the Codex thread id. |
| `messages` | User/assistant text, stream state, usage, and activity. |
| `journal` | Applied changes, safe inverse calls, and undo state. |
| `attachments` | Files attached to local conversations. |
| `pageCache`, `mentionCache` | Local page/mention lookup data. |

Streaming messages are updated in place, so reopening the panel can identify and show an
interrupted turn. Users can search, export, or delete local history. Codex also retains
its own conversation data under its normal `~/.codex` storage.

## Security boundaries

| Risk | Main control |
|---|---|
| Prompt injection in Notion content | Tool results are marked untrusted; injected write requests are refused; risky changes require approval. |
| Overwriting a newer edit | Page content is hashed and re-read immediately before a content write. |
| Token exposure | Public-client OAuth, session-only access token, rotated refresh token, no OpenAI token in Chrome. |
| Model-output XSS | Markdown output is sanitized with DOMPurify. |
| Runaway work | Tool, time, concurrency, retry, and request-rate limits. |
| Malformed/large native messages | Envelope validation, a 32 MiB inbound limit, and validated chunk reassembly. |
| Two active panels | One owner selected with Web Locks; other panels are viewers. |

See [THREAT-MODEL.md](THREAT-MODEL.md) and [PERMISSIONS.md](PERMISSIONS.md) for the full
security and Chrome-permission rationale.

## Repository map

```text
Nox/
├── extension/
│   ├── manifest.config.ts       Chrome MV3 manifest
│   ├── src/background/          tab tracking + DNR rule
│   ├── src/content/             Notion title/icon metadata
│   ├── src/sidepanel/           React interface
│   ├── src/lib/                 agent, Codex, Notion, safety, history
│   └── tests/                   unit and integration tests
├── bridge/                      native host, installer, protocol, fake Codex
├── scripts/live/                opt-in real-Codex smoke test
├── spikes/                      retained OAuth/key utilities
├── docs/                        architecture, security, release, and spike notes
├── install.mjs                  install dependencies, build, register bridge
└── README.md                    product and installation overview
```

## Build and verify

Nox requires Node.js 22+ and pnpm.

```bash
node install.mjs                 # install, build, and register the bridge

cd extension
pnpm dev                         # extension development build
pnpm build                       # type-check and production build
pnpm test                        # Vitest suite

node ../bridge/test-bridge.mjs   # bridge + fake Codex integration test
```

The bridge wire format is documented in [bridge/PROTOCOL.md](../bridge/PROTOCOL.md).
Release checks are in [smoke.md](smoke.md).
