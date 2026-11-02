# s2s — Site-to-Source

[![CI](https://github.com/Rosdal/s2s/actions/workflows/ci.yml/badge.svg)](https://github.com/Rosdal/s2s/actions/workflows/ci.yml)
![status: pre-alpha, nothing works yet](https://img.shields.io/badge/status-pre--alpha%2C%20nothing%20works%20yet-red)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

s2s turns a live URL into a plausible, buildable reconstruction of its frontend source. The CLI does the deterministic work: it captures the page in a real browser, recovers source maps, detects third-party packages, unbundles and cleans up the first-party code, and scaffolds a project. Then it writes `AGENTS.md` and `PROMPT.md`, so the reasoning-heavy part (naming, structure, types) runs in Claude Code on your own subscription, with a screenshot-diff verify loop to check the result.

> **Status: pre-alpha.** Nothing works yet. The repository holds empty package stubs, and the CLI only prints its version.

## Planned usage

```sh
npx @rosdal/s2s grab https://example.com
cd example-com && claude
```

Each stage will also be its own command (`s2s capture`, `s2s maps`, `s2s detect`, `s2s unbundle`, `s2s scaffold`, `s2s verify`), and every stage resumes from the workspace's `manifest.json`. See the [product design](docs/design.md) for the full plan.

## Intended use

s2s is an analysis and learning tool. Use it to:

- learn how a site's frontend is built,
- analyse code that already runs in your browser, and
- recover frontend source that you own but lost.

Do not use it to:

- **redistribute or reuse someone else's code.** Reconstructed first-party code still belongs to the site owner.
- **ignore a site's terms.** Many sites forbid scraping. s2s keeps polite defaults (rate limit, `robots.txt`, an honest user agent) and will never bypass logins, paywalls, CAPTCHAs or bot protection.

s2s cannot recover server code, APIs, environment variables, comments, tests or history, only what a public visitor's browser receives. Output stays on your machine; the tool has no upload or sharing features.

You are responsible for how you use it. This section is not legal advice.

## Repository layout

| Package                 | npm name                   | Visibility        |
| ----------------------- | -------------------------- | ----------------- |
| `packages/cli`          | `@rosdal/s2s`              | public, bin `s2s` |
| `packages/core`         | `@rosdal/s2s-core`         | private           |
| `packages/fingerprints` | `@rosdal/s2s-fingerprints` | private           |
| `packages/ui`           | `@rosdal/s2s-ui`           | private           |

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Report security issues as described in [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE) © Rosdal
