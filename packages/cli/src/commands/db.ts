import {
  type IndexFileStatus,
  indexStatus,
  PullError,
  type PullProgress,
  pullIndex,
  STALE_DAYS,
} from "@rosdal/s2s-core";
import { buildLocal } from "@rosdal/s2s-fingerprints";
import { defineCommand } from "citty";
import type { CliIO } from "./capture.js";

const mb = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;

/** `s2s db pull | status | build`: the fingerprint index behind `s2s detect`. */
export function dbCommand(io: CliIO, setExitCode: (code: number) => void) {
  const pull = defineCommand({
    meta: { name: "pull", description: "Download the newest fingerprint index" },
    args: {
      tag: { type: "string", description: "A specific fingerprints-YYYY-MM-DD release" },
      json: { type: "boolean", description: "Print only the result as JSON" },
    },
    async run({ args }) {
      const controller = new AbortController();
      const removeHandler = io.onInterrupt(() => controller.abort(new Error("Interrupted")));
      const onProgress = (event: PullProgress) => {
        if (args.json) return;
        if (event.kind === "release") io.stderr(`Downloading ${event.tag} (${mb(event.bytes)})`);
        if (event.kind === "verified") io.stderr(`  checksum ok (${event.sha256.slice(0, 12)}…)`);
        if (event.kind === "installed") io.stderr(`  installed ${event.path}`);
      };
      try {
        const result = await pullIndex({
          ...(args.tag ? { tag: args.tag } : {}),
          signal: controller.signal,
          onProgress,
        });
        if (args.json) io.stdout(JSON.stringify(result, null, 2));
        else if (!result.downloaded)
          io.stderr(`Already up to date: ${result.tag} (${result.path})`);
        setExitCode(0);
      } catch (error) {
        if (controller.signal.aborted) {
          io.stderr("Interrupted");
          setExitCode(130);
        } else if (error instanceof PullError) {
          io.stderr(error.message);
          setExitCode(1);
        } else throw error;
      } finally {
        removeHandler();
      }
    },
  });

  const status = defineCommand({
    meta: { name: "status", description: "Show the installed fingerprint index" },
    args: { json: { type: "boolean", description: "Print only the result as JSON" } },
    async run({ args }) {
      const result = await indexStatus();
      if (args.json) io.stdout(JSON.stringify(result, null, 2));
      else
        for (const line of statusLines(result.dir, result.shared, result.overlay)) io.stdout(line);
      setExitCode(result.shared && !result.shared.error ? 0 : 1);
    },
  });

  const build = defineCommand({
    meta: {
      name: "build",
      description: "Fingerprint packages into a local overlay (name, name@version or name@range)",
    },
    args: {
      "from-tarball": {
        type: "string",
        description: "Fingerprint local .tgz files instead (comma-separated)",
      },
      json: { type: "boolean", description: "Print only the result as JSON" },
    },
    async run({ args }) {
      const specs = (args._ ?? []).map(String).filter(Boolean);
      const tarballs = (args["from-tarball"] ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      if (specs.length === 0 && tarballs.length === 0) {
        io.stderr(
          "Name at least one package (s2s db build lodash@4.17.21) or --from-tarball <file>.",
        );
        setExitCode(2);
        return;
      }
      try {
        const result = await buildLocal({
          specs,
          tarballs,
          onProgress: (message) => {
            if (!args.json) io.stderr(`  ${message}`);
          },
        });
        if (args.json) io.stdout(JSON.stringify(result, null, 2));
        else {
          for (const v of result.versions)
            io.stdout(
              `${v.name}@${v.version}: ${v.error ? `failed (${v.error})` : `${v.functions} functions${v.skipped ? `, ${v.skipped} entries skipped` : ""}`}`,
            );
          io.stderr(`Overlay written to ${result.out}`);
        }
        setExitCode(result.versions.some((v) => v.error) ? 1 : 0);
      } catch (error) {
        io.stderr((error as Error).message);
        setExitCode(1);
      }
    },
  });

  return defineCommand({
    meta: { name: "db", description: "Manage the fingerprint index: pull, status, build" },
    subCommands: { pull, status, build },
  });
}

export function statusLines(
  dir: string,
  shared: IndexFileStatus | null,
  overlay: IndexFileStatus | null,
): string[] {
  const lines = [`Fingerprint folder: ${dir}`];
  if (!shared) lines.push('Shared index: none. Run "s2s db pull".');
  else if (shared.error) lines.push(`Shared index: unusable (${shared.error}). Run "s2s db pull".`);
  else {
    const stale = (shared.ageDays ?? 0) > STALE_DAYS ? ' (stale: run "s2s db pull")' : "";
    lines.push(
      `Shared index: ${shared.date ?? "unknown date"}, ${shared.ageDays ?? "?"} days old${stale}`,
      `  ${shared.packages} packages, ${shared.versions} versions, ${shared.hashes} function hashes, ${shared.strings} strings, ${mb(shared.bytes)}`,
      `  schema ${shared.schemaVersion}, builder ${shared.builderVersion ?? "?"}`,
    );
  }
  if (overlay) {
    lines.push(
      overlay.error
        ? `Local overlay: unusable (${overlay.error})`
        : `Local overlay: ${overlay.packages} packages, ${overlay.versions} versions, ${mb(overlay.bytes)}`,
    );
  }
  return lines;
}
