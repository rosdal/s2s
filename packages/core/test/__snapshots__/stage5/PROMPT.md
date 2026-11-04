Reconstruct this site's source, one group at a time, following `AGENTS.md`.

1. Read `AGENTS.md`, `PROGRESS.md` and `analysis/modules.json`. Run `s2s verify` once to confirm the baseline passes. If it doesn't, stop and say why.
2. If the structure item in `PROGRESS.md` is unticked: lay out the target folder structure and routes from `analysis/project-hints.json` and the page snapshots in `raw/pages/`, write it down in `PROGRESS.md`, tick the item and commit.
3. Take the first unticked group in `PROGRESS.md`. Read its modules, rename identifiers, add types, split them into components and hooks, move them out of `project/src/_recovered/` into the structure, and fix every import.
4. Run `s2s verify`. On failure, read `verify/report.md`, fix, and run it again. After three failed attempts, revert the group (`git checkout -- project`), note why in the Notes section of `PROGRESS.md`, and move on.
5. Tick the group, commit as `reconstruct: group <n> — <summary>`, and continue with the next group. When the session is running low, stop at a clean commit.
6. When every group is done, work through the final items: typecheck clean (`pnpm --dir project run typecheck`), `project/src/_recovered/` empty, and a `project/README.md` that says this is a reconstruction of https://shop.example.com/, not its original source.

If you are picking this up from an earlier session, `PROGRESS.md` and `git log` tell you where it stopped: continue from the first unticked item.
