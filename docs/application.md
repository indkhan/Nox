# Nox — Application Architecture

This document describes how everything in this codebase works: every component, module,
protocol, data flow, and design decision. It is the single architectural reference for
the project.

Nox is an open-source AI sidebar for Notion, shipped as a Chrome/Chromium MV3 extension.
It connects to **your** Notion workspace through Notion's official hosted MCP server, and
drives **your local Codex install** through OpenAI's own `codex app-server` binary, relayed
by a small native-messaging host (`nox-bridge`). There is no Nox server, no account, and
no telemetry.

---

## Table of contents

1. [Repository layout](#1-repository-layout)
2. [High-level architecture](#2-high-level-architecture)
3. [The extension](#3-the-extension)
   - 3.1 [Manifest and permissions](#31-manifest-and-permissions)
   - 3.2 [Service worker (background)](#32-service-worker-background)
   - 3.3 [Content script](#33-content-script)
   - 3.4 [Side panel (the only surface)](#34-side-panel-the-only-surface)
   - 3.5 [Notion OAuth + MCP client](#35-notion-oauth--mcp-client)
   - 3.6 [Scheduler (rate limiting)](#36-scheduler-rate-limiting)
   - 3.7 [Codex connection (native bridge + client)](#37-codex-connection-native-bridge--client)
   - 3.8 [Agent loop](#38-agent-loop)
   - 3.9 [Writes pipeline: approvals, guard, journal, undo](#39-writes-pipeline-approvals-guard-journal-undo)
   - 3.10 [Database features](#310-database-features)
   - 3.11 [History / persistence](#311-history--persistence)
4. [The bridge](#4-the-bridge)
5. [Protocols end to end](#5-protocols-end-to-end)
6. [Security model](#6-security-model)
7. [Spikes and scripts](#7-spikes-and-scripts)
8. [Testing](#8-testing)
9. [Build and development workflow](#9-build-and-development-workflow)
10. [Key design decisions and their evidence](#10-key-design-decisions-and-their-evidence)

---

## 1. Repository layout

```
Nox/
├── application.md          ← this file
├── README.md               product overview
├── RESEARCH.md             verified findings (OAuth probes, tool surface, MV3 constraints)
├── MVP.md                  V1 scope, agent behaviour spec, UI spec, data model
├── PLAN.md                 epics E0–E9 with acceptance criteria, risk register
├── extension-key.json      gitignored RSA private key pinning the extension id
├── extension/              production extension code (E1+)
│   ├── manifest.config.ts  MV3 manifest source
│   ├── vite.config.ts      Vite + CRXJS + Tailwind build
│   ├── src/                background/, content/, shared/, lib/, sidepanel/
│   └── tests/              Vitest suite (unit + integration + opt-in live)
├── bridge/                 nox-bridge native messaging host
│   ├── nox-bridge.mjs      the host itself (dependency-free Node script)
│   ├── resolve-codex.mjs   deliberate codex binary resolution
│   ├── install.mjs         per-OS registration installer
│   ├── PROTOCOL.md         extension ⇄ bridge envelope protocol
│   ├── test-bridge.mjs     deterministic integration test (fake-codex)
│   └── fixtures/fake-codex.mjs  scripted fake codex app-server
├── spikes/                 E0 scripts still in use (gen-key, notion-auth)
├── scripts/live/           live smoke tests against real Codex (opt-in)
└── docs/                   THREAT-MODEL, PERMISSIONS, DEV, smoke, per-epic plans
```

---

## 2. High-level architecture

```
Notion tab ──chrome.tabs/SW──► Side panel (agent loop, MCP client, IndexedDB)
   (which page                        │                    │
    you're on)                        ▼                    ▼
                      https://mcp.notion.com/mcp    nox-bridge (native messaging)
                      OAuth 2.1 + PKCE + DCR          └─► codex app-server
                                                          └─► your Codex quota
```

Two halves, both owned by the user:

**Notion** is fully browser-native. Notion's hosted MCP server supports OAuth 2.1 with
Dynamic Client Registration as a **public client**, so Nox ships no client secret and needs
no backend. All Notion traffic goes directly from the panel to `https://mcp.notion.com/mcp`
over Streamable HTTP.

**Codex** runs on the user's machine. The `nox-bridge` Node script starts
`codex app-server`, which talks to the user's own ChatGPT/Codex subscription login.
Nox registers the Notion tools with Codex via the experimental `dynamicTools` API:
**Codex decides what to do; Nox performs every Notion call itself.** This split is what
makes approval cards, the action stream, and undo possible. No OpenAI credential ever
exists inside the extension.

Three processes cooperate:

| Process | Role |
|---|---|
| Chrome service worker | Tab/page tracking, DNR Origin-strip rule, message bus |
| Side panel document | The runtime: agent loop, Notion MCP client, Codex client, IndexedDB, all UI |
| `nox-bridge` (Node) | Native messaging host; relays JSON-RPC between panel and codex app-server |

A deliberate consequence of spike 0.4: the side panel document survives tab and window
switches when the panel is enabled globally, so the entire runtime lives there. There is
**no offscreen document** and no agent logic in the service worker.

---

## 3. The extension

Stack: TypeScript (strict), React 19, Zustand 5, Tailwind 4, `idb` 8, `marked` +
DOMPurify, built with Vite 6 + `@crxjs/vite-plugin`. Tested with Vitest 3.

### 3.1 Manifest and permissions

Source: `extension/manifest.config.ts`. MV3, name "Nox", fixed `key` so the extension id
is stable (`mocebdbngeojcjenigojedapolmpafeo`) — required because:

- the native host's `allowed_origins` takes no wildcards;
- the OAuth redirect URI is derived from the id.

Permissions and why each exists (full justifications in `docs/PERMISSIONS.md`):

| Permission | Why |
|---|---|
| `sidePanel` | the sole UI surface |
| `storage` | settings, refresh token, current-page state, owner lock |
| `unlimitedStorage` | local chat history with attachments |
| `identity` | `launchWebAuthFlow` for Notion OAuth 2.1 + PKCE |
| `tabs` | current-page detection from tab URL — no DOM scraping |
| `nativeMessaging` | talks only to the user-installed `com.nox.bridge` |
| `declarativeNetRequest` (+`WithHostAccess`) | exactly one dynamic rule stripping the `Origin` header on requests to `mcp.notion.com` |

Host permissions are limited to `*.notion.so`, `*.notion.com`, `*.notion.site`,
`mcp.notion.com`. No `<all_urls>`, no remote code, no analytics.

### 3.2 Service worker (background)

Files: `extension/src/background/index.ts`, `extension/src/background/dnr.ts`.

**Current-page tracking (no content script for identity).** The SW listens to
`tabs.onActivated` / `tabs.onUpdated` / `tabs.onRemoved` / `windows.onFocusChanged`,
parses the page id from the active tab's URL (both `notion.so` and `notion.com` domains,
dashed and undashed 32-hex ids, `?v=` view ids), normalizes it
(`shared/notion-page.ts` → `parseNotionUrl`, `normalizeId`), stores it under
`nox.currentPage` in `chrome.storage.session`, and broadcasts
`{type:'nox/current-page-changed', page}`. It also answers `nox/get-current-page`,
`nox/get-recent-pages` (last 8 pages, feeding the @-mention picker) and
`nox/get-dnr-status`. Per-tab title/icon metadata arrives from the content script via
`nox/page-meta`.

Content-script-free URL parsing was chosen deliberately: content scripts miss tabs that
were open before the extension loaded, and DOM scraping would be fragile.

**DNR Origin-strip rule (`dnr.ts`) — load-bearing.** `mcp.notion.com` rejects requests
carrying a `chrome-extension://` `Origin` header with `403 Invalid Origin`; only
declarativeNetRequest can remove the header from the extension's own fetches.
`ensureOriginStripRule()` installs dynamic rule id 1, trying several rule variants
(`initiator+request+type`, `request+type`, …), then *verifies* the install with
`probeOriginStripped()` — an unauthenticated POST to `/mcp` where HTTP 401 proves the
Origin was stripped and 403 proves it leaked. Every Notion connection first checks this
rule and hard-fails if inactive.

### 3.3 Content script

File: `extension/src/content/index.ts`. Injected on Notion domains at `document_idle`.
Its single job is cosmetic: scrape the page title and icon (emoji or image) from Notion's
DOM into `{type:'nox/page-meta', ...}` messages for the SW, hooking SPA navigation
(`pushState`/`replaceState`/`popstate`). Best-effort, silently degrades. It never handles
identity, page ids, or security-relevant data — those come from tab URLs only.

### 3.4 Side panel (the only surface)

Entry: `sidepanel/index.html` → `main.tsx` → `ErrorBoundary` → `App.tsx`.
Opened on action click via `setPanelBehavior({openPanelOnActionClick:true})`.

**Store (`store.ts`):** one Zustand store `useNoxStore` holds current page, Notion
connection status/identity/limitations, Codex status/version/model hints, agent mode,
pending approval cards, thread title/id, busy state, and settings-modal state. It
subscribes to `nox/current-page-changed` broadcasts.

**Window ownership lock:** `lib/history/panel.ts` claims
`navigator.locks.request('nox-agent-owner', {ifAvailable:true, exclusive:true})`.
One window becomes `owner` (runs connections and turns); any second window is a read-only
`viewer` and shows a banner. This prevents two windows corrupting one thread without
routing anything through the service worker.

**Components:**

| Component | Responsibility |
|---|---|
| `ChatPanel.tsx` | the turn engine: restores last thread, persists turns, subscribes to agent events, streams text deltas, renders activity timeline, undo bar, approvals, composer |
| `Composer.tsx` | contentEditable editor, @-mention picker (recent pages + remote search), mode select (Ask before changes / Auto), model & effort selects, send ⇄ stop, Esc-to-cancel |
| `MessageParts.tsx` | `ActivityTimeline` (labels, durations, result previews incl. embedded tables), follow-up actions, sanitized markdown rendering |
| `ApprovalCards.tsx` | pending approval cards (summary, exact payload JSON, reasons, target link, reversibility) answering the write gate; `UndoBar` |
| `ConnectionCard.tsx` / `BridgeCard.tsx` / `codex-connect.ts` | Notion connect flow (DNR check first), Codex connect button mirroring health/hints |
| `SettingsModal.tsx` | connections, theme, log viewer, storage usage, delete-all-data |
| `ThreadMenu.tsx` | history list/search/export/delete |
| `EmptyState.tsx`, `Onboarding.tsx`, `ResultsTable.tsx`, `ErrorBoundary.tsx` | supporting UI |

Accessibility: keyboard-only operation, focus management, `aria-live` stream,
reduced-motion support.

### 3.5 Notion OAuth + MCP client

**Facade (`lib/notion/index.ts`):** class `Notion` is the only module composing
TokenStore + ClientRegistrar + McpClient + Scheduler + CapabilityGate. `connect()`
runs the staged OAuth flow naming each failing hop (discovery → register → consent →
token exchange → initialize+identity). `refreshIdentity()` does an MCP `initialize` plus
`notion-fetch {id:'self'}` to rebuild capabilities. `scheduleCallTool(name,args)` routes
`notion-search` to the `search` bucket, everything else to `global`. `signOut()` revokes
and wipes. Production wiring lives in `lib/notion/panel.ts` (real `fetch`,
`chrome.identity.launchWebAuthFlow` interactive consent).

**OAuth (`lib/oauth/`):**
- `discovery.ts` — RFC 9728 protected-resource metadata → authorization-server metadata
  (with direct fallback); RFC 7591 Dynamic Client Registration as a public client
  (`token_endpoint_auth_method:'none'`). No client secret ships in the bundle.
- `pkce.ts` — S256 verifier/challenge/state via WebCrypto.
- `tokens.ts` — TokenStore: access token in `chrome.storage.session` (memory/disk split),
  refresh token durable in `chrome.storage.local`, written first for crash safety.
  Proactive refresh at 80% of token lifetime, single-flight refresh, atomic refresh-token
  rotation (Notion rotates on every refresh), terminal `invalid_grant` → wipe + require
  re-auth, best-effort revocation on sign-out.

**MCP transport (`lib/mcp/`):**
- `client.ts` — minimal Streamable-HTTP JSON-RPC client to `https://mcp.notion.com/mcp`
  (protocol `2025-06-18`), echoing `mcp-session-id`, Bearer auth; methods `initialize`,
  `listTools`, `callTool`, `readResource`. Accepts plain-JSON or SSE responses (`sse.ts`).
- `jsonrpc.ts` — request builders with monotonic ids.
- `errors.ts` — `classifyError()` maps failures into a taxonomy
  (`unauthenticated, dnr-missing, rate-limited, transient, plan-gated,
  workspace-mismatch, not-found, invalid-args, unknown`) each with user-facing and
  model-readable messages and retryability. Workspace mismatch is explained, never shown
  as a raw permissions error.

**Capabilities (`lib/notion/capabilities.ts`):** parses `notion-fetch {id:'self'}` to get
workspace/user identity plus Notion's own `current_tool_access` map
(`available | available_with_limit | upgrade_required | not_enabled`). Class
`CapabilityGate.can(tool)` gates both the UI and tool registration; plan-gated tools are
disabled with an explanation rather than failing mid-run. Fails open when the map is empty.

### 3.6 Scheduler (rate limiting)

File: `lib/mcp/scheduler.ts`. Class `Scheduler` enforces Notion's limits locally:
token buckets `global` (3 req/s) and `search` (0.5 req/s — search is capped harder),
shared max 3 concurrent calls, jittered exponential backoff honoring `Retry-After` on
HTTP 429/5xx and JSON-RPC `-32001`, abort-aware waiting. Every Notion call funnels through
this, so 200 rapid searches throttle gracefully instead of erroring.

### 3.7 Codex connection (native bridge + client)

**NativeBridge (`lib/codex/native.ts`):** wraps `chrome.runtime.connectNative('com.nox.bridge')`.
Envelope protocol (see §5): `{t:'rpc'|'resp'|'req'|'notif'|'status'|'chunk'|'chunkEnd'}`,
ping/pong, `respondTool(rid,result)`, 600 s default RPC timeout, `failAllPending()` on
disconnect.

**Chunking (`lib/codex/frame.ts`):** Chrome caps host→extension messages at 1 MiB. Large
envelopes arrive as `{t:'chunk',id,data}` slices followed by
`{t:'chunkEnd',id,totalChars,chunks}`; `ChunkAssembler` reassembles and validates char
counts. Pure and unit-tested. The bridge chunks anything over 256 KiB (JSON escaping can
expand raw slices ~6×).

**CodexClient (`lib/codex/client.ts`):** drives the app-server lifecycle —
`initialize` (clientInfo "nox", `experimentalApi` capability) → `model/list` →
`thread/start` → `turn/start` ⇄ item notifications → `turn/completed`. It normalizes raw
JSON-RPC into typed `CodexEvent`s (`turn-started`, `reasoning-started/delta`,
`text-started/delta`, `web-search(-completed)`, `tool-call`, `tool-completed`, `usage`,
`done{interrupted,finalText}`, `error`) so neither the agent loop nor the UI ever sees raw
JSON-RPC. Server→client `item/tool/call` requests invoke the registered `onToolCall` hook
and are answered through the bridge; other server requests are declined.

**Thread configuration** (from MVP §5, applied in `thread/start`):
`sandbox:'read-only'` (Codex must not shell out or patch files), `approvalPolicy:'never'`,
`ephemeral:false` (persistent threads survive crashes and enable prompt caching),
custom `developer_instructions`, `dynamicTools` = Notion tool schemas, explicit temp cwd,
user-selected model and reasoning effort (defaults fetched live from `model/list`).

**Health (`lib/codex/health.ts`):** `classifyBridgeFailure(message)` maps errors onto
distinct states — `bridge-missing | codex-missing | login-expired | quota-exhausted |
overloaded | unknown` — each with an actionable remediation hint ("Run:
node bridge/install.mjs", "npm i -g @openai/codex", "codex login", …). Checked on panel
open and before each turn.

Production assembly: `lib/codex/panel.ts` exposes `bridge`, `codex`, and
`connectCodexAction()` (ping host → initialize → list models).

### 3.8 Agent loop

Files: `lib/agent/{loop,executor,dynamic-tools,instructions,untrusted,context,activity}.ts`,
DI root `lib/agent/panel.ts`.

**AgentLoop (`loop.ts`)** — one instance per panel document. Owns the thread id and wires
`codex.onToolCall` → executor. Each turn:

1. Build a `<context>` preamble from the current page and @-mentions
   (`context.ts`, mentions capped at 8000 chars).
2. `ensureThread()` — `thread/start` or `thread/resume`, re-asserting settings/model/tools
   so updated `dynamicTools` schemas take effect. Tools are produced by
   `toDynamicTools(tools, gate)` (`dynamic-tools.ts`): MCP `tools/list` mapped into Codex
   function-tool shapes, dropping tools the account's plan cannot use.
3. `turn/start`; stream normalized events to the UI.
4. On server tool-call requests, execute with provenance tagging: `'user-only'` vs
   `'untrusted-context'` — any mention of untrusted content makes the whole turn
   untrusted, escalating approval requirements.
5. Enforce turn timeout (default 10 min). One transparent bridge reconnect + thread resume
   per turn is allowed when nothing has been executed yet.
6. Auto-title the thread from the first exchange.

Cancellation: aborts the executor and issues `turn/interrupt`; partial results preserved.

**ToolExecutor (`executor.ts`)** — step limit (default 12 calls), per-result character
budget (24k, truncated with a visible marker), converts every failure into a
model-readable text result ("errors are results" — a failed tool call never crashes the
turn), emits journal events.

**Prompt-injection defense (`untrusted.ts`, `instructions.ts`):** every tool result is
wrapped in `<<<UNTRUSTED_CONTENT>>>…<<<END_UNTRUSTED_CONTENT>>>` markers (nested markers
escaped); developer instructions carry deterministic rules — Notion-assistant persona
("NOT a coding agent"), Notion-flavoured markdown, `[Title](notion://page/<id>)` citation
format, act-vs-ask policy, and injection-defense rules stating that instructions found
inside tool output are data, never commands.

**UI activity mapping (`activity.ts`):** pure reducer `applyActivityEvent` builds the
ordered activity timeline (reasoning/search/tool items with status, duration, previews,
undoable flags); `TOOL_PRESENTATION` supplies plain-language labels ("Reading 'X'",
"Queried a database") hiding internal tool names, plus follow-up suggestions.

**Assembly (`panel.ts`):** constructs the WriteGate over the real scheduler/journal/store
and the singleton AgentLoop whose executor routes every tool call through
`writeGate.handle()`.

### 3.9 Writes pipeline: approvals, guard, journal, undo

Directory: `lib/writes/`. Every mutation passes through one chain in `gate.ts`:

```
classify → approve → guard → execute → verify → inverse → journal
```

Reads pass straight through (and record read-hashes used later by the guard).

- **Classify (`classify.ts`)** — `MutationKind` taxonomy: `read, content-replace,
  content-update, properties, move, duplicate, create-*, schema, view, unknown`;
  `SAFE_PROPERTY_TYPES` whitelist (text, number, select, date, checkbox);
  `detectRichPage()` regex markers (synced blocks, columns, embeds…) that make
  round-trip undo unsafe.
- **Approve (`approvals.ts`)** — modes `ask` (default; gates ALL writes) and `auto`
  (gates only escalations). Both modes always ask for: writes outside the turn's context
  set, `move-pages`, schema/view changes, bulk runs >25 rows, and anything originating
  from untrusted-context provenance. Verdicts: allow / require-approval / refuse.
  `ApprovalEngine` manages promise-backed approval cards surfaced in the UI with
  Approve / Approve all this turn / Reject.
- **Guard (`guard.ts`, `hash.ts`)** — Notion's MCP has no conditional write, so before
  content writes Nox re-fetches the page and SHA-256 hash-compares its CRLF-normalized
  markdown against the recorded read-hash; on mismatch it aborts with "the page changed"
  instead of overwriting. Post-write verification ensures a trusted inverse is only
  recorded when the write landed as expected.
- **Inverse (`inverse.ts`)** — builds runnable inverse plans where safe. Only content
  writes get a full inverse today (re-apply pre-image markdown via `replace_content`);
  structurally rich pages are marked **not-undoable** because Notion's markdown round
  trip is lossy (spike 0.6 verdict). Moves restore position; creations are permanently
  not-undoable (Notion's MCP has no delete tool — the UI deep-links instead).
- **Journal (`journal.ts`)** — serialized append-only record (memory store + IndexedDB
  store behind one interface) of every mutation: args, pre-image, inverse, status,
  thread scoping, mutual-exclusion claim/release for undo.
- **Undo (`undo.ts`)** — `undoNewest()` / `undoEntry()`; bypasses approval deliberately;
  reports partial failures explicitly; block identity (comments, block links) does not
  survive undo because new blocks get new ids — the UI says so wherever undo is offered.

### 3.10 Database features

Directory: `lib/db/`.

- **Query (`query.ts`)** — SQL mode when the plan allows `notion-query-data-sources`,
  view mode otherwise; normalizes heterogeneous tool output (JSON `{columns,rows}`,
  object arrays, plain text) into a rendered `QueryResultTable` with counts and groups.
  Bulk autofill and view-DSL helpers existed in an earlier iteration but were never
  wired into the agent loop and have been removed.

### 3.11 History / persistence

Directory: `lib/history/`. IndexedDB database `nox` (v2, versioned migrations via `idb`),
stores: `threads`, `messages` (incremental streaming persistence), `journal`, `pageCache`,
`mentionCache`, `attachments`.

- `repository.ts` — thread CRUD, rename/pin/delete, full-text search over titles and
  message text, export (JSON and markdown).
- `turn.ts` — `startPersistedTurn()` creates thread + user row up front; streaming
  assistant updates overwrite one row, so a crash mid-turn leaves consistent state.
- `restore.ts` — rebuilds UI turns after restart, marks interrupted turns (banner on
  reopen), reconstructs tool activity from the latest turn's journal entries.
- `panel.ts` — repository singleton, Web Locks owner/viewer role, storage usage,
  `deleteAllData()` (nukes IDB + both chrome.storage areas).

Note on data ownership: Nox's chat history is browser-only, but Codex keeps its own copy
of conversation history under `~/.codex` — that is how prompt caching and crash recovery
work, and it is documented honestly in the README and privacy materials.

---

## 4. The bridge

Directory: `bridge/`. Three files matter:

### `nox-bridge.mjs` — the native messaging host

A dependency-free Node script (registered as Chrome native-messaging host
`com.nox.bridge`) relaying JSON-RPC in both directions:

- **Framing:** Chrome native messaging — 4-byte little-endian length prefix + UTF-8 JSON.
  Inbound frames >32 MiB rejected defensively.
- **Chunking:** host→extension output is capped at 1 MiB by Chrome; any envelope over
  256 KiB (`SAFE_CHUNK`) is split into `{"t":"chunk","id":N,"data":slice}` frames followed
  by `{"t":"chunkEnd","id":N,"totalChars","chunks"}`. Monotonic chunk ids; receiver
  validates total char count.
- **Codex side:** newline-delimited JSON-RPC over stdio to `codex app-server`.
- **Deliberate binary resolution:** never `spawn('codex')` — PATH can pick an old install
  whose `model/list` hides newer models. `resolve-codex.mjs` gathers candidates
  (npm-vendored platform binaries, desktop app bundle, standalone releases, PATH last),
  runs `--version` on each, semver-sorts, takes the newest, honors a `CODEX_BIN` env
  override (used by tests), and spawns with `cwd: tmpdir()` so the thread never inherits
  the browser's working directory.
- **Lifecycle:** lazy start on first rpc; restart-on-crash with backoff
  (`min(10s, 1s×restarts)`, budget of 5 restarts, counter resets after 60 s stable);
  on exit it fails all outstanding client calls and auto-declines all pending
  `item/tool/call`s so Codex never hangs; terminal `dead` state still answers pings.
- **Envelope types handled:** `ping`→`pong` (node/platform/pid, codex info, spawn state,
  stderr tail), `rpc {cid,method,params}` (bridge assigns fresh integer ids toward
  Codex; error codes −32099 not-running, −32098 exited, −32097 timeout),
  `notify`, `tool-response {rid,result}` (defaults to `{"decision":"decline"}`), `start`.

### `install.mjs` — per-OS registration

Reads the pinned extension id from `extension-key.json`. Windows: writes a `.bat` wrapper
and `com.nox.bridge.json` host manifest (exact-id `allowed_origins`), registers
`HKCU\Software\Google\Chrome\NativeMessagingHosts\com.nox.bridge` via `reg add`.
macOS/Linux: shebang shim + manifest file copied into the Chrome/Chromium native-messaging
directories. One command per OS.

### `test-bridge.mjs` + `fixtures/fake-codex.mjs`

Deterministic integration test spawning the real bridge against a scripted fake
app-server: ping/pong, relay round-trips, a complete turn including an `item/tool/call`
answered with `tool-response`, a 2 MiB agent message delivered intact across chunk
frames, and crash-restart-until-dead semantics. This suite must stay green for any
bridge change (CONTRIBUTING rule).

---

## 5. Protocols end to end

Full envelope reference: `bridge/PROTOCOL.md`.

### Panel ⇄ bridge (native messaging)

```
Extension → host:  {"t":"ping"}                                   → {"t":"pong",…}
                   {"t":"rpc","cid":1,"method":"turn/start","params":{…}}  → {"t":"resp","cid":1,…}
                   {"t":"notify","method":"initialized","params":{}}
                   {"t":"tool-response","rid":9,"result":{…}}
Host → extension:  {"t":"req","rid":9,"method":"item/tool/call","params":{…}}
                   {"t":"notif","method":"item/agentMessage/delta","params":{…}}
                   {"t":"status","state":"spawning|running|exited|restarting|dead"}
                   {"t":"chunk"/"chunkEnd",…}                     (>256 KiB payloads)
```

### Bridge ⇄ codex app-server (stdio, newline-delimited JSON-RPC)

```
Client → server:  initialize {clientInfo, capabilities:{experimentalApi:true}}
                  model/list                       → account models + efforts
                  thread/start {model, effort, sandbox:'read-only',
                                approvalPolicy:'never', ephemeral:false,
                                developerInstructions, dynamicTools[], cwd}
                  thread/resume {threadId}
                  turn/start {threadId, input:[{type:'text'|'image', …}]}
                  turn/interrupt
Server → client:  item/tool/call {tool, arguments, callId}        ← answered by panel
Server events:    item/started|item/completed (reasoning|dynamicToolCall|
                  agentMessage|webSearch), item/reasoning/delta,
                  item/agentMessage/delta, error, turn/completed {usage, interrupted}
```

### A full turn, traced

1. User sends a message in `ChatPanel.send()`; the turn is persisted immediately.
2. `AgentLoop.sendUserMessage()` builds the context preamble (current page + mentions),
   ensures a thread (start/resume with fresh `dynamicTools`), issues `turn/start`.
3. The RPC travels: panel → `NativeBridge` → port frame → `nox-bridge` → stdin →
   `codex app-server`.
4. Codex streams reasoning/text deltas back as notifications; `CodexClient` normalizes
   them; the loop fans them out to the UI, which streams them into the store and IndexedDB.
5. When Codex wants a Notion operation it sends `item/tool/call`; the panel executes it:
   `WriteGate.handle` → classify → approve (card may block the turn until answered) →
   guard (hash check) → `notion.scheduleCallTool` → Scheduler bucket/backoff →
   `McpClient` POST to mcp.notion.com with the Bearer token → result wrapped untrusted,
   truncated, answered via `bridge.respondTool`.
6. Loop repeats until Codex finishes or the 12-step limit hits; `turn/completed` carries
   usage; journal entries attach to activity items enabling per-change Undo.

---

## 6. Security model

Full detail: `docs/THREAT-MODEL.md`. Summary of the mechanisms and where they live:

| Threat | Mitigation | Code |
|---|---|---|
| Prompt injection (primary) | Untrusted-content wrappers around every tool result; injection rules in developer instructions; injected write requests refused outright; ask-before-changes default; escalations always approved even in Auto | `agent/untrusted.ts`, `agent/instructions.ts`, `writes/approvals.ts` |
| Overwrite race | Pre-write hash comparison; abort instead of overwrite; post-write verification | `writes/guard.ts`, `writes/hash.ts` |
| Token theft | No client secret (per-install public-client DCR); access token session-only; atomic refresh rotation; revocation on sign-out | `oauth/tokens.ts` |
| XSS via model output | marked + DOMPurify sanitization, unit-tested against an XSS battery | `lib/markdown.ts` |
| Over-broad permissions | Narrow hosts; pinned-id bridge origin; no content scripts for identity; no remote code | `manifest.config.ts`, `docs/PERMISSIONS.md` |
| Runaway agent | 12-call step budget, 10-min turn timeout, 3 rps global / 0.5 rps search buckets, Retry-After honoring, one reconnect per turn | `agent/executor.ts`, `mcp/scheduler.ts` |
| Malformed bridge traffic | Envelope checks, chunk length validation, loud drops | `codex/frame.ts`, `nox-bridge.mjs` |

Residual risk is stated plainly: injected content may influence what the model *says*,
but silent writes require passing the approval gate, and out-of-context writes need
approval even in Auto mode.

---

## 7. Spikes and scripts

`spikes/` retains the E0 scripts still in use; the throwaway probes were removed after
their verdicts landed (evidence preserved in `docs/spikes/`):

| Script | Purpose |
|---|---|
| `gen-key.mjs` | pins the extension id (keypair; id = sha256-derived); referenced by `bridge/install.mjs` |
| `notion-auth.mjs` | full OAuth path headlessly; writes the token cache consumed by the opt-in live tests |

Spike verdicts shaped production directly: the DNR rule is load-bearing (0.1); the agent
loop lives in the panel, no offscreen doc (0.4); chunking is mandatory (0.3); rich-page
`replace_content` is not a safe undo inverse (0.6 fail → targeted inverses + not-undoable
marking); `resolve-codex.mjs` exists because the desktop binary hid newer models (0.5).

`scripts/live/codex-smoke.mjs` drives the real bridge against the real codex binary for
one trivial turn — opt-in live smoke, exits nonzero unless the turn completes with text.

---

## 8. Testing

Framework: Vitest 3 (`pnpm test` in `extension/`), environments chosen per-file via
`// @vitest-environment jsdom` comments; `fake-indexeddb` for IDB; React tests render via
`renderToStaticMarkup`. Design rule: every module is testable without Chrome — chrome
APIs sit behind adapters (`KeyValueStore`, facade singletons, DI roots in `*/panel.ts`).

Suites (`extension/tests/`):

| Area | Files |
|---|---|
| OAuth/PKCE/tokens | `oauth-discovery.test.ts`, `pkce.test.ts`, `token-store.test.ts` |
| MCP + scheduling + errors | `mcp-client.test.ts`, `scheduler.test.ts`, `errors.test.ts` |
| Notion facade + capabilities | `notion-facade.test.ts`, `capabilities.test.ts` |
| Agent internals | `agent/agent-modules.test.ts`, `activity.test.ts`, `activity-ui.test.tsx` |
| Codex client/native/health | `codex/client.test.ts`, `native.test.ts`, `health.test.ts`, `loop-integration.test.ts` |
| Writes pipeline | `writes/approvals.test.ts`, `classify.test.ts`, `gate.test.ts` |
| Databases | `db/db.test.ts` |
| History/persistence | `history.test.ts`, `history-turns.test.ts`, `viewer.test.tsx` |
| Misc | `dnr.test.ts`, `markdown.test.ts`, `notion-page.test.ts`, `theme*.test.ts`, `codex-connect.test.ts` |
| Live (opt-in) | `live/connect-preflight.test.ts`, `live/notion-live.test.ts` |

Outside the extension: `node bridge/test-bridge.mjs` (framing + chunking + fake-codex
integration), `scripts/live/codex-smoke.mjs` (real quota), and the manual per-release
checklist in `docs/smoke.md`.

---

## 9. Build and development workflow

```bash
cd extension
pnpm install
pnpm dev            # Vite + CRXJS hot reload; load unpacked from extension/dist (or dev output)
pnpm build          # tsc --noEmit && vite build
pnpm typecheck
pnpm test           # vitest run

node bridge/install.mjs       # once per machine; restart Chrome afterwards
node bridge/test-bridge.mjs   # bridge integration suite (no Chrome needed)
```

One-time setup already done: `spikes/gen-key.mjs` created `extension-key.json` (private,
gitignored); the matching **public** key is committed in the manifest config and pins the
extension id and OAuth redirect URI.

---

## 10. Key design decisions and their evidence

| Decision | Rationale | Evidence |
|---|---|---|
| Agent loop lives in the side panel, not the SW or an offscreen doc | Panel survives tab/window switches when enabled globally | Spike 0.4 |
| Codex decides, Nox executes all Notion calls | Enables approvals, action stream, undo; keeps OpenAI credentials out of the extension | Spike 0.2; RESEARCH §3.3 |
| Public-client OAuth + DCR, no backend | Notion's hosted MCP supports it; zero server, zero secrets | RESEARCH §2; spike 0.1 |
| DNR Origin-strip rule installed and verified before any MCP call | `mcp.notion.com` 403s on `chrome-extension://` origins; only DNR can fix it | Spike 0.1; `background/dnr.ts` |
| Chunked bridge framing | 1 MiB host→extension cap is certain | Spike 0.3; `test-bridge.mjs` |
| Deliberate codex resolution + temp cwd | Mixed installs hide models; threads otherwise inherit the browser's cwd | Spike 0.5; `resolve-codex.mjs` |
| Targeted inverses; rich-page replace marked not-undoable; creations never undoable | Notion markdown round trip is lossy; MCP has no delete | Spike 0.6 (fail) |
| Read-only sandbox + `approvalPolicy:'never'` on the thread | Codex must never shell out or patch files; all effects flow through Nox's gated executor | MVP §5 |
| Owner/viewer via Web Locks, not SW routing | Simplest multi-window safety; viewers stay read-only | `history/panel.ts` |
| Runtime `tools/list` + capability gating | Notion MCP is Beta; tools and plan limits change | PLAN E2/E7 |
