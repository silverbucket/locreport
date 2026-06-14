import { classify } from "./classifier.js";
import { blameLines, listTreeFiles } from "./git.js";
import { detectLanguage } from "./languages.js";
import { classifyLines } from "./linecount.js";
import { EXCLUDED_ROLES } from "./types.js";

/** Code-age breakdown for one commit: surviving lines grouped by author-year. */
export interface CohortResult {
  total: number;
  /** Year (as string) -> surviving line count. */
  byYear: Record<string, number>;
}

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
    .map((path) => ({ path, syntax: detectLanguage(path) }))
    .filter((f) => f.syntax !== null && !EXCLUDED_ROLES.has(classify(f.path)));

  const byYear: Record<string, number> = {};
  let total = 0;

  await pool(included, concurrency, async ({ path, syntax }) => {
    const lines = await blameLines(gitDir, sha, path);
    if (lines.length === 0) return;
    // Classify each physical line; count only the ones that are code.
    const kinds = classifyLines(lines.map((l) => l.content).join("\n"), syntax!);
    for (let i = 0; i < lines.length; i++) {
      if (kinds[i] !== "code") continue;
      const key = String(lines[i]!.year);
      byYear[key] = (byYear[key] ?? 0) + 1;
      total += 1;
    }
  });

  return { total, byYear };
}
