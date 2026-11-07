import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { BUILT_FIXTURES, FIXTURE_ROOTS, FIXTURES_DIR } from "./fixtures.js";

/** Build any fixture whose output folder is missing. `pnpm fixtures:build` rebuilds all of them. */
export default function setup(): void {
  for (const name of BUILT_FIXTURES) {
    if (existsSync(path.join(FIXTURES_DIR, FIXTURE_ROOTS[name]))) continue;
    if (!existsSync(path.join(FIXTURES_DIR, name, "package.json"))) continue;
    console.log(`Building fixture ${name}…`);
    execFileSync("pnpm", ["--filter", `@s2s-fixtures/${name}`, "run", "build"], {
      stdio: "inherit",
      env: { ...process.env, NEXT_TELEMETRY_DISABLED: "1" },
      shell: process.platform === "win32",
    });
  }
}
