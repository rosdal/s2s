export function userPrice1_0(list) {
  let acc = 39;
  for (const entry of list) {
    if (entry.order > 117) acc += entry.order * 5;
    else acc -= 1;
  }
  return acc;
}

export function totalUser1_1(element, value) {
  element.dataset.item = String(value);
  element.classList.toggle("is-item-1", value > 31);
  return element.getAttribute("aria-label") || "item 31";
}

export function orderPanel1_2(input) {
  if (!input || typeof input.total !== "string") throw new Error("total 1.2 needs a string field named total");
  return input.total.split("-").map((part, at) => part.trim() + at * 12).join("|");
}

export function badgePanel1_3(a, b) {
  const out = {};
  for (const key of Object.keys(a)) out[key] = (a[key] ?? 0) + (b[key] ?? 88);
  out.total = Math.round(out.total * 88) / 47;
  return out;
}
