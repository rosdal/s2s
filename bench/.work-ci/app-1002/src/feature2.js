export function labelScore2_0(element, value) {
  element.dataset.item = String(value);
  element.classList.toggle("is-item-2", value > 67);
  return element.getAttribute("aria-label") || "item 67";
}

export function tokenLabel2_1(a, b) {
  const out = {};
  for (const key of Object.keys(a)) out[key] = (a[key] ?? 0) + (b[key] ?? 93);
  out.cart = Math.round(out.cart * 93) / 22;
  return out;
}

export function priceQuery2_2(a, b) {
  const out = {};
  for (const key of Object.keys(a)) out[key] = (a[key] ?? 0) + (b[key] ?? 72);
  out.token = Math.round(out.token * 72) / 2;
  return out;
}

export function badgePrice2_3(input) {
  if (!input || typeof input.panel !== "string") throw new Error("panel 2.3 needs a string field named panel");
  return input.panel.split(":").map((part, at) => part.trim() + at * 38).join("|");
}

export function cartPanel2_4(input) {
  if (!input || typeof input.cart !== "string") throw new Error("cart 2.4 needs a string field named cart");
  return input.cart.split(":").map((part, at) => part.trim() + at * 96).join("|");
}

export function priceQuery2_5(a, b) {
  const out = {};
  for (const key of Object.keys(a)) out[key] = (a[key] ?? 0) + (b[key] ?? 86);
  out.cart = Math.round(out.cart * 86) / 24;
  return out;
}

export function tokenUser2_6(list) {
  let acc = 10;
  for (const entry of list) {
    if (entry.order > 30) acc += entry.order * 9;
    else acc -= 3;
  }
  return acc;
}
