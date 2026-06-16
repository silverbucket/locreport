# locreport

Count a **GitHub** repository's lines of code **over time**, split by what each
file is for — app code, tests, config, docs, or data. Comments are counted
separately, and build and vendored files are left out.

A single line count can't tell you whether a project is growing because the app
is growing or because tests and docs are piling up. locreport tracks each kind on
its own, across the project's whole history, so you can see what's really
changing.

Use it from the **command line**, as a **web app**, or as a **Docker image**.

## How it works

For each point in time (yearly by default), locreport:

1. Finds the last commit on or before that date.
2. Reads that commit's files.
3. Counts each file's code, comment, and blank lines.
4. Sorts each file into a role by its path.
5. Adds up the totals per role.

The result is a table of lines of code by role, over time.

### Roles

| Role | Counted? | Examples |
| --- | --- | --- |
| `app` | ✅ (the actual app) | `src/**`, anything not matched below |
| `test` | ✅ | `test/`, `__tests__/`, `e2e/`, `*.test.ts`, `*_test.go`, `*_spec.rb` |
| `config` | ✅ | `*.yml`, `*.toml`, `*.config.*`, `.env*`, `package.json` |
| `docs` | ✅ | `*.md`, `*.rst`, `docs/` |
| `data` | ✅ | `*.json`, `*.csv`, `*.xml`, fixtures |
| `build` | ❌ excluded | `Dockerfile`, `Makefile`, `.github/workflows/` |
| `vendored` | ❌ excluded | `node_modules/`, `vendor/`, `dist/`, `*.min.js`, lockfiles |

The rules live in `src/classifier.ts` and are easy to adjust.

## Usage

```bash
pnpm install

# yearly (the default)
pnpm analyze erikbern/git-of-theseus
pnpm analyze XAMPPRocky/tokei --interval 6m
pnpm analyze owner/repo --json > report.json
```

You can pass `owner/repo`, a full `https://github.com/owner/repo` URL, or an SSH
URL. Only `github.com` repos are accepted.

Options: `--interval 1m|3m|6m|1y`, `--branch <name>`, `--by-package`, `--cohort`,
`--no-cache`, `--json`.

### Code age (`--cohort`)

```bash
pnpm analyze sindresorhus/slugify --cohort
```

Groups the surviving code lines by the year they were written (using `git
blame`). This is the slowest option, so it's off by default. In the web app, the
**Code age** tab lets you pick a role to focus on, and each role's totals match
that role's code count in the main table.

### Monorepos (`--by-package`)

```bash
pnpm analyze vuejs/core --by-package
```

Adds a per-package breakdown on top of the repo-wide table:

```
Package                    App   Tests  Config   Docs  Comments   Total
@vue/runtime-core       16,648  26,379      52     20     3,714  43,099
@vue/compiler-core       8,730  12,552      58      1     1,512  21,341
...
(root)                   1,478       0     146  3,649       257   5,318
```

locreport finds packages from the workspace setup (`pnpm-workspace.yaml`, npm or
yarn `workspaces`, `lerna.json`, Cargo, or `go.work`). If there's no workspace
config, it treats any folder with a package manifest as a package. Each file
counts toward its nearest package.

## Web app

```bash
pnpm web          # http://localhost:4317  (set PORT to change)
```

Enter a GitHub repo, pick an interval, and click **Analyze**. The page shows a
chart and table with three views:

- **By role** — lines of code by role over time.
- **By package** — the same, per package (for monorepos).
- **Code age** — surviving lines by the year they were written.

You can switch between stacked and line charts, click a legend entry to focus on
one series, export the table as CSV or the report as JSON, and share the URL to
re-open the same view.

To run it for others, see the [server guide](docs/operating.md).

## Caching

locreport caches the cloned repo and each commit's counts in
`~/.cache/locreport`, so running the same repo again is fast. Use `--no-cache`
to skip the cache for one run. For tuning the cache on a server, see the
[server guide](docs/operating.md#cache-settings).

## Counting backend

locreport has two counters:

- **builtin** (default) — works out of the box and covers common languages.
- **cloc** — if [`cloc`](https://github.com/AlDanial/cloc) is on your `PATH`, it's
  used automatically. It supports more languages and is more accurate.

```bash
brew install cloc   # optional, more accurate
```

## Development

```bash
pnpm test          # run the tests
pnpm test:watch
pnpm typecheck
```

The tests build a small local git repo, so they need no network or GitHub access.

To build and run the web app in Docker locally:

```bash
pnpm docker:up        # build + run with docker compose
# or
docker build -t locreport .
```

## Limitations

- The builtin counter can miscount comment-like text inside strings. Install
  `cloc` to avoid this.
- The line between `build` and `config` files is a judgment call; edit the rules
  in `src/classifier.ts` to taste.
- History follows the first parent of a single branch.

## License

[MIT](LICENSE)
