import * as p from "@clack/prompts";
import { cleanUrl, PACKAGE_MANAGERS, workspaceSlug } from "@rosdal/s2s-core";
import { surfaceOf } from "../ui.js";
import type { CliIO } from "./capture.js";
import { type GrabArgs, grabArgs, grabRunner } from "./grab.js";

type Option = "crawl" | "mobile" | "install" | "auth" | "har";

/** `s2s` with no arguments in a terminal: ask for the essentials, then run `s2s grab`. */
export async function interactive(io: CliIO, version: string): Promise<number> {
  const t = surfaceOf(io).theme;
  p.intro(`${t.badge("s2s")} ${t.muted("reconstruct a site's source")} ${t.dim(`v${version}`)}`);
  const cancelled = () => {
    p.cancel("Cancelled.");
    return 130;
  };
  const url = await p.text({
    message: "Site URL",
    placeholder: "https://example.com",
    validate: (value) => (cleanUrl(value ?? "") ? undefined : "Enter an http(s) URL"),
  });
  if (p.isCancel(url)) return cancelled();
  const target = cleanUrl(url) as URL;
  const out = await p.text({
    message: "Workspace folder",
    initialValue: workspaceSlug(target),
  });
  if (p.isCancel(out)) return cancelled();
  const pm = await p.select({
    message: "Package manager",
    options: [
      { value: "", label: "Pick for me", hint: "the source maps' hint, else the first installed" },
      ...PACKAGE_MANAGERS.map((name) => ({ value: name, label: name })),
    ],
    initialValue: "",
  });
  if (p.isCancel(pm)) return cancelled();
  const options = await p.multiselect<Option>({
    message: "Options",
    options: [
      { value: "crawl", label: "Crawl linked pages", hint: "depth 1" },
      { value: "mobile", label: "Capture a mobile viewport too", hint: "390×844" },
      { value: "install", label: "Install dependencies", hint: "scripts disabled" },
      { value: "auth", label: "Use a logged-in session", hint: "Playwright storage-state file" },
      { value: "har", label: "Write a HAR file" },
    ],
    initialValues: ["mobile", "install"],
    required: false,
  });
  if (p.isCancel(options)) return cancelled();
  const chosen = new Set(options);
  let authState: string | undefined;
  if (chosen.has("auth")) {
    const file = await p.text({
      message: "Storage-state file",
      placeholder: "auth.json",
      validate: (value) => (value?.trim() ? undefined : "Enter a file path"),
    });
    if (p.isCancel(file)) return cancelled();
    authState = file.trim();
  }
  const allowed = await p.confirm({
    message:
      "Do you have the right to copy this site's frontend (your own site, or permission from its owner)?",
    initialValue: false,
  });
  if (p.isCancel(allowed)) return cancelled();
  if (!allowed) {
    p.outro("s2s is for sites you own or may reconstruct. Nothing was captured.");
    return 1;
  }
  p.outro(`Starting ${t.bold("s2s grab")}`);
  // Every flag starts at its own default, so this flow never drifts from `s2s grab`.
  const defaults = Object.fromEntries(
    Object.entries(grabArgs)
      .filter(([, spec]) => "default" in spec)
      .map(([name, spec]) => [name, (spec as { default: unknown }).default]),
  );
  const args = {
    ...defaults,
    _: [],
    url: target.href,
    out: out || workspaceSlug(target),
    viewports: chosen.has("mobile") ? "desktop,mobile" : "desktop",
    depth: chosen.has("crawl") ? "1" : "0",
    install: chosen.has("install"),
    har: chosen.has("har"),
    ...(pm ? { pm } : {}),
    ...(authState ? { "auth-state": authState } : {}),
  } as unknown as GrabArgs;
  return grabRunner(io, version)(args);
}
