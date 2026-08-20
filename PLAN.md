# Nox — Delivery Plan (V1)

Epics and acceptance criteria for [MVP.md](MVP.md). Evidence in [RESEARCH.md](RESEARCH.md).

**Sequence:** E0 first (it can still reshape the runtime), then E1 → E2 → E3 → E4 in order.
E5–E8 parallelize once E4 lands. E9 gates release.

Sizes are relative (S / M / L).

---

## E0 — Spikes (~1.5 days, throwaway code)

Each produces a one-paragraph verdict in `docs/spikes/`.

| # | Test | Decides | If it fails |
|---|---|---|---|
| 0.1 | Notion OAuth end-to-end from a real unpacked extension: DCR → `launchWebAuthFlow` → token → `initialize` → `tools/list` → `notion-fetch self` | that the whole Notion design holds | Manual "paste a token" fallback. Expected to pass — the server side is already verified. |
| 0.2 | Bridge: spawn `codex app-server --stdio`, `initialize` with `experimentalApi`, `thread/start` with `dynamicTools` + `:read-only` + custom `developer_instructions` + no writable `cwd`; register a fake tool and get an `item/tool/call` callback | the entire Codex architecture | Fall back to a local OpenAI-compatible proxy (RESEARCH.md §3.7) — same UI, different provider file. |
| 0.3 | Force a >1 MB host→extension message and observe the failure | the bridge's framing design | Chunking becomes mandatory rather than defensive. |
| 0.4 | Does the panel document survive a tab switch with the panel enabled **globally**? Does it survive a window switch? | where the agent loop lives | Move the loop to an offscreen document; panel becomes a view. |
| 0.5 | Which models does the subscription expose through app-server, and how slow is each on "draft an outline for this page"? | the default model and reasoning effort | Pick the fastest usable; if all are slow, set expectations in the UI. |
| 0.6 | `notion-fetch` → `replace_content` round-trip on a complex page (toggles, columns, callouts, synced blocks, embedded database) | how far undo can be trusted | Restrict content-replace to pages under a complexity threshold and warn. |

**Status (2026-08-20):** 0.1 **pass** (needed a `declarativeNetRequest` Origin strip — see
`docs/spikes/`), 0.3 **pass** (chunking mandatory), 0.4 **pass** (panel survives tab switches →
the agent loop lives there, no offscreen document). 0.2 partially proven — `dynamicTools` accepted,
the `item/tool/call` round trip still blocked on Codex quota. 0.5 and 0.6 outstanding.

**Exit:** verdicts written; runtime location fixed; undo scope fixed.

---

## E1 — Skeleton (S)

1. **Pin the extension ID**: generate a keypair, put `key` in `manifest.json`. Do this first — the
   native host's `allowed_origins` takes no wildcards and the OAuth redirect URI depends on it.
2. Vite + CRXJS (or WXT) + TypeScript + React + Tailwind; `pnpm dev` hot-reloads.
3. Manifest: MV3, `sidePanel`, `storage`, `unlimitedStorage`, `identity`, `tabs`, `nativeMessaging`,
   `declarativeNetRequest`, `declarativeNetRequestWithHostAccess`; hosts limited to
   `https://*.notion.so/*`, `https://*.notion.com/*`, `https://mcp.notion.com/*`.
4. Service worker: panel **enabled globally**, opens on action click.
5. Current-page detection in the service worker via `chrome.tabs` (`onActivated`, `onUpdated`,
   `onFocusChanged`): parse the page id from the active tab's url (both domains, `?v=` views,
   dashed and undashed ids). **No content script** — it misses tabs open before the extension
   loaded. No DOM scraping.
6. Typed message bus, Zustand store, error boundary, dark theme tokens, CI (typecheck + build).

**AC:** clicking the icon on a Notion page opens a panel showing the current page id. CI green.

---

## E2 — Notion MCP + OAuth (L)

0. **`Origin`-strip DNR rule** installed before any MCP call — `mcp.notion.com` returns
   `403 Invalid Origin` for `chrome-extension://` origins (RESEARCH §2.1). Verify it is active and
   fail loudly if it is not.
1. OAuth discovery → RFC 7591 DCR → PKCE S256 via `launchWebAuthFlow`; validate `state` and `iss`.
2. Token storage split (`session` / `local`), **atomic refresh-token rotation**, proactive refresh
   at 80% of `expires_in`, `invalid_grant` → re-auth, sign-out revokes and wipes.
3. MCP client over streamable HTTP: `initialize`, `tools/list`, `tools/call`, `resources/read`
   (for `notion://docs/view-dsl-spec`); SSE fallback to `/sse`.
4. **Scheduler**: 3 rps global, 0.5 rps search, max 3 concurrent, jittered backoff, `Retry-After`.
5. Async task helper: detect `async_task`, poll per `poll_after_seconds`, surface progress.
6. Capability gate from `notion-fetch self`; `can(tool)` used by the UI and tool registration.
7. Connection UI: connect / connected-as / reconnect / disconnect + plan limitations panel.
8. **Workspace mismatch detection** — the open page belongs to a workspace the token does not
   cover: explain it, do not surface a raw permissions error.

**AC:** connect in under 60s on a clean profile; identity and tool list shown; expired token
self-heals; 200 rapid searches throttle instead of erroring.

---

## E3 — Bridge + Codex (M)

1. `nox-bridge`: dependency-free Node script, spawns `codex app-server --stdio`, relays JSON-RPC.
2. **Chunked framing** for the 1 MB host→extension cap; reassembly in the panel.
3. Install scripts: Windows (`REG ADD` + manifest), macOS and Linux (manifest file). One command
   each, documented per OS.
4. Thread lifecycle: `initialize` (with `experimentalApi`) → `thread/start` with the settings table
   in MVP §5 → `turn/start` → stream `item/*` → `turn/completed`. `thread/resume` on reconnect.
5. Restart on crash with the thread id preserved.
6. Health check on panel open and before each turn, with distinct states: bridge not installed,
   `codex` not found, login expired, Codex quota exhausted.
7. Normalized event stream (`text-delta`, `reasoning-delta`, `tool-call`, `usage`, `done`, `error`)
   so the UI never sees raw JSON-RPC.

**AC:** panel says "Codex connected"; a plain question streams an answer with reasoning summaries;
killing Codex mid-session reconnects and resumes; a >1 MB response arrives intact.

---

## E4 — Agent loop and Notion tools (L)

1. Register Notion tools as `dynamicTools`, filtered by `current_tool_access` and mode.
2. Tool executor: handle `item/tool/call`, schedule, journal, stream progress, return results; map
   MCP errors into model-readable results rather than crashing the turn.
3. **Untrusted-content wrapper** on every tool result, plus system rules that instructions inside
   tool output are data.
4. `developer_instructions`: Notion-assistant persona, Notion-flavoured markdown rules, page-id and
   URL handling, source citation, when to ask versus act.
5. Context assembly: current page, `@` mentions, images; tool-result truncation with a visible marker.
6. Cancellation: `turn/interrupt` plus abort through the scheduler, partial results preserved.
7. Step limit (default 12) and turn timeout.
8. Auto-titling of threads from the first exchange.

**AC:** "find the Projects database and tell me what's overdue" completes end to end; cancelling
mid-tool leaves consistent state; a page containing `ignore previous instructions` triggers no
unapproved write. **This is the milestone where the product exists.**

---

## E5 — UI (L)

1. Panel shell: header, thread switcher, new chat, pin, overflow, collapse.
2. Empty state: greeting, `Here's what others ask me first`, three suggestions including the
   current-page variant.
3. Message list: user pills, streaming markdown (`marked` + DOMPurify), code blocks, nested lists,
   clickable source chips.
4. Progress rows: collapsed phase label with animated icon, expandable step list with status,
   duration and Undo on mutations.
5. Composer: context pills, autosizing textarea, `+` attach, settings, `Auto | Ask before changes`,
   send ⇄ stop; Enter / Shift+Enter / `@` / Esc.
6. Job bar pinned to the top of the panel for bulk runs.
7. Interrupted-turn banner on reopen.
8. Settings: model, reasoning effort, default mode, escalation threshold, bridge status, data controls.
9. Accessibility: keyboard-only operation, focus management, `aria-live` stream, reduced motion.

**AC:** side-by-side with the reference screenshots, layout and states match; no layout shift while
streaming; fully keyboard operable.

---

## E6 — Writes, approvals, undo (L)

1. Write wrappers with pre-image capture for every mutating tool.
2. **Write guard**: re-fetch and hash-compare immediately before content writes; abort with "the
   page changed" instead of overwriting.
3. Approval card: tool, plain-language summary, exact payload, target link, Approve / Approve all
   this turn / Reject; blocks the turn until answered.
4. Mode wiring: Ask gates all writes; Auto gates only the MVP §6.3 escalations.
5. Journal and inverse builders (MVP §6.5), including the safe-property whitelist.
6. Undo UI: per-action and per-turn, newest-first, explicit partial-failure reporting.
7. Not-undoable handling for creations: clear marking, deep link, "delete in Notion" step.
8. Block-identity warning surfaced wherever undo is offered.
9. Complexity guard before `replace_content` on rich pages (per spike 0.6).

**AC:** every write appears in the stream; reversible writes reverse and the Notion tab reflects it;
Ask mode cannot write unapproved; the write guard demonstrably prevents a mid-turn overwrite.

---

## E7 — Databases (L)

1. Database and data-source discovery: schema, properties, templates, views.
2. Query: SQL where the plan allows, view mode otherwise; rendered as a table with counts and groups.
3. Row operations: create rows, update properties, apply templates, property-type validation with
   one repair retry.
4. Schema: `create-database`, `update-data-source`.
5. Views: `create-view`, `update-view`. **Nox implements no DSL** — it reads
   `notion://docs/view-dsl-spec` and hands it to Codex as reference, feeding Notion's validation
   errors back for one repair attempt.
6. Bulk autofill: preview (rows, property, prompt, estimated quota) → concurrency 3 → top job bar →
   cancel → one-click undo. Confirmation above 25 rows. Closing the panel stops the run and leaves
   the journal intact.
7. Plan gating: `upgrade_required` tools disabled with an explanation, never a mid-run failure.

**AC:** create a database with a board view grouped by Status from a chat message; autofill 25+ rows
with progress, cancel cleanly, undo in one click; invalid select values never reach Notion.

---

## E8 — History, settings, onboarding (M)

1. IndexedDB schema with versioned migrations; incremental message persistence.
2. Thread list, switcher, rename, pin, delete, **search** (titles and message text), **export**
   (JSON and markdown).
3. **Single-owner lock** in `chrome.storage.session`; a second window shows "open in another window".
4. Interrupted-turn recovery from the journal.
5. Cache eviction, storage-usage indicator, "delete all data".
6. Onboarding: connect Notion → install bridge → try a suggestion, with per-OS instructions.

**AC:** 100 threads / 5k messages stay responsive; nothing lost across restart or extension update;
two windows never corrupt a thread.

---

## E9 — Ship (M)

1. Threat model doc: prompt injection, token theft, over-broad permissions, malicious page content.
2. Permission justifications for every manifest entry, especially `nativeMessaging` and
   `unlimitedStorage`.
3. Privacy policy: no Nox server, exact outbound hosts, what is stored where — **including that
   Codex persists history under `~/.codex`**.
4. Docs: README, MVP, RESEARCH, CONTRIBUTING, LICENSE (MIT), per-OS bridge install, troubleshooting.
5. Tests, deliberately thin: unit tests for OAuth/PKCE helpers, the scheduler, page-id parsing,
   inverse-op builders and bridge chunking. One manual smoke checklist per release.
6. **Release order**: GitHub zip first so users are never blocked by review, then Chrome Web Store
   submission. Budget one rejection round — an extension that needs separately installed software
   plus `nativeMessaging` draws scrutiny. Listing copy describes the Notion assistant, not
   "use Codex elsewhere".

**AC:** a stranger can clone, install the bridge on their OS, connect and run without asking a
question.

---

## Dependencies and milestones

```
E0 ─► E1 ─┬─► E2 ─┐
          └─► E3 ─┴─► E4 ─┬─► E5
                          ├─► E6 ─► E7
                          └─► E8
E9 gates release
```

- **M1 "It works"** — E0–E4. Chat that reads your workspace and knows the page you're on.
- **M2 "It's safe and looks right"** — E5, E6.
- **M3 "It ships"** — E7, E8, E9.

---

## Risk register

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| `dynamicTools` changes or is withdrawn | Medium | High | The provider boundary is one file; a local OpenAI-compatible proxy (RESEARCH.md §3.7) is a same-day fallback. |
| Panel unloads on tab/window switch | Medium | High | Spike 0.4 first; fallback is an offscreen document with the panel as a view. |
| 1 MB native-messaging cap | Certain | Medium | Chunked framing in E3, proven in spike 0.3. |
| Notion overwrite race | Certain without the guard | High | Write guard in E6; no other protection exists. |
| Undo expectations (creations, block identity, exotic properties) | Certain | Medium | Explicit not-undoable states in the UI; documented in the README. |
| Latency versus Notion AI | Medium | Medium | Spike 0.5 picks the fastest usable model; streaming reasoning keeps the UI alive. |
| Codex quota exhausted mid-bulk-run | Medium | Medium | Quota estimate in the preview, distinct error state, journal preserved for undo. |
| Notion rate limits | Medium | Medium | Scheduler, caching, search on its own bucket. |
| Notion MCP is Beta; tools change | Medium | Medium | Runtime `tools/list`, no hardcoded schemas, capability gating. |
| Web Store rejection | Medium | Medium | GitHub release ships first; narrow permissions; careful listing copy. |
| Bridge install friction (SmartScreen, corporate AV) | Medium | Medium | Plain Node script, no binary, documented per OS, clear failure states in the panel. |
| Scope creep | High | High | The MVP.md "Out" list is binding. |

---

## Open questions

1. Do we ship a GitHub release at M2 to get real usage before E7–E9?
2. Is 25 rows the right "always confirm" line for bulk runs?
3. Framework: Vite + CRXJS, or WXT?
4. Do we want a "dry run" mode (show every planned write without executing) as a third mode, or is
   Ask-before-changes enough?
