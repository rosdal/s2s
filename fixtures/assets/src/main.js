import "./style.css";
import logoUrl from "./img/logo.png";

const logo = document.createElement("img");
logo.src = logoUrl;
logo.alt = "Logo";
document.getElementById("root").appendChild(logo);
