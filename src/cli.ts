#!/usr/bin/env node
import { analyzeRepo } from "./analyze.js";
import { isInterval, INTERVALS } from "./intervals.js";
import { formatPackages, formatReport } from "./report.js";
import type { Interval } from "./types.js";

interface Args {
  url?: string;
  interval: Interval;
  branch?: string;
  json: boolean;
  byPackage: boolean;
  cache: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { interval: "1y", json: false, byPackage: false, cache: true };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--interval" || a === "-i") {
      const v = argv[++i];
      if (!v || !isInterval(v)) throw new Error(`--interval must be one of: ${INTERVALS.join(", ")}`);
      args.interval = v;
    } else if (a === "--branch" || a === "-b") {
      args.branch = argv[++i];
    } else if (a === "--json") {
      args.json = true;
    } else if (a === "--by-package" || a === "-p") {
      args.byPackage = true;
    } else if (a === "--no-cache") {
      args.cache = false;
    } else if (a === "--help" || a === "-h") {
      args.url = undefined;
      return args;
    } else if (!a.startsWith("-")) {
      args.url = a;
    } else {
      throw new Error(`Unknown option: ${a}`);
    }
  }
  return args;
}

const HELP = `locreport — LOC over time for a GitHub repo, split by role.

Usage:
  locreport <github-repo> [--interval 1m|3m|6m|1y] [--branch <name>] [--by-package] [--json]

Examples:
  locreport erikbern/git-of-theseus
  locreport https://github.com/XAMPPRocky/tokei --interval 6m
  locreport some/monorepo --by-package
  locreport owner/repo --json > report.json

Options:
  -i, --interval    sampling interval (default 1y)
  -b, --branch      branch to analyze (default: repo default)
  -p, --by-package  also break down per package (monorepo workspaces)
      --no-cache    skip the on-disk cache (fresh clone, no reuse)
      --json        emit full JSON (includes per-snapshot package history)

Roles: app, test, config, docs, data (counted) and build, vendored (excluded).
Cache lives in ~/.cache/locreport (override with LOCREPORT_CACHE_DIR).
`;

async function main(): Promise<void> {
  let args: Args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`Error: ${(err as Error).message}\n`);
    process.stderr.write(HELP);
    process.exit(2);
  }

  if (!args.url) {
    process.stdout.write(HELP);
    process.exit(0);
  }

  const report = await analyzeRepo(args.url, {
    interval: args.interval,
    branch: args.branch,
    byPackage: args.byPackage,
    cache: args.cache,
    onProgress: (e) => {
      if (args.json) return; // keep stdout clean for JSON
      if (e.type === "cloning") process.stderr.write(`Cloning ${e.repo}...\n`);
      else if (e.type === "updating") process.stderr.write(`Updating cached clone of ${e.repo}...\n`);
      else if (e.type === "resolved") {
        const cached = e.cached > 0 ? ` (${e.cached} cached)` : "";
        process.stderr.write(`Branch ${e.branch}, counter "${e.counter}", ${e.snapshots} snapshots${cached}.\n`);
      } else if (e.type === "snapshot")
        process.stderr.write(`  [${e.index}/${e.total}] ${e.date} ${e.sha.slice(0, 8)}${e.cached ? " (cached)" : ""}\n`);
    },
  });

  if (args.json) {
    process.stdout.write(JSON.stringify(report, null, 2) + "\n");
    return;
  }

  process.stdout.write("\n" + formatReport(report) + "\n");
  if (args.byPackage) {
    const pkgs = formatPackages(report);
    process.stdout.write(pkgs ? "\n" + pkgs + "\n" : "\n(No packages detected — single-package repo.)\n");
  }
}

main().catch((err) => {
  console.error(`\nError: ${(err as Error).message}`);
  process.exit(1);
});
