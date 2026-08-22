# Release engineering

## Versioning

`extension/manifest.config.ts` `version` is the single source of truth. Bump it
in the release commit; the zip artifact and release tag follow it.

## GitHub-first distribution

GitHub ships before (and regardless of) Chrome Web Store review:

1. `pnpm --dir extension build`
2. Zip `extension/dist/` **as the archive root** (Chrome requires manifest.json
   at the top level of the unpacked folder):
   `cd extension/dist && zip -r ../../nox-v<version>.zip .`
3. Draft a GitHub release from `docs/RELEASE-NOTES-template.md`, attach the zip.
4. Users: download → unzip → Load unpacked. Bridge install stays one script.

## Chrome Web Store

- Listing copy: `docs/store-listing.md` (describes the Notion assistant — never "use Codex elsewhere").
- Budget one rejection round; `nativeMessaging` + separately installed software draws scrutiny. The permission justifications doc is pasted into the review notes.
- Reviewer access note: bridge install is optional for review of the listing itself, but required for full function; include a 30-second demo video.

## Post-tag checklist

- [ ] CI green on the release commit (both OS jobs)
- [ ] Tag `v<x.y.z>` on the release commit
- [ ] GitHub release published with zip attached
- [ ] CWS draft submitted with justifications + screenshots
