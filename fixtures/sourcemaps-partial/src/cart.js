// Two modules declare `label`; once bundled into one scope only one can get its name back.
function label(value) {
  return `cart:${value}`;
}

export function computeTotal(items) {
  let runningTotal = 0;
  for (const item of items) runningTotal += item.price;
  document.body.dataset.cart = label(runningTotal);
  return runningTotal;
}
