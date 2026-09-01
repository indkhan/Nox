# Permission justifications

Chrome Web Store review copy — why each entry exists. Nox requests nothing else.

| Permission | Justification |
|---|---|
| `sidePanel` | The side panel is the product's only surface: a Notion-AI-style chat that must survive tab switches (verified in E0). |
| `storage` | Settings, the Notion refresh token (extension-private), the single-owner lock, and cached page/mention metadata. |
| `unlimitedStorage` | Local chat history with attachments can exceed the default ~10 MB quota for active workspaces. History stays browser-local; there is no Nox server to offload to. |
| `identity` | `chrome.identity.launchWebAuthFlow` performs Notion's OAuth 2.1 + PKCE consent flow and provides the stable `chromiumapp.org` redirect URI required by our Dynamic Client Registration. |
| `tabs` | Current-page detection: reading the active tab's Notion URL is how Nox knows which page you are on **without content scripts or DOM scraping**. URLs only — page content comes from Notion's MCP server. |
| `nativeMessaging` | Talks to the user-installed `com.nox.bridge` host so the official `codex app-server` binary runs locally with the user's own login. The bridge manifest allows exactly this extension id. |
| `declarativeNetRequest` | One dynamic rule removes the forbidden `Origin` header on requests this extension itself sends to `mcp.notion.com`. Without it Notion's server rejects every authenticated call with `403 Invalid Origin` (documented in RESEARCH §2.1). Scoped to `initiatorDomains: [this extension id]` + `requestDomains: [mcp.notion.com]`. |
| `declarativeNetRequestWithHostAccess` | Required for that rule to modify headers on hosts we already have permission for. |
| Host permissions (`*.notion.so`, `*.notion.com`, `mcp.notion.com`) | Fetching/writing workspace data through Notion's hosted MCP server from extension pages, and matching Notion web tab URLs. |

## What Nox deliberately does NOT do

- No `<all_urls>` and no broad host permissions. The narrow Notion-only content
  script reads the visible page title and icon; it never reads page content.
- No remote code: everything ships in the bundle.
- No analytics, no telemetry, no outbound host other than `mcp.notion.com` and the local bridge.
