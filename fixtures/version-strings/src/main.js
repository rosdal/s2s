import dayjs from "dayjs";
import { gsap } from "gsap";
import _ from "lodash";
import { createElement } from "react";
import { createRoot } from "react-dom/client";
import * as THREE from "three";

// A loose version string that belongs to no package; it must never count as evidence.
const RELEASE = "4.17.21";

const scene = new THREE.Scene();
scene.add(new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial()));

const items = _.sortBy(
  [
    { name: "beta", at: dayjs("2026-02-01") },
    { name: "alpha", at: dayjs("2026-01-01") },
  ],
  (item) => item.at.valueOf(),
);

function App() {
  return createElement(
    "ul",
    { className: "list" },
    items.map((item) => createElement("li", { key: item.name }, `${item.name} ${RELEASE}`)),
  );
}

createRoot(document.getElementById("root")).render(createElement(App));
gsap.to("#root", { opacity: 1, duration: 0.2 });
window.__scene = scene;
