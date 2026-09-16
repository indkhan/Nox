# Permission justifications

Chrome Web Store review copy — why each entry exists. Nox requests nothing else.

| Permission | Justification |
|---|---|
| `sidePanel` | The side panel is the product's only surface: a Notion-AI-style chat that must survive tab switches (verified in E0). |
| `storage` | Settings and the Notion refresh token (extension-private, restricted to trusted extension contexts at background startup). Single-agent ownership is coordinated with a `nox-agent-owner` Web Lock, not a storage lock. No page/mention cache is stored. |
| `unlimitedStorage` | Local chat history with attachments can exceed the default ~10 MB quota for active workspaces. History stays browser-local; there is no Nox server to offload to. Codex additionally keeps its own history under `~/.codex`. |
| `identity` | `chrome.identity.launchWebAuthFlow` performs Notion's OAuth 2.1 + PKCE consent flow and provides the stable `chromiumapp.org` redirect URI required by our Dynamic Client Registration. |
| `tabs` | Current-page detection: reading the active tab's Notion URL is how Nox knows which page you are on. A narrow content script additionally reads only the visible page title and icon as untrusted labels — page identity comes from the tab URL, never the DOM, and page content comes from Notion's MCP server. |
| `nativeMessaging` | Talks to the user-installed `com.nox.bridge` host so the official `codex app-server` binary runs locally with the user's own login. The bridge manifest allows exactly this extension id. |
| `declarativeNetRequest` | One narrow dynamic rule removes the forbidden `Origin` header on requests this extension itself sends to the exact `https://mcp.notion.com/mcp` endpoint. Without it Notion's server rejects authenticated calls with `403 Invalid Origin` (see `docs/application.md` — Notion connection). Scope is the owning extension id as initiator plus the exact endpoint URL plus `xmlhttprequest` — no broader fallback. Before OAuth, Nox verifies only that the narrow rule is installed (installed/unverified); normal workspace operation waits for the owner's authenticated MCP acceptance afterwards. Failed validation removes the rule and leaves an actionable retry. Header stripping itself across Chrome versions remains a supported-Chrome integration check, not something the rule installation proves. |
| `declarativeNetRequestWithHostAccess` | Required for that rule to modify headers on hosts we already have permission for. |
| Host permissions (`*.notion.so`, `*.notion.com`, `*.notion.site`, `mcp.notion.com`) | Fetching/writing workspace data through Notion's hosted MCP server from extension pages, and matching Notion web tab URLs (including `.notion.site` pages). |

## What Nox deliberately does NOT do

- No `<all_urls>` and no broad host permissions. The narrow Notion-only content
  script reads the visible page title and icon as untrusted labels; it never reads page content and cannot read refresh credentials.
- No remote code: everything ships in the bundle.
- No Nox analytics or telemetry, and no Nox-operated host other than none at all:
  extension-initiated requests go to `mcp.notion.com` and the local bridge, while
  prompts and relevant workspace content are additionally processed by the user's
  Codex provider and — only when enabled — by live web sources. File upload is
  unavailable in this alpha, so no upload origin is contacted.
