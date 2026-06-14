import { classify } from "./classifier.js";
import { blameFileYears, listTreeFiles } from "./git.js";
import { detectLanguage } from "./languages.js";
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
 * Compute the code-age cohort for `sha`: blame every counted source file in the
 * tree and bucket its lines by the year they were last authored. Vendored/build
 * files and files of unrecognized languages are excluded, matching the rest of
 * the report's "counted code" notion.
 */
export async function computeCohort(gitDir: string, sha: string, concurrency = 8): Promise<CohortResult> {
  const files = await listTreeFiles(gitDir, sha);
  const included = files.filter((f) => !EXCLUDED_ROLES.has(classify(f)) && detectLanguage(f) !== null);

  const byYear: Record<string, number> = {};
  let total = 0;

  await pool(included, concurrency, async (file) => {
    const years = await blameFileYears(gitDir, sha, file);
    for (const [year, count] of years) {
      const key = String(year);
      byYear[key] = (byYear[key] ?? 0) + count;
      total += count;
    }
  });

  return { total, byYear };
}
