# Auto-update and release guide

The plugin uses the original Zotero add-on ID (`zotero-mcp-plugin@autoagent.my`). Its update URL now points to this repository:

`https://github.com/Max101Johnston/EmbeddingZotero/releases/latest/download/update.json`

There is no GitHub Release or downloadable update manifest yet. Pushing the source repository alone does not enable automatic updates. The checked-in `zotero-mcp-plugin/update.json` and `update-beta.json` intentionally contain an empty `updates` list, so they do not advertise upstream binaries.

## Publish a version

1. Update the version in `zotero-mcp-plugin/package.json` and `package-lock.json`, then update [CHANGELOG.md](CHANGELOG.md).
2. Run `npm ci`, the relevant tests, and `npm run build` in `zotero-mcp-plugin`.
3. Run `npm run prepare-release`. This writes `update.json` and `update-beta.json` with links to this repository. Inspect the generated version, compatibility range, and links before committing them.
4. Create a GitHub Release tagged `v<version>` and upload the built XPI as `zotero-mcp-plugin-<version>.xpi`, together with the matching `update.json`. The release asset name must match the generated `update_link`.
5. Confirm that the update manifest and XPI URLs return the intended files before telling users automatic updates are available.

The beta manifest is generated separately. Publish it only with a matching beta release and XPI. A release is a distinct step from committing and pushing source code.

Because this fork shares the upstream add-on ID, installing it replaces the upstream plugin in a Zotero profile. Back up the profile before changing versions.