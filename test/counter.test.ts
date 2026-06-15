import { chmod, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BuiltinCounter, ClocCounter, parseClocJson } from "../src/counter.js";

describe("parseClocJson", () => {
  it("parses --by-file output, skipping header and SUM", () => {
    const json = JSON.stringify({
      header: { cloc_version: "2.02" },
      "src/index.ts": { blank: 5, comment: 3, code: 42, language: "TypeScript" },
      "test/index.test.ts": { blank: 2, comment: 1, code: 20, language: "TypeScript" },
      SUM: { blank: 7, comment: 4, code: 62 },
    });
    const out = parseClocJson(json);
    expect(out).toHaveLength(2);
    expect(out[0]).toEqual({ path: "src/index.ts", language: "TypeScript", code: 42, comment: 3, blank: 5 });
  });

  it("rebases absolute paths under baseDir", () => {
    const json = JSON.stringify({
      "/tmp/extract/src/a.go": { blank: 0, comment: 0, code: 10, language: "Go" },
      SUM: { blank: 0, comment: 0, code: 10 },
    });
    expect(parseClocJson(json, "/tmp/extract")[0]?.path).toBe("src/a.go");
  });
});

describe("BuiltinCounter (on a real directory)", () => {
  let dir: string;

  beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "locreport-counter-"));
    await mkdir(path.join(dir, "src"), { recursive: true });
    await writeFile(path.join(dir, "src", "app.ts"), "// c\nconst x = 1;\n\nfunction f() {}\n");
    await writeFile(path.join(dir, "main.py"), "# hi\nx = 1\n");
    await writeFile(path.join(dir, "data.bin"), Buffer.from([0, 1, 2, 0, 3])); // binary, skipped
    await writeFile(path.join(dir, "unknown.xyz"), "whatever\n"); // unknown ext, skipped
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("counts known text files, skips binary and unknown extensions", async () => {
    const out = await new BuiltinCounter().count(dir);
    const byPath = Object.fromEntries(out.map((f) => [f.path, f]));
    expect(Object.keys(byPath).sort()).toEqual(["main.py", "src/app.ts"]);
    expect(byPath["src/app.ts"]).toMatchObject({ language: "TypeScript", code: 2, comment: 1, blank: 1 });
    expect(byPath["main.py"]).toMatchObject({ language: "Python", code: 1, comment: 1 });
  });
});

// Regression guard for the cloc invocation itself (the args, not just parsing):
// real cloc rejects an argument-bearing --follow-links, so a stub reproduces
// that failure. Without it, only parseClocJson was covered and a bad flag shipped.
describe.skipIf(process.platform === "win32")("ClocCounter (stub binary)", () => {
  let dir: string;
  let stub: string;

  beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "locreport-cloc-"));
    stub = path.join(dir, "cloc");
    await writeFile(
      stub,
      [
        "#!/bin/sh",
        "# Mimic real cloc: error out on an argument-bearing --follow-links.",
        'for a in "$@"; do',
        "  case \"$a\" in --follow-links=*) echo 'Option follow-links does not take an argument' >&2; exit 1 ;; esac",
        "done",
        `cat <<'JSON'`,
        '{"header":{"cloc_version":"2.02"},"src/index.ts":{"blank":1,"comment":2,"code":3,"language":"TypeScript"},"SUM":{"blank":1,"comment":2,"code":3}}',
        "JSON",
      ].join("\n"),
    );
    await chmod(stub, 0o755);
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("invokes cloc with valid flags and parses its output", async () => {
    const out = await new ClocCounter(stub).count(dir);
    expect(out).toEqual([{ path: "src/index.ts", language: "TypeScript", code: 3, comment: 2, blank: 1 }]);
  });
});
