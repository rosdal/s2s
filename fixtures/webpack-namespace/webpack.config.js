import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

export default {
  mode: "production",
  devtool: "source-map",
  entry: "./src/index.js",
  output: {
    path: path.join(here, "dist", "static"),
    publicPath: "/static/",
    filename: "[name].[contenthash:8].js",
    chunkFilename: "[name].[contenthash:8].chunk.js",
    devtoolNamespace: "shop-ns",
    clean: true,
  },
  plugins: [
    {
      apply(compiler) {
        compiler.hooks.afterEmit.tap("WriteHtml", (compilation) => {
          const { entrypoints } = compilation.getStats().toJson({ all: false, entrypoints: true });
          const scripts = entrypoints.main.assets
            .map((asset) => `<script defer src="/static/${asset.name}"></script>`)
            .join("\n    ");
          compilation.compiler.outputFileSystem.writeFileSync(
            path.join(here, "dist", "index.html"),
            `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>webpack namespace fixture</title>
    ${scripts}
  </head>
  <body>
    <h1>webpack namespace fixture</h1>
  </body>
</html>
`,
          );
        });
      },
    },
  ],
};
