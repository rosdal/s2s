# Contributing

## Setup

You need Node 22 or later (24 LTS recommended, see `.nvmrc`) and pnpm. The pnpm version is pinned in the `packageManager` field; run `corepack enable`, or use a globally installed pnpm, which switches to the pinned version on its own.

```sh
pnpm install
pnpm lint && pnpm typecheck && pnpm test && pnpm build
pnpm exec s2s --version
```

`pnpm format` rewrites files with Biome.

## Workflow

`main` is protected. Work on a branch and open a pull request; CI must pass before it can merge.

### Commit messages

Use [Conventional Commits](https://www.conventionalcommits.org/): `feat:`, `fix:`, `docs:`, `chore:`, `refactor:`, `test:`, `ci:`. Add a scope when it helps, for example `feat(core): record HAR`.

### Changesets

A change that affects a published package (today only `@rosdal/s2s`) needs a changeset:

```sh
pnpm changeset
```

Pick the package and bump type, write a one-line summary for the changelog, and commit the generated file in `.changeset/` with your change. Docs-only and tooling-only changes don't need one.

### Package signatures

`s2s detect` finds packages in bundles that have no source maps or banners by matching version strings. Each package has one file in `packages/core/src/detect/signatures/`: a regex with a named `version` group, plus anchor tokens that must appear nearby, so a stray `"4.17.21"` never counts on its own. To add a package, add its file, import it in `signatures.ts`, and add a test with a real excerpt from the package's minified build to `packages/core/test/detect-units.test.ts`.

The Stage 3 tests read npm registry answers from `fixtures/registry/`. If a fixture starts naming a new package, record it with `node fixtures/registry/record.mjs <name>`.

## Ground rules

- Never commit captured sites. `workspaces/` is gitignored for that reason.
- Add a dependency only with the stage that uses it.
- Read the [intended use](README.md#intended-use) section. Features that bypass logins, paywalls or bot protection won't be accepted.
