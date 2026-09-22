/* eslint-env node */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { createHash } from "crypto";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const rootDir = path.resolve(__dirname, "..");
const packageJsonPath = path.join(rootDir, "package.json");
const updateJsonPath = path.join(rootDir, "update.json");
const updateBetaJsonPath = path.join(rootDir, "update-beta.json");
const buildDir = path.join(rootDir, ".scaffold", "build");
const builtUpdateJsonPath = path.join(buildDir, "update.json");
const xpiPath = path.join(buildDir, "zotero-mcp-plugin.xpi");

const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf-8"));
const {
  version,
  config: { addonID },
} = packageJson;

const repoUrl = "https://github.com/Max101Johnston/EmbeddingZotero";
const isBeta = version.includes("-");
const outputPath = isBeta ? updateBetaJsonPath : updateJsonPath;

if (!fs.existsSync(xpiPath) || !fs.existsSync(builtUpdateJsonPath)) {
  throw new Error("Build the plugin with npm run build before preparing a release.");
}

const builtManifest = JSON.parse(fs.readFileSync(builtUpdateJsonPath, "utf8"));
const updates = builtManifest.addons?.[addonID]?.updates;
const expectedLink = `${repoUrl}/releases/download/v${version}/zotero-mcp-plugin.xpi`;
const expectedHash = `sha512:${createHash("sha512")
  .update(fs.readFileSync(xpiPath))
  .digest("hex")}`;

if (
  !Array.isArray(updates) ||
  updates.length !== 1 ||
  updates[0].version !== version ||
  updates[0].update_link !== expectedLink ||
  updates[0].update_hash !== expectedHash
) {
  throw new Error(
    "The built update manifest does not match the package version, repository, or XPI hash. Rebuild before releasing.",
  );
}

fs.writeFileSync(outputPath, `${JSON.stringify(builtManifest, null, 2)}\n`);
console.log(`Prepared ${path.basename(outputPath)} for v${version}`);
