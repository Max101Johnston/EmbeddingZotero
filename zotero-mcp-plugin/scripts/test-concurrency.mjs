import { build } from "esbuild";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tests = [
  "requestLifecycle",
  "vectorSearchWorkers",
  "dimensionAudit",
  "embeddingDimensions",
  "httpRequestReader",
  "indexConcurrency",
  "libraryReconciliation",
];
const outdir = path.join(root, "build/concurrency-tests");
const result = await build({
  absWorkingDir: root,
  entryPoints: tests.map((name) => `test/${name}.test.ts`),
  outdir,
  outExtension: { ".js": ".mjs" },
  bundle: true,
  platform: "node",
  format: "esm",
  packages: "external",
  write: false,
});
fs.mkdirSync(outdir, { recursive: true });
for (const file of result.outputFiles)
  fs.writeFileSync(file.path, file.contents);
const run = spawnSync(
  process.execPath,
  [
    path.join(root, "node_modules/mocha/bin/mocha.js"),
    "--no-config",
    ...tests.map((name) => path.join(outdir, `${name}.test.mjs`)),
  ],
  { cwd: root, stdio: "inherit" },
);
if (run.error) throw run.error;
process.exitCode = run.status ?? 1;
