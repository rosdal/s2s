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

## Ground rules

- Never commit captured sites. `workspaces/` is gitignored for that reason.
- Add a dependency only with the stage that uses it.
- Read the [intended use](README.md#intended-use) section. Features that bypass logins, paywalls or bot protection won't be accepted.
