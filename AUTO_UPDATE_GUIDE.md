# Auto-update and release guide

The plugin uses the original Zotero add-on ID (`zotero-mcp-plugin@autoagent.my`). Its update URL now points to this repository:

`https://github.com/Max101Johnston/EmbeddingZotero/releases/latest/download/update.json`

Stable builds read `update.json` from the latest non-prerelease GitHub Release. Beta builds read `zotero-mcp-plugin/update-beta.json` from this repository's `main` branch. Both channels point to XPI files released from EmbeddingZotero.

## Publish a version

1. Update the version in `zotero-mcp-plugin/package.json` and `package-lock.json`, then update [CHANGELOG.md](CHANGELOG.md).
2. Run `npm ci`, the relevant tests, and `npm run build` in `zotero-mcp-plugin`.
3. Run `npm run prepare-release`. It checks the built XPI, the scaffold-generated update manifest, the release download URL, and the SHA-512 hash. It copies the validated manifest to `update.json` for a stable version or `update-beta.json` for a beta version. Commit the relevant manifest with the source.
4. Create a GitHub Release tagged `v<version>` and upload the exact built XPI as `zotero-mcp-plugin.xpi`. For a stable release, also upload the matching `update.json` as a Release asset. A beta Release can be marked as a prerelease; its update manifest is served from `main`.
5. Confirm that the update manifest and XPI URLs return the intended files before telling users automatic updates are available.

Do not rebuild between generating the manifest and uploading the XPI: a rebuild may change its hash. GitHub's `latest` release URL does not serve prereleases, which is why beta builds use a different manifest URL.

Because this fork shares the upstream add-on ID, installing it replaces the upstream plugin in a Zotero profile. Back up the profile before changing versions.
