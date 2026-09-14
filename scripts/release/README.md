# Install Nox

Tested: Google Chrome on Windows 10/11 and Ubuntu 22.04/24.04, Node.js 22+,
Codex 0.153.4. macOS and other Chromium browsers are unverified in this alpha —
they may work but are not claimed as supported.

1. Install and log in to Codex (`codex login`).
2. Run `node install.mjs` in this directory.
3. Restart Chrome.
4. Open `chrome://extensions`, enable Developer mode, choose **Load unpacked**,
   and select the printed `extension/dist` directory.

The installer prints the resolved Codex binary and version for diagnosis
(path and version only). To pin a specific local binary, set `CODEX_BIN` to its
absolute path before running the installer or starting the bridge; an invalid
`CODEX_BIN` fails with an actionable error and never silently launches another
version. A newer-than-tested Codex version is used as-is with an unverified
warning — newest-installed is not equated with tested-compatible.

## Update

Re-run `node install.mjs` from the new location after pulling a new release or
after moving/deleting the checkout: the native-host manifest and generated
wrappers contain absolute paths that break when the directory moves.

## Uninstall

Run `node bridge/install.mjs --uninstall` (or `node install.mjs`'s bridge step
in reverse): this removes the native-host registration and the generated
`nox-bridge` wrapper/manifest. It never touches your Codex login or history
(`~/.codex`) — sign out or delete those separately if desired. Then remove the
extension in `chrome://extensions` and delete the extracted directory.
