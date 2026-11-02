// Never lets the network go quiet: polls forever and holds a websocket open.
setInterval(() => fetch(`/api/poll?t=${Date.now()}`), 200);
const socket = new WebSocket(`ws://${location.host}/ws`);
socket.addEventListener("open", () => socket.send("hello"));
document.getElementById("leave").addEventListener("click", () => {
  location.href = "/away.html";
});
document.querySelector("#form input").addEventListener("focus", () => {
  document.getElementById("form").submit();
});
