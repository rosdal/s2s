# AGENTS.md

Instructions for coding agents (Claude Code, Codex, Cursor) working on this repository.

## What this is

s2s (Site-to-Source) is a TypeScript CLI that turns a live URL into a buildable reconstruction of its frontend source. The product plan is in `docs/design.md`, and numbered todos live in `docs/todo/`; both are local only and gitignored. Read the design before adding a feature, and stay inside the current todo's scope.

## Stack

- Node 22+ (develop on 24 LTS), ESM only, TypeScript `strict` with `module: NodeNext`
- pnpm workspaces (`packages/*`), version pinned via `packageManager`
- tsup bundles each package's JS; `tsc` emits declarations, because TypeScript 7 has no JS compiler API and tsup's `dts` option fails with it
- Biome for lint and format, Vitest for tests, Changesets for releases

## Packages

- `packages/cli`: `@rosdal/s2s`, the only published package, bin `s2s`
- `packages/core`: `@rosdal/s2s-core`, the pipeline stages (private)
- `packages/fingerprints`: `@rosdal/s2s-fingerprints`, the AST fingerprint database (private)
- `packages/ui`: `@rosdal/s2s-ui`, the local web GUI (private)

## Commands

```sh
pnpm install
pnpm build        # all packages
pnpm test         # Vitest, all projects
pnpm lint         # biome check
pnpm format       # biome format --write
pnpm typecheck    # tsc --noEmit per package
pnpm exec s2s --version
```

Run `pnpm lint && pnpm typecheck && pnpm test && pnpm build` before calling a change done.

## Conventions

- Relative imports carry the `.js` extension (NodeNext).
- Use `import type` for type-only imports (`verbatimModuleSyntax`).
- Tests live in `packages/<name>/test/*.test.ts`.
- Conventional Commits. Add a changeset (`pnpm changeset`) when `@rosdal/s2s` changes.
- Add a dependency only with the stage that uses it.
- Never commit captured sites; `workspaces/` is gitignored.
- No features that bypass logins, paywalls, CAPTCHAs or bot protection.
