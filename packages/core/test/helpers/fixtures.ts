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
  | "hostile";

/** Folder each fixture is served from; fixtures with a build step serve their build output. */
export const FIXTURE_ROOTS: Record<FixtureName, string> = {
  static: "static",
  "vite-react": "vite-react/dist",
  "webpack-react": "webpack-react/dist",
  "nextjs-pages": "nextjs-pages/out",
  "cdn-libs": "cdn-libs",
  sourcemaps: "sourcemaps/dist",
  hostile: "hostile",
};

export const BUILT_FIXTURES = [
  "vite-react",
  "webpack-react",
  "nextjs-pages",
  "sourcemaps",
] as const;

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".map": "application/json",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8",
  ".woff2": "font/woff2",
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

async function serveFile(root: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", "http://localhost");
  let file = path.join(root, decodeURIComponent(url.pathname));
  if (!file.startsWith(root)) {
    res.writeHead(403).end();
    return;
  }
  try {
    if ((await stat(file)).isDirectory()) file = path.join(file, "index.html");
    const body = await readFile(file);
    res.writeHead(200, { "content-type": TYPES[path.extname(file)] ?? "application/octet-stream" });
    res.end(req.method === "HEAD" ? undefined : body);
  } catch {
    res.writeHead(404, { "content-type": "text/plain" }).end("not found");
  }
}

/** Serve one fixture on a random localhost port. `hostile` gets a polling endpoint and a websocket. */
export async function serveFixture(name: FixtureName): Promise<FixtureServer> {
  const root = path.join(FIXTURES_DIR, FIXTURE_ROOTS[name]);
  const server = createServer((req, res) => {
    if (name === "hostile" && req.url?.startsWith("/api/poll")) {
      res.writeHead(200, { "content-type": "application/json" }).end('{"ok":true}');
      return;
    }
    void serveFile(root, req, res);
  });
  if (name === "hostile") server.on("upgrade", acceptWebSocket);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/`,
    root,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

/** Every `.js`, `.mjs` and `.css` file in a fixture's served folder, as URL paths. */
export async function fixtureChunks(name: FixtureName): Promise<string[]> {
  const root = path.join(FIXTURES_DIR, FIXTURE_ROOTS[name]);
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && /\.(m?js|css)$/.test(entry.name))
    .map(
      (entry) =>
        `/${path.relative(root, path.join(entry.parentPath, entry.name)).replaceAll("\\", "/")}`,
    )
    .filter((p) => !p.includes("/node_modules/") && !p.endsWith(".config.js"))
    .sort();
}
