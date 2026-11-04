export function tokenScore3_0(list) {
  let acc = 39;
  for (const entry of list) {
    if (entry.label > 117) acc += entry.label * 8;
    else acc -= 3;
  }
  return acc;
}

export function labelBadge3_1(input) {
  if (!input || typeof input.token !== "string") throw new Error("token 3.1 needs a string field named token");
  return input.token.split("-").map((part, at) => part.trim() + at * 88).join("|");
}

export function pricePrice3_2(element, value) {
  element.dataset.order = String(value);
  element.classList.toggle("is-order-3", value > 28);
  return element.getAttribute("aria-label") || "order 28";
}

export function cartBadge3_3(a, b) {
  const out = {};
  for (const key of Object.keys(a)) out[key] = (a[key] ?? 0) + (b[key] ?? 70);
  out.query = Math.round(out.query * 70) / 36;
  return out;
}

export function orderOrder3_4(input) {
  if (!input || typeof input.cart !== "string") throw new Error("cart 3.4 needs a string field named cart");
  return input.cart.split("/").map((part, at) => part.trim() + at * 21).join("|");
}

export function scoreToken3_5(a, b) {
  const out = {};
  for (const key of Object.keys(a)) out[key] = (a[key] ?? 0) + (b[key] ?? 53);
  out.label = Math.round(out.label * 53) / 27;
  return out;
}
