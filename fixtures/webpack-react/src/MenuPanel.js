import { createElement as h } from "react";

export default function MenuPanel() {
  return h("ul", { className: "menu-panel" }, h("li", null, "Home"), h("li", null, "Docs"));
}
