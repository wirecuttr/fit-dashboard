import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const outDir = mkdtempSync(join(tmpdir(), "fit-dashboard-cardiac-tests-"));
const tscBin = process.platform === "win32" ? "node_modules/.bin/tsc.cmd" : "node_modules/.bin/tsc";

try {
  const compile = spawnSync(tscBin, ["-p", "tsconfig.cardiac-test.json", "--outDir", outDir], { stdio: "inherit" });
  if (compile.status !== 0) process.exit(compile.status ?? 1);

  writeFileSync(join(outDir, "package.json"), '{"type":"commonjs"}\n');
  const run = spawnSync(process.execPath, [join(outDir, "scripts/test-cardiac-decoupling.js")], { stdio: "inherit" });
  if (run.status !== 0) process.exit(run.status ?? 1);
} finally {
  rmSync(outDir, { recursive: true, force: true });
}
