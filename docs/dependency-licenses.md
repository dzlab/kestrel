# Dependency license inventory

This inventory records the license review for the exact versions in `package-lock.json` as of 2026-11-15. It is an engineering record, not legal advice. The committed lockfile remains the source of truth for resolved versions and integrity hashes.

## Direct packages

| Package | Locked version | License |
| --- | ---: | --- |
| `@assistant-ui/react` | 0.15.36 | MIT |
| `@radix-ui/react-dialog` | 1.3.1 | MIT |
| `class-variance-authority` | 0.7.1 | Apache-2.0 |
| `clsx` | 2.1.1 | MIT |
| `lucide-react` | 0.468.0 | ISC |
| `react` | 19.3.1 | MIT |
| `react-dom` | 19.3.1 | MIT |
| `react-markdown` | 10.1.0 | MIT |
| `remark-gfm` | 4.0.1 | MIT |
| `shiki` | 3.23.0 | MIT |
| `tailwind-merge` | 3.7.0 | MIT |
| `@types/bun` | 1.4.0 | MIT |
| `@types/react` | 19.3.0 | MIT |
| `@types/react-dom` | 19.3.0 | MIT |
| `@vitejs/plugin-react` | 5.2.0 | MIT |
| `typescript` | 5.9.3 | Apache-2.0 |
| `vite` | 7.3.8 | MIT |

The lockfile's transitive packages use MIT, Apache-2.0, ISC, BSD-3-Clause, 0BSD, or CC-BY-4.0. Five exact-version lock entries omit a `license` field; their registry manifests and included license texts resolve them as follows:

| Package | Locked version | Manifest and included text |
| --- | ---: | --- |
| `@types/bun` | 1.4.0 | MIT; included `bun/LICENSE` |
| `@types/node` | 26.4.0 | MIT; included `node/LICENSE` |
| `bun-types` | 1.4.0 | MIT; registry manifest and Bun license documentation |
| `typescript` | 5.9.3 | Apache-2.0; included `package/LICENSE.txt` |
| `undici-types` | 8.3.0 | MIT; included `package/LICENSE` |

## `caniuse-lite` disposition

`caniuse-lite` 1.0.30001826 is licensed under CC-BY-4.0. Its exact package includes the Creative Commons Attribution 4.0 license text, identifies Ben Briggs as the package author, and points to the [`browserslist/caniuse-lite`](https://github.com/browserslist/caniuse-lite) repository.

In this dependency graph it is data consumed by `browserslist`, reached through the Vite/Babel development toolchain. It is not a Kestrel runtime dependency, is not copied by the package `files` allowlist, and is not shipped as a standalone database in `ui/dist/`. The generated browser assets are the output of that toolchain rather than a redistribution of the caniuse database.

For transparency, the upstream attribution is: caniuse-lite by Ben Briggs and contributors, licensed under [CC-BY-4.0](https://creativecommons.org/licenses/by/4.0/). If future packaging copies or embeds the database itself, the release must retain creator identification, the license link or text, a source link where supplied, and an indication of modifications as required by CC-BY-4.0 section 3(a).
