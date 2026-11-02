import { greet } from "./greet.js";

document.body.dataset.greeting = greet("maps");
import("./lazy.js").then((mod) => mod.mark());
