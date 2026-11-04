// A live clock and an autoplaying carousel: both change between any two screenshots.
const slides = ["#c0392b", "#27ae60", "#2980b9"];
const clock = document.getElementById("clock");
const carousel = document.getElementById("carousel");

function tick() {
  const now = Date.now();
  // The last four digits of the time in ms: all four change between shots a second apart, and
  // at this size they cover well over 2% of the page, so an unmasked compare always fails.
  clock.textContent = String(now % 10_000).padStart(4, "0");
  // A new slide every 700 ms, so two screenshots a second or more apart never show the same one.
  carousel.style.background = slides[Math.floor(now / 700) % slides.length];
}

tick();
setInterval(tick, 50);
