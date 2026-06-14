/**
 * Pure, language-aware line counting.
 *
 * Given a file's text and its comment syntax, classify every physical line as
 * code, comment, or blank — mirroring cloc's basic model:
 *   - a line with ANY code is "code" (even if it also has a trailing comment)
 *   - a line with only a comment is "comment"
 *   - an empty / whitespace-only line is "blank"
 *
 * Known limitation: comment tokens appearing inside string literals are not
 * recognized as strings (e.g. `const s = "// not a comment"`). This is the same
 * class of edge case cloc itself documents; it affects a small fraction of lines.
 * For higher fidelity, install `cloc` and the ClocCounter backend is used.
 */

export interface Syntax {
  /** Canonical language name (e.g. "TypeScript"). */
  name: string;
  /** Line-comment starter tokens (e.g. ["//", "#"]). */
  line: string[];
  /** Block-comment [start, end] token pairs (e.g. [["/*", "*\/"]]). */
  block: Array<[string, string]>;
}

export interface LineCounts {
  code: number;
  comment: number;
  blank: number;
}

function startsWithAt(s: string, i: number, token: string): boolean {
  return s.startsWith(token, i);
}

export function countText(text: string, syntax: Syntax): LineCounts {
  const counts: LineCounts = { code: 0, comment: 0, blank: 0 };
  // Split on \n; tolerate \r\n. A trailing newline does not create a phantom line.
  const lines = text.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();

  let blockEnd: string | null = null; // non-null => currently inside a block comment

  for (const raw of lines) {
    const line = raw.replace(/\r$/, "");
    if (line.trim() === "") {
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
          i = n; // rest of line is comment; stay in block
        } else {
          i = end + blockEnd.length;
          blockEnd = null;
        }
        continue;
      }

      const ch = line[i]!;
      if (ch === " " || ch === "\t") {
        i++;
        continue;
      }

      // Line comment?
      const lineTok = syntax.line.find((t) => startsWithAt(line, i, t));
      if (lineTok) {
        hasComment = true;
        break; // rest of the line is a comment
      }

      // Block comment start?
      const blk = syntax.block.find(([start]) => startsWithAt(line, i, start));
      if (blk) {
        hasComment = true;
        blockEnd = blk[1];
        i += blk[0].length;
        continue;
      }

      // Otherwise it's code.
      hasCode = true;
      i++;
    }

    if (hasCode) counts.code++;
    else if (hasComment) counts.comment++;
    else counts.blank++; // only whitespace remained
  }

  return counts;
}
