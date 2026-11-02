import { cpSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

export default {
  mode: "production",
  entry: "./src/index.js",
  output: {
    path: path.join(here, "dist", "static"),
    publicPath: "/static/",
    filename: "[name].[contenthash:8].js",
    chunkFilename: "[name].[contenthash:8].chunk.js",
    clean: true,
  },
  optimization: { runtimeChunk: "single" },
  plugins: [
    {
      apply(compiler) {
        compiler.hooks.afterEmit.tap("CopyHtml", (compilation) => {
          const { entrypoints } = compilation.getStats().toJson({ all: false, entrypoints: true });
          const scripts = entrypoints.main.assets
            .map((asset) => `<script defer src="/static/${asset.name}"></script>`)
            .join("\n    ");
          const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>webpack React fixture</title>
    ${scripts}
  </head>
  <body>
    <div id="root"></div>
  </body>
</html>
`;
          cpSync(path.join(here, "public"), path.join(here, "dist"), { recursive: true });
          compilation.compiler.outputFileSystem.writeFileSync(
            path.join(here, "dist", "index.html"),
            html,
          );
        });
      },
    },
  ],
};
