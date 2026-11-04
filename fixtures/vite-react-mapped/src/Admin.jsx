import "./admin.css";
import { formatRole } from "./shared.js";

export default function Admin() {
  return <section className="admin">Admin panel for {formatRole("owner")}</section>;
}
