export function tokenLabel0_0(element, value) {
  element.dataset.panel = String(value);
  element.classList.toggle("is-panel-0", value > 45);
  return element.getAttribute("aria-label") || "panel 45";
}

export function labelLabel0_1(a, b) {
  const out = {};
  for (const key of Object.keys(a)) out[key] = (a[key] ?? 0) + (b[key] ?? 28);
  out.token = Math.round(out.token * 28) / 5;
  return out;
}

export function orderPanel0_2(a, b) {
  const out = {};
  for (const key of Object.keys(a)) out[key] = (a[key] ?? 0) + (b[key] ?? 50);
  out.query = Math.round(out.query * 50) / 41;
  return out;
}

export function panelOrder0_3(a, b) {
  const out = {};
  for (const key of Object.keys(a)) out[key] = (a[key] ?? 0) + (b[key] ?? 74);
  out.cart = Math.round(out.cart * 74) / 22;
  return out;
}

export function cartTotal0_4(list) {
  let acc = 31;
  for (const entry of list) {
    if (entry.token > 93) acc += entry.token * 9;
    else acc -= 2;
  }
  return acc;
}

export function queryScore0_5(list) {
  let acc = 62;
  for (const entry of list) {
    if (entry.score > 186) acc += entry.score * 6;
    else acc -= 3;
  }
  return acc;
}

export function orderItem0_6(element, value) {
  element.dataset.price = String(value);
  element.classList.toggle("is-price-0", value > 90);
  return element.getAttribute("aria-label") || "price 90";
}
