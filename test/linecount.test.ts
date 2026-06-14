import { describe, expect, it } from "vitest";
import { detectLanguage } from "../src/languages.js";
import { countText } from "../src/linecount.js";

const ts = detectLanguage("x.ts")!;
const py = detectLanguage("x.py")!;
const css = detectLanguage("x.css")!;

describe("detectLanguage", () => {
  it("detects by extension and special names", () => {
    expect(detectLanguage("src/a.ts")?.name).toBe("TypeScript");
    expect(detectLanguage("Dockerfile")?.name).toBe("Dockerfile");
    expect(detectLanguage("Dockerfile.prod")?.name).toBe("Dockerfile");
    expect(detectLanguage("Makefile")?.name).toBe("Makefile");
    expect(detectLanguage("weird.bin")).toBeNull();
    expect(detectLanguage("noext")).toBeNull();
  });
});

describe("countText", () => {
  it("counts code, line comments and blanks (C-style)", () => {
    const src = ["// header comment", "", "const x = 1; // trailing comment", "function f() {}", "  ", "// done"].join(
      "\n",
    );
    expect(countText(src, ts)).toEqual({ code: 2, comment: 2, blank: 2 });
  });

  it("counts multi-line block comments", () => {
    const src = ["/* a", " * b", " */", "code();", "x(); /* inline */"].join("\n");
    // lines 1-3 comment, line 4 code, line 5 code (has code + inline comment)
    expect(countText(src, ts)).toEqual({ code: 2, comment: 3, blank: 0 });
  });

  it("treats code before a block-open on the same line as code", () => {
    const src = "doThing(); /* explain\nmore */\n";
    expect(countText(src, ts)).toEqual({ code: 1, comment: 1, blank: 0 });
  });

  it("handles code after a block-close on the same line", () => {
    const src = "/* note */ run();";
    expect(countText(src, ts)).toEqual({ code: 1, comment: 0, blank: 0 });
  });

  it("counts python hash comments", () => {
    const src = ["# comment", "x = 1", "y = 2  # trailing", "", "\t"].join("\n");
    expect(countText(src, py)).toEqual({ code: 2, comment: 1, blank: 2 });
  });

  it("CSS has block but no line comments", () => {
    const src = [".a { color: red; }", "/* c */", "// not-a-comment-in-css"].join("\n");
    // line 3: '//' is not a CSS comment, so it's code
    expect(countText(src, css)).toEqual({ code: 2, comment: 1, blank: 0 });
  });

  it("ignores a trailing newline (no phantom blank line)", () => {
    expect(countText("a();\n", ts)).toEqual({ code: 1, comment: 0, blank: 0 });
    expect(countText("a();", ts)).toEqual({ code: 1, comment: 0, blank: 0 });
  });

  it("handles CRLF line endings", () => {
    expect(countText("a();\r\n// c\r\n", ts)).toEqual({ code: 1, comment: 1, blank: 0 });
  });

  it("empty input is all zeros", () => {
    expect(countText("", ts)).toEqual({ code: 0, comment: 0, blank: 0 });
  });
});
