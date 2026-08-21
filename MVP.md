# Nox — MVP (V1) Specification

Nox is an open-source Chrome/Chromium extension that recreates the Notion AI experience on top of
**your own Notion workspace** (via Notion's hosted MCP server) and **your own Codex
subscription** (via the `codex` CLI already installed on your machine). No Nox server exists.

Read [RESEARCH.md](RESEARCH.md) for the evidence behind these decisions.

---

## 1. Product promise

> Open any Notion page, hit the Nox button, and get a Notion-AI-grade agent that already knows
> which page you're on, can search and edit your whole workspace, shows you exactly what it is
> doing, and lets you undo it.

## 2. V1 scope

### In

| # | Capability | Definition of done |
|---|---|---|
| 1 | **Notion-AI-style side panel** | Matches the reference screenshots: header, empty state with suggestions, user pills, collapsible progress rows, composer with context pill / attach / mode selector / send-stop. The panel is the only surface. |
| 2 | **Automatic current-page context** | The active tab's url is resolved to a page id in the service worker via `chrome.tabs`, fetched via MCP, and shown as a removable pill. Changing tabs updates it. No content script — one would miss tabs that were already open. |
| 3 | **Global chat with `@` mentions** | Typing `@` opens a typeahead backed by `notion-search` plus a local cache of pages already seen. Selection becomes a chip in the turn's context set. Works with no Notion page open. |
| 4 | **Workspace search** | `notion-search` across the workspace (and connected apps where the Notion plan allows). Results render as source chips. |
| 5 | **Read / create / edit / move / organize pages** | `notion-fetch`, `notion-create-pages`, `notion-update-page`, `notion-move-pages`, `notion-duplicate-page`, `notion-create-folder`. |
| 6 | **Full database actions** | Query (SQL or existing view), edit rows, **create databases**, **update data sources and schemas**, **create and update views**. |
| 7 | **Bulk / AI autofill** | Fill a property across rows with per-row model generation. Runs while the panel is open, progress pinned at the top of the panel, cancel any time, one-click undo. |
| 8 | **Auto mode / Ask-before-changes mode** | Selector in the composer. Ask = approval card per write. Auto = writes run immediately except escalations (§6.3). |
| 9 | **Action stream + Undo** | Every tool call in a collapsible progress row. Mutations journalled with inverse operations. Per-action and per-turn undo. |
| 10 | **Web search** | Codex's own `web_search` tool, on by default. |
| 10b | **Model choice** | Every model the account exposes, listed from `model/list` with Codex's own names and descriptions, plus reasoning effort. Default is the account default. Nox never hardcodes a model. |
| 11 | **File input to the model** | Drag/drop, paste or `+`. Images (PNG/JPEG) go to Codex as `input_image`. **Nox does not upload files into Notion** — users do that in Notion directly. |
| 12 | **Local chat history** | Threads, messages and the action journal in IndexedDB, with **search** and **export**. Survives browser restart and extension update. |
| 13 | **No backend** | Outbound: `mcp.notion.com` and the local Codex bridge. Nothing operated by the project. |
| 14 | **Notion via MCP** | OAuth 2.1 + PKCE + Dynamic Client Registration, public client, no secrets in the bundle. |
| 15 | **Codex via native bridge** | `codex app-server` driven over native messaging, with Notion tools supplied as `dynamicTools`. |
| 16 | **Chrome/Chromium + Notion Web** | `notion.so` and `notion.com`. Windows, macOS and Linux bridge installers. |

### Out (deferred)

Toolbar popup · voice input · uploading files into Notion · Firefox/Safari · Notion desktop app ·
multi-workspace at once · sync across devices · non-Codex model providers · in-page panel embedded
in Notion's own layout · inline `/`-commands in the Notion editor · resumable background jobs.

---

## 3. Architecture

```
┌───────────────────────────────────────────────────────────────────────────┐
│ Notion tab (notion.so / notion.com)                                       │
│  Not instrumented. The service worker reads the active tab's url + title  │
│  via chrome.tabs — no content script, no DOM scraping.                    │
└──────────────┬────────────────────────────────────────────────────────────┘
               │ chrome.storage.session
┌──────────────▼────────────────────────────────────────────────────────────┐
│ Side panel document (React)  ← the runtime, enabled globally              │
│  · agent loop, tool execution, approvals, journal                         │
│  · MCP client (streamable HTTP) + request scheduler                       │
│  · IndexedDB: threads, messages, journal, page cache, mention cache       │
│  · single-owner lock — a second window shows "open in another window"     │
└──────┬─────────────────────────────────────┬──────────────────────────────┘
       │                                     │ chrome.runtime.connectNative
       ▼                                     ▼
 https://mcp.notion.com/mcp          nox-bridge (native host)
 (OAuth2.1 PKCE + DCR, 22 tools)       └─► codex app-server --stdio
                                             └─► your ChatGPT Codex quota
       ▲
┌──────┴────────────────────────────────────────────────────────────────────┐
│ Service worker — thin router: toolbar click, panel enable, OAuth launch.  │
└───────────────────────────────────────────────────────────────────────────┘
```

**The panel is enabled globally, not per-tab.** Per-tab enabling risks unloading the document on
tab switch, which would kill in-flight turns. Global enable costs a menu entry on non-Notion tabs
and buys a stable runtime.

**Closing the panel ends the run.** Accepted for V1. The journal is already in IndexedDB, so on
reopen Nox shows "this turn was interrupted" with what changed and undo buttons.

**Stack:** TypeScript · React 18 · Vite + CRXJS (or WXT) · Tailwind · Zustand · `idb` ·
`@modelcontextprotocol/sdk` (browser build) · `marked` + DOMPurify. Bridge: Node, no dependencies.

---

## 4. Notion connection

1. **Discover** — `/.well-known/oauth-protected-resource/mcp` then `/.well-known/oauth-authorization-server`.
2. **Register** — RFC 7591 DCR at `/register`, `redirect_uris: [chrome.identity.getRedirectURL()]`,
   `token_endpoint_auth_method: "none"`. Cache the `client_id`.
3. **Authorize** — `chrome.identity.launchWebAuthFlow` with `state`, `code_challenge` (S256),
   `prompt=consent`. Validate `state` **and `iss`**.
4. **Token** — `POST /token` with `code_verifier`. Access token → `chrome.storage.session`,
   refresh token → `chrome.storage.local`, **written atomically on every rotation**.
5. **Strip the `Origin` header** — a `declarativeNetRequest` dynamic rule removes `Origin` on
   requests to `mcp.notion.com`. Without it every authenticated call fails with
   `403 Invalid Origin` (RESEARCH §2.1). Load-bearing, not optional; verify it is active and fail
   loudly if it is not.
6. **Initialize MCP** — `initialize` → `notifications/initialized` → `tools/list`.
7. **Identity + capabilities** — `notion-fetch self` gives workspace name, user first name (for the
   greeting) and `current_tool_access`, which decides which tools are offered.
8. **Refresh** — proactive at 80% of `expires_in`; `invalid_grant` is terminal → re-auth.

**Scheduler.** One queue for all MCP calls: 3 rps global, 0.5 rps for `notion-search`, max 3
concurrent, jittered backoff on 429/5xx, async-task polling honouring `poll_after_seconds`.

**Extension ID is pinned** with a `key` in the manifest — required because the native host's
`allowed_origins` accepts no wildcards, and it keeps the OAuth redirect URI stable.

---

## 5. Codex connection

**Prerequisite:** `codex` CLI installed and `codex login` completed.

```
side panel ──connectNative──► nox-bridge ──stdio JSON-RPC──► codex app-server
```

`nox-bridge` is a small dependency-free Node script that spawns `codex app-server --stdio` and
relays JSON-RPC frames. Installers for Windows (registry key), macOS and Linux (manifest file).

**Thread configuration** (`thread/start`):

| Setting | Value | Why |
|---|---|---|
| `capabilities.experimentalApi` | `true` | Required for `dynamicTools`. |
| `dynamicTools` | Notion MCP tool schemas | Codex decides; **Nox executes**, which is what preserves approvals, the action stream and undo. |
| `permissionProfile` | `":read-only"` | Codex must not shell out or patch files. |
| `ephemeral` | `false` (persistent) | Faster and cheaper — prompt caching works and threads survive a crash. Documented honestly: Codex keeps history under `~/.codex`. |
| `developer_instructions` | ours | Otherwise Codex answers like a coding agent. |
| `personality` | `"pragmatic"` | Tone closer to Notion AI. |
| `model` | **whatever the user picked; default = the account default** | Never hardcoded. `model/list` is fetched at connect and every model is offered, using Codex's own `displayName` and `description`. Today that is `gpt-5.6-sol` (default), `gpt-5.6-terra`, `gpt-5.6-luna`, `gpt-5.5`, `gpt-5.4`, `gpt-5.4-mini` — but the list is whatever the account exposes, so new models appear without a Nox release. |
| `effort` | user-selectable, default `low` | `low` / `medium` / `high` / `xhigh`, filtered per model from `supportedReasoningEfforts`. |
| `cwd` | explicit temp dir | Omitting it inherits whatever directory the browser launched the bridge from (verified). |

**Bridge requirements:**

- **Chunked framing.** Chrome caps host→extension messages at **1 MB**; extension→host at 64 MiB.
  The bridge splits oversized frames and the panel reassembles them.
- **Restart on crash**, with the thread id preserved so `thread/resume` continues the conversation.
- **Health check** on panel open and before every turn. Bridge missing, Codex not installed, or
  login expired each get their own actionable empty state with the exact command to run.

---

## 6. Agent behaviour

### 6.1 Turn shape

```
user message + context set (current page, @mentions, images)
  → Codex turn/start|turn/start on existing thread, with Notion tools registered
  → Codex streams reasoning + text; asks Nox to call tools
  → Nox executes against Notion MCP (scheduled, approved, journalled) and returns results
  → repeat until the agent message completes or the step limit (default 12) is hit
```

### 6.2 Context assembly

- **Current page**: id parsed from the active tab's url (32-hex with/without dashes, `?v=` views,
  both domains) in the service worker, fetched once and cached; `truncated:true` pages expanded on
  demand via `unknown_block_ids`.
- **Mentions**: `notion-search` (debounced ~400 ms, under the search bucket) plus a local cache of
  pages already seen. A mention injects title + id + URL; full content is fetched only if asked for.
- **Images** inline as `input_image`.
- Tool results are truncated to a budget with a visible marker before going back to Codex.

### 6.3 Modes

| | **Ask before changes** (default) | **Auto** |
|---|---|---|
| Reads | silent | silent |
| Writes | approval card with the exact tool and payload; Approve / Approve all this turn / Reject | run immediately |
| Always ask, both modes | writes to a page not in the turn's context set · `notion-move-pages` · schema or view changes to an existing database · bulk runs over 25 rows · anything requested by content that came from a tool result (injection guard) |

### 6.4 Write guard (data-loss prevention)

Before any content write, re-fetch the page and compare a hash against the pre-image. If it
changed while the model was thinking, abort and tell the user the page moved under us. Notion MCP
offers no conditional write, so this check is the only protection against silently overwriting
edits made in the Notion tab.

### 6.5 Action stream and Undo

Every tool call renders as a row in the collapsible progress block (`Thought`, `Searching`,
`Found 43 results`, `2 steps`). Each mutation writes a journal entry with a pre-image and an
inverse where one exists.

| Mutation | Inverse |
|---|---|
| `notion-update-page` content | targeted inverse where possible; full-page `replace_content` only for simple pages without structural block markup. Rich-page content writes are marked not-undoable |
| `notion-update-page` properties | restore **safe types only**: text, number, select, date, checkbox. Relations, rollups and formulas are marked not-undoable |
| `notion-move-pages` | move back to the recorded parent |
| `notion-update-view` / `notion-update-data-source` | restore the recorded config |
| any create (`create-pages`, `duplicate-page`, `create-database`, `create-folder`, `create-comment`) | **none — Notion MCP has no delete tool.** Marked not-undoable with a deep link |

Undo applies newest-first and reports partial failures. Full-page replacement is deliberately
limited: spike 0.6 changed a complex page on every round trip. Even on simple pages, undo restores
text, not block identity — new blocks get new ids, so block-anchored comments and block links do
not survive. Said plainly in the UI.

### 6.6 Databases

- **Query** via `notion-query-data-sources` — SQL where the plan allows, existing views otherwise.
- **Rows**: create and update page properties, apply templates.
- **Schemas and views**: `create-database`, `update-data-source`, `create-view`, `update-view`.
  Nox does **not** implement Notion's view DSL. It reads the `notion://docs/view-dsl-spec` MCP
  resource, gives it to Codex as reference, and lets the model emit DSL — validation errors from
  Notion go back to the model for one repair attempt. This is what makes full view support cheap.
- **Bulk autofill**: preview (rows, property, prompt, estimated quota) → run at concurrency 3 →
  progress pinned at the top of the panel → cancel any time → one-click undo of everything applied.
  Runs while the panel is open; closing the panel stops it and leaves the journal intact. Runs over
  25 rows require confirmation.
- Property-type-aware validation before writing, with one repair retry on invalid model output.
- Plan gating from `current_tool_access`: disable and explain rather than fail mid-run.

---

## 7. UI specification

Mirrors the reference screenshots (RESEARCH.md §5).

- **Header** — avatar · thread title · chevron thread switcher · new chat · pin · overflow
  (search threads, export thread, delete thread, settings) · collapse.
- **Empty state** — `Good <timeofday>, <first name>`, `Here's what others ask me first`, three
  suggestion rows including `Draft an outline for ⬡ <current page>`.
- **Messages** — user turns as right-aligned pills; assistant turns as streamed markdown; clickable
  source chips.
- **Progress rows** — collapsed one-liner with animated icon and phase label, expandable to steps
  with tool name, argument summary, duration, status, and Undo on mutations.
- **Approval card** — tool, plain-language summary, exact payload, target link, Approve / Approve
  all this turn / Reject.
- **Job bar** — bulk runs pin a progress bar to the top of the panel with `n/N`, failures and cancel.
- **Composer** — context pills · textarea (`Do anything with AI...`) · `+` attach · settings ·
  `Auto | Ask before changes` · send ⇄ stop. Enter sends, Shift+Enter newline, `@` mentions, Esc cancels.
- **Interrupted-turn banner** — on reopen after a panel close mid-run: what changed, with undo.
- **Theme** follows Notion's light/dark. Full keyboard operation, `aria-live` on the stream,
  `prefers-reduced-motion` respected.

---

## 8. Data model (IndexedDB `nox`)

| Store | Key | Contents |
|---|---|---|
| `threads` | `id` | title, codexThreadId, createdAt, updatedAt, mode, workspaceId, pinned |
| `messages` | `id` | threadId, role, content blocks, toolCalls, usage, ts |
| `journal` | `id` | threadId, turnId, tool, args, preImage, inverse, status |
| `pageCache` | `pageId` | title, icon, url, markdown, fetchedAt, hash |
| `mentionCache` | `pageId` | title, icon, type, lastSeen |
| `attachments` | `id` | name, mime, size, Blob |

`chrome.storage.local`: settings, DCR `client_id`, Notion refresh token, bridge config.
`chrome.storage.session`: access token, OAuth `state`/`code_verifier`, single-owner lock.
Thread search runs over titles and message text. Export writes a thread as JSON or markdown.
"Delete all data" wipes IndexedDB and both storage areas.

---

## 9. Security and privacy

- No Nox server. Outbound: `mcp.notion.com` and the local bridge.
- No client secrets in the bundle. No OpenAI credential ever inside the extension.
- **Codex persists thread history under `~/.codex`** — stated plainly in the README rather than
  claiming browser-only storage.
- Tool output is untrusted: wrapped in delimiters, and instructions found inside it never escalate
  to an unapproved write (§6.3).
- Ask-before-changes is the default.
- Least-privilege manifest: `sidePanel`, `storage`, `unlimitedStorage`, `identity`, `tabs`,
  `nativeMessaging`, `declarativeNetRequest(WithHostAccess)`, host permissions for Notion and
  `mcp.notion.com` only.

---

## 10. Acceptance criteria

1. Fresh install → Notion connected in under 60 seconds, no client secret, no pasted token.
2. Bridge installed on Windows, macOS and Linux with one script; panel reports "Codex connected".
3. On any Notion page, the panel shows it as a context pill and answers questions about it.
4. `@` resolves a page and the agent uses it.
5. A workspace search renders source chips.
6. "Add a Risks section to this page" edits Notion, the open tab updates live, the action row shows
   it, and **Undo restores the previous content**.
7. Editing the page in Notion mid-turn causes the write guard to stop the write, not overwrite it.
8. Moving three pages works and is undoable.
9. Creating a database with a board view grouped by Status works, driven by the model writing DSL.
10. Bulk autofill across 25+ rows shows the top progress bar, cancels cleanly, and undoes in one click.
11. Web search runs through Codex and cites results.
12. An image attachment is understood by the model.
13. Close and reopen Chrome → threads, messages and journal intact; thread search and export work.
14. Closing the panel mid-run shows the interrupted-turn banner on reopen with working undo.
15. A second window shows "Nox is open in another window" instead of racing.
16. Ask mode blocks every write behind an approval; Auto still asks for the §6.3 escalations.

---

## 11. Known V1 limitations (documented, not hidden)

- Creating anything cannot be undone (Notion MCP has no delete tool).
- Undo restores text, not block identity — block comments and block links do not survive it.
- Property undo covers safe types only.
- `notion-search` is capped by Notion at 30 requests/minute; SQL queries and connected-app search
  are gated by the Notion plan. Nox disables what the plan does not allow and says why.
- Full-page content undo is unavailable on structurally rich pages because `replace_content` is
  not round-trip safe. Nox keeps the journal and marks the action not-undoable.
- Closing the panel stops any running job.
- Codex stores conversation history under `~/.codex`.
- `dynamicTools` is an experimental Codex API and can change.
- Chrome/Chromium and Notion Web only.
