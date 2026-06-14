#!/usr/bin/env node
import { analyzeRepo } from "./analyze.js";
import { isInterval, INTERVALS } from "./intervals.js";
import { formatReport } from "./report.js";
import type { Interval } from "./types.js";

interface Args {
  url?: string;
  interval: Interval;
  branch?: string;
  json: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { interval: "1y", json: false };
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
  locreport <github-repo> [--interval 1m|3m|6m|1y] [--branch <name>] [--json]

Examples:
  locreport erikbern/git-of-theseus
  locreport https://github.com/XAMPPRocky/tokei --interval 6m
  locreport owner/repo --json > report.json

Roles: app, test, config, docs, data (counted) and build, vendored (excluded).
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
    onProgress: (e) => {
      if (args.json) return; // keep stdout clean for JSON
      if (e.type === "cloning") process.stderr.write(`Cloning ${e.repo}...\n`);
      else if (e.type === "resolved")
        process.stderr.write(`Branch ${e.branch}, counter "${e.counter}", ${e.snapshots} snapshots.\n`);
      else if (e.type === "snapshot")
        process.stderr.write(`  [${e.index}/${e.total}] ${e.date} ${e.sha.slice(0, 8)}\n`);
    },
  });

  if (args.json) process.stdout.write(JSON.stringify(report, null, 2) + "\n");
  else process.stdout.write("\n" + formatReport(report) + "\n");
}

main().catch((err) => {
  console.error(`\nError: ${(err as Error).message}`);
  process.exit(1);
});
