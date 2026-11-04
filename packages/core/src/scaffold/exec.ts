import { spawn } from "node:child_process";
import type { PackageManager } from "../detect/project.js";

export interface ExecResult {
  exitCode: number;
  output: string;
}

/** Run a command, collecting stdout and stderr together. Never throws for a non-zero exit. */
export function exec(
  command: string,
  args: string[],
  options: { cwd: string; env?: Record<string, string>; signal?: AbortSignal; shell?: boolean },
): Promise<ExecResult> {
  const chunks: string[] = [];
  return new Promise((resolve) => {
    // Package managers are `.cmd` shims on Windows, which only a shell can start. With a shell the
    // command goes as one string; callers only pass fixed, space-free arguments then.
    const shell = options.shell ?? process.platform === "win32";
    const child = spawn(shell ? [command, ...args].join(" ") : command, shell ? [] : args, {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      shell,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      ...(options.signal ? { signal: options.signal } : {}),
    });
    child.stdout.on("data", (d: Buffer) => chunks.push(d.toString()));
    child.stderr.on("data", (d: Buffer) => chunks.push(d.toString()));
    child.on("error", (error) => {
      chunks.push(`${error.message}\n`);
      resolve({ exitCode: 127, output: chunks.join("") });
    });
    child.on("close", (code) => resolve({ exitCode: code ?? 1, output: chunks.join("") }));
  });
}

/** `<pm> run <script>` in the project folder. */
export function runScript(
  dir: string,
  pm: PackageManager,
  script: string,
  signal?: AbortSignal,
): Promise<ExecResult> {
  return exec(pm, ["run", script], {
    cwd: dir,
    // Colour codes would end up in the build output the agent reads.
    env: { FORCE_COLOR: "0", NO_COLOR: "1" },
    ...(signal ? { signal } : {}),
  });
}

/**
 * Run git without a shell (arguments may hold spaces). With `fallbackIdentity`, commits are made as
 * `s2s` when the machine has no git identity configured.
 */
export function git(args: string[], cwd: string, fallbackIdentity = false): Promise<ExecResult> {
  return exec("git", args, {
    cwd,
    shell: false,
    ...(fallbackIdentity
      ? {
          env: {
            GIT_AUTHOR_NAME: "s2s",
            GIT_AUTHOR_EMAIL: "s2s@localhost",
            GIT_COMMITTER_NAME: "s2s",
            GIT_COMMITTER_EMAIL: "s2s@localhost",
          },
        }
      : {}),
  });
}
