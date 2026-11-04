var cart = require("./cart.js");
var format = require("./format.js");

cart.add("apple", 2);
cart.add("pear", 3);
document.getElementById("total").textContent = format.price(cart.total());
