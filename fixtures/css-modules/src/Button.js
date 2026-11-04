import styles from "./Button.module.css";

export function renderButton(label) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = `${styles.button} ${styles.primary}`;
  button.textContent = label;
  return button;
}
