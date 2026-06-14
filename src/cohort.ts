import { classify } from "./classifier.js";
import { blameLines, listTreeFiles } from "./git.js";
import { detectLanguage } from "./languages.js";
import { classifyLines } from "./linecount.js";
import { EXCLUDED_ROLES, type Cohort, type Role } from "./types.js";

export type CohortResult = Cohort;

/** Run `fn` over `items` with at most `limit` concurrent executions. */
async function pool<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let i = 0;
  const width = Math.max(1, Math.min(limit, items.length));
  const worker = async () => {
    while (i < items.length) await fn(items[i++]!);
  };
  await Promise.all(Array.from({ length: width }, worker));
}

/**
 * Compute the code-age cohort for `sha`: blame every counted source file and
 * bucket its **code** lines by the year they were authored. Only code lines are
 * counted (comments and blanks are excluded), and vendored/build files and
 * unrecognized languages are skipped — so the cohort total reconciles with the
 * report's "Total" counted-code metric (across app/test/config/docs/data).
 */
export async function computeCohort(gitDir: string, sha: string, concurrency = 8): Promise<CohortResult> {
  const files = await listTreeFiles(gitDir, sha);
  const included = files
    .map((path) => ({ path, role: classify(path), syntax: detectLanguage(path) }))
    .filter((f) => f.syntax !== null && !EXCLUDED_ROLES.has(f.role));

  const byYear: Record<string, number> = {};
  const byRoleYear: Partial<Record<Role, Record<string, number>>> = {};

  await pool(included, concurrency, async ({ path, role, syntax }) => {
    const lines = await blameLines(gitDir, sha, path);
    if (lines.length === 0) return;
    // Classify each physical line; count only the ones that are code.
    const kinds = classifyLines(lines.map((l) => l.content).join("\n"), syntax!);
    const roleBucket = (byRoleYear[role] ??= {});
    for (let i = 0; i < lines.length; i++) {
      if (kinds[i] !== "code") continue;
      const key = String(lines[i]!.year);
      byYear[key] = (byYear[key] ?? 0) + 1;
      roleBucket[key] = (roleBucket[key] ?? 0) + 1;
    }
  });

  return { byYear, byRoleYear };
}
