# PROGRESS

Work through this from the top; `PROMPT.md` says how. Groups come from `analysis/modules.json`, in dependency order.

## Structure

- [ ] Lay out the folder structure and routes (see `analysis/project-hints.json` and `raw/pages/`)

## Groups

- [ ] Group 1 (`g1`, 2 modules, 9 KB)
  - `project/src/_recovered/cart/12.jsx` (component, unbundled)
  - `project/src/_recovered/main/501.js` (entry, unbundled)

## Packages to review

See `analysis/packages-review.json`.

- [ ] Review `scheduler`: add it with evidence, or reject it and note why

## Final

- [ ] Typecheck clean: `pnpm --dir project run typecheck`
- [ ] `project/src/_recovered/` is empty
- [ ] `project/README.md` says this is a reconstruction of https://shop.example.com/, not its original source

## Notes

Skipped groups, open questions and decisions go here.
