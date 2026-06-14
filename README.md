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
| `test`       | ✅ | `test/`, `__tests__/`, `*.test.ts`, `*_test.go`, `*_spec.rb` |
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

Options: `--interval 1m|3m|6m|1y`, `--branch <name>`, `--json`.

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
