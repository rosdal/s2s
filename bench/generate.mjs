// Generates benchmark apps: a seeded pick of indexed packages at random versions, a random subset
// of their exports, and first-party code around them so vendor ranges have edges to find.
import { exec as execCallback } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { build } from "esbuild";

const exec = promisify(execCallback);

/** mulberry32: a small seeded PRNG, so a seed always generates the same apps. */
export function rng(seed) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    int: (min, max) => min + Math.floor(next() * (max - min + 1)),
    pick: (list) => list[Math.floor(next() * list.length)],
    sample(list, n) {
      const copy = [...list];
      const out = [];
      while (out.length < n && copy.length > 0)
        out.push(copy.splice(Math.floor(next() * copy.length), 1)[0]);
      return out;
    },
  };
}

const WORDS = [
  "cart",
  "user",
  "price",
  "total",
  "item",
  "order",
  "label",
  "query",
  "token",
  "panel",
  "badge",
  "score",
];

/** First-party code: a module of small, distinct functions with their own strings and numbers. */
function firstPartyModule(r, index) {
  const lines = [];
  const names = [];
  const count = r.int(3, 7);
  for (let i = 0; i < count; i++) {
    const name = `${r.pick(WORDS)}${r.pick(WORDS).replace(/^./, (c) => c.toUpperCase())}${index}_${i}`;
    names.push(name);
    const k = r.int(2, 97);
    const word = r.pick(WORDS);
    switch (r.int(0, 3)) {
      case 0:
        lines.push(
          `export function ${name}(list) {\n  let acc = ${k};\n  for (const entry of list) {\n    if (entry.${word} > ${k * 3}) acc += entry.${word} * ${r.int(2, 9)};\n    else acc -= ${r.int(1, 5)};\n  }\n  return acc;\n}`,
        );
        break;
      case 1:
        lines.push(
          `export function ${name}(input) {\n  if (!input || typeof input.${word} !== "string") throw new Error("${word} ${index}.${i} needs a string field named ${word}");\n  return input.${word}.split("${r.pick(["-", "/", ":", "."])}").map((part, at) => part.trim() + at * ${k}).join("|");\n}`,
        );
        break;
      case 2:
        lines.push(
          `export function ${name}(a, b) {\n  const out = {};\n  for (const key of Object.keys(a)) out[key] = (a[key] ?? 0) + (b[key] ?? ${k});\n  out.${word} = Math.round(out.${word} * ${k}) / ${r.int(2, 50)};\n  return out;\n}`,
        );
        break;
      default:
        lines.push(
          `export function ${name}(element, value) {\n  element.dataset.${word} = String(value);\n  element.classList.toggle("is-${word}-${index}", value > ${k});\n  return element.getAttribute("aria-label") || "${word} ${k}";\n}`,
        );
    }
  }
  return { code: `${lines.join("\n\n")}\n`, names };
}

/** Exported names of a package entry, read from esbuild's metafile; empty for CommonJS. */
async function exportNames(dir, specifier) {
  try {
    const result = await build({
      stdin: {
        contents: `export * from ${JSON.stringify(specifier)};`,
        resolveDir: dir,
        loader: "js",
      },
      bundle: true,
      write: false,
      format: "esm",
      platform: "browser",
      metafile: true,
      logLevel: "silent",
      define: { "process.env.NODE_ENV": '"production"' },
      loader: { ".css": "empty" },
    });
    return Object.values(result.metafile.outputs).flatMap((o) => o.exports);
  } catch {
    return undefined;
  }
}

async function npmInstall(dir) {
  const base = "npm install --ignore-scripts --no-audit --no-fund --loglevel=error";
  const opts = { cwd: dir, maxBuffer: 64 * 1024 * 1024 };
  try {
    await exec(base, opts);
  } catch {
    // Peer conflicts between random versions: take npm's best effort.
    await exec(`${base} --legacy-peer-deps`, opts);
  }
}

/**
 * Generate one app in `dir`: pick 3–10 packages from `pool` (`{ name, versions }[]`), install
 * them, import a random subset of each one's exports, and wire in first-party modules.
 */
export async function generateApp({ seed, pool, dir }) {
  const r = rng(seed);
  const chosen = r
    .sample(pool, r.int(3, 10))
    .map((p) => ({ name: p.name, version: r.pick(p.versions) }));
  await rm(dir, { recursive: true, force: true });
  await mkdir(path.join(dir, "src"), { recursive: true });
  const dependencies = Object.fromEntries(chosen.map((c) => [c.name, c.version]));
  await writeFile(
    path.join(dir, "package.json"),
    `${JSON.stringify({ name: `bench-app-${seed}`, private: true, type: "module", dependencies }, null, 2)}\n`,
  );
  await npmInstall(dir);

  const imports = [];
  const uses = [];
  const used = [];
  for (const [i, c] of chosen.entries()) {
    if (!existsSync(path.join(dir, "node_modules", c.name))) continue;
    const names = await exportNames(dir, c.name);
    if (names === undefined) continue;
    const named = names.filter((n) => n !== "default" && /^[A-Za-z_$][\w$]*$/.test(n));
    const local = `pkg${i}`;
    if (named.length === 0) {
      // No named exports found: a namespace import works for CommonJS and ESM alike.
      imports.push(`import * as ${local} from ${JSON.stringify(c.name)};`);
      uses.push(local);
    } else {
      const subset = r.sample(named, r.int(1, Math.min(8, named.length)));
      imports.push(
        `import { ${subset.map((n, j) => `${n} as ${local}_${j}`).join(", ")} } from ${JSON.stringify(c.name)};`,
      );
      uses.push(...subset.map((_, j) => `${local}_${j}`));
    }
    used.push(c.name);
  }
  const modules = r.int(2, 4);
  for (let m = 0; m < modules; m++) {
    const mod = firstPartyModule(r, m);
    await writeFile(path.join(dir, "src", `feature${m}.js`), mod.code);
    imports.push(`import { ${mod.names.join(", ")} } from "./feature${m}.js";`);
    uses.push(...mod.names);
  }
  // Interleave vendor and first-party imports, then use everything so nothing is tree-shaken.
  const order = r.sample(imports, imports.length);
  await writeFile(
    path.join(dir, "src", "main.js"),
    `${order.join("\n")}\n\nwindow.__benchUsed = [${uses.join(", ")}];\n`,
  );
  const installed = {};
  for (const name of used) {
    const pkg = JSON.parse(
      await readFile(path.join(dir, "node_modules", name, "package.json"), "utf8"),
    );
    installed[name] = pkg.version;
  }
  return { seed, requested: dependencies, direct: installed };
}
