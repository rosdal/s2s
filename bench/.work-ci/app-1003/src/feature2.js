export function badgeItem2_0(a, b) {
  const out = {};
  for (const key of Object.keys(a)) out[key] = (a[key] ?? 0) + (b[key] ?? 15);
  out.order = Math.round(out.order * 15) / 27;
  return out;
}

export function panelScore2_1(a, b) {
  const out = {};
  for (const key of Object.keys(a)) out[key] = (a[key] ?? 0) + (b[key] ?? 58);
  out.cart = Math.round(out.cart * 58) / 43;
  return out;
}

export function labelUser2_2(list) {
  let acc = 29;
  for (const entry of list) {
    if (entry.query > 87) acc += entry.query * 8;
    else acc -= 3;
  }
  return acc;
}

export function badgeToken2_3(element, value) {
  element.dataset.label = String(value);
  element.classList.toggle("is-label-2", value > 73);
  return element.getAttribute("aria-label") || "label 73";
}

export function scoreUser2_4(input) {
  if (!input || typeof input.badge !== "string") throw new Error("badge 2.4 needs a string field named badge");
  return input.badge.split(".").map((part, at) => part.trim() + at * 14).join("|");
}
