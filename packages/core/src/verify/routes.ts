import { stat } from "node:fs/promises";
import path from "node:path";
import type { Page } from "playwright-core";
import type { BodyStore } from "../capture/body-store.js";
import type { Rect } from "./image.js";
import type { ReplayIndex } from "./replay.js";

function safeDecode(pathname: string): string | undefined {
  try {
    return decodeURIComponent(pathname);
  } catch {
    return undefined;
  }
}

/**
 * Serve the rebuilt site's own files from `origin`, replay captured responses for everything else
 * it asks for, and block the rest. Bodies in `withheld` are never replayed. With `dist` null,
 * nothing is served from disk and every request is replayed or blocked.
 */
export async function installReplay(
  page: Page,
  ctx: {
    origin: string;
    dist: string | null;
    replay: ReplayIndex;
    store: BodyStore;
    blocked: Set<string>;
    onReplay: () => void;
    withheld?: Set<string>;
  },
): Promise<void> {
  const { origin, dist, replay, store, blocked } = ctx;
  const fulfil = async (route: Parameters<Parameters<Page["route"]>[1]>[0], url: string) => {
    const hit = replay.lookup(url, origin);
    if (!hit || ctx.withheld?.has(hit.bodyHash)) return false;
    ctx.onReplay();
    await route.fulfill({
      status: hit.status,
      headers: hit.headers,
      body: await store.read(hit.bodyHash),
    });
    return true;
  };
  await page.route("**/*", async (route) => {
    const url = route.request().url();
    if (!/^https?:/.test(url)) return route.continue();
    const parsed = new URL(url);
    if (parsed.origin === origin && dist !== null) {
      const file = path.join(dist, safeDecode(parsed.pathname) ?? "\0");
      const exists =
        file.startsWith(dist) &&
        (await stat(file).then(
          (s) => s.isFile(),
          () => false,
        ));
      if (!exists && (await fulfil(route, url))) return;
      return route.continue();
    }
    if (await fulfil(route, url)) return;
    blocked.add(url);
    return route.abort("blockedbyclient");
  });
}

/** Every visible canvas in document coordinates, in screenshot pixels. */
export async function canvasRects(page: Page, scale: number): Promise<Rect[]> {
  const rects = await page
    .evaluate(() =>
      [...document.querySelectorAll("canvas")]
        .map((c) => c.getBoundingClientRect())
        .filter((r) => r.width > 0 && r.height > 0)
        .map((r) => [r.left + window.scrollX, r.top + window.scrollY, r.width, r.height]),
    )
    .catch(() => [] as number[][]);
  return rects.map(([x = 0, y = 0, w = 0, h = 0]) => ({
    x: Math.floor(x * scale),
    y: Math.floor(y * scale),
    width: Math.ceil(w * scale),
    height: Math.ceil(h * scale),
  }));
}
