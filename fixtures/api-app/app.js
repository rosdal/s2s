// Renders a list from the site's own JSON API, and pings a third-party tracker.
const list = document.getElementById("items");

fetch("/api/items")
  .then((response) => response.json())
  .then((items) => {
    for (const item of items) {
      const li = document.createElement("li");
      li.className = "item";
      li.textContent = item.name;
      list.appendChild(li);
    }
  })
  .catch((error) => console.error("items failed", error));

fetch("https://tracker.example.invalid/ping").catch(() => {});
