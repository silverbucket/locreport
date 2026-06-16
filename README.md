# locreport

Analyze a **GitHub** repository's lines of code **over time**, intelligently split
by the *role* each file plays — actual application code vs. tests vs. config vs.
docs vs. data — with comment lines tracked separately and build/vendored code
excluded. Use it from the **command line**, as a **self-hosted web app**, or as a
**Docker image**.

A single lines-of-code total can't tell whether a project is growing because the
application code is growing, or because tests, docs and config are accumulating
around it. locreport counts each role separately, across the repository's whole
history, so those trends move independently.

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
to tweak.

## Usage

```bash
pnpm install

# yearly (default)
pnpm analyze erikbern/git-of-theseus
pnpm analyze XAMPPRocky/tokei --interval 6m
pnpm analyze owner/repo --json > report.json
```

Accepts `owner/repo`, `https://github.com/owner/repo[.git]`, or
`git@github.com:owner/repo.git`. **Only github.com is accepted** (this also acts
as an SSRF guard, since the tool clones whatever it's given).

Options: `--interval 1m|3m|6m|1y`, `--branch <name>`, `--by-package`, `--cohort`,
`--no-cache`, `--json`.

### Code age (`--cohort`)

```bash
pnpm analyze sindresorhus/slugify --cohort
```

Groups each snapshot's surviving **code lines by the year they were authored**
(theseus-style), via `git blame`. Only code lines are counted (comments/blanks
excluded). The cohort is bucketed **per role**, so the web UI's **Code age** tab
has a role selector (default **App code**, plus Tests/Config/Docs/Data and "All
counted"); each scope reconciles exactly with the matching role's code count
(App-scoped cohort == the App column; "All counted" == the Total column). The
CLI prints the latest snapshot's overall age breakdown. It's the heaviest
analysis (a blame pass per commit), so it's opt-in and cached per commit.

### Monorepos (`--by-package`)

```bash
pnpm analyze vuejs/core --by-package
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

Enter a GitHub repo, pick an interval, and hit **Analyze**. The page streams live
progress over Server-Sent Events while the repo is cloned and sampled, then shows
a chart and table with three switchable views:

- **By role** — stacked-area chart of LOC by role over time, with a per-interval table.
- **By package** — the same over time for a chosen metric, with a per-package table (monorepo-aware).
- **Code age** — surviving lines bucketed by the year they were authored (runs `git blame`, same as the CLI's `--cohort`).

Toggle **Stacked** (area/composition) vs unstacked **lines** (growth rates), click
a legend entry to **isolate** a series, **export** the table as CSV or the full
report as JSON, and **share the URL** — repo, interval, view, metric and stacked
state are encoded in the query string and re-run automatically on load.

It's a dependency-light Node HTTP server (`src/server/server.ts`) that reuses the
same engine as the CLI. Chart.js is self-hosted (no CDN), and the page runs under
a locked-down `default-src 'self'` CSP. Repo-controlled strings (package names)
are HTML-escaped before rendering.

## Deploy (self-host with Docker)

Run the published multi-arch image from GHCR:

```bash
docker run -p 4317:4317 -v locreport-cache:/cache ghcr.io/silverbucket/locreport
```

`:latest` tracks the most recent release; pin a version tag (e.g. `:1.1.0`) for
reproducible deploys, or use `:edge` to track `master`. To build locally instead:

```bash
pnpm docker:up      # build + run on http://localhost:4317 (docker compose)
# or:
docker build -t locreport .
docker run -p 4317:4317 -v locreport-cache:/cache locreport
```

The image is a hardened multi-stage build: it runs as a non-root user, bundles
`git` and `cloc` (so the accurate counter is used automatically), installs only
production dependencies, persists the cache in a `/cache` volume, and ships a
healthcheck.

Because the web endpoint clones user-supplied repos, it ships with safety
limits, all env-overridable (see `docker-compose.yml`):

| Env var | Default | Purpose |
| --- | --- | --- |
| `LOCREPORT_MAX_CONCURRENT` | 2 | simultaneous analyses |
| `LOCREPORT_MAX_QUEUE` | 10 | waiters before "server busy" |
| `LOCREPORT_RATE_MAX` / `LOCREPORT_RATE_WINDOW_MS` | 30 / 60000 | per-IP rate limit |
| `LOCREPORT_MAX_REPO_MB` | 2048 | reject bare repos larger than this |
| `LOCREPORT_MAX_CACHE_MB` | 5120 | total cached-clone budget, LRU-evicted (0 disables) |
| `LOCREPORT_GIT_TIMEOUT_MS` | 300000 | per git operation |
| `LOCREPORT_ANALYSIS_TIMEOUT_MS` | 600000 | per analysis |

These complement the built-in **github.com-only** guard (an SSRF safeguard,
since the server clones whatever URL it's given). Put a TLS-terminating reverse
proxy in front for public exposure; `X-Forwarded-For` is honored for rate
limiting.

### Custom head includes

To inject deployment-specific HTML into the page `<head>` (analytics tags, custom
meta, verification tokens, …) without committing it to source control, drop a
file at `public/includes.html`. It's gitignored, baked into the image at build
time when present, and spliced into every page load. See
[`public/includes.example.html`](public/includes.example.html) for the format.

| Env var | Default | Purpose |
| --- | --- | --- |
| `LOCREPORT_INCLUDES_FILE` | `public/includes.html` | path to the head-includes file |
| `LOCREPORT_CSP` | locked to `'self'` | override the document Content-Security-Policy |

The default CSP is same-origin only, so an include that loads external or inline
resources needs a matching `LOCREPORT_CSP` to be allowed.

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

Cached bare clones are kept under a total size budget (`LOCREPORT_MAX_CACHE_MB`,
default 5 GiB) and evicted **least-recently-used** when exceeded, so a public
instance can't be made to fill its disk by requesting many distinct repos. Set
it to `0` to disable eviction (unbounded growth).

Eviction runs after each clone and never removes one that may be mid-analysis
(it skips anything used within a grace window that always covers the analysis
timeout). So it's a **soft cap**: under a burst of many distinct repos the cache
can briefly exceed the budget before trimming — size it with headroom relative
to the volume.

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
pnpm test          # run the suite (vitest)
pnpm test:watch
pnpm typecheck
```

Tests are hermetic — the end-to-end test builds a local git repo with backdated
commits, so the suite needs no network and no GitHub access.

## Notes & limitations

- The builtin counter can misclassify comment tokens inside string literals;
  install `cloc` for string-literal-aware counting.
- The `build` vs `config` boundary is heuristic and the most debatable; edit
  `DEFAULT_RULES` in `src/classifier.ts` to taste.
- History follows `--first-parent` on a single branch.

## License

[MIT](LICENSE)
