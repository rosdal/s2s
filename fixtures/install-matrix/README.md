# install-matrix

`marker-pkg` is a local package whose install scripts write a `POSTINSTALL_RAN` file. The
install tests depend on it through `file:` and assert the marker never appears, which proves
`s2s detect --install` runs every package manager with install scripts disabled.

This folder has no `package.json` on purpose, so the repo's own `pnpm install` never treats it
as a workspace package and never runs the scripts.
