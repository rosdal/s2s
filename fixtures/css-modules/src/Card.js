import styles from "./Card.module.css";

export function renderCard(title, child) {
  const card = document.createElement("article");
  card.className = styles.card;
  const heading = document.createElement("h2");
  heading.className = styles.title;
  heading.textContent = title;
  card.append(heading, child);
  return card;
}
