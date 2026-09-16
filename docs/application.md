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
| Service worker | `extension/src/background/` | Tracks the active Notion page from tab URLs, keeps recent-page metadata, opens the side panel, installs the narrow Notion Origin-strip rule (installed/unverified pre-OAuth), and restricts credential storage to trusted contexts. |
| Content script | `extension/src/content/` | Reads only the visible page title and icon within bounded sizes. Page identity comes from the tab URL, not the DOM; title/icon are untrusted labels and the script needs no storage access. |
| Side panel | `extension/src/sidepanel/` | Owns the UI and long-running runtime: connections, agent loop, approvals, streaming, history, and settings. |

The panel is the only product surface. Until both Codex and Notion are connected, the
owner panel shows the existing connection controls as a dedicated setup screen and moves
to chat automatically when both are ready. On startup, the owner reconnects Codex and
silently restores Notion when a durable refresh token is available; OAuth consent is
available when the saved authorization cannot be restored. After a connection loss, the
interrupted conversation stays visible with a reconnect banner instead of a blank setup
screen (initial onboarding still uses the setup screen); Send stays disabled until both
transports report connected. A Web Lock named
`nox-agent-owner` lets one
browser window run turns; another open panel becomes a read-only viewer. This avoids
duplicate agents writing into the same thread.

The UI is React with a single Zustand store. Model output is rendered through `marked`
and DOMPurify without automatic media/resource sinks: Markdown images become ordinary
clickable links, raw resource tags are removed, and page icon URLs use a local fallback.
Extension-page CSP permits packaged assets and only the verified Notion MCP
connection. Valid dashed or undashed Notion UUID links become HTTPS page links;
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
be disclosed, and selected files are described as local-only inputs. The composer supports the current page, explicit `@` page mentions, local
attachments, Ask/Auto mode, model, reasoning effort, and service tier.

### Notion connection

`extension/src/lib/notion/` composes the OAuth token store, MCP client, scheduler, and
capability gate.

1. Nox discovers Notion's OAuth endpoints.
2. It registers itself as a public client and uses Authorization Code + PKCE.
3. The access token stays in session storage; the refresh token is durable in local
   extension storage and is rotated safely. Both areas are restricted to trusted
   extension contexts at background startup (content scripts cannot read refresh
   credentials; page metadata still flows via runtime messages). Every authorization captures one login-attempt
   generation before async discovery/consent; sign-out, wipe, delete-all, and replacement logins invalidate
   it first. Initial saves and facade/identity/UI completion commit only while that attempt is still current:
   under the short credential-write lock (never held across network) a superseded save throws STALE_LOGIN_ATTEMPT
   with zero credential writes, identity mutates facade state only for the current attempt, and the UI re-checks
   durable credentials before showing Connected — a late result can neither resurrect authorization nor replace a
   newer login. Refreshes serialize across panels under a shared refresh lock, re-check the
   persisted generation inside the same short lock,
   and use the validated discovered token endpoint. A stale refresh response can never overwrite
   a newer login, and an old `invalid_grant` can never wipe one.
4. Nox initializes MCP, fetches the user's identity, and asks for the current tool list.
   The authorized initialize is the endpoint compatibility acceptance probe: only an
   affirmative accepted response verifies the scoped connection, while 401, 403,
   429, 5xx, redirects, malformed envelopes, and lookup failures leave it
   unverified and clear the rule for a narrow reinstall on retry.
5. Tools unavailable on the user's Notion plan are not offered to Codex.

Sign-out captures the revocation token, cancels turns/grants, clears local/session tokens
promptly under the credential lock, then revokes best-effort with a five-second timeout;
a storage failure surfaces as an incomplete sign-out, never false success. Rotation that
succeeds remotely but cannot be persisted surfaces re-authentication required. Sign-out in
one panel propagates to all panels via storage events; delete-all clears credentials
through the same serialized generation path before touching the database.

All workspace calls go to `https://mcp.notion.com/mcp` using MCP protocol `2025-06-18`.
Responses may be JSON or server-sent events. Response bodies stream through an 8 MiB
byte budget enforced on actual received wire bytes (declared `Content-Length` is
only an early hint; the supported non-stream fallback uses exact UTF-8 accounting):
oversize bodies fail honestly without a mutation retry, mid-stream aborts surface
as AbortError rather than partial text, SSE cancels early once a complete event
carries the matching request id, SSE is parsed by content type with CRLF/LF/CR,
comments, and newline-joined `data:` semantics, and only the matching request id
completes a call — another id's error never does. Malformed responses after dispatch
surface as uncertain outcomes. The scheduler allows at most three calls at
once, limits general traffic to 3 requests/second and search to 0.5 requests/second, and
retries temporary failures with `Retry-After` support for trusted known reads only.
Mutations, upload tickets, and unknown tools run exactly once: an ambiguous failure
after dispatch surfaces as an uncertain outcome instead of a silent replay.
Search spends both the global and search budgets; admission reserves concurrency
and every applicable budget together. An explicit server `Retry-After` is honored
as a minimum, and any wait that would run past the turn deadline stops instead.

Mutation authority is checked again by the scheduler after rate/concurrency admission,
immediately before the provider call; a lease or connection change during queueing
therefore dispatches nothing. Continuation handles carry the exact model-visible read
identity, so a handle from an older page version cannot complete a newer replacement
baseline even when lengths match.

Chrome adds an extension `Origin` header that Notion MCP rejects. The background worker
therefore installs one narrow declarativeNetRequest rule that removes that header only
for the owning extension's requests to the exact `https://mcp.notion.com/mcp` endpoint
(initiator plus exact-URL plus `xmlhttprequest`; no broader fallback). Before OAuth it
verifies narrow-rule installation only and reports installed/unverified; normal workspace
operation waits for the owner's authenticated acceptance afterwards. Failed installation
or acceptance removes the rule and leaves an actionable retry that reinstalls narrowly.
Extension messages use exact discriminants with bounded UUID/URL/title/icon validation;
the panel accepts current-page updates only from the background context, and the
background accepts page metadata only from the owning tab context with stale-URL checks.

### Codex connection

The extension cannot start a local process directly, so it uses Chrome native messaging:

```text
side panel ⇄ com.nox.bridge ⇄ codex app-server
  JSON          framed JSON       newline JSON-RPC
```

`bridge/nox-bridge.mjs` is a dependency-free Node host. It resolves the newest usable Codex
binary to an absolute existing path (PATH names never stay bare), caches successful
discovery for the host lifetime, honors an explicit `CODEX_BIN` absolute-path override
that fails closed when invalid, and records the selected path/version (newest-selected
is not equated with tested-compatible). It starts `codex app-server` in a temporary working directory, relays requests and
notifications, and reports health. It retries crashes up to five times. Codex stdout is
decoded as a UTF-8 stream (split multibyte sequences survive) with one line capped at
8 MiB characters; truncated or malformed lines are discarded with a bounded diagnostic
and never carried across a restart. Large messages
are split into 256 KiB chunks because Chrome caps native-host output messages at 1 MiB.
The extension reassembles at most eight chunked envelopes (256 chunks each, 32 MiB
aggregate, 30-second lifetime), validates every envelope discriminant and id without
coercion, answers malformed Codex requests with a bounded correlated error only when
the request id is valid, and drops stale or mismatched traffic without settling
unrelated work.

The Codex client initializes the app server, lists the models available to the user's
account, and starts or resumes a persistent thread with:

- `sandbox: "read-only"`
- `approvalPolicy: "never"`
- Notion tools converted at runtime to Codex dynamic tools
- Nox's workspace-plan tool (the local-file-upload tool stays hidden until its ticket contract is verified)
- Nox safety instructions

`approvalPolicy: "never"` applies to Codex's own computer actions. Notion changes still
pass through Nox's separate write gate.

Native disconnects and exited/dead statuses downgrade the Codex store label from transport
reality instead of leaving a stale "Connected". Explicit reconnect clears stale
transport/client state and lists models again even when the UI still said connected,
preserves visible history and the stored Codex thread ID, never resubmits the failed turn,
reapplies effective research/model settings, and expires old plan/Auto/upload grants and
read baselines.

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
Attachments remain local-only inputs; their metadata does not provide PDF/image contents.
Selected files stay as in-memory drafts until Send (at most ten files, 20 MiB
each, 25 MiB total, with named rejections): removing a chip, starting a new
chat, or refreshing discards them without leaving rows behind. Send persists
the user message, the draft bytes, and thread ownership in one bounded
transaction before Codex starts; only those committed ids reach the turn, and
a persistence failure sends nothing while the draft is retained.

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
- strips model-supplied control fields (never authority) and marks turns exposed to
  real workspace content as untrusted-context, which always needs confirmation —
  markers are advisory to the model; the gates below enforce. Exposure is retained
  for the Codex conversation lifetime and restored conservatively after reload, so a
  turn-two small-edit grant still needs confirmation; only a fresh thread resets it;
- routes Notion calls through the write gate and scheduler;
- wraps tool results as untrusted text before returning them to Codex;
- truncates oversized results, reports model-delivered sizes to the gate, and records
  activity timing. Truncated dynamic results and mention excerpts downgrade the
  baseline to model-partial; only fully delivered continuation reads restore it.

Structural work—database/schema/view changes, moves, and large page creation—first needs
a validated workspace plan with explicit approval in both Ask and Auto modes; no model
plan grants its own consent. After exact plan approval, covered actions run once each
without a redundant ordinary card, while capabilities, ownership, scope, guard,
scheduler, ledger, and cancellation checks still run. Operation
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
only by operation label until a second concrete plan supplies their ids.
Reads never need plans or approval. A single cosmetic view rename or
single-page move uses an ordinary approval card; anything structural needs a
plan. In Auto, silent edits happen only under the user's explicit per-turn
small-edit grant for listed pages — property updates and small text additions
up to five effects — while analysis without the grant authorizes nothing. Approval cards show the complete canonical
payload with targets, object count, and destructive flags outside the
collapsible details; approving dispatches the frozen snapshot, never the live
request object, and there is no approve-all. Workspace plans validate every
field with 1–10 operations, and evidence must be pages Nox actually retrieved
in the conversation — unknown ids are rejected, never shown as inspected.
Content replacement additionally requires a successful, complete read baseline
the model actually observed in the current thread, workspace, and connection:
provider completeness and model-delivered completeness are tracked separately.
Failed, partial (truncated/omitted blocks), unavailable, and unrecognized fetch
payloads never authorize replacement, and locally truncated dynamic results or
mention excerpts (8,000 per page, 24,000 combined) downgrade the baseline to
model-partial before any approval card — possession of a continuation handle
alone never completes it. Fully delivered continuation reads (accounting for
expiration and the 1 MiB turn budget) restore completeness; otherwise a targeted
re-fetch is required. A missing baseline forces a re-fetch instead of reusing
guard reads the model never saw. The baseline hash binds approval; the gate
re-checks it at guard time and again immediately before dispatch, retiring it
after a write or unknown outcome. An external
edit between the final read and the provider write remains a documented race
without provider conditional-write support.

Forward writes, upload effects, and undo share one serial mutation runner in
the panel holding the `nox-agent-owner` Web Lock lease. The gate refuses
mutations from viewer windows, revalidates owner lease, Notion connection
generation, workspace scope, tool capability, and cancellation after every
async boundary (guard reads, intent persistence, final re-read) and
immediately before dispatch — a stale snapshot settles its intent as failed
with zero transport — and rejects undo while a turn is active (new turns
likewise wait while undo holds the runner). Queued work rechecks unresolved
outcomes inside the serial boundary after earlier work settles, so calls
admitted behind an ambiguous first outcome stop for review. Timeline and
Undo-bar undo share one runtime path that re-reads the journal entry from
storage before dispatch; viewer and busy panels show why undo is unavailable
instead of an enabled control. A restored panel mints one undo operation
scope for its persisted thread, so undo works before any new model turn.

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
guard ─────► normalized re-fetch; refuse stale, partial, or unrecognized baselines
      │
      ▼
execute ───► call Notion MCP and verify content writes
      │
      ▼
journal ───► store an inverse when the change can be restored safely
```

Undo is deliberately conservative. Creating an object cannot be undone because the MCP
surface has no delete tool. Rich-page replacement is not considered safely reversible
because Notion's Markdown round-trip can lose structure. Content inverses additionally
require a verified complete plain baseline plus attributable post-write state, with the
expected post-hash confirmed from trusted internal metadata before undo; a later edit
blocks undo to protect the newer content. Applied but not-undoable changes show the
precise reason with the real target link, and readback that cannot verify reports
applied-but-unverified rather than a fabricated failure. Nox labels such changes as not
undoable rather than promising a partial restore.

File upload into Notion is unavailable in this alpha: the MCP ticket envelope
has no verified live fixture, so `nox-upload-local-file` is never advertised
and upload calls fail closed with `UPLOAD_UNSUPPORTED` before ticket creation,
transport, or journaling. Selection still binds files to the current turn with
stored-metadata integrity checks, the raw ticket tool is never advertised and
is refused as an unsupported effect, and local attachment handling is unchanged.
Ticket validation is fail-closed against the verified file-upload contract
(create → upload_url → multipart send → file_upload-id attach, with no
form_fields / field_name / suggested_markdown aliases): error tickets, wrong
origins (exact-origin comparison, never suffix matching), embedded URL
credentials, unexpected URL shapes, oversize bodies, redirects (never followed,
rejected before bytes reach the target), and unconfirmed or misattributed
results all refuse without retry, with no bearer token attached outside the MCP
endpoint. A confirmed upload reports uploaded-but-unattached, since attachment
is a separate step. The extension-page CSP therefore allowlists only the
verified MCP endpoint — no upload origin is listed until a live ticket fixture
verifies one.

## Local data

IndexedDB database `nox` is currently version 3.

| Store | Contains |
|---|---|
| `threads` | Conversation metadata and the Codex thread id. |
| `messages` | User/assistant text, stream state, usage, and activity. |
| `journal` | Applied changes, safe inverse calls, and undo state. |
| `attachments` | Files attached to local conversations, owned by exactly one thread. |

Version 3 removes unused page/mention cache stores and unused sort indexes while
preserving threads, messages, attachments, and the change journal.

Deleting a thread removes its messages, journal entries, and owned attachment
bytes in the same transaction; other threads and unlinked legacy rows are
untouched. Startup drops provably unreferenced legacy blobs (no thread, or a
thread that no longer exists) without guessing ownership by filename. Exports
carry attachment metadata only — never file bytes, upload tickets, or tokens.

Each panel keeps one cached database connection and closes it promptly when
another context deletes or upgrades the store, so one window cannot hold
"Delete all data" blocked forever. Deletion is cooperative: the deleter marks
a session tombstone first (other panels cancel their turns, close, and refuse
to reopen while it stands; a missed notification is repaired from the mark,
and a stale mark from a crashed deleter is cleared), clears credentials before
touching the database, waits for the real delete outcome while naming a
remaining blocker, and only then clears storage and lifts the mark. The
UndoBar shows a thread-scoped undoable count refreshed by journal changes,
thread switches, and deletion notices instead of polling the full journal.

Turn history is written through a recoverable per-turn queue: at most one
save in flight plus the latest waiting partial, so rapid streaming coalesces
instead of piling up. Each save settles on its own — one failure never poisons
later saves — and a final/outcome snapshot always supersedes waiting partials
and can never be overwritten by an older one. A failed final save surfaces
"History could not be saved" next to its answer with a snapshot retry (never
a model rerun) and a copy option; reopened history always reflects the latest
successful save.

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
| Malformed/large native messages | Envelope validation, a 32 MiB inbound limit, and validated chunk reassembly. Reassembly failures log a category only, never envelope content. |
| Support-log disclosure | Diagnostics log event categories, hop/stage, safe status codes, operation IDs, and connection stages only — no prompt bodies, page titles, tokens, provider bodies, upload URLs, or queries. Console capture converts errors to safe metadata with credential redaction; Copy is user-initiated with a review reminder and no telemetry. |
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
installed and signed in and whether Chrome is present. Codex discovery resolves to an
absolute path with an explicit `CODEX_BIN` override that fails closed; release archives
carry the root license plus assembled third-party notices, are staged in an isolated
temporary directory, and share one version source (`extension/package.json`, display
`v<version>-alpha`).

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
