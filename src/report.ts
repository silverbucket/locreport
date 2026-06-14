import { EXCLUDED_ROLES, type Bucket, type Report, type Role, type Snapshot } from "./types.js";

export interface RoleSummary {
  app: number;
  test: number;
  config: number;
  docs: number;
  data: number;
  /** Comment lines across all counted (non-excluded) roles. */
  comments: number;
  /** Code lines across all counted roles (the "real codebase" total). */
  countedCode: number;
  /** Code lines in excluded roles (build + vendored), for reference. */
  excluded: number;
}

export interface SnapshotSummary extends RoleSummary {
  date: string;
  sha: string;
}

/** Summarize a role->bucket map into the report's headline numbers. */
export function summarizeRoles(byRole: Record<Role, Bucket>): RoleSummary {
  let comments = 0;
  let countedCode = 0;
  let excluded = 0;
  for (const [role, b] of Object.entries(byRole)) {
    if (EXCLUDED_ROLES.has(role as never)) {
      excluded += b.code;
    } else {
      countedCode += b.code;
      comments += b.comment;
    }
  }
  return {
    app: byRole.app.code,
    test: byRole.test.code,
    config: byRole.config.code,
    docs: byRole.docs.code,
    data: byRole.data.code,
    comments,
    countedCode,
    excluded,
  };
}

export function summarizeSnapshot(s: Snapshot): SnapshotSummary {
  return { date: s.date, sha: s.sha.slice(0, 8), ...summarizeRoles(s.byRole) };
}

function pad(value: string, width: number, left = true): string {
  return left ? value.padStart(width) : value.padEnd(width);
}

const COLUMNS: Array<{ key: keyof SnapshotSummary; header: string }> = [
  { key: "date", header: "Date" },
  { key: "app", header: "App" },
  { key: "test", header: "Tests" },
  { key: "config", header: "Config" },
  { key: "docs", header: "Docs" },
  { key: "data", header: "Data" },
  { key: "comments", header: "Comments" },
  { key: "countedCode", header: "Total" },
  { key: "excluded", header: "Excl.*" },
];

/** Render a Report as an aligned, human-readable text table. */
export function formatReport(report: Report): string {
  const rows = report.snapshots.map(summarizeSnapshot);
  const fmt = (key: keyof SnapshotSummary, v: string | number) =>
    key === "date" || key === "sha" ? String(v) : Number(v).toLocaleString("en-US");

  const widths = COLUMNS.map((c) =>
    Math.max(c.header.length, ...rows.map((r) => fmt(c.key, r[c.key]).length)),
  );

  const headerLine = COLUMNS.map((c, i) => pad(c.header, widths[i]!, c.key !== "date")).join("  ");
  const sep = widths.map((w) => "-".repeat(w)).join("  ");
  const body = rows
    .map((r) => COLUMNS.map((c, i) => pad(fmt(c.key, r[c.key]), widths[i]!, c.key !== "date")).join("  "))
    .join("\n");

  return [
    `Repo:     ${report.repoUrl}`,
    `Branch:   ${report.branch}    Interval: ${report.interval}    Snapshots: ${report.snapshots.length}`,
    "",
    headerLine,
    sep,
    body,
    "",
    "* Excl. = build + vendored/generated code (excluded from Total).",
    "  Counts are lines of CODE; Comments is comment lines across counted roles.",
  ].join("\n");
}

/**
 * Render the per-package breakdown for the latest snapshot as a table. Returns
 * an empty string if the report has no package data. (Per-snapshot package
 * history is available in the JSON output for charting.)
 */
export function formatPackages(report: Report): string {
  const last = report.snapshots[report.snapshots.length - 1];
  if (!last?.byPackage || last.byPackage.length === 0) return "";

  const rows = last.byPackage.map((p) => ({ pkg: p.name || "(root)", ...summarizeRoles(p.byRole) }));

  const cols: Array<{ key: keyof (typeof rows)[number]; header: string; left?: boolean }> = [
    { key: "pkg", header: "Package", left: true },
    { key: "app", header: "App" },
    { key: "test", header: "Tests" },
    { key: "config", header: "Config" },
    { key: "docs", header: "Docs" },
    { key: "data", header: "Data" },
    { key: "comments", header: "Comments" },
    { key: "countedCode", header: "Total" },
    { key: "excluded", header: "Excl.*" },
  ];

  const fmt = (key: string, v: string | number) => (key === "pkg" ? String(v) : Number(v).toLocaleString("en-US"));
  const widths = cols.map((c) => Math.max(c.header.length, ...rows.map((r) => fmt(c.key, r[c.key]).length)));
  const line = (vals: Array<string | number>) =>
    cols.map((c, i) => pad(fmt(c.key, vals[i]!), widths[i]!, !c.left)).join("  ");

  const header = cols.map((c, i) => pad(c.header, widths[i]!, !c.left)).join("  ");
  const sep = widths.map((w) => "-".repeat(w)).join("  ");
  const body = rows.map((r) => line(cols.map((c) => r[c.key]))).join("\n");

  return [`Per-package breakdown (latest snapshot: ${last.date}):`, "", header, sep, body].join("\n");
}

/**
 * Render the code-age cohort for the latest snapshot: surviving lines grouped by
 * the year they were authored. Empty string if no cohort data.
 */
export function formatCohort(report: Report): string {
  const last = report.snapshots[report.snapshots.length - 1];
  const byYear = last?.cohortByYear;
  if (!byYear || Object.keys(byYear).length === 0) return "";

  const years = Object.keys(byYear).sort();
  const total = years.reduce((s, y) => s + byYear[y]!, 0);
  const yearW = Math.max(4, ...years.map((y) => y.length));
  const numW = Math.max(5, ...years.map((y) => byYear[y]!.toLocaleString("en-US").length));

  const rows = years.map((y) => {
    const lines = byYear[y]!;
    const pct = total ? ((lines / total) * 100).toFixed(1) : "0.0";
    return `${y.padEnd(yearW)}  ${lines.toLocaleString("en-US").padStart(numW)}  ${pct.padStart(5)}%`;
  });

  return [
    `Code age (latest snapshot: ${last.date}) — ${total.toLocaleString("en-US")} surviving lines:`,
    "",
    `${"Year".padEnd(yearW)}  ${"Lines".padStart(numW)}  Share`,
    `${"-".repeat(yearW)}  ${"-".repeat(numW)}  -----`,
    ...rows,
  ].join("\n");
}
