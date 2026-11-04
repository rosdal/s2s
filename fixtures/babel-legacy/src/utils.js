export function merge(base, extra) {
  return { ...base, ...extra };
}

export function describe(todo) {
  const owner = todo.meta?.owner ?? todo.owner;
  const { title, done = false } = todo;
  return `${title} (${owner})${done ? " done" : ""}`;
}
