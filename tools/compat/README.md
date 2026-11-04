# Compatibility shims

Overrides in `pnpm-workspace.yaml` point at these to keep vulnerable packages out of the
legacy fixture toolchains (webpack 4, browserify). Neither ships in `@rosdal/s2s`.

- `minimatch-cjs` gives glob 7 and multimatch 5 the callable CommonJS export of minimatch 3,
  backed by the patched minimatch 11.
- `crypto-browserify-stub` replaces browserify's and webpack 4's `crypto` polyfill. No fixture
  bundles `crypto`, and the real polyfill pulls in elliptic, which has no patched release.
