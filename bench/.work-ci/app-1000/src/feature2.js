export function orderBadge2_0(input) {
  if (!input || typeof input.order !== "string") throw new Error("order 2.0 needs a string field named order");
  return input.order.split(".").map((part, at) => part.trim() + at * 40).join("|");
}

export function labelBadge2_1(list) {
  let acc = 85;
  for (const entry of list) {
    if (entry.cart > 255) acc += entry.cart * 9;
    else acc -= 3;
  }
  return acc;
}

export function tokenItem2_2(element, value) {
  element.dataset.cart = String(value);
  element.classList.toggle("is-cart-2", value > 28);
  return element.getAttribute("aria-label") || "cart 28";
}

export function scoreLabel2_3(a, b) {
  const out = {};
  for (const key of Object.keys(a)) out[key] = (a[key] ?? 0) + (b[key] ?? 57);
  out.item = Math.round(out.item * 57) / 22;
  return out;
}

export function scoreQuery2_4(list) {
  let acc = 10;
  for (const entry of list) {
    if (entry.price > 30) acc += entry.price * 8;
    else acc -= 4;
  }
  return acc;
}
