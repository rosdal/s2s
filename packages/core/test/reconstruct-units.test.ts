import { describe, expect, test } from "vitest";
import { projectHints } from "../src/maps/hints.js";
import { recoverInlined } from "../src/maps/inlined.js";
import { normalizeSource } from "../src/maps/paths.js";
import {
  escapeOf,
  inferFolderNames,
  placeSource,
  renameFolders,
  urlDirectory,
} from "../src/maps/reroot.js";
import { chunkExports, chunkStem, synthesizeMissing } from "../src/scaffold/barrels.js";
import { buildFailureExcerpt } from "../src/scaffold/exec.js";
import { tsconfig, viteConfig } from "../src/scaffold/templates.js";
import {
  findWorkspacePackages,
  resolveWorkspaceSpecifier,
  workspaceEntry,
} from "../src/scaffold/workspaces.js";

describe("source rerooting", () => {
  test("normalizeSource counts the leading climb", () => {
    const climb = (raw: string) => {
      const r = normalizeSource(raw);
      return r.ok ? r.climb : -1;
    };
    expect(climb("../../index.tsx")).toBe(2);
    expect(climb("../../../packages/a/x.ts")).toBe(3);
    expect(climb("src/a/../b.js")).toBe(0);
    expect(climb("/abs/../x.js")).toBe(0);
  });

  test("a source that climbed less sits in an unnamed folder below the deepest root", () => {
    const dir = urlDirectory("https://example.com/assets/index-abc.js.map");
    expect(dir).toEqual(["assets"]);
    expect(escapeOf(2, dir)).toBe(1);
    expect(escapeOf(3, dir)).toBe(2);
    expect(escapeOf(1, dir)).toBe(0);
    expect(placeSource("index.tsx", 1, 2)).toBe("_dir1/index.tsx");
    expect(placeSource("packages/a/x.ts", 2, 2)).toBe("packages/a/x.ts");
    expect(placeSource("x.ts", 0, 2)).toBe("_dir1/_dir2/x.ts");
  });

  test("an import that only resolves under a real name names the placeholder", () => {
    const files = [
      {
        path: "_dir1/index.tsx",
        content: 'import "../excalidraw-app/sentry";\nimport App from "./App";',
      },
      { path: "_dir1/sentry.ts", content: "export {};" },
      { path: "_dir1/App.tsx", content: "export default 1;" },
      { path: "packages/a/x.ts", content: "" },
    ];
    const names = inferFolderNames(files);
    expect([...names]).toEqual([["_dir1", "excalidraw-app"]]);
    expect(renameFolders("_dir1/sentry.ts", names)).toBe("excalidraw-app/sentry.ts");
  });

  test("an unnamed placeholder is dropped, keeping the flat layout", () => {
    const names = inferFolderNames([{ path: "_dir1/a.ts", content: 'import "./b";' }]);
    expect(names.size).toBe(0);
    expect(renameFolders("_dir1/a.ts", names)).toBe("a.ts");
  });

  test("a name that is already a sibling folder is not used", () => {
    const names = inferFolderNames([
      { path: "_dir1/index.ts", content: 'import "../app/x";' },
      { path: "_dir1/x.ts", content: "" },
      { path: "app/other.ts", content: "" },
    ]);
    expect(names.size).toBe(0);
  });
});

describe("synthesizeMissing", () => {
  const src = "project/src/_recovered/_sourcemap";
  test("rebuilds a re-export barrel from what importers take and who defines it", () => {
    const files = new Map<string, string | undefined>([
      [
        `${src}/actions/a.ts`,
        'import { getSelected, isSome } from "../scene";\nimport type { SceneT } from "../scene";\nimport "./a.scss";',
      ],
      [
        `${src}/scene/selection.ts`,
        "export const getSelected = () => 1;\nexport function isSome() {}",
      ],
      [`${src}/scene/types.ts`, "export type SceneT = { a: 1 };"],
      [`${src}/scene/deep/selection.ts`, "export const getSelected = 2;"],
    ]);
    const out = synthesizeMissing(files);
    const barrel = out.find((f) => f.kind === "barrel");
    expect(barrel?.path).toBe(`${src}/scene/index.ts`);
    expect(barrel?.content).toContain('export { getSelected, isSome } from "./selection";');
    expect(barrel?.content).toContain('export type { SceneT } from "./types";');
    expect(barrel?.content).not.toContain("deep");
    const stub = out.find((f) => f.kind === "style-stub");
    expect(stub).toMatchObject({
      path: `${src}/actions/a.scss`,
      importers: [`${src}/actions/a.ts`],
    });
  });

  test("leaves resolvable imports alone and lists names nobody exports", () => {
    const files = new Map<string, string | undefined>([
      [`${src}/a.ts`, 'import { x } from "./b";\nimport { ghost } from "./lib";'],
      [`${src}/b.ts`, "export const x = 1;"],
      [`${src}/lib/one.ts`, "export const other = 1;"],
    ]);
    const out = synthesizeMissing(files);
    expect(out).toHaveLength(1);
    expect(out[0]?.missing).toEqual(["ghost"]);
  });

  test("names the folder lacks come from default exports, the closest file elsewhere, or `any`", () => {
    const files = new Map<string, string | undefined>([
      [
        `${src}/app.ts`,
        'import { Canvas, pick, type Point } from "./scene";\nimport { ghost } from "./scene";',
      ],
      [`${src}/scene/Canvas.tsx`, "export default function Canvas() {}"],
      [`${src}/scene/other.ts`, "export const x = 1;"],
      [`${src}/packages/element/src/selection.ts`, "export const pick = 1;"],
      [`${src}/far/away/selection.ts`, "export const pick = 2;"],
    ]);
    const [barrel] = synthesizeMissing(files);
    expect(barrel?.content).toContain('export { default as Canvas } from "./Canvas";');
    expect(barrel?.content).toMatch(/export \{ pick \} from "\.\.\/(?:packages|far)\//);
    expect(barrel?.content).toContain("export type Point = any;");
    expect(barrel?.missing).toEqual(["ghost"]);
    expect(barrel?.placeholderTypes).toEqual(["Point"]);
  });

  test("bare imports of workspace packages get their entry barrel", () => {
    const files = new Map<string, string | undefined>([
      [
        `${src}/app.ts`,
        'import { clamp } from "@acme/math";\nimport { T } from "@acme/math/types";',
      ],
      [`${src}/packages/math/src/clamp.ts`, "export const clamp = 1;"],
      [`${src}/packages/math/src/types.ts`, "export type T = 1;"],
    ]);
    const workspace = [{ name: "@acme/math", root: `${src}/packages/math/src` }];
    const out = synthesizeMissing(files, workspace);
    expect(out.map((f) => f.path)).toEqual([`${src}/packages/math/src/index.ts`]);
    expect(out[0]?.content).toContain('export { clamp } from "./clamp";');
  });
});

describe("workspace packages", () => {
  const src = "project/src/_recovered/_sourcemap";
  const files = [
    `${src}/packages/element/src/index.ts`,
    `${src}/packages/excalidraw/index.tsx`,
    `${src}/_vendor/node_modules/nanoid/index.js`,
  ];
  test("an imported name with a recovered packages/<name> folder and no install evidence", () => {
    const found = findWorkspacePackages(
      ["@x/element", "@x/excalidraw", "nanoid", "@x/missing"],
      files,
      new Set(["nanoid"]),
    );
    expect(found).toEqual([
      { name: "@x/element", root: `${src}/packages/element/src` },
      { name: "@x/excalidraw", root: `${src}/packages/excalidraw` },
    ]);
    expect(resolveWorkspaceSpecifier("@x/element/types", found)).toBe(
      `${src}/packages/element/src/types`,
    );
    expect(resolveWorkspaceSpecifier("@x/elementary", found)).toBeUndefined();
    expect(workspaceEntry(found[1] as (typeof found)[number], new Set(files))).toBe(
      `${src}/packages/excalidraw/index.tsx`,
    );
  });

  test("the configs alias them", () => {
    const aliases = [{ name: "@x/el", entry: "./src/el/index.ts", root: "./src/el" }];
    const vite = viteConfig("react", aliases);
    expect(vite).toContain('import { fileURLToPath } from "node:url";');
    expect(vite).toContain('{ find: /^@x\\/el$/, replacement: here("./src/el/index.ts") },');
    expect(vite).toContain('{ find: /^@x\\/el\\//, replacement: here("./src/el/") },');
    expect(viteConfig("react")).not.toContain("alias");
    const paths = JSON.parse(tsconfig("react", aliases)).compilerOptions.paths;
    expect(paths).toEqual({ "@x/el": ["./src/el/index.ts"], "@x/el/*": ["./src/el/*"] });
  });
});

describe("recoverInlined", () => {
  // Generated: `const a={x:1},b={labels:a,n:!0};const c=Object.freeze({__proto__:null});use(b,c);`
  const code =
    "const a={x:1},b={labels:a,n:!0};const c=Object.freeze({__proto__:null});let d={};use(b,c,d);";
  const source = [
    'import en from "./en.json";',
    'import * as items from "./items";',
    'import cur from "./cur.json";',
    "use(en, items, cur);",
  ].join("\n");
  // Map `en`, `items` and `cur` in the use() call (line 3) to `b`, `c` and `d` in the code.
  const call = code.indexOf("use(") + 4;
  const map = {
    sources: ["src/i18n.ts"],
    sourcesContent: [source],
    names: ["en", "items", "cur"],
    mappings: [
      [
        [call, 0, 3, 4, 0],
        [call + 2, 0, 3, 8, 1],
        [call + 4, 0, 3, 15, 2],
      ] as [number, number, number, number, number][],
    ],
  };
  const out = recoverInlined(
    map,
    code,
    [{ index: 0, output: "src/i18n.ts", content: source }],
    new Set(),
  );
  test("a JSON import comes back from the object the bundle inlined", () => {
    const en = out.find((f) => f.path === "src/en.json");
    expect(en && JSON.parse(en.content)).toEqual({ labels: { x: 1 }, n: true });
  });
  test("a tree-shaken namespace becomes an empty module", () => {
    const items = out.find((f) => f.path === "src/items.ts");
    expect(items?.content).toContain("export {};");
  });
  test("a reassigned binding is not taken as the file", () => {
    expect(out.find((f) => f.path === "src/cur.json")).toBeUndefined();
  });
});

describe("split chunks", () => {
  test("names and exports of a hashed chunk", () => {
    expect(chunkStem("https://x.com/assets/firebaseSDK-BRg0yXND.js")).toBe("firebaseSDK");
    expect(chunkStem("https://x.com/assets/subset-shared.chunk-D3ioWSie.js")).toBe(
      "subset-shared.chunk",
    );
    expect(chunkStem("https://x.com/app.js")).toBeUndefined();
    expect(
      chunkExports("x();export{me as Bytes,Zm as doc,q};\n//# sourceMappingURL=a.js.map\n"),
    ).toEqual([
      { local: "me", exported: "Bytes" },
      { local: "Zm", exported: "doc" },
      { local: "q", exported: "q" },
    ]);
  });

  test("an import of the chunk's entry re-exports its parts under the public names", () => {
    const src = "project/src/_recovered";
    const files = new Map<string, string | undefined>([
      [`${src}/_sourcemap/app/firebase.ts`, 'const sdk = await import("./firebaseSDK");'],
      [`${src}/firebaseSDK/part-1.js`, "const me = 1;\nexport { me };"],
      [`${src}/firebaseSDK/part-2.js`, "const Zm = 2;\nexport { Zm };"],
    ]);
    const chunk = {
      stem: "firebaseSDK",
      exports: [
        { local: "me", exported: "Bytes" },
        { local: "Zm", exported: "doc" },
      ],
      parts: [`${src}/firebaseSDK/part-1.js`, `${src}/firebaseSDK/part-2.js`],
    };
    const [standIn] = synthesizeMissing(files, [], [chunk]);
    expect(standIn?.path).toBe(`${src}/_sourcemap/app/firebaseSDK.js`);
    expect(standIn?.content).toContain(
      'export { me as Bytes } from "../../firebaseSDK/part-1.js";',
    );
    expect(standIn?.content).toContain('export { Zm as doc } from "../../firebaseSDK/part-2.js";');
  });
});

test("a failed build's excerpt starts at the failure, not at the files that were written", () => {
  const output = [
    "$ vite build",
    "transforming...",
    "./A.woff2 referenced in ./A.woff2 didn't resolve at build time, it will remain unchanged",
    "✓ 1322 modules transformed.",
    "rendering chunks...",
    ...Array.from({ length: 80 }, (_, i) => `dist/assets/chunk-${i}.js   1.0 kB`),
    "memory allocation of 2890008 bytes failed",
    "[ELIFECYCLE] Command failed with exit code -1073740791.",
  ].join("\n");
  expect(buildFailureExcerpt(output).split("\n")).toEqual([
    "memory allocation of 2890008 bytes failed",
    "[ELIFECYCLE] Command failed with exit code -1073740791.",
  ]);
  expect(buildFailureExcerpt("one\ntwo\nthree", 2)).toBe("two\nthree");
});

test("an imported .scss file is styling evidence even when no map holds it", () => {
  const hints = projectHints(
    [{ path: "src/Button.tsx", content: 'import "./Button.scss";\nexport {};' }],
    [],
    undefined,
  );
  expect(hints.styling.map((s) => s.value)).toContain("scss");
});
