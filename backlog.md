# Backlog — Local-host Nox (web mode for Notion Desktop users)

Notion Desktop is Electron with extensions locked out, so the Chrome extension can
never run inside it. Instead, the bridge hosts the existing sidepanel UI as a local
webpage (`http://localhost:7860`) that users open in any browser next to the desktop app.

Why this works: all Notion access already goes through `https://mcp.notion.com/mcp`
(no DOM scraping), and the whole agent loop already lives in the side panel, not the
service worker. `NativeBridge` takes an injectable `PortLike`, so swapping native
messaging for a WebSocket is nearly free.

**Accepted trade-off:** no auto-detection of the current Notion page (impossible
outside an extension regardless). Users rely on `@`-mentions / manual context.

---

## Phase 0 — Spike (de-risk the two unknowns, ~half a day)

- [ ] **CORS probe**: from a `http://localhost:X` page, POST unauthenticated to
      `mcp.notion.com/mcp`. `dnr.ts:6` established that Notion 403s bad Origins —
      determine whether a localhost Origin is rejected too.
      - If rejected → bridge proxies MCP calls (plan below assumes this; safer either way).
- [ ] Confirm the bridge envelope JSON rides fine over WebSocket (expected — chunking
      only exists because of the 1 MiB native-messaging cap).
- [ ] Verify Notion's OAuth accepts `http://localhost:<port>/callback` as a redirect URI.

## Phase 1 — Bridge becomes a local server (~1–2 days)

Extend `bridge/nox-bridge.mjs`:

- [ ] **Static serving**: serve the built UI at `http://localhost:7860`.
- [ ] **`/ws` (WebSocket)**: same envelopes as `bridge/PROTOCOL.md`
      (`rpc`/`resp`/`req`/`notif`/`status`) — reuse the codex lifecycle code
      (`startCodex`, restart budget) almost untouched.
- [ ] **`/mcp-proxy` (HTTP POST)**: forward requests to `mcp.notion.com`, stripping
      `Origin` server-side → delete the entire DNR machinery (`background/dnr.ts`).
- [ ] Bind to `127.0.0.1` only; generate a random token on first run; require it on
      `/ws` and `/mcp-proxy` so other local processes can't ride the user's Codex quota.
- [ ] Auto-open the browser at startup.

## Phase 2 — Web build of the sidepanel (~2–3 days)

Second Vite target (plain web app, no crx plugin):

- [ ] Introduce a small **platform adapter** module:
      - `storage`: localStorage + IndexedDB instead of `chrome.storage`.
      - `bridgeTransport`: WebSocket implementing `PortLike` (`lib/codex/native.ts`).
- [ ] Point the MCP client's `fetch` at `/mcp-proxy` instead of `https://mcp.notion.com`.
- [ ] Drop content-script / current-page context usage behind the adapter.
- [ ] Keep the extension build fully working — this phase is additive only.

## Phase 3 — OAuth (~1 day)

- [ ] Register `http://localhost:<port>/callback` via Dynamic Client Registration
      (DCR is per-install, so per-machine redirect URIs are legitimate — no shared secret).
- [ ] PKCE flow stays identical; tokens move from `chrome.storage` to localStorage.
- [ ] Contingency if http redirect URIs are refused (see Phase 0 spike): fall back to
      an out-of-band copy/paste code flow.

## Phase 4 — Install & packaging (~1 day)

- [ ] Biggest UX change: **Chrome launched the bridge on demand; now nothing does.**
      Installer adds a shortcut / autostart entry so `nox-bridge` runs in the background.
- [ ] Update `bridge/install.mjs` + README: "run installer → Nox opens at localhost:7860".
- [ ] Ship a `.bat` / `.sh` "Start Nox" launcher.

## Phase 5 — Tests & cleanup (~1 day)

- [ ] Unit tests: WS transport, proxy handler, token-in-localStorage store.
- [ ] Smoke script mirroring `scripts/live/codex-smoke.mjs` against the web build.
- [ ] CI: build both targets (extension + web).

**Total estimate: ~5–8 working days.**
