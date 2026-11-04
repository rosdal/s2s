// A live clock and an autoplaying carousel: both change between any two screenshots.
const slides = ["#c0392b", "#27ae60", "#2980b9"];
const clock = document.getElementById("clock");
const carousel = document.getElementById("carousel");

function tick() {
  const now = Date.now();
  clock.textContent = String(now);
  // A new slide every 700 ms, so two screenshots a second or more apart never show the same one.
  carousel.style.background = slides[Math.floor(now / 700) % slides.length];
}

tick();
setInterval(tick, 50);
