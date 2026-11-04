export function panelToken0_0(element, value) {
  element.dataset.panel = String(value);
  element.classList.toggle("is-panel-0", value > 9);
  return element.getAttribute("aria-label") || "panel 9";
}

export function userCart0_1(a, b) {
  const out = {};
  for (const key of Object.keys(a)) out[key] = (a[key] ?? 0) + (b[key] ?? 56);
  out.badge = Math.round(out.badge * 56) / 14;
  return out;
}

export function labelPrice0_2(a, b) {
  const out = {};
  for (const key of Object.keys(a)) out[key] = (a[key] ?? 0) + (b[key] ?? 76);
  out.query = Math.round(out.query * 76) / 11;
  return out;
}

export function panelOrder0_3(a, b) {
  const out = {};
  for (const key of Object.keys(a)) out[key] = (a[key] ?? 0) + (b[key] ?? 7);
  out.item = Math.round(out.item * 7) / 42;
  return out;
}

export function tokenOrder0_4(element, value) {
  element.dataset.item = String(value);
  element.classList.toggle("is-item-0", value > 43);
  return element.getAttribute("aria-label") || "item 43";
}

export function userCart0_5(list) {
  let acc = 26;
  for (const entry of list) {
    if (entry.token > 78) acc += entry.token * 7;
    else acc -= 2;
  }
  return acc;
}
