import { computeTotal } from "./cart.js";
import { formatPrice } from "./format.js";

const shoppingItems = [{ price: 3 }, { price: 4 }];
document.body.dataset.total = formatPrice(computeTotal(shoppingItems));
