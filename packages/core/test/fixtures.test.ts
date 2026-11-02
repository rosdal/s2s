import { afterAll, beforeAll, expect, test } from "vitest";
import { type FixtureServer, fixtureChunks, serveFixture } from "./helpers/fixtures.js";

let server: FixtureServer;
beforeAll(async () => {
  server = await serveFixture("hostile");
});
afterAll(() => server.close());

test("fixture server serves files, the poll endpoint and 404s", async () => {
  expect((await fetch(server.url)).headers.get("content-type")).toContain("text/html");
  expect(await (await fetch(new URL("robots.txt", server.url))).text()).toContain("/private/");
  expect((await fetch(new URL("api/poll", server.url))).status).toBe(200);
  expect((await fetch(new URL("missing.js", server.url))).status).toBe(404);
});

test("built fixtures list their chunks", async () => {
  expect(await fixtureChunks("webpack-react")).toEqual(
    expect.arrayContaining([expect.stringMatching(/^\/static\/settings\.[0-9a-f]+\.chunk\.js$/)]),
  );
  expect((await fixtureChunks("nextjs-pages")).some((p) => p.endsWith("_buildManifest.js"))).toBe(
    true,
  );
});
