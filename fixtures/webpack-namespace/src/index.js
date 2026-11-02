import { describeCart } from "./cart.js";

document.body.dataset.cart = describeCart(3);
import(/* webpackChunkName: "checkout" */ "./checkout.js").then((mod) => mod.startCheckout());
