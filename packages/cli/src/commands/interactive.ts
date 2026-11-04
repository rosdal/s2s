import * as p from "@clack/prompts";
import { cleanUrl, workspaceSlug } from "@rosdal/s2s-core";
import type { CliIO } from "./capture.js";
import { type GrabArgs, grabArgs, grabRunner } from "./grab.js";

/** `s2s` with no arguments in a terminal: ask for the essentials, then run `s2s grab`. */
export async function interactive(io: CliIO, version: string): Promise<number> {
  p.intro(`s2s ${version}`);
  const cancelled = () => {
    p.cancel("Cancelled.");
    return 130;
  };
  const url = await p.text({
    message: "Which URL should s2s reconstruct?",
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
  const viewports = await p.multiselect({
    message: "Viewports to capture",
    options: [
      { value: "desktop", label: "desktop (1440×900)" },
      { value: "mobile", label: "mobile (390×844)" },
    ],
    initialValues: ["desktop", "mobile"],
    required: true,
  });
  if (p.isCancel(viewports)) return cancelled();
  const depth = await p.select({
    message: "Pages to capture",
    options: [
      { value: "0", label: "Only this page" },
      { value: "1", label: "This page and the pages it links to" },
      { value: "2", label: "Two levels of links" },
    ],
    initialValue: "0",
  });
  if (p.isCancel(depth)) return cancelled();
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
  p.outro("Starting s2s grab");
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
    viewports: (viewports as string[]).join(","),
    depth: String(depth),
  } as unknown as GrabArgs;
  return grabRunner(io, version)(args);
}
