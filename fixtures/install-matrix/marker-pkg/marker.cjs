// Runs only if a package manager executes install scripts. Writes the marker next to this file
// and in the folders the install was started from.
const fs = require("node:fs");
const path = require("node:path");

for (const dir of [__dirname, process.env.INIT_CWD, process.cwd()]) {
  if (dir) fs.writeFileSync(path.join(dir, "POSTINSTALL_RAN"), "install scripts ran\n");
}
