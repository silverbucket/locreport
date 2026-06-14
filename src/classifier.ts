import type { Role } from "./types.js";

/**
 * Role classification.
 *
 * Each file is assigned exactly one role based on its repo-relative path. Rules
 * are evaluated in order and the FIRST match wins, so order encodes precedence.
 * The ruleset is data, not code, so it can later be surfaced as user-editable
 * configuration.
 *
 * Precedence rationale (most specific / most "exclude-worthy" first):
 *   1. vendored / generated  -> excluded (never the author's code)
 *   2. build / CI / tooling   -> excluded ("exclude all build files")
 *   3. tests / harnesses      -> counted, own bucket
 *   4. docs                   -> counted, own bucket
 *   5. data / fixtures        -> counted, own bucket
 *   6. config                 -> counted ("supporting config files")
 *   7. app                    -> default fallback (the *actual* app)
 */

export interface Rule {
  role: Role;
  /** Human-readable reason, useful for debugging/explainability. */
  label: string;
  test: (path: string) => boolean;
}

const seg = (p: string) => p.split("/");
const base = (p: string) => seg(p).pop() ?? p;
const lower = (p: string) => p.toLowerCase();

/** True if any path segment (a directory or the filename) exactly equals one of `names`. */
function hasSegment(path: string, names: string[]): boolean {
  const set = new Set(names);
  return seg(lower(path)).some((s) => set.has(s));
}

function baseMatches(path: string, re: RegExp): boolean {
  return re.test(base(lower(path)));
}

function extIn(path: string, exts: string[]): boolean {
  const b = base(lower(path));
  return exts.some((e) => b.endsWith(e));
}

// ---------------------------------------------------------------------------
// The default ruleset. Order matters.
// ---------------------------------------------------------------------------

export const DEFAULT_RULES: Rule[] = [
  // 1. Vendored / generated -----------------------------------------------
  {
    role: "vendored",
    label: "vendored dependency directory",
    test: (p) =>
      hasSegment(p, [
        "node_modules",
        "vendor",
        "third_party",
        "thirdparty",
        "bower_components",
        "jspm_packages",
        ".yarn",
      ]),
  },
  {
    role: "vendored",
    label: "build output / distribution directory",
    test: (p) => hasSegment(p, ["dist", "build", "out", "target", ".next", "bin", "obj"]),
  },
  {
    role: "vendored",
    label: "minified / generated artifact",
    test: (p) => baseMatches(p, /\.(min|bundle)\.(js|css)$/) || baseMatches(p, /\.(pb|generated)\.[a-z]+$/),
  },
  {
    role: "vendored",
    label: "dependency lockfile",
    test: (p) =>
      [
        "package-lock.json",
        "yarn.lock",
        "pnpm-lock.yaml",
        "npm-shrinkwrap.json",
        "composer.lock",
        "gemfile.lock",
        "poetry.lock",
        "cargo.lock",
        "go.sum",
        "pipfile.lock",
      ].includes(base(lower(p))),
  },

  // 2. Build / CI / tooling -----------------------------------------------
  {
    role: "build",
    label: "CI / workflow directory",
    test: (p) =>
      hasSegment(p, [".github", ".gitlab", ".circleci", ".buildkite", ".husky"]) ||
      lower(p).includes(".github/workflows/"),
  },
  {
    role: "build",
    label: "build tool / task runner file",
    test: (p) =>
      [
        "makefile",
        "dockerfile",
        "containerfile",
        "rakefile",
        "gulpfile.js",
        "gruntfile.js",
        "procfile",
        "justfile",
        "vagrantfile",
        ".dockerignore",
        ".gitignore",
        ".gitattributes",
        ".editorconfig",
      ].includes(base(lower(p))) ||
      baseMatches(p, /^dockerfile(\.|$)/) ||
      extIn(p, [".bazel", ".bzl", ".gradle", ".cmake"]) ||
      base(lower(p)) === "cmakelists.txt",
  },
  {
    role: "build",
    label: "linter / formatter / bundler / tooling config",
    test: (p) => {
      const b = base(lower(p));
      return (
        /^\.?(eslint|prettier|stylelint|babel|browserslist|nvmrc|npmrc|editorconfig)/.test(b) ||
        /\.(eslintrc|prettierrc|babelrc|stylelintrc)(\.|$)/.test(b) ||
        /^(webpack|rollup|vite|esbuild|tsup|turbo|jest|vitest|playwright|karma|tox|nox)\./.test(b) ||
        /^tsconfig.*\.json$/.test(b)
      );
    },
  },

  // 3. Tests / harnesses ---------------------------------------------------
  {
    role: "test",
    label: "test / spec directory",
    test: (p) =>
      hasSegment(p, [
        "test",
        "tests",
        "spec",
        "specs",
        "__tests__",
        "__mocks__",
        "e2e",
        "testdata",
        "fixtures",
        "integration",
        "integration-tests",
        "stress-test",
        "stress-tests",
      ]),
  },
  {
    role: "test",
    label: "test / spec filename",
    test: (p) =>
      baseMatches(p, /(^|[._-])(test|tests|spec|specs)\./) ||
      baseMatches(p, /(_|\.)(test|spec)s?\.[a-z]+$/) ||
      base(lower(p)) === "conftest.py",
  },

  // 4. Docs ----------------------------------------------------------------
  {
    role: "docs",
    label: "documentation directory or file",
    test: (p) => hasSegment(p, ["docs", "doc"]) || extIn(p, [".md", ".markdown", ".rst", ".adoc", ".txt"]),
  },

  // 5a. Well-known manifests are config, not generic data, even though they
  //     are JSON/TOML. Checked before the broad data rule below.
  {
    role: "config",
    label: "package manifest",
    test: (p) =>
      ["package.json", "composer.json", "bower.json", "manifest.json", "deno.json", "deno.jsonc"].includes(
        base(lower(p)),
      ),
  },

  // 5b. Data / fixtures (data blobs, not code) ----------------------------
  {
    role: "data",
    label: "structured data / fixture file",
    test: (p) => extIn(p, [".json", ".json5", ".jsonc", ".csv", ".tsv", ".xml", ".geojson", ".ndjson", ".parquet"]),
  },

  // 6. Config (application/support config that IS counted) -----------------
  {
    role: "config",
    label: "configuration file",
    test: (p) => {
      const b = base(lower(p));
      return (
        extIn(p, [".yml", ".yaml", ".toml", ".ini", ".cfg", ".conf", ".properties", ".env"]) ||
        /\.config\.[a-z]+$/.test(b) ||
        /^\.env(\.|$)/.test(b) ||
        ["package.json", "pyproject.toml", "setup.cfg", "manifest.json"].includes(b)
      );
    },
  },
];

/**
 * Classify a single repo-relative path into a role using `rules`
 * (defaults to DEFAULT_RULES). Unmatched files are "app" code.
 */
export function classify(path: string, rules: Rule[] = DEFAULT_RULES): Role {
  const normalized = path.replace(/\\/g, "/").replace(/^\.?\//, "");
  for (const rule of rules) {
    if (rule.test(normalized)) return rule.role;
  }
  return "app";
}

/** Like classify(), but also returns which rule matched (for explainability). */
export function classifyExplain(path: string, rules: Rule[] = DEFAULT_RULES): { role: Role; label: string } {
  const normalized = path.replace(/\\/g, "/").replace(/^\.?\//, "");
  for (const rule of rules) {
    if (rule.test(normalized)) return { role: rule.role, label: rule.label };
  }
  return { role: "app", label: "default (application code)" };
}
