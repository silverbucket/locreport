# locreport

Analyze a **GitHub** repository's lines of code **over time**, intelligently split
by the *role* each file plays — actual application code vs. tests vs. config vs.
docs vs. data — with comment lines tracked separately and build/vendored code
excluded.

This is the **Phase 0 engine + CLI**. No web UI or persistence yet (by design);
those come next once the engine is proven.

## How it works

For a repo, at each interval boundary (yearly by default):

1. Find the last commit on/before that date.
2. Extract that commit's tree (`git archive`).
3. Count every source file's **code / comment / blank** lines.
4. Classify each file into a **role** by its path.
5. Aggregate per role into a snapshot.

The result is a per-interval table of LOC by role.

### Roles

| Role         | Counted? | Examples |
| ------------ | -------- | -------- |
| `app`        | ✅ (the *actual* app) | `src/**`, anything not matched below |
| `test`       | ✅ | `test/`, `__tests__/`, `integration/`, `stress-tests/`, `e2e/`, `*.test.ts`, `*_test.go`, `*_spec.rb` |
| `config`     | ✅ | `*.yml`, `*.toml`, `*.config.*`, `.env*`, `package.json` |
| `docs`       | ✅ | `*.md`, `*.rst`, `docs/` |
| `data`       | ✅ | `*.json`, `*.csv`, `*.xml`, fixtures |
| `build`      | ❌ excluded | `Dockerfile`, `Makefile`, `.github/workflows/`, eslint/webpack/tsconfig |
| `vendored`   | ❌ excluded | `node_modules/`, `vendor/`, `dist/`, `*.min.js`, lockfiles, generated |

Rules live in `src/classifier.ts` as an **ordered, first-match-wins** list — easy
to tweak or later expose as user-editable config.

## Usage

```bash
npm install

# yearly (default)
npm run dev -- erikbern/git-of-theseus
npx tsx src/cli.ts XAMPPRocky/tokei --interval 6m
npx tsx src/cli.ts owner/repo --json > report.json
```

Accepts `owner/repo`, `https://github.com/owner/repo[.git]`, or
`git@github.com:owner/repo.git`. **Only github.com is accepted** (this also acts
as an SSRF guard, since the tool clones whatever it's given).

Options: `--interval 1m|3m|6m|1y`, `--branch <name>`, `--by-package`, `--json`.

### Monorepos (`--by-package`)

```bash
npx tsx src/cli.ts vuejs/core --by-package
```

adds a per-package breakdown on top of the repo-wide table:

```
Package                    App   Tests  Config   Docs  Comments   Total
@vue/runtime-core       16,648  26,379      52     20     3,714  43,099
@vue/compiler-core       8,730  12,552      58      1     1,512  21,341
...
(root)                   1,478       0     146  3,649       257   5,318
```

Detection is **workspace-aware**: it reads the workspace declaration
(`pnpm-workspace.yaml`, npm/yarn `workspaces`, `lerna.json`, Cargo
`[workspace] members`, or `go.work`) and treats only declared members as
packages. With no workspace declaration it falls back to treating any directory
containing a package manifest as a package (ignoring vendored dirs). Each file
is assigned to its **nearest ancestor package**, and files above any package go
to `(root)`. Detection runs per commit, so packages appear/grow over time.

The CLI table shows the latest snapshot; the full per-snapshot package history
is in `--json` output for charting.

## Web UI

```bash
pnpm web          # → http://localhost:4317  (set PORT to change)
```

Enter a GitHub repo, pick an interval, optionally tick **Per package**, and hit
Analyze. The page streams live progress over Server-Sent Events while the repo
is cloned and sampled, then renders:

- a **stacked-area chart** of LOC by role over time, and
- a **per-interval table** (plus a **per-package table** when enabled).

It's a dependency-light Node HTTP server (`src/server/server.ts`) that reuses the
same engine as the CLI. Chart.js is self-hosted (no CDN), and the page runs under
a locked-down `default-src 'self'` CSP. Repo-controlled strings (package names)
are HTML-escaped before rendering. No persistence yet — each analysis re-clones.

## Caching & performance

By default the engine caches aggressively, so re-runs are near-instant:

- **Persistent clone** — each repo is bare-cloned once into the cache and
  refreshed with `git fetch` on later runs instead of re-cloning.
- **Per-commit counts** — a commit is immutable, so its counted result is cached
  keyed by `(counter, sha)`. Switching interval reuses every commit already seen
  (e.g. a yearly run warms the cache for a later monthly run).
- **Parallel counting** — cache misses are counted concurrently (~CPU count).

Example (vuejs/core, yearly): cold ~10s, warm ~2s (all commits cached).

Cache lives in `~/.cache/locreport` (override with `LOCREPORT_CACHE_DIR`). Pass
`--no-cache` for a one-off fresh clone with no reuse. Cache entries are versioned
and auto-invalidated when counting/classification semantics change; to wipe it
manually, delete the cache directory.

## Counting backend

Two interchangeable backends behind one interface (`src/counter.ts`):

- **builtin** (default, zero-dependency) — a language-aware line counter covering
  the most common languages. Always available.
- **cloc** — if a [`cloc`](https://github.com/AlDanial/cloc) binary is on your
  `PATH`, it is used automatically: ~250 languages and more precise comment
  detection (it understands string literals; the builtin counter does not).

```bash
brew install cloc   # optional, recommended for accuracy
```

## Development

```bash
npm test           # run the suite (vitest)
npm run test:watch
npm run typecheck
```

Tests are hermetic — the end-to-end test builds a local git repo with backdated
commits, so the suite needs no network and no GitHub access.

## Known limitations (Phase 0)

- Builtin counter misclassifies comment tokens inside string literals; install
  `cloc` to remove this.
- The `build` vs `config` boundary is heuristic and the most debatable; edit
  `DEFAULT_RULES` to taste.
- No caching/persistence yet — every run re-clones. (Phase 1.)
- Follows `--first-parent` history on a single branch.
