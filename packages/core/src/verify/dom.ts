/**
 * DOM-tree similarity, evaluated in the page: both trees are reduced to a multiset of element
 * tokens (tag, id, classes, parent tag) and compared with the Dice coefficient. Script, style and
 * other non-rendered elements are skipped. Kept as a string so the bundler can't touch it.
 *
 * Called with the captured hydrated DOM as its argument; returns
 * `{ similarity, captured, current, missing, extra }` where `missing` and `extra` are the most
 * frequent tokens only one side has.
 */
export const DOM_SIMILARITY = `(capturedHtml) => {
  const SKIP = new Set(["SCRIPT", "STYLE", "LINK", "META", "NOSCRIPT", "TEMPLATE", "BASE", "TITLE"]);
  const tokens = (root) => {
    const counts = new Map();
    const walk = (el) => {
      for (const child of el.children) {
        if (SKIP.has(child.tagName)) continue;
        const classes = [...child.classList].sort().join(".");
        const token = el.tagName.toLowerCase() + ">" + child.tagName.toLowerCase() +
          (child.id ? "#" + child.id : "") + (classes ? "." + classes : "");
        counts.set(token, (counts.get(token) || 0) + 1);
        walk(child);
      }
    };
    if (root) walk(root);
    return counts;
  };
  const captured = tokens(new DOMParser().parseFromString(capturedHtml, "text/html").body);
  const current = tokens(document.body);
  let shared = 0, a = 0, b = 0;
  for (const [, n] of captured) a += n;
  for (const [, n] of current) b += n;
  for (const [token, n] of captured) shared += Math.min(n, current.get(token) || 0);
  const diff = (x, y) => [...x].map(([t, n]) => [t, n - (y.get(t) || 0)]).filter(([, n]) => n > 0)
    .sort((p, q) => q[1] - p[1] || (p[0] < q[0] ? -1 : 1)).slice(0, 5).map(([t, n]) => n + "× " + t);
  return {
    similarity: a + b === 0 ? 1 : (2 * shared) / (a + b),
    captured: a,
    current: b,
    missing: diff(captured, current),
    extra: diff(current, captured),
  };
}`;

export interface DomResult {
  similarity: number;
  captured: number;
  current: number;
  missing: string[];
  extra: string[];
}
