# Release engineering

## Versioning

`extension/package.json` `version` is the single source of truth
(`extension/manifest.config.ts` reads it; `extension/src/lib/codex/client.ts`
imports it). Display and tag label mapping: `v<version>-alpha`
(e.g. `v0.1.0-alpha`); release ZIPs keep the existing `nox-v<version>.zip` names
and are not renamed retroactively. Bump the package version in the release
commit; the manifest, ZIP artifact, and release tag follow it.

## GitHub-first distribution

GitHub ships before (and regardless of) Chrome Web Store review:

1. `pnpm --dir extension build`
2. Run `node scripts/package-release.mjs` to create the extension-only Web Store
   ZIP and the self-contained GitHub ZIP.
3. Draft a GitHub release from `docs/RELEASE-NOTES-template.md`; attach both ZIPs.
4. Users extract the GitHub ZIP, run `node install.mjs`, restart Chrome, and
   load its `extension/dist` directory.

## Chrome Web Store

- Listing copy: `docs/store-listing.md` (describes the Notion assistant — never "use Codex elsewhere").
- Budget one rejection round; `nativeMessaging` + separately installed software draws scrutiny. The permission justifications doc is pasted into the review notes.
- Reviewer access note: bridge install is optional for review of the listing itself, but required for full function; include a 30-second demo video.

## Post-tag checklist

- [ ] CI green on the release commit (both OS jobs)
- [ ] Tag `v<x.y.z>` on the release commit
- [ ] GitHub release published with zip attached
- [ ] CWS draft submitted with justifications + screenshots
