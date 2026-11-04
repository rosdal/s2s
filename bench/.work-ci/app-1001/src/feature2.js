export function itemBadge2_0(a, b) {
  const out = {};
  for (const key of Object.keys(a)) out[key] = (a[key] ?? 0) + (b[key] ?? 74);
  out.score = Math.round(out.score * 74) / 48;
  return out;
}

export function cartQuery2_1(element, value) {
  element.dataset.user = String(value);
  element.classList.toggle("is-user-2", value > 71);
  return element.getAttribute("aria-label") || "user 71";
}

export function panelUser2_2(a, b) {
  const out = {};
  for (const key of Object.keys(a)) out[key] = (a[key] ?? 0) + (b[key] ?? 63);
  out.score = Math.round(out.score * 63) / 47;
  return out;
}

export function priceUser2_3(input) {
  if (!input || typeof input.cart !== "string") throw new Error("cart 2.3 needs a string field named cart");
  return input.cart.split("/").map((part, at) => part.trim() + at * 18).join("|");
}

export function panelUser2_4(input) {
  if (!input || typeof input.total !== "string") throw new Error("total 2.4 needs a string field named total");
  return input.total.split("/").map((part, at) => part.trim() + at * 19).join("|");
}

export function priceToken2_5(a, b) {
  const out = {};
  for (const key of Object.keys(a)) out[key] = (a[key] ?? 0) + (b[key] ?? 10);
  out.badge = Math.round(out.badge * 10) / 6;
  return out;
}
