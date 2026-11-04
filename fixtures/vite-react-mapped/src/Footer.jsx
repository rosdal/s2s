import "./footer.css";
import { formatRole } from "./shared.js";

export default function Footer() {
  return <footer className="footer">Footer for {formatRole("visitor")}</footer>;
}
