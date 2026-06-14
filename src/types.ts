/** The role a file plays in a codebase. Drives how its lines are bucketed. */
export type Role =
  | "app" // the actual application/source code
  | "test" // tests, specs, test harnesses, fixtures-as-code
  | "config" // application/support config (counted)
  | "docs" // documentation (markdown, rst, ...)
  | "data" // data/fixture blobs (json/yaml/csv used as data)
  | "build" // build/CI/tooling files (excluded from "real" totals)
  | "vendored"; // vendored or generated code (excluded)

/** Roles that are excluded from the "real codebase" totals by default. */
export const EXCLUDED_ROLES: ReadonlySet<Role> = new Set<Role>(["build", "vendored"]);

/** Per-file line counts as produced by a Counter backend. */
export interface FileCount {
  /** Repo-relative POSIX path. */
  path: string;
  /** Language as detected by the counter (e.g. "TypeScript"). */
  language: string;
  code: number;
  comment: number;
  blank: number;
}

/** A FileCount enriched with the role assigned by the classifier. */
export interface ClassifiedFile extends FileCount {
  role: Role;
}

/** Supported sampling intervals. */
export type Interval = "1m" | "3m" | "6m" | "1y";

/** Aggregated counts for one (role) or (role, language) bucket. */
export interface Bucket {
  code: number;
  comment: number;
  blank: number;
  files: number;
}

/** Analysis result for a single point in time. */
export interface Snapshot {
  /** ISO date (YYYY-MM-DD) of the interval boundary. */
  date: string;
  /** The commit analyzed (the last commit on/before `date`). */
  sha: string;
  /** Counts grouped by role. */
  byRole: Record<Role, Bucket>;
}

/** Full report across all sampled snapshots. */
export interface Report {
  repoUrl: string;
  cloneUrl: string;
  branch: string;
  interval: Interval;
  generatedAt: string;
  snapshots: Snapshot[];
}
