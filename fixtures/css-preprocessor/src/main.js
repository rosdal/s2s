import card from "./components/card.module.css";

const el = document.createElement("div");
el.className = card.card;
el.textContent = "card";
document.body.append(el);
