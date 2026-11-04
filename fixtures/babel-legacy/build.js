// webpack 4 with Babel preset-env for old browsers: classes, spread, async/await, optional
// chaining and template literals all come out as helpers and ES5.
import { copyFileSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
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
  // One module per source file, so the fixture's module count is its file count. Module
  // concatenation (on by default) would hoist them into one scope, as Rollup does.
  optimization: { concatenateModules: false },
  module: {
    rules: [
      {
        test: /\.js$/,
        exclude: /node_modules/,
        use: {
          loader: "babel-loader",
          options: {
            babelrc: false,
            configFile: false,
            presets: [["@babel/preset-env", { targets: "ie 11", modules: false }]],
          },
        },
      },
    ],
  },
});
await new Promise((resolve, reject) =>
  compiler.run((error, stats) => {
    if (error) return reject(error);
    if (stats.hasErrors()) return reject(new Error(stats.toString("errors-only")));
    resolve();
  }),
);
copyFileSync(path.join(here, "index.html"), path.join(dist, "index.html"));
