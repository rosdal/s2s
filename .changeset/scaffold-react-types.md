---
"@rosdal/s2s": patch
---

The scaffold now adds `@types/react` and `@types/react-dom` for React projects, matching the site's React major, so the agent's strict TSX typechecks without a new dependency. npm projects also get a `.npmrc` with `legacy-peer-deps=true`, so the agent's own installs get past the same peer conflicts the scaffold's install does. Both came out of the first acceptance run, on TodoMVC.
