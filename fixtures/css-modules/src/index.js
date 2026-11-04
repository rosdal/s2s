import "./global.css";
import { renderButton } from "./Button.js";
import { renderCard } from "./Card.js";

const root = document.getElementById("root");
root.appendChild(renderCard("CSS Modules", renderButton("Open")));
