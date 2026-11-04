export function createCounter(start) {
  let value = start;
  return {
    increment() {
      value += 1;
      return value;
    },
  };
}
