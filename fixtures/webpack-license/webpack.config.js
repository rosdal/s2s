import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

// Production mode runs Terser with extractComments on, so license banners move into
// `main.<hash>.js.LICENSE.txt` and the bundle keeps a pointer comment to that file.
export default {
  mode: "production",
  entry: "./src/index.js",
  output: {
    path: path.join(here, "dist"),
    publicPath: "/",
    filename: "[name].[contenthash:8].js",
    clean: true,
  },
  plugins: [
    {
      apply(compiler) {
        compiler.hooks.afterEmit.tap("WriteHtml", (compilation) => {
          const { entrypoints } = compilation.getStats().toJson({ all: false, entrypoints: true });
          const scripts = entrypoints.main.assets
            .map((asset) => `<script defer src="/${asset.name}"></script>`)
            .join("\n    ");
          writeFileSync(
            path.join(here, "dist", "index.html"),
            `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>webpack license fixture</title>
    ${scripts}
  </head>
  <body>
    <div id="root"></div>
  </body>
</html>
`,
          );
        });
      },
    },
  ],
};
