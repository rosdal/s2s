// The build configurations. `heldout` (terser with top-level mangling and three compress passes)
// is never one of the index's variants, so it measures generalization rather than memory.
import { readdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { build as esbuild } from "esbuild";
import { rolldown } from "rolldown";
import { minify } from "terser";
import TerserPlugin from "terser-webpack-plugin";
import { build as vite } from "vite";
import webpack from "webpack";

const DEFINE = { "process.env.NODE_ENV": '"production"' };

async function outputs(outDir) {
  const files = (await readdir(outDir, { recursive: true })).filter((f) => f.endsWith(".js"));
  const out = [];
  for (const file of files) {
    const full = path.join(outDir, file);
    const map = await readFile(`${full}.map`, "utf8").catch(() => undefined);
    out.push({
      file: full,
      code: await readFile(full, "utf8"),
      map: map ? JSON.parse(map) : undefined,
    });
  }
  return out;
}

export const BUILDS = {
  async webpack(dir, outDir) {
    const compiler = webpack({
      mode: "production",
      context: dir,
      entry: "./src/main.js",
      output: { path: outDir, filename: "[name].js" },
      devtool: "source-map",
      performance: { hints: false },
      optimization: { minimizer: [new TerserPlugin({ extractComments: false })] },
      module: { rules: [{ test: /\.css$/, type: "asset/source" }] },
    });
    await new Promise((resolve, reject) =>
      compiler.run((error, stats) => {
        if (error || stats?.hasErrors()) reject(error ?? new Error(stats?.toString("errors-only")));
        else compiler.close(() => resolve(undefined));
      }),
    );
  },
  async vite(dir, outDir) {
    await vite({
      root: dir,
      configFile: false,
      logLevel: "silent",
      define: DEFINE,
      build: {
        outDir,
        emptyOutDir: true,
        sourcemap: true,
        rollupOptions: { input: path.join(dir, "src/main.js") },
      },
    });
  },
  async rolldown(dir, outDir) {
    const bundle = await rolldown({
      input: path.join(dir, "src/main.js"),
      cwd: dir,
      platform: "browser",
      transform: { define: DEFINE },
      logLevel: "silent",
    });
    await bundle.write({ dir: outDir, format: "esm", minify: true, sourcemap: true });
    await bundle.close();
  },
  async esbuild(dir, outDir) {
    await esbuild({
      entryPoints: [path.join(dir, "src/main.js")],
      bundle: true,
      minify: true,
      sourcemap: true,
      format: "esm",
      platform: "browser",
      define: DEFINE,
      outdir: outDir,
      logLevel: "silent",
      loader: { ".css": "empty" },
    });
  },
  async heldout(dir, outDir) {
    const result = await esbuild({
      entryPoints: [path.join(dir, "src/main.js")],
      bundle: true,
      sourcemap: "external",
      format: "esm",
      platform: "browser",
      define: DEFINE,
      outdir: outDir,
      write: false,
      logLevel: "silent",
      loader: { ".css": "empty" },
    });
    const js = result.outputFiles.find((f) => f.path.endsWith(".js"));
    const map = result.outputFiles.find((f) => f.path.endsWith(".js.map"));
    const out = await minify(
      { "main.js": js.text },
      {
        module: true,
        toplevel: true,
        compress: { passes: 3 },
        mangle: { toplevel: true },
        sourceMap: { content: map.text, url: "main.js.map" },
      },
    );
    const { mkdir, writeFile } = await import("node:fs/promises");
    await mkdir(outDir, { recursive: true });
    await writeFile(path.join(outDir, "main.js"), out.code);
    await writeFile(
      path.join(outDir, "main.js.map"),
      typeof out.map === "string" ? out.map : JSON.stringify(out.map),
    );
  },
};

export async function runBuild(name, dir) {
  const outDir = path.join(dir, `dist-${name}`);
  await rm(outDir, { recursive: true, force: true });
  await BUILDS[name](dir, outDir);
  return outputs(outDir);
}
