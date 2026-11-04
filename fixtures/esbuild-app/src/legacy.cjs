const { slugify } = require("./slug.js");

module.exports = {
  title(text) {
    return slugify(text).toUpperCase();
  },
};
