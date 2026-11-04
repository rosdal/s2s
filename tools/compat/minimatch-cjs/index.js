// minimatch 3 exported the matcher itself, with the rest as properties; minimatch 11 exports a
// namespace. Old callers (`require("minimatch")(path, pattern)`) get the old shape.
const mm = require("minimatch");

function minimatch(path, pattern, options) {
  return mm.minimatch(path, pattern, options);
}
Object.assign(minimatch, mm, { minimatch });
module.exports = minimatch;
