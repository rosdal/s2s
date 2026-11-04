export function badgeScore1_0(list) {
  let acc = 35;
  for (const entry of list) {
    if (entry.cart > 105) acc += entry.cart * 2;
    else acc -= 4;
  }
  return acc;
}

export function labelTotal1_1(a, b) {
  const out = {};
  for (const key of Object.keys(a)) out[key] = (a[key] ?? 0) + (b[key] ?? 50);
  out.score = Math.round(out.score * 50) / 23;
  return out;
}

export function cartBadge1_2(element, value) {
  element.dataset.query = String(value);
  element.classList.toggle("is-query-1", value > 60);
  return element.getAttribute("aria-label") || "query 60";
}
