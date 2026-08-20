# Running Nox in development

Everything here is the E0/E1 spike harness. No build step, no dependencies — plain MV3 plus
Node scripts, so it loads and runs as-is.

## One-time setup

```bash
node spikes/gen-key.mjs      # pins the extension id (already done — extension-key.json)
node bridge/install.mjs      # registers the native messaging host, then restart Chrome
```

`gen-key.mjs` refuses to overwrite an existing key, because the extension id is derived from it and
both the native host's `allowed_origins` and the Notion OAuth redirect URI depend on that id
staying put. The **public** key lives in `extension/manifest.json` (safe to commit); the private key
stays in the gitignored `extension-key.json`.

Current id: `mocebdbngeojcjenigojedapolmpafeo`
Redirect: `https://mocebdbngeojcjenigojedapolmpafeo.chromiumapp.org/`

## Load the extension

1. `chrome://extensions` → enable **Developer mode**
2. **Load unpacked** → select the `extension/` folder
3. Open a Notion page → click the Nox icon

## Checks that run without Chrome

```bash
node bridge/test-bridge.mjs           # native-messaging framing + 2 MB chunking
node spikes/codex-dynamictools.mjs    # spike 0.2 — needs Codex quota
```

## Notion from the terminal

The same OAuth path the extension uses, minus `chrome.identity`. Lets the Notion spikes run
headlessly.

```bash
node spikes/notion-auth.mjs    # prints a URL — open it, click Approve (once)
node spikes/notion-probe.mjs   # tools, identity, plan capabilities, view DSL spec
```

The token lands in `spikes/.notion-token.json` (gitignored). It is real access to the workspace.

## Layout

| Path | What |
|---|---|
| `extension/` | MV3 spike harness — panel, content script, Notion MCP client |
| `bridge/` | Native messaging host + installer + framing test |
| `spikes/` | Throwaway probes (Codex, Notion, key generation) |
| `docs/spikes/` | Written verdicts |
