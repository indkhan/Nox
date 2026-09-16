# Bundled font provenance (Nox extension)

Self-hosted because MV3 CSP forbids remote fonts (see `../index.css`).

| Family | Files in this directory | License (authoritative family license) |
|---|---|---|
| Inter | `inter-latin-400/500/600/700-normal.woff2` | SIL Open Font License 1.1 (Rasmus Andersson — https://github.com/rsms/inter) |
| JetBrains Mono | `jetbrains-mono-latin-400-normal.woff2` | SIL Open Font License 1.1 (JetBrains — https://github.com/JetBrains/JetBrainsMono) |

Provenance note: these files were vendored without a retained source,
version, or download record (see commit `d8f1dc8`), and their filenames alone
are not treated as provenance. The family names above come from the
`@font-face` declarations in `../index.css`; the OFL 1.1 license is each
family's authoritative license. Vendored file versions and exact upstream
sources are unverified — do not cite a specific font version from this package.
The full OFL 1.1 text is included in release archives as assembled by
`scripts/package-release.mjs`; this directory carries the family attribution,
not a version claim.
