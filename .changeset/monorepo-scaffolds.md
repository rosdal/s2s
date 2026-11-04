---
"@rosdal/s2s": patch
---

Get monorepo sites like Excalidraw much closer to building untouched.

- Source maps keep their folder depth: a file whose sources climb out of a deeper folder no longer loses that folder, and its real name is read from imports that need it.
- The scaffold rebuilds barrel `index.ts` files that compiled to no code, writes empty stand-ins for stylesheets no map held, and aliases the site's own workspace packages (`@excalidraw/element`) to their recovered folders instead of installing them from npm.
- Maps rebuild data the bundle inlined without mappings (JSON imports such as locale files, and namespaces of tree-shaken modules) from the binding the importer's map points at, and write captured bytes in place of the placeholder Vite keeps for each asset.
- The scaffold points imports of a lazy chunk that came without a map (`./firebaseSDK`) at the unbundler's split parts, and aliases plugin virtual modules (`virtual:pwa-register`) to the code their map kept.
- Capture keeps a DOM snapshot per viewport, and verify compares each viewport with its own, so a responsive app's mobile layout no longer fails against the desktop DOM.
- Detection adds `sass` when code imports `.scss` files, reads React's `use-sync-external-store-shim/with-selector` banner as one package, and no longer guesses a parent version newer than a dependency the bundle still contains.
- `grab` skips the baseline check when the scaffold does not build instead of printing the same errors twice, build logs drop colour codes, capture progress lines show each phase's own totals, and the unbundle summary counts the same modules the scaffold does.
