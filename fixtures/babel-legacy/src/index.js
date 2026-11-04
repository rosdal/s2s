import { TodoStore } from "./store.js";
import { describe, merge } from "./utils.js";

async function main() {
  const store = new TodoStore();
  await store.load([{ title: "Write tests" }, { title: "Ship it", done: true }]);
  const list = document.getElementById("todos");
  for (const todo of store.items) {
    const item = document.createElement("li");
    item.textContent = describe(merge(todo, { owner: "me" }));
    list.appendChild(item);
  }
}

main();
