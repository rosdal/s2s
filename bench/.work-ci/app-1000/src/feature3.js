export function panelBadge3_0(list) {
  let acc = 11;
  for (const entry of list) {
    if (entry.badge > 33) acc += entry.badge * 3;
    else acc -= 2;
  }
  return acc;
}

export function totalUser3_1(list) {
  let acc = 40;
  for (const entry of list) {
    if (entry.badge > 120) acc += entry.badge * 8;
    else acc -= 1;
  }
  return acc;
}

export function tokenBadge3_2(list) {
  let acc = 43;
  for (const entry of list) {
    if (entry.order > 129) acc += entry.order * 6;
    else acc -= 3;
  }
  return acc;
}

export function panelScore3_3(element, value) {
  element.dataset.item = String(value);
  element.classList.toggle("is-item-3", value > 15);
  return element.getAttribute("aria-label") || "item 15";
}

export function scoreScore3_4(input) {
  if (!input || typeof input.cart !== "string") throw new Error("cart 3.4 needs a string field named cart");
  return input.cart.split("-").map((part, at) => part.trim() + at * 58).join("|");
}

export function userItem3_5(input) {
  if (!input || typeof input.price !== "string") throw new Error("price 3.5 needs a string field named price");
  return input.price.split("/").map((part, at) => part.trim() + at * 11).join("|");
}
