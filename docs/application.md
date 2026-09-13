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

The panel is the only product surface. Until both Codex and Notion are connected, the
owner panel shows the existing connection controls as a dedicated setup screen and moves
to chat automatically when both are ready. On startup, the owner reconnects Codex and
silently restores Notion when a durable refresh token is available; OAuth consent is
available when the saved authorization cannot be restored. A Web Lock named
`nox-agent-owner` lets one
browser window run turns; another open panel becomes a read-only viewer. This avoids
duplicate agents writing into the same thread.

The UI is React with a single Zustand store. Model output is rendered through `marked`
and DOMPurify without automatic media/resource sinks: Markdown images become ordinary
clickable links, raw resource tags are removed, and page icon URLs use a local fallback.
Extension-page CSP permits packaged assets and only the verified Notion MCP/upload
connections. Valid dashed or undashed Notion UUID links become HTTPS page links;
web sources use Markdown links with safe new-tab behavior. Search activity preserves
item IDs, queries and available open/find actions, with expandable details. Commentary
and documented reasoning summaries are shown as progress, separate from the answer;
legacy raw-reasoning activity remains hidden. Failed/stopped response labels survive
history restoration. Journal recovery merges tool outcomes without discarding
saved commentary or research activity.

Answering instructions are rebuilt per turn from current identity, tool capabilities,
search preference and date/timezone. The panel loads settings before it enables chat or
turn setup; a failed settings read is retryable and does not silently enable research.
Workspace claims require workspace evidence;
current external facts require available web research. Discussion/research does not
authorize changes, including in Auto mode. Incomplete evidence and failed work must
be disclosed, and selected files are described as upload inputs. The composer supports the current page, explicit `@` page mentions, local
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
retries temporary failures with `Retry-After` support for trusted known reads only.
Mutations, upload tickets, and unknown tools run exactly once: an ambiguous failure
after dispatch surfaces as an uncertain outcome instead of a silent replay.
Search spends both the global and search budgets; admission reserves concurrency
and every applicable budget together. An explicit server `Retry-After` is honored
as a minimum, and any wait that would run past the turn deadline stops instead.

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

### Web research

The Web research preference requests live Codex search, or disables it, through
thread-scoped configuration. It never changes global Codex settings. Managed search
restrictions are inspected before thread setup and reported as limitations. Freshness
is established by actual source retrieval, not by the preference alone.

Before resuming a conversation, Nox reconnects its owned app-server process so
configuration overrides apply to a reloaded thread, preserving the same stored ID.
Codex 0.153.4 retains old developer messages across resume; Nox appends its current
trusted instructions through `thread/inject_items` before starting the next turn.
This refreshes settings, capability and date context without replaying user work.
Before each turn, Nox verifies thread-scoped feature flags and MCP inventory. It
turns off inherited MCP servers, plugins/connectors, shell access, browser/computer
use, image tools, hooks, memory, and multi-agent features, and caps agent threads at
one. Codex 0.153.4 can force the unified-exec backend flag from model metadata;
`shell_tool` is the verified shell availability gate. Built-in orchestration surfaces
can still vary by model: complete model-specific isolation remains a live release
check, not a guarantee derived from a read-only sandbox. Configuration inspection is
allowlisted by the native bridge so provider credentials and MCP headers never enter
Chrome.

Native research runs inside Codex, outside ToolExecutor. Nox deduplicates search
activity by item ID and interrupts at 12 observed research items, separately from the
12 dynamic-call ceiling and ten-minute deadline. The protocol cannot gate native
search before execution, so in-flight work may exceed the observed boundary.

### Agent and tool execution

`extension/src/lib/agent/` owns the thread and turn lifecycle. The current page is sent as
a reference; page contents are included only for explicit `@` mentions. Current-page metadata is
captured at Send and merged with mentions by normalized page ID. Retrieval metadata
labels reference-only, fetched, partial, and unavailable pages. Mention excerpts are
limited to 8,000 characters per page and 24,000 combined. Local truncation includes
opaque continuation handles; `nox-read-continuation` reads already-fetched text under
the same 12-call limit and source capability check. Its memory is ephemeral, capped at
one million characters per turn, and cleared on completion. Remote Notion truncation
requires fetching the returned omitted subtree IDs or using supported targeted tools.
Attachments remain upload inputs; their metadata does not provide PDF/image contents.

Failed resume never starts a replacement thread. Only a recoverable connection failure
is retried once against the same thread, before any turn is sent. Codex events are
matched to the acknowledged thread and turn, including events received before the
start response. Assistant messages are assembled by ID: completed text replaces
streamed text, commentary stays in activity, and final answers stay separate. When
phases are absent, the last completed assistant message is the answer; interrupted
turns retain the latest partial text. Only reasoning summaries
are shown. Failed and interrupted turns preserve partial text and their outcome in
history. Reasoning effort is validated against model capabilities and sent on
`turn/start`, using the model default unless the user selects an override.

Cancellation and the ten-minute deadline include mention preparation and thread
setup. Cancellation aborts reads, rejects pending approvals, prevents late dynamic
tools, and interrupts the acknowledged turn ID. An interruption RPC failure or missing completion after five seconds disconnects
the bridge and surfaces an error; a disconnected turn is never automatically replayed.

Every tool request passes through `ToolExecutor`, which:

- enforces the per-turn step limit;
- handles Nox-only tools locally;
- rejects tool requests smuggled inside untrusted workspace content;
- routes Notion calls through the write gate and scheduler;
- wraps tool results as untrusted text before returning them to Codex;
- truncates oversized results and records activity timing.

Structural work—database/schema/view changes, moves, and large page creation—first needs
a validated workspace plan. Ask mode displays that plan for approval; Auto mode approves
the validated plan internally and executes its matching structural operations without a
second approval card. The plan still limits execution to its listed operations. Operation
names must use the exact `notion-*` tool name, and target matching accepts any relevant ID
carried by the call (for example, either the database or data-source ID of a view).

## Change safety

All Notion calls are classified. Known reads pass through. Every proposed mutation is first
parsed into a validated effect — canonical tool, frozen arguments, affected
targets, and object count — within a per-operation size budget; unknown tool
shapes are refused as unsupported and malformed proposals as invalid before any
approval card or transport, and model-supplied internal fields are rejected
rather than stripped silently. Substantial work needs an explicit workspace
plan with complete operation arguments in both Ask and Auto modes: approval
covers exactly the listed operations once each, bound to the current
workspace, connection, thread, and turn, and later creations are referenced
only by operation label until a second concrete plan supplies their ids. Approval cards show the complete canonical
payload with targets, object count, and destructive flags outside the
collapsible details; approving dispatches the frozen snapshot, never the live
request object, and there is no approve-all. Workspace plans validate every
field with 1–10 operations, and evidence must be pages Nox actually retrieved
in the conversation — unknown ids are rejected, never shown as inspected.

Forward writes, upload effects, and undo share one serial mutation runner in
the panel holding the `nox-agent-owner` Web Lock lease. The gate refuses
mutations from viewer windows, re-checks the owner lease, the Notion
connection generation, and cancellation immediately before dispatch, and
rejects undo while a turn is active (new turns likewise wait while undo
holds the runner). Timeline and Undo-bar undo share one runtime path that
re-reads the journal entry from storage before dispatch; viewer and busy
panels show why undo is unavailable instead of an enabled control.

Every mutation persists a pending intent — operation scope, frozen arguments,
and pre-image — before dispatch and settles it to applied, failed, or unknown
afterwards, so a crash can never leave a dispatched effect without a durable
identity. Mutations require a persisted thread and an established workspace;
a success the store cannot record surfaces as an applied-with-recovery-warning
instead of plain success. Unresolved operations restore as prominent
Needs-review activity with inspect links and readback evidence, and block new
writes and undo until marked reviewed. Undo reserves its original atomically
and completes only when the inverse is known applied.

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

IndexedDB database `nox` is currently version 3.

| Store | Contains |
|---|---|
| `threads` | Conversation metadata and the Codex thread id. |
| `messages` | User/assistant text, stream state, usage, and activity. |
| `journal` | Applied changes, safe inverse calls, and undo state. |
| `attachments` | Files attached to local conversations. |

Version 3 removes unused page/mention cache stores and unused sort indexes while
preserving threads, messages, attachments, and the change journal.

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

Nox requires Node.js 22+. The main installer uses an existing pnpm 10+ installation or
downloads a pinned pnpm release through Node's Corepack, then checks whether Codex is
installed and signed in and whether Chrome is present.

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
