// The answer key comes from each build's source maps: every byte mapped into node_modules is
// vendor code, and the package (and installed version) it maps to was really bundled.
import { readFile } from "node:fs/promises";
import path from "node:path";
import { decodedMappings, TraceMap } from "@jridgewell/trace-mapping";

const NM = "node_modules/";

/** `node_modules/a/node_modules/@s/b/x.js` → `{ name: "@s/b", dir: "node_modules/a/node_modules/@s/b" }`. */
export function vendorOf(source) {
  const s = source.replace(/\\/g, "/");
  const first = s.indexOf(NM);
  if (first === -1) return undefined;
  const last = s.lastIndexOf(NM);
  const rest = s.slice(last + NM.length).split("/");
  const name = rest[0]?.startsWith("@") ? `${rest[0]}/${rest[1]}` : rest[0];
  if (!name) return undefined;
  return { name, dir: `${s.slice(first, last + NM.length)}${name}` };
}

/** Per bundle: a vendor mask over its characters, and bundled packages with their versions. */
export async function answerKey(appDir, bundles) {
  const versions = new Map();
  const versionOf = async (dir) => {
    if (!versions.has(dir)) {
      try {
        versions.set(
          dir,
          JSON.parse(await readFile(path.join(appDir, dir, "package.json"), "utf8")).version,
        );
      } catch {
        versions.set(dir, null);
      }
    }
    return versions.get(dir);
  };
  const packages = new Map();
  const masks = new Map();
  for (const bundle of bundles) {
    const mask = new Uint8Array(bundle.code.length);
    masks.set(bundle.file, mask);
    if (!bundle.map) continue;
    const map = new TraceMap(bundle.map);
    const owners = [];
    for (const source of map.sources) {
      const v = source ? vendorOf(source) : undefined;
      owners.push(v ? { name: v.name, version: await versionOf(v.dir) } : undefined);
    }
    const lines = decodedMappings(map);
    let lineStart = 0;
    const codeLines = bundle.code.split("\n");
    for (let l = 0; l < codeLines.length; l++) {
      const segs = lines[l] ?? [];
      const length = codeLines[l].length;
      for (let i = 0; i < segs.length; i++) {
        const seg = segs[i];
        const end = i + 1 < segs.length ? segs[i + 1][0] : length;
        const owner = seg.length > 1 ? owners[seg[1]] : undefined;
        if (!owner) continue;
        mask.fill(1, lineStart + seg[0], lineStart + end);
        // A package can be bundled twice at different versions (a nested copy); keep them all.
        const known = packages.get(owner.name) ?? { versions: new Set(), chars: 0 };
        if (owner.version) known.versions.add(owner.version);
        known.chars += end - seg[0];
        packages.set(owner.name, known);
      }
      lineStart += length + 1;
    }
  }
  return { packages, masks };
}

const ratio = (a, b) => (b === 0 ? null : a / b);

/** Is `reported` (exact or x-range) the same minor as one of the bundled versions? */
export function sameMinor(reported, truths) {
  if (!reported) return false;
  const [rM, rm] = reported.split(".");
  return [...truths].some((truth) => {
    const [tM, tm] = truth.split(".");
    return rM === tM && rm === tm;
  });
}

/**
 * Score one build of one app. A package counts in the key when the index holds it and the build
 * really bundled at least `minChars` of it; a detection is correct when the package was bundled
 * at all (a transitive dependency is a right answer too).
 */
export function scoreBuild({ key, result, indexed, minChars }) {
  const truth = [...key.packages].filter(([name, p]) => indexed.has(name) && p.chars >= minChars);
  const truthNames = new Set(truth.map(([n]) => n));
  const levels = {};
  for (const [level, keep] of [
    ["low", () => true],
    ["medium", (m) => m.confident],
  ]) {
    const found = result.packages.filter(keep);
    const tp = found.filter((m) => key.packages.has(m.name));
    const fp = found.filter((m) => !key.packages.has(m.name)).map((m) => m.name);
    const hit = new Set(tp.map((m) => m.name));
    const fn = [...truthNames].filter((n) => !hit.has(n));
    const tpInKey = [...truthNames].filter((n) => hit.has(n)).length;
    levels[level] = {
      tp: tp.length,
      fp: fp.length,
      fn: fn.length,
      tpInKey,
      falsePositives: fp,
      missed: fn,
    };
  }
  let exact = 0;
  let minor = 0;
  let versioned = 0;
  for (const m of result.packages.filter((p) => p.confident && truthNames.has(p.name))) {
    const truthVersions = key.packages.get(m.name)?.versions ?? new Set();
    versioned++;
    if (truthVersions.has(m.version)) exact++;
    if (sameMinor(m.version, truthVersions)) minor++;
  }
  // Vendor ranges against the true vendor characters.
  let inter = 0;
  let union = 0;
  for (const [file, mask] of key.masks) {
    const predicted = new Uint8Array(mask.length);
    for (const m of result.packages)
      for (const b of m.bundles)
        if (b.id === file) for (const r of b.ranges) predicted.fill(1, r.start, r.end);
    for (let i = 0; i < mask.length; i++) {
      if (mask[i] && predicted[i]) inter++;
      if (mask[i] || predicted[i]) union++;
    }
  }
  return {
    levels,
    versions: { versioned, exact, minor },
    iou: { inter, union },
    chars: result.stats.chars,
    ms: result.stats.ms,
  };
}

/** Sum per-build scores into precision, recall, version accuracy, IoU and speed. */
export function aggregate(scores) {
  const sum = (f) => scores.reduce((n, s) => n + f(s), 0);
  const level = (name) => {
    const tp = sum((s) => s.levels[name].tp);
    const fp = sum((s) => s.levels[name].fp);
    const tpInKey = sum((s) => s.levels[name].tpInKey);
    const fn = sum((s) => s.levels[name].fn);
    return {
      precision: round(ratio(tp, tp + fp)),
      recall: round(ratio(tpInKey, tpInKey + fn)),
      tp,
      fp,
      fn,
    };
  };
  const versioned = sum((s) => s.versions.versioned);
  const chars = sum((s) => s.chars);
  return {
    builds: scores.length,
    medium: level("medium"),
    low: level("low"),
    exactVersion: round(
      ratio(
        sum((s) => s.versions.exact),
        versioned,
      ),
    ),
    sameMinor: round(
      ratio(
        sum((s) => s.versions.minor),
        versioned,
      ),
    ),
    vendorIoU: round(
      ratio(
        sum((s) => s.iou.inter),
        sum((s) => s.iou.union),
      ),
    ),
    msPerMB: chars ? Math.round(sum((s) => s.ms) / (chars / 1e6)) : null,
  };
}

function round(x) {
  return x === null ? null : Math.round(x * 1000) / 1000;
}
