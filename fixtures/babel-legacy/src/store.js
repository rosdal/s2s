export class TodoStore {
  constructor() {
    this.items = [];
  }

  async load(todos) {
    await Promise.resolve();
    this.items = [...this.items, ...todos];
    return this.items.length;
  }

  get remaining() {
    return this.items.filter((todo) => !todo.done).length;
  }
}
