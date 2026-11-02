const TRACKING_PARAMS =
  /^(utm_[a-z_]+|gclid|gclsrc|dclid|gbraid|wbraid|fbclid|msclkid|mc_cid|mc_eid|igshid|yclid|twclid|_ga|_gl|_hsenc|_hsmi|mkt_tok|ref_src)$/i;

/**
 * Parse an http(s) URL and strip what never changes the page: the fragment and tracking
 * parameters. Remaining query parameters are sorted. Returns `undefined` for non-http URLs.
 */
export function cleanUrl(input: string, base?: string | URL): URL | undefined {
  let url: URL;
  try {
    url = new URL(input, base);
  } catch {
    return undefined;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
  url.hash = "";
  url.username = "";
  url.password = "";
  const kept = [...url.searchParams].filter(([key]) => !TRACKING_PARAMS.test(key));
  kept.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  url.search = new URLSearchParams(kept).toString();
  return url;
}

/**
 * Dedupe key for a page URL: the cleaned URL with a trailing slash removed from non-root paths,
 * so `/about` and `/about/` count as one page.
 */
export function pageKey(input: string | URL): string {
  const url = cleanUrl(String(input));
  if (!url) return String(input);
  if (url.pathname.length > 1 && url.pathname.endsWith("/")) {
    url.pathname = url.pathname.replace(/\/+$/, "");
  }
  return url.href;
}

/** URL without its fragment, used to tell whether a resource was already fetched. */
export function resourceKey(input: string): string {
  const hash = input.indexOf("#");
  return hash === -1 ? input : input.slice(0, hash);
}
