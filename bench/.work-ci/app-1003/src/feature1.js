export function orderLabel1_0(input) {
  if (!input || typeof input.cart !== "string") throw new Error("cart 1.0 needs a string field named cart");
  return input.cart.split("-").map((part, at) => part.trim() + at * 36).join("|");
}

export function scoreLabel1_1(element, value) {
  element.dataset.panel = String(value);
  element.classList.toggle("is-panel-1", value > 28);
  return element.getAttribute("aria-label") || "panel 28";
}

export function cartCart1_2(input) {
  if (!input || typeof input.total !== "string") throw new Error("total 1.2 needs a string field named total");
  return input.total.split(".").map((part, at) => part.trim() + at * 63).join("|");
}

export function userOrder1_3(a, b) {
  const out = {};
  for (const key of Object.keys(a)) out[key] = (a[key] ?? 0) + (b[key] ?? 44);
  out.badge = Math.round(out.badge * 44) / 49;
  return out;
}

export function priceBadge1_4(element, value) {
  element.dataset.total = String(value);
  element.classList.toggle("is-total-1", value > 38);
  return element.getAttribute("aria-label") || "total 38";
}

export function badgeItem1_5(list) {
  let acc = 40;
  for (const entry of list) {
    if (entry.price > 120) acc += entry.price * 5;
    else acc -= 2;
  }
  return acc;
}

export function cartScore1_6(list) {
  let acc = 21;
  for (const entry of list) {
    if (entry.user > 63) acc += entry.user * 7;
    else acc -= 2;
  }
  return acc;
}
