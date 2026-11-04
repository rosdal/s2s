import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { parseVersion } from "./registry.js";

export const PACKAGE_MANAGERS = ["pnpm", "npm", "yarn", "bun"] as const;
export type PackageManager = (typeof PACKAGE_MANAGERS)[number];

/** Order tried when nothing else picks a manager. */
const AUTO_ORDER: PackageManager[] = ["pnpm", "bun", "yarn", "npm"];

export const LOCKFILES: Record<PackageManager, string[]> = {
  pnpm: ["pnpm-lock.yaml"],
  npm: ["package-lock.json"],
  yarn: ["yarn.lock"],
  bun: ["bun.lock", "bun.lockb"],
};

const SHELL = process.platform === "win32";

/** The installed version of a package manager, or `undefined` when it is not on the PATH. */
export function localVersion(pm: PackageManager): string | undefined {
  const result = spawnSync(SHELL ? `${pm} --version` : pm, SHELL ? [] : ["--version"], {
    encoding: "utf8",
    shell: SHELL,
    timeout: 15_000,
    windowsHide: true,
  });
  if (result.status !== 0) return undefined;
  const version = result.stdout.trim().split(/\s+/)[0] ?? "";
  return parseVersion(version) ? version : undefined;
}

export interface ChosenManager {
  name: PackageManager;
  /** Why this one: the flag, the source maps' layout, or the first one installed. */
  source: "flag" | "sourcemap-hint" | "installed" | "default";
  /** Installed version, for the `packageManager` field; `undefined` when not installed. */
  version: string | undefined;
}

/**
 * Pick the package manager: `--pm`, then the source maps' hint (a pnpm store path means pnpm), then
 * the first of pnpm, bun, yarn and npm that is installed. `versionOf` is injectable for tests.
 */
export function chooseManager(
  flag: PackageManager | undefined,
  hint: string | undefined,
  versionOf: (pm: PackageManager) => string | undefined = localVersion,
): ChosenManager {
  if (flag) return { name: flag, source: "flag", version: versionOf(flag) };
  if (hint && (PACKAGE_MANAGERS as readonly string[]).includes(hint)) {
    const name = hint as PackageManager;
    return { name, source: "sourcemap-hint", version: versionOf(name) };
  }
  for (const name of AUTO_ORDER) {
    const version = versionOf(name);
    if (version) return { name, source: "installed", version };
  }
  return { name: "npm", source: "default", version: undefined };
}

/** A valid npm package name from the site's host: `www.Example.co.uk` gives `example-co-uk`. */
export function projectName(targetUrl: string): string {
  let host = "site";
  try {
    host = new URL(targetUrl).hostname;
  } catch {
    // Keep the fallback.
  }
  const name = host
    .replace(/^www\./, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 200);
  return name || "site";
}

/** The `dependencies` value for a version: an exact pin, a caret range, or `latest`. */
export function versionSpec(version: string | null, ranges: "exact" | "caret"): string {
  if (!version) return "latest";
  if (!parseVersion(version)) return version;
  return ranges === "caret" ? `^${version}` : version;
}

export interface PackageJson {
  name: string;
  version: string;
  private: true;
  packageManager?: string;
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
}

const sorted = (record: Record<string, string>) =>
  Object.fromEntries(Object.entries(record).sort(([a], [b]) => a.localeCompare(b)));

export function buildPackageJson(input: {
  name: string;
  manager: ChosenManager;
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
}): PackageJson {
  return {
    name: input.name,
    version: "0.0.0",
    private: true,
    ...(input.manager.version
      ? { packageManager: `${input.manager.name}@${input.manager.version}` }
      : {}),
    dependencies: sorted(input.dependencies),
    devDependencies: sorted(input.devDependencies),
  };
}

/** Arguments and environment that install without running any lifecycle script. */
export function installCommand(
  pm: PackageManager,
  version: string | undefined,
): { args: string[]; env: Record<string, string> } {
  // npm-compatible managers read this too; it backs up the flag below.
  const env: Record<string, string> = { npm_config_ignore_scripts: "true" };
  switch (pm) {
    case "pnpm":
      return { args: ["install", "--ignore-scripts", "--ignore-workspace"], env };
    case "npm":
      // Versions inferred from a bundle often disagree on peers (a guessed react-router wanting a
      // newer react); npm would refuse the whole install over it. pnpm, yarn and bun only warn.
      return {
        args: ["install", "--ignore-scripts", "--no-audit", "--no-fund", "--legacy-peer-deps"],
        env,
      };
    case "bun":
      return { args: ["install", "--ignore-scripts"], env };
    case "yarn": {
      const major = Number(version?.split(".")[0] ?? "1");
      // Yarn 2+ rejects --ignore-scripts; it reads enableScripts from the environment instead.
      if (major >= 2)
        return {
          args: ["install"],
          env: { ...env, YARN_ENABLE_SCRIPTS: "false", YARN_ENABLE_IMMUTABLE_INSTALLS: "false" },
        };
      return { args: ["install", "--ignore-scripts", "--non-interactive"], env };
    }
  }
}

export interface InstallResult {
  manager: PackageManager;
  exitCode: number;
  /** The lockfile the install wrote, or `null` when none appeared. */
  lockfile: string | null;
  output: string;
}

/** Run the manager in `dir` with scripts disabled. Never throws for a failed install. */
export async function installProject(
  dir: string,
  manager: { name: PackageManager; version: string | undefined },
  signal?: AbortSignal,
): Promise<InstallResult> {
  const { args, env } = installCommand(manager.name, manager.version);
  const chunks: string[] = [];
  const exitCode = await new Promise<number>((resolve) => {
    // With a shell, one command string: the arguments are fixed flags without spaces.
    const child = spawn(
      SHELL ? [manager.name, ...args].join(" ") : manager.name,
      SHELL ? [] : args,
      {
        cwd: dir,
        env: { ...process.env, ...env },
        shell: SHELL,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
        ...(signal ? { signal } : {}),
      },
    );
    child.stdout.on("data", (d: Buffer) => chunks.push(d.toString()));
    child.stderr.on("data", (d: Buffer) => chunks.push(d.toString()));
    child.on("error", (error) => {
      chunks.push(`${error.message}\n`);
      resolve(127);
    });
    child.on("close", (code) => resolve(code ?? 1));
  });
  const lockfile = LOCKFILES[manager.name].find((f) => existsSync(path.join(dir, f))) ?? null;
  return { manager: manager.name, exitCode, lockfile, output: chunks.join("") };
}
