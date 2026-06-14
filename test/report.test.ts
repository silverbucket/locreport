import { describe, expect, it } from "vitest";
import { formatReport, summarizeSnapshot } from "../src/report.js";
import type { Bucket, Report, Role, Snapshot } from "../src/types.js";

function bucket(code: number, comment = 0): Bucket {
  return { code, comment, blank: 0, files: 1 };
}

function snapshot(date: string, partial: Partial<Record<Role, Bucket>>): Snapshot {
  const zero = bucket(0);
  return {
    date,
    sha: "abcdef1234567890",
    byRole: {
      app: bucket(0),
      test: bucket(0),
      config: bucket(0),
      docs: bucket(0),
      data: bucket(0),
      build: bucket(0),
      vendored: bucket(0),
      ...partial,
    } as Record<Role, Bucket>,
  };
}

describe("summarizeSnapshot", () => {
  it("sums counted code and comments, isolates excluded code", () => {
    const s = summarizeSnapshot(
      snapshot("2023-01-01", {
        app: bucket(100, 20),
        test: bucket(50, 5),
        config: bucket(10, 2),
        build: bucket(30, 99),
        vendored: bucket(1000, 1),
      }),
    );
    expect(s.app).toBe(100);
    expect(s.test).toBe(50);
    expect(s.countedCode).toBe(160); // app + test + config (docs/data 0)
    expect(s.comments).toBe(27); // 20 + 5 + 2 (build/vendored comments excluded)
    expect(s.excluded).toBe(1030); // build + vendored code
  });
});

describe("formatReport", () => {
  it("renders an aligned table with all snapshots", () => {
    const report: Report = {
      repoUrl: "https://github.com/a/b",
      cloneUrl: "https://github.com/a/b.git",
      branch: "main",
      interval: "1y",
      generatedAt: "2024-01-01T00:00:00Z",
      snapshots: [
        snapshot("2022-01-01", { app: bucket(1000, 100) }),
        snapshot("2023-01-01", { app: bucket(2000, 200), test: bucket(500) }),
      ],
    };
    const out = formatReport(report);
    expect(out).toContain("github.com/a/b");
    expect(out).toContain("2022-01-01");
    expect(out).toContain("2023-01-01");
    expect(out).toContain("App");
    expect(out).toContain("2,000"); // locale-formatted
  });
});
