import { createCounter } from "./counter.js";
import legacy from "./legacy.cjs";

const counter = createCounter(0);
const button = document.getElementById("count");
button.addEventListener("click", () => {
  button.textContent = String(counter.increment());
});
document.getElementById("title").dataset.slug = legacy.title("esbuild fixture");
