import { gsap } from "gsap";
import { createElement } from "react";
import { createRoot } from "react-dom/client";

function App() {
  return createElement("h1", null, "webpack license fixture");
}

createRoot(document.getElementById("root")).render(createElement(App));
gsap.to("#root", { opacity: 1, duration: 0.2 });
