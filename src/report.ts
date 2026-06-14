import { EXCLUDED_ROLES, type Report, type Snapshot } from "./types.js";

export interface SnapshotSummary {
  date: string;
  sha: string;
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

export function summarizeSnapshot(s: Snapshot): SnapshotSummary {
  let comments = 0;
  let countedCode = 0;
  let excluded = 0;
  for (const [role, b] of Object.entries(s.byRole)) {
    if (EXCLUDED_ROLES.has(role as never)) {
      excluded += b.code;
    } else {
      countedCode += b.code;
      comments += b.comment;
    }
  }
  return {
    date: s.date,
    sha: s.sha.slice(0, 8),
    app: s.byRole.app.code,
    test: s.byRole.test.code,
    config: s.byRole.config.code,
    docs: s.byRole.docs.code,
    data: s.byRole.data.code,
    comments,
    countedCode,
    excluded,
  };
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
