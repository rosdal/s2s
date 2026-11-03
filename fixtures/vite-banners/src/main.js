import { gsap } from "gsap";
import { createElement } from "react";
import { createRoot } from "react-dom/client";
import Swiper from "swiper";

function App() {
  return createElement(
    "div",
    { className: "swiper" },
    createElement("div", { className: "swiper-wrapper" }),
  );
}

createRoot(document.getElementById("root")).render(createElement(App));
gsap.to("#root", { opacity: 1, duration: 0.2 });
window.__swiper = () => new Swiper(".swiper");
