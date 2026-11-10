import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const FIXTURES_DIR = fileURLToPath(new URL("../../../../fixtures/", import.meta.url));

export type FixtureName =
  | "static"
  | "vite-react"
  | "webpack-react"
  | "nextjs-pages"
  | "cdn-libs"
  | "sourcemaps"
  | "sourcemaps-partial"
  | "sourcemaps-inline"
  | "webpack-namespace"
  | "pnpm-vendor"
  | "css-preprocessor"
  | "hostile-map"
  | "hostile"
  | "webpack-license"
  | "vite-banners"
  | "version-strings"
  | "vue-app"
  | "hostile-banner"
  | "vite-react-mapped"
  | "esbuild-app"
  | "babel-legacy"
  | "css-modules"
  | "assets"
  | "obfuscated"
  | "browserify-legacy"
  | "dynamic"
  | "api-app"
  | "three-basic"
  | "three-compressed"
  | "r3f-scene"
  | "three-postfx"
  | "three-physics"
  | "three-skinned";

/** Folder each fixture is served from; fixtures with a build step serve their build output. */
export const FIXTURE_ROOTS: Record<FixtureName, string> = {
  static: "static",
  "vite-react": "vite-react/dist",
  "webpack-react": "webpack-react/dist",
  "nextjs-pages": "nextjs-pages/out",
  "cdn-libs": "cdn-libs",
  sourcemaps: "sourcemaps/dist",
  "sourcemaps-partial": "sourcemaps-partial/dist",
  "sourcemaps-inline": "sourcemaps-inline/dist",
  "webpack-namespace": "webpack-namespace/dist",
  "pnpm-vendor": "pnpm-vendor/dist",
  "css-preprocessor": "css-preprocessor/dist",
  "hostile-map": "hostile-map",
  hostile: "hostile",
  "webpack-license": "webpack-license/dist",
  "vite-banners": "vite-banners/dist",
  "version-strings": "version-strings/dist",
  "vue-app": "vue-app/dist",
  "hostile-banner": "hostile-banner",
  "vite-react-mapped": "vite-react-mapped/dist",
  "esbuild-app": "esbuild-app/dist",
  "babel-legacy": "babel-legacy/dist",
  "css-modules": "css-modules/dist",
  assets: "assets/dist",
  obfuscated: "obfuscated/dist",
  "browserify-legacy": "browserify-legacy/dist",
  dynamic: "dynamic",
  "api-app": "api-app",
  "three-basic": "three-basic/dist",
  "three-compressed": "three-compressed/dist",
  "r3f-scene": "r3f-scene/dist",
  "three-postfx": "three-postfx/dist",
  "three-physics": "three-physics/dist",
  "three-skinned": "three-skinned/dist",
};

export const BUILT_FIXTURES = [
  "vite-react",
  "webpack-react",
  "nextjs-pages",
  "sourcemaps",
  "sourcemaps-partial",
  "sourcemaps-inline",
  "webpack-namespace",
  "pnpm-vendor",
  "css-preprocessor",
  "webpack-license",
  "vite-banners",
  "version-strings",
  "vue-app",
  "vite-react-mapped",
  "esbuild-app",
  "babel-legacy",
  "css-modules",
  "assets",
  "obfuscated",
  "browserify-legacy",
  "three-basic",
  "three-compressed",
  "r3f-scene",
  "three-postfx",
  "three-physics",
  "three-skinned",
] as const;

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".map": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".txt": "text/plain; charset=utf-8",
  ".woff2": "font/woff2",
  ".glb": "model/gltf-binary",
  ".gltf": "model/gltf+json",
  ".ktx2": "image/ktx2",
  ".hdr": "application/octet-stream",
  ".wasm": "application/wasm",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".ogg": "audio/ogg",
  ".jpg": "image/jpeg",
  ".webp": "image/webp",
};

export interface FixtureServer {
  url: string;
  root: string;
  close(): Promise<void>;
}

function acceptWebSocket(req: IncomingMessage, socket: import("node:stream").Duplex): void {
  const key = req.headers["sec-websocket-key"];
  if (typeof key !== "string") {
    socket.destroy();
    return;
  }
  const accept = createHash("sha1")
    .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
    .digest("base64");
  socket.write(
    `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
  );
  socket.on("data", () => {});
  socket.on("error", () => {});
}

async function serveFile(
  root: string,
  req: IncomingMessage,
  res: ServerResponse,
  html?: (body: string) => string,
): Promise<void> {
  const url = new URL(req.url ?? "/", "http://localhost");
  let file = path.join(root, decodeURIComponent(url.pathname));
  if (!file.startsWith(root)) {
    res.writeHead(403).end();
    return;
  }
  try {
    if ((await stat(file)).isDirectory()) file = path.join(file, "index.html");
    const raw = await readFile(file);
    const body = html && file.endsWith(".html") ? Buffer.from(html(raw.toString("utf8"))) : raw;
    res.writeHead(200, { "content-type": TYPES[path.extname(file)] ?? "application/octet-stream" });
    res.end(req.method === "HEAD" ? undefined : body);
  } catch {
    res.writeHead(404, { "content-type": "text/plain" }).end("not found");
  }
}

/**
 * Serve one fixture on a random localhost port. `hostile` gets a polling endpoint and a websocket.
 * `html` rewrites every HTML page as it is served.
 */
export async function serveFixture(
  name: FixtureName,
  options: { html?: (body: string) => string } = {},
): Promise<FixtureServer> {
  const root = path.join(FIXTURES_DIR, FIXTURE_ROOTS[name]);
  const server = createServer((req, res) => {
    if (name === "static" && req.url === "/old.css") {
      res.writeHead(302, { location: "/css/site.css" }).end();
      return;
    }
    if (name === "api-app" && req.url === "/api/items") {
      res
        .writeHead(200, { "content-type": "application/json" })
        .end('[{"name":"Alpha"},{"name":"Beta"},{"name":"Gamma"}]');
      return;
    }
    if (name === "hostile" && req.url?.startsWith("/api/poll")) {
      res.writeHead(200, { "content-type": "application/json" }).end('{"ok":true}');
      return;
    }
    void serveFile(root, req, res, options.html);
  });
  // Upgraded sockets leave the server's bookkeeping, so close() would wait on them forever.
  const sockets = new Set<import("node:stream").Duplex>();
  if (name === "hostile") {
    server.on("upgrade", (req, socket) => {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
      acceptWebSocket(req, socket);
    });
  }
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/`,
    root,
    close: () =>
      new Promise((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

/**
 * Every `.js`, `.mjs` and `.css` file in a fixture's served folder that some other served file
 * names, as URL paths. A file nothing references (Turbopack's `/_app` page-loader chunk, for one)
 * can't be loaded by the site, so no capture could find it.
 */
export async function fixtureChunks(name: FixtureName): Promise<string[]> {
  const root = path.join(FIXTURES_DIR, FIXTURE_ROOTS[name]);
  const entries = (await readdir(root, { recursive: true, withFileTypes: true })).filter(
    (entry) =>
      entry.isFile() &&
      !path.join(entry.parentPath, entry.name).includes(`${path.sep}node_modules${path.sep}`),
  );
  const files = entries.map((entry) => path.join(entry.parentPath, entry.name));
  const texts = await Promise.all(
    files
      .filter((file) => /\.(m?js|css|html)$/.test(file))
      .map(async (file) => ({ file, text: await readFile(file, "utf8") })),
  );
  return files
    .filter((file) => /\.(m?js|css)$/.test(file) && !file.endsWith(".config.js"))
    .filter((file) => {
      // webpack builds chunk names at runtime ("settings" + "." + "24504f64" + ".chunk.js"), so
      // the content hash alone counts as a reference.
      const base = path.basename(file);
      const tokens = [
        base,
        ...base.split(/[.]/).filter((part) => part.length >= 6 && /\d/.test(part)),
      ];
      return texts.some((t) => t.file !== file && tokens.some((token) => t.text.includes(token)));
    })
    .map((file) => `/${path.relative(root, file).replaceAll("\\", "/")}`)
    .sort();
}
