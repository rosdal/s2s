function label(value) {
  return `price:${value}`;
}

export function formatPrice(amount) {
  return label(amount.toFixed(2));
}
