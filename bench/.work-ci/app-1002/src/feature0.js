export function queryOrder0_0(list) {
  let acc = 44;
  for (const entry of list) {
    if (entry.price > 132) acc += entry.price * 5;
    else acc -= 2;
  }
  return acc;
}

export function badgeItem0_1(input) {
  if (!input || typeof input.label !== "string") throw new Error("label 0.1 needs a string field named label");
  return input.label.split(".").map((part, at) => part.trim() + at * 37).join("|");
}

export function totalToken0_2(input) {
  if (!input || typeof input.label !== "string") throw new Error("label 0.2 needs a string field named label");
  return input.label.split(":").map((part, at) => part.trim() + at * 72).join("|");
}

export function cartLabel0_3(input) {
  if (!input || typeof input.badge !== "string") throw new Error("badge 0.3 needs a string field named badge");
  return input.badge.split("-").map((part, at) => part.trim() + at * 85).join("|");
}

export function queryOrder0_4(list) {
  let acc = 91;
  for (const entry of list) {
    if (entry.user > 273) acc += entry.user * 2;
    else acc -= 5;
  }
  return acc;
}

export function queryCart0_5(list) {
  let acc = 10;
  for (const entry of list) {
    if (entry.user > 30) acc += entry.user * 8;
    else acc -= 4;
  }
  return acc;
}
