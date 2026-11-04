const greetings = ["Hello", "Bonjour", "Hallo", "Ciao"];

function greet(name, index) {
  return `${greetings[index % greetings.length]}, ${name}!`;
}

function render(names) {
  const list = document.getElementById("list");
  for (let i = 0; i < names.length; i++) {
    const item = document.createElement("li");
    item.textContent = greet(names[i], i);
    list.appendChild(item);
  }
  document.title = "Greeted " + names.length + " people";
}

render(["Ada", "Grace", "Linus"]);
