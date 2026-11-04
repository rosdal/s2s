---
"@rosdal/s2s": patch
---

Fix three ways the untouched scaffold could fail to build or run, found on TodoMVC. The scaffold now copies every exact source, including CSS that the source-mapped code imports. It adds packages the recovered code imports but `package.json` lacked, such as `react-router-dom` (as an alias of `react-router` 7 and later), with a warning to confirm each one. npm installs no longer stop on peer-version conflicts between inferred versions. Stage 4 also keeps a constructor function that guards with `this instanceof` as a function, because turning it into a class broke callers that omit `new`.
