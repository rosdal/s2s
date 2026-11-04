/**
 * Turn a captured page into the project's `index.html`: the site's own scripts and stylesheets
 * come out (the generated entry loads their recovered versions), everything else stays, and one
 * module script for `src/main.ts` goes where the first removed script was.
 */
export function buildIndexHtml(input: {
  html: string;
  pageUrl: string;
  /** Absolute URLs of first-party scripts and stylesheets the entry replaces. */
  replaced: Set<string>;
  /** Drop every inline script too (an SSR framework's hydration data and bootstrap). */
  dropInlineScripts: boolean;
  entry: string;
}): { html: string; removed: string[] } {
  const removed: string[] = [];
  const resolve = (href: string | undefined): string | undefined => {
    if (!href) return undefined;
    try {
      return new URL(href, input.pageUrl).href.replace(/#.*$/, "");
    } catch {
      return undefined;
    }
  };
  const isReplaced = (href: string | undefined): boolean => {
    const url = resolve(href);
    if (!url) return false;
    return input.replaced.has(url) || input.replaced.has(url.replace(/\?.*$/, ""));
  };
  const MARK = "<!--s2s-entry-->";
  let marked = false;
  const mark = () => {
    if (marked) return "";
    marked = true;
    return MARK;
  };

  let html = input.html.replace(
    /<script\b([^>]*)>([\s\S]*?)<\/script\b[^>]*>/gi,
    (whole, attrs: string, body: string) => {
      const src = attr(attrs, "src");
      const type = (attr(attrs, "type") ?? "").toLowerCase();
      if (src !== undefined) {
        if (!isReplaced(src)) return whole;
        removed.push(resolve(src) ?? src);
        return mark();
      }
      const data = type.includes("json") || type === "text/template" || type === "text/html";
      if (data) return whole;
      if (
        input.dropInlineScripts ||
        type === "module" ||
        /\bimport\s*\(|__webpack_require__|webpackChunk/.test(body)
      ) {
        removed.push(`inline script (${body.length} chars)`);
        return mark();
      }
      return whole;
    },
  );
  html = html.replace(/<link\b([^>]*?)\/?>/gi, (whole, attrs: string) => {
    const rel = (attr(attrs, "rel") ?? "").toLowerCase();
    if (!/\b(stylesheet|modulepreload|preload|prefetch)\b/.test(rel)) return whole;
    const href = attr(attrs, "href");
    if (!isReplaced(href)) return whole;
    removed.push(resolve(href) ?? href ?? "");
    return "";
  });
  const tag = `<script type="module" src="${input.entry}"></script>`;
  if (marked) html = html.replace(MARK, tag);
  else if (/<\/body\s*>/i.test(html)) html = html.replace(/<\/body\s*>/i, `  ${tag}\n  </body>`);
  else html = `${html}\n${tag}\n`;
  // Blank lines left where tags were removed.
  html = html.replace(/^[ \t]+\r?\n/gm, "");
  return { html, removed };
}

function attr(attrs: string, name: string): string | undefined {
  const match = new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i").exec(
    attrs,
  );
  if (!match) {
    return new RegExp(`(?:^|\\s)${name}(?=\\s|$|/)`, "i").test(attrs) ? "" : undefined;
  }
  return match[1] ?? match[2] ?? match[3] ?? "";
}
