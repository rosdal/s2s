document.getElementById("status").textContent = "hydrated";
document.getElementById("status").className = "hydrated";
new Worker("/js/worker.js");
