import type { Page, Route } from "playwright-core";
import { type Recorder, sleep, waitForQuiet } from "./recorder.js";

export interface TriggerOptions {
  quietMs: number;
  /** Epoch ms after which the phase stops waiting for quiet. */
  deadline: number;
  maxInteractions: number;
  signal?: AbortSignal;
}

export interface TriggerReport {
  scrollSteps: number;
  hovers: number;
  clicks: number;
  focuses: number;
  abortedNavigations: number;
}

const MAX_SCROLL_STEPS = 40;

// Same-page toggles: collapsed disclosure buttons, closed <details>, unselected tabs.
const TOGGLES = [
  '[aria-expanded="false"]:not(a[href]:not([href^="#"]))',
  "details:not([open]) > summary",
  '[role="tab"][aria-selected="false"]',
].join(", ");
const NAV_ITEMS = [
  "header nav > ul > li > a",
  "header nav > ul > li > button",
  "nav > ul > li > a",
  "nav > ul > li > button",
  '[role="menubar"] > [role="menuitem"]',
  '[role="menubar"] > li > [role="menuitem"]',
].join(", ");
const INPUTS =
  'input:not([type="hidden"]):not([type="submit"]):not([type="button"]):not([type="checkbox"]):not([type="radio"]):not([type="file"]), textarea, select';

/**
 * Pull in lazily loaded code: scroll the page, hover top-level nav items, open same-page toggles
 * and focus the first inputs, waiting for the network to settle after each step. Main-frame
 * navigations and form submits are aborted so the page never leaves.
 */
export async function triggerLazyCode(
  page: Page,
  recorder: Recorder,
  options: TriggerOptions,
): Promise<TriggerReport> {
  const report: TriggerReport = {
    scrollSteps: 0,
    hovers: 0,
    clicks: 0,
    focuses: 0,
    abortedNavigations: 0,
  };
  const mainFrame = page.mainFrame();
  const guard = async (route: Route) => {
    const request = route.request();
    if (request.isNavigationRequest() && request.frame() === mainFrame) {
      report.abortedNavigations++;
      await route.abort("aborted");
    } else {
      await route.fallback();
    }
  };
  await page.route("**/*", guard);
  // New tabs opened by clicks are closed right away.
  const onPopup = (popup: Page) => void popup.close().catch(() => {});
  page.on("popup", onPopup);

  const settle = () =>
    waitForQuiet(recorder, options.quietMs, options.deadline, options.signal).catch((error) => {
      if (options.signal?.aborted) throw error;
      return false;
    });
  let budget = options.maxInteractions;

  try {
    // 1. Scroll in viewport-height steps.
    for (let step = 0; step < MAX_SCROLL_STEPS; step++) {
      const done = await page
        .evaluate(() => {
          const el = document.scrollingElement ?? document.documentElement;
          const before = el.scrollTop;
          window.scrollBy(0, window.innerHeight);
          return (
            el.scrollTop === before || el.scrollTop + window.innerHeight >= el.scrollHeight - 2
          );
        })
        .catch(() => true);
      report.scrollSteps++;
      await settle();
      if (done) break;
    }
    await page.evaluate(() => window.scrollTo(0, 0)).catch(() => {});

    // 2. Hover top-level navigation items.
    for (const item of (await page.locator(NAV_ITEMS).all()).slice(0, 10)) {
      if (budget <= 0) break;
      if (!(await item.isVisible().catch(() => false))) continue;
      budget--;
      await item.hover({ timeout: 1_000 }).catch(() => {});
      report.hovers++;
      await settle();
    }

    // 3. Open same-page toggles.
    for (const toggle of (await page.locator(TOGGLES).all()).slice(0, 15)) {
      if (budget <= 0) break;
      if (!(await toggle.isVisible().catch(() => false))) continue;
      budget--;
      await toggle.click({ timeout: 1_000, noWaitAfter: true }).catch(() => {});
      report.clicks++;
      await settle();
      await page.keyboard.press("Escape").catch(() => {});
    }

    // 4. Focus the first few inputs.
    for (const input of (await page.locator(INPUTS).all()).slice(0, 3)) {
      if (budget <= 0) break;
      if (!(await input.isVisible().catch(() => false))) continue;
      budget--;
      await input.focus({ timeout: 1_000 }).catch(() => {});
      report.focuses++;
      await settle();
    }
    // Let any aborted navigation attempt finish unwinding before the guard goes away.
    await sleep(50, options.signal);
  } finally {
    page.off("popup", onPopup);
    await page.unroute("**/*", guard).catch(() => {});
  }
  return report;
}
