# Running Nox in development

E0 is complete. Everything here is the retained spike harness: no build step or dependencies,
just plain MV3 and Node scripts. Production E1 code will start in a fresh `extension/` directory.

## One-time setup

```bash
node spikes/gen-key.mjs      # pins the extension id (already done — extension-key.json)
node bridge/install.mjs      # registers the native messaging host, then restart Chrome
```

`gen-key.mjs` refuses to overwrite an existing key, because the extension id is derived from it and
both the native host's `allowed_origins` and the Notion OAuth redirect URI depend on that id
staying put. The **public** key lives in `spikes/extension-harness/manifest.json` (safe to commit)
and must be copied into the E1 manifest; the private key stays in gitignored `extension-key.json`.

Current id: `mocebdbngeojcjenigojedapolmpafeo`
Redirect: `https://mocebdbngeojcjenigojedapolmpafeo.chromiumapp.org/`

## Load the extension

1. `chrome://extensions` → enable **Developer mode**
2. **Load unpacked** → select the `spikes/extension-harness/` folder
3. Open a Notion page → click the Nox icon

## Checks that run without Chrome

```bash
node bridge/test-bridge.mjs           # native-messaging framing + 2 MB chunking
node spikes/codex-full.mjs            # spikes 0.2/0.5 — needs Codex quota
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
| `spikes/extension-harness/` | Retained E0 MV3 harness — panel, current-page router, Notion MCP client |
| `extension/` | Reserved for fresh E1 production code |
| `bridge/` | Native messaging host + installer + framing test |
| `spikes/` | Throwaway probes (Codex, Notion, key generation) |
| `docs/spikes/` | Written verdicts |
