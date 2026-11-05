import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "vitest";
import {
  bestExport,
  bundleDeclarations,
  PackageReader,
  resolveBinding,
  shapeOf,
} from "../src/scaffold/vendor-names.js";

const ROOT = process.env.S2S_DEBUG_DIR as string;
test.skipIf(!ROOT)(
  "names",
  async () => {
    const sc = path.join(ROOT, "sc");
    const bodies = await readdir(path.join(sc, "raw", "bodies"));
    for (const b of bodies) {
      const text = await readFile(path.join(sc, "raw", "bodies", b), "utf8");
      if (!text.includes("__THREE__")) continue;
      const decls = bundleDeclarations(text);
      for (const [n, pkg] of [["zn", "gsap"]] as const) {
        const d = decls.get(n);
        const r = new PackageReader(path.join(sc, "project"), pkg);
        const entry = await r.entry();
        const ex = entry ? await r.exportsOf(entry) : new Map();
        if (pkg === "gsap")
          console.log("gsap exports", [...ex].map(([k, v]) => `${k}:${v.size}`).join(" "));
        if (!d) {
          console.log(n, "no decl");
          continue;
        }
        const shape = shapeOf(d);
        console.log(
          n,
          d.type,
          JSON.stringify(text.slice(d.start ?? 0, (d.start ?? 0) + 150)),
          shape.size,
        );
        const subs = await r.subpaths([...shape].map((s) => s.slice(2)));
        console.log("subpaths", subs.length, subs.slice(0, 5));
        console.log(
          "resolve",
          await resolveBinding(r, shape),
          bestExport(
            shape,
            [...ex].map(([name, s]) => ({ name, shape: s })),
          ),
        );
      }
    }
  },
  600_000,
);
