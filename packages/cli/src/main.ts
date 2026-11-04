import { type CommandDef, defineCommand, renderUsage, runCommand } from "citty";
import { type CliIO, captureCommand } from "./commands/capture.js";
import { detectCommand } from "./commands/detect.js";
import { grabCommand } from "./commands/grab.js";
import { interactive } from "./commands/interactive.js";
import { mapsCommand } from "./commands/maps.js";
import { scaffoldCommand } from "./commands/scaffold.js";
import { unbundleCommand } from "./commands/unbundle.js";
import { verifyCommand } from "./commands/verify.js";

export type { CliIO };

export const defaultIO: CliIO = {
  stdout: (line) => console.log(line),
  stderr: (line) => console.error(line),
  onInterrupt: (handler) => {
    process.on("SIGINT", handler);
    return () => process.off("SIGINT", handler);
  },
  interactive: Boolean(process.stdin.isTTY && process.stdout.isTTY),
};

/** Run the CLI with the given arguments and return the process exit code. */
export async function runCli(
  argv: string[],
  version: string,
  io: CliIO = defaultIO,
): Promise<number> {
  let exitCode = 0;
  const capture = captureCommand(io, version, (code) => {
    exitCode = code;
  });
  const maps = mapsCommand(io, (code) => {
    exitCode = code;
  });
  const detect = detectCommand(io, (code) => {
    exitCode = code;
  });
  const unbundle = unbundleCommand(io, (code) => {
    exitCode = code;
  });
  const scaffold = scaffoldCommand(io, (code) => {
    exitCode = code;
  });
  const verify = verifyCommand(io, (code) => {
    exitCode = code;
  });
  const grab = grabCommand(io, version, (code) => {
    exitCode = code;
  });
  const subCommands = { grab, capture, maps, detect, unbundle, scaffold, verify };
  const main = defineCommand({
    meta: {
      name: "s2s",
      version,
      description: "Turn a live URL into a buildable reconstruction of its frontend source.",
    },
    subCommands,
  });

  if (argv.length === 1 && (argv[0] === "--version" || argv[0] === "-v")) {
    io.stdout(version);
    return 0;
  }
  if (argv.length === 0 && io.interactive) return interactive(io, version);
  const help = argv.includes("--help") || argv.includes("-h");
  if (help || argv.length === 0) {
    const name = argv[0] ?? "";
    // `Object.hasOwn`, so `constructor` or `toString` never count as commands.
    const sub = Object.hasOwn(subCommands, name)
      ? subCommands[name as keyof typeof subCommands]
      : undefined;
    const usage = sub
      ? await renderUsage(sub as unknown as CommandDef, main)
      : await renderUsage(main);
    io.stdout(usage);
    return argv.length === 0 ? 1 : 0;
  }
  try {
    await runCommand(main, { rawArgs: argv });
    return exitCode;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if ((error as { code?: string }).code?.startsWith("E_")) {
      io.stderr(`${message}\nRun "s2s --help" for usage.`);
    } else {
      io.stderr(`s2s: ${error instanceof Error ? (error.stack ?? message) : message}`);
    }
    return 1;
  }
}
