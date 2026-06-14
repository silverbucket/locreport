import { describe, expect, it } from "vitest";
import { intervalDates, isInterval, toISODate } from "../src/intervals.js";

const d = (s: string) => new Date(`${s}T00:00:00Z`);

describe("isInterval", () => {
  it("accepts known intervals and rejects others", () => {
    expect(isInterval("1y")).toBe(true);
    expect(isInterval("6m")).toBe(true);
    expect(isInterval("2w")).toBe(false);
    expect(isInterval("")).toBe(false);
  });
});

describe("intervalDates", () => {
  it("steps yearly and always includes the final date", () => {
    expect(intervalDates(d("2020-01-01"), d("2023-01-01"), "1y")).toEqual([
      "2020-01-01",
      "2021-01-01",
      "2022-01-01",
      "2023-01-01",
    ]);
  });

  it("appends the repo's last date when it doesn't land on a step", () => {
    const out = intervalDates(d("2020-01-01"), d("2021-07-15"), "1y");
    expect(out).toEqual(["2020-01-01", "2021-01-01", "2021-07-15"]);
  });

  it("steps every 6 months", () => {
    expect(intervalDates(d("2020-01-01"), d("2021-01-01"), "6m")).toEqual([
      "2020-01-01",
      "2020-07-01",
      "2021-01-01",
    ]);
  });

  it("handles month rollover correctly (monthly)", () => {
    const out = intervalDates(d("2020-11-30"), d("2021-02-28"), "1m");
    // Nov 30 +1m -> Dec 30; +1m -> Jan 30; +1m -> Mar 2 (JS clamps Feb 30) > last
    expect(out[0]).toBe("2020-11-30");
    expect(out).toContain("2021-02-28"); // final always appended
  });

  it("returns a single date when first == last", () => {
    expect(intervalDates(d("2022-05-05"), d("2022-05-05"), "1y")).toEqual(["2022-05-05"]);
  });

  it("throws when last precedes first", () => {
    expect(() => intervalDates(d("2022-01-01"), d("2021-01-01"), "1y")).toThrow();
  });
});

describe("toISODate", () => {
  it("formats as UTC YYYY-MM-DD", () => {
    expect(toISODate(new Date("2022-03-04T23:59:59Z"))).toBe("2022-03-04");
  });
});
