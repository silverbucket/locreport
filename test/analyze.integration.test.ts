import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { analyzeBareRepo } from "../src/analyze.js";
import { BuiltinCounter } from "../src/counter.js";
import { summarizeSnapshot } from "../src/report.js";

/**
 * End-to-end test of the engine (git sampling + counting + classification +
 * aggregation) against a locally-built repo with backdated commits. No network.
 */

let workRoot: string;
let gitDir: string;

function git(args: string[], cwd: string, dateISO?: string): void {
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: "Test",
    GIT_AUTHOR_EMAIL: "test@example.com",
    GIT_COMMITTER_NAME: "Test",
    GIT_COMMITTER_EMAIL: "test@example.com",
    ...(dateISO ? { GIT_AUTHOR_DATE: dateISO, GIT_COMMITTER_DATE: dateISO } : {}),
  };
  execFileSync("git", args, { cwd, env, stdio: "pipe" });
}

async function write(repo: string, rel: string, content: string): Promise<void> {
  const full = path.join(repo, rel);
  await mkdir(path.dirname(full), { recursive: true });
  await writeFile(full, content);
}

beforeAll(async () => {
  workRoot = await mkdtemp(path.join(tmpdir(), "locreport-it-"));
  const src = path.join(workRoot, "src-repo");
  await mkdir(src, { recursive: true });
  git(["init", "-b", "main"], src);

  // --- Commit 1: 2021 — app + docs + a build file ---
  await write(src, "src/app.ts", "// main entry\nexport const x = 1;\nexport function run() {\n  return x;\n}\n");
  await write(src, "README.md", "# Project\n\nHello.\n");
  await write(src, "Dockerfile", "FROM node:20\n# build image\nRUN echo hi\n");
  git(["add", "-A"], src);
  git(["commit", "-m", "initial"], src, "2021-01-02T12:00:00");

  // --- Commit 2: 2022 — add tests + more app code ---
  await write(src, "src/util.ts", "export const add = (a: number, b: number) => a + b;\n");
  await write(src, "test/app.test.ts", "// tests\nimport { run } from '../src/app';\ntest('runs', () => run());\n");
  git(["add", "-A"], src);
  git(["commit", "-m", "tests"], src, "2022-01-02T12:00:00");

  // --- Commit 3: 2023 — add config + a vendored dependency ---
  await write(src, "config/settings.yml", "# config\nport: 3000\nhost: localhost\n");
  await write(src, "node_modules/dep/index.js", "module.exports = 1; // vendored\n");
  git(["add", "-Af"], src); // -f to force-add the gitignore-less node_modules
  git(["commit", "-m", "config"], src, "2023-01-02T12:00:00");

  // Bare-clone locally (exercises the same code path as a real clone).
  gitDir = path.join(workRoot, "repo.git");
  git(["clone", "--bare", "--quiet", src, gitDir], workRoot);
});

afterAll(async () => {
  await rm(workRoot, { recursive: true, force: true });
});

describe("analyzeBareRepo (end-to-end, builtin counter)", () => {
  it("produces a yearly snapshot per commit with correct role splits", async () => {
    const report = await analyzeBareRepo(
      gitDir,
      workRoot,
      { repoUrl: "https://github.com/test/repo", cloneUrl: "https://github.com/test/repo.git" },
      { interval: "1y", counter: new BuiltinCounter() },
    );

    expect(report.branch).toBe("main");
    expect(report.snapshots.length).toBe(3);

    const [s2021, s2022, s2023] = report.snapshots.map(summarizeSnapshot);

    // App code grows over time.
    expect(s2021!.app).toBeGreaterThan(0);
    expect(s2022!.app).toBeGreaterThan(s2021!.app);

    // Tests appear only from 2022.
    expect(s2021!.test).toBe(0);
    expect(s2022!.test).toBeGreaterThan(0);

    // Config appears only from 2023.
    expect(s2022!.config).toBe(0);
    expect(s2023!.config).toBeGreaterThan(0);

    // Build (Dockerfile) and vendored (node_modules) are excluded from Total.
    expect(s2023!.excluded).toBeGreaterThan(0);

    // The vendored file must NOT inflate app code.
    const vendored = report.snapshots[2]!.byRole.vendored;
    expect(vendored.files).toBe(1);
  });

  it("samples fewer snapshots at a coarser-than-history interval", async () => {
    const report = await analyzeBareRepo(
      gitDir,
      workRoot,
      { repoUrl: "https://github.com/test/repo", cloneUrl: "https://github.com/test/repo.git" },
      { interval: "1m", counter: new BuiltinCounter() },
    );
    // Monthly sampling over ~2 years yields more snapshots than yearly.
    expect(report.snapshots.length).toBeGreaterThan(3);
    // Last snapshot is the newest commit state (has config).
    const last = summarizeSnapshot(report.snapshots[report.snapshots.length - 1]!);
    expect(last.config).toBeGreaterThan(0);
  });
});
