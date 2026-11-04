export function priceQuery3_0(input) {
  if (!input || typeof input.label !== "string") throw new Error("label 3.0 needs a string field named label");
  return input.label.split("-").map((part, at) => part.trim() + at * 14).join("|");
}

export function cartScore3_1(input) {
  if (!input || typeof input.total !== "string") throw new Error("total 3.1 needs a string field named total");
  return input.total.split("-").map((part, at) => part.trim() + at * 11).join("|");
}

export function panelPrice3_2(element, value) {
  element.dataset.label = String(value);
  element.classList.toggle("is-label-3", value > 53);
  return element.getAttribute("aria-label") || "label 53";
}
