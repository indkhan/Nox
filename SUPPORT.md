# Support

Before reporting a problem, confirm Node.js 22+, pnpm 10+, current Chrome, a
logged-in Codex CLI, and the latest Nox release. Restart Chrome and retry.

Run these diagnostics from the repository or extracted release directory:

```bash
codex --version
node --version
node bridge/test-bridge.mjs
```

Search existing issues, then use the bug-report form. Include OS, Chrome, Node,
Codex and Nox versions, exact steps, expected and actual behavior, and sanitized
logs. Never post OAuth tokens or private Notion content.

See [known limitations](README.md#known-limitations) before filing an issue.
