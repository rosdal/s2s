// Fixture bundles never use `crypto`; a build that does fails loudly instead of shipping nothing.
module.exports = new Proxy(
  {},
  {
    get(_, key) {
      if (key === "__esModule" || typeof key === "symbol") return undefined;
      throw new Error(`crypto.${String(key)} is not available in fixture builds`);
    },
  },
);
