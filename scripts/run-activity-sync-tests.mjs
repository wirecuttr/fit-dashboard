import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const cacheDir = join(process.cwd(), "node_modules", ".cache");
mkdirSync(cacheDir, { recursive: true });
const outDir = mkdtempSync(join(cacheDir, "fit-dashboard-activity-sync-tests-"));
const tscBin = process.platform === "win32" ? "node_modules/.bin/tsc.cmd" : "node_modules/.bin/tsc";

try {
  const compile = spawnSync(tscBin, ["-p", "tsconfig.activity-sync-test.json", "--outDir", outDir], { stdio: "inherit" });
  if (compile.status !== 0) process.exit(compile.status ?? 1);

  writeFileSync(join(outDir, "package.json"), '{"type":"commonjs"}\n');
  const run = spawnSync(process.execPath, [join(outDir, "scripts/test-activity-sync.js")], { stdio: "inherit" });
  if (run.status !== 0) process.exit(run.status ?? 1);
} finally {
  rmSync(outDir, { recursive: true, force: true });
}
