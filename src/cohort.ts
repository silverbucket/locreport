import { classify } from "./classifier.js";
import { blameLines, listTreeFiles } from "./git.js";
import { detectLanguage } from "./languages.js";
import { classifyLines } from "./linecount.js";
import { EXCLUDED_ROLES, type Cohort, type Role } from "./types.js";

export type CohortResult = Cohort;

/** Runs a task under a shared concurrency budget. */
export type Limiter = <T>(fn: () => Promise<T>) => Promise<T>;

/**
 * A reusable concurrency limiter (p-limit style). Sharing one limiter across
 * commits keeps total `git blame` concurrency bounded — otherwise the per-file
 * parallelism here, nested under a per-commit pool, would over-subscribe the CPU
 * (and balloon memory, since each blame buffers up to 256 MB).
 */
export function createLimiter(concurrency: number): Limiter {
  const max = Math.max(1, concurrency);
  let active = 0;
  const queue: Array<() => void> = [];
  const release = () => {
    active--;
    queue.shift()?.();
  };
  return <T>(fn: () => Promise<T>): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      const run = () => {
        active++;
        fn().then(resolve, reject).finally(release);
      };
      if (active < max) run();
      else queue.push(run);
    });
}

/**
 * Compute the code-age cohort for `sha`: blame every counted source file and
 * bucket its **code** lines by the year they were authored. Only code lines are
 * counted (comments and blanks are excluded), and vendored/build files and
 * unrecognized languages are skipped — so the cohort total reconciles with the
 * report's "Total" counted-code metric (across app/test/config/docs/data).
 *
 * `limit` bounds concurrent blames; pass a shared limiter to bound the total
 * across several commits computed in parallel.
 */
export async function computeCohort(gitDir: string, sha: string, limit: Limiter = createLimiter(8)): Promise<CohortResult> {
  const files = await listTreeFiles(gitDir, sha);
  const included = files
    .map((path) => ({ path, role: classify(path), syntax: detectLanguage(path) }))
    .filter((f) => f.syntax !== null && !EXCLUDED_ROLES.has(f.role));

  const byYear: Record<string, number> = {};
  const byRoleYear: Partial<Record<Role, Record<string, number>>> = {};

  await Promise.all(
    included.map(({ path, role, syntax }) =>
      limit(async () => {
        const lines = await blameLines(gitDir, sha, path);
        if (lines.length === 0) return;
        // Classify each physical line; count only the ones that are code. The
        // aggregation below is synchronous, so concurrent tasks can't interleave it.
        const kinds = classifyLines(lines.map((l) => l.content).join("\n"), syntax!);
        const roleBucket = (byRoleYear[role] ??= {});
        for (let i = 0; i < lines.length; i++) {
          if (kinds[i] !== "code") continue;
          const key = String(lines[i]!.year);
          byYear[key] = (byYear[key] ?? 0) + 1;
          roleBucket[key] = (roleBucket[key] ?? 0) + 1;
        }
      }),
    ),
  );

  return { byYear, byRoleYear };
}
