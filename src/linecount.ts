/**
 * Pure, language-aware line counting.
 *
 * Given a file's text and its comment + string syntax, classify every physical
 * line as code, comment, or blank — mirroring cloc's basic model:
 *   - a line with ANY code is "code" (even if it also has a trailing comment)
 *   - a line with only a comment is "comment"
 *   - an empty / whitespace-only line is "blank"
 *
 * String literals are tracked so that comment tokens INSIDE strings (e.g.
 * `const u = "http://x"` or `s = "a # b"`) are not mistaken for comments.
 * Multi-line strings (backticks, Python triple-quotes) and escapes are handled.
 *
 * Remaining nuance not modelled: Python docstrings count as code (string), not
 * comments. Install `cloc` for its fuller, language-specific handling.
 */

export interface StringDelim {
  open: string;
  close: string;
  /** Backslash escapes the close delimiter (C/JS strings) vs not (raw strings). */
  escape: boolean;
  /** May span multiple lines (backticks, triple-quotes). */
  multiline: boolean;
}

export interface Syntax {
  /** Canonical language name (e.g. "TypeScript"). */
  name: string;
  /** Line-comment starter tokens (e.g. ["//", "#"]). */
  line: string[];
  /** Block-comment [start, end] token pairs (e.g. [["/*", "*\/"]]). */
  block: Array<[string, string]>;
  /** String/char literal delimiters, longest `open` first. */
  strings: StringDelim[];
}

export interface LineCounts {
  code: number;
  comment: number;
  blank: number;
}

/**
 * From `from`, find the index just past `close`, honoring backslash escapes when
 * `escape` is set. Returns -1 if `close` isn't found on this line.
 */
function scanToClose(line: string, from: number, close: string, escape: boolean): number {
  let i = from;
  const n = line.length;
  while (i < n) {
    if (escape && line[i] === "\\") {
      i += 2;
      continue;
    }
    if (line.startsWith(close, i)) return i + close.length;
    i++;
  }
  return -1;
}

export function countText(text: string, syntax: Syntax): LineCounts {
  const counts: LineCounts = { code: 0, comment: 0, blank: 0 };
  const lines = text.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();

  let blockEnd: string | null = null; // inside a block comment
  let str: StringDelim | null = null; // inside a multi-line string

  for (const raw of lines) {
    const line = raw.replace(/\r$/, "");
    if (line.trim() === "") {
      // Blank lines stay blank even inside an open block comment / string.
      counts.blank++;
      continue;
    }

    let hasCode = false;
    let hasComment = false;
    let i = 0;
    const n = line.length;

    while (i < n) {
      if (blockEnd) {
        const end = line.indexOf(blockEnd, i);
        hasComment = true;
        if (end === -1) {
          i = n;
        } else {
          i = end + blockEnd.length;
          blockEnd = null;
        }
        continue;
      }

      if (str) {
        // Continuation of a multi-line string: content is code.
        hasCode = true;
        const end = scanToClose(line, i, str.close, str.escape);
        if (end === -1) {
          i = n;
        } else {
          i = end;
          str = null;
        }
        continue;
      }

      const ch = line[i]!;
      if (ch === " " || ch === "\t") {
        i++;
        continue;
      }

      const lineTok = syntax.line.find((t) => line.startsWith(t, i));
      if (lineTok) {
        hasComment = true;
        break; // rest of the line is a comment
      }

      const blk = syntax.block.find(([start]) => line.startsWith(start, i));
      if (blk) {
        hasComment = true;
        blockEnd = blk[1];
        i += blk[0].length;
        continue;
      }

      const sd = syntax.strings.find((s) => line.startsWith(s.open, i));
      if (sd) {
        hasCode = true;
        const end = scanToClose(line, i + sd.open.length, sd.close, sd.escape);
        if (end === -1) {
          if (sd.multiline) str = sd; // carry the open string to the next line
          i = n;
        } else {
          i = end;
        }
        continue;
      }

      // Anything else is code.
      hasCode = true;
      i++;
    }

    if (hasCode) counts.code++;
    else if (hasComment) counts.comment++;
    else counts.blank++;
  }

  return counts;
}
