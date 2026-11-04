// webpack 5 with css-loader CSS Modules, extracted to one stylesheet. The JS keeps a class map
// per module (`{ card: "Card__card--x1y2z" }`).
import { copyFileSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import MiniCssExtractPlugin from "mini-css-extract-plugin";
import webpack from "webpack";

const here = import.meta.dirname;
const dist = path.join(here, "dist");
rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });
const compiler = webpack({
  mode: "production",
  context: here,
  entry: "./src/index.js",
  output: { path: path.join(dist, "assets"), filename: "app.js", publicPath: "/assets/" },
  // Concatenation would hoist every module into one scope and inline the class maps; with it
  // off, each class map stays its own module, as on many real webpack sites.
  optimization: { concatenateModules: false },
  plugins: [new MiniCssExtractPlugin({ filename: "app.css" })],
  module: {
    rules: [
      {
        test: /\.css$/,
        use: [
          MiniCssExtractPlugin.loader,
          {
            loader: "css-loader",
            options: {
              modules: {
                auto: true,
                namedExport: false,
                exportLocalsConvention: "as-is",
                localIdentName: "[name]__[local]--[hash:base64:5]",
              },
            },
          },
        ],
      },
    ],
  },
});
await new Promise((resolve, reject) =>
  compiler.run((error, stats) => {
    if (error) return reject(error);
    if (stats.hasErrors()) return reject(new Error(stats.toString("errors-only")));
    compiler.close(() => resolve());
  }),
);
copyFileSync(path.join(here, "index.html"), path.join(dist, "index.html"));
