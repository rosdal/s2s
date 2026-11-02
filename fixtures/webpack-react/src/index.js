import { createElement as h, useState } from "react";
import { createRoot } from "react-dom/client";

function Menu() {
  const [open, setOpen] = useState(false);
  const [Panel, setPanel] = useState(null);
  const toggle = () => {
    setOpen(!open);
    if (!Panel) {
      import(/* webpackChunkName: "menu-panel" */ "./MenuPanel.js").then((mod) =>
        setPanel(() => mod.default),
      );
    }
  };
  return h(
    "nav",
    null,
    h(
      "button",
      { type: "button", "aria-expanded": String(open), onClick: toggle, id: "menu" },
      "Menu",
    ),
    open && Panel ? h(Panel) : null,
  );
}

function App() {
  const openSettings = () => {
    // Behind a prompt the capture never answers, so only chunk-map discovery finds it.
    if (window.prompt("Admin password?") === "letmein") {
      import(/* webpackChunkName: "settings" */ "./Settings.js").then((mod) => mod.default());
    }
  };
  return h(
    "main",
    null,
    h("h1", null, "webpack React fixture"),
    h(Menu),
    h("a", { href: "#", onClick: openSettings, "data-never": "" }, "Settings"),
  );
}

createRoot(document.getElementById("root")).render(h(App));
