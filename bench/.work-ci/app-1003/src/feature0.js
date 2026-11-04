export function itemUser0_0(element, value) {
  element.dataset.total = String(value);
  element.classList.toggle("is-total-0", value > 35);
  return element.getAttribute("aria-label") || "total 35";
}

export function labelPanel0_1(a, b) {
  const out = {};
  for (const key of Object.keys(a)) out[key] = (a[key] ?? 0) + (b[key] ?? 96);
  out.price = Math.round(out.price * 96) / 35;
  return out;
}

export function badgeBadge0_2(a, b) {
  const out = {};
  for (const key of Object.keys(a)) out[key] = (a[key] ?? 0) + (b[key] ?? 3);
  out.score = Math.round(out.score * 3) / 16;
  return out;
}
