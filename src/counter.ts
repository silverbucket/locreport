import { execFile } from "node:child_process";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { detectLanguage } from "./languages.js";
import { countText } from "./linecount.js";
import type { FileCount } from "./types.js";

const execFileAsync = promisify(execFile);

/**
 * A Counter produces per-file line counts for every source file in a directory
 * tree (the extracted contents of a single commit).
 */
export interface Counter {
  readonly name: string;
  count(dir: string): Promise<FileCount[]>;
}

// --- helpers ---------------------------------------------------------------

async function walk(dir: string): Promise<string[]> {
  const out: string[] = [];
  async function recurse(current: string): Promise<void> {
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === ".git") continue;
        await recurse(full);
      } else if (entry.isFile()) {
        out.push(full);
      }
    }
  }
  await recurse(dir);
  return out;
}

/** Heuristic binary check: a NUL byte in the first chunk. */
function looksBinary(buf: Buffer): boolean {
  const limit = Math.min(buf.length, 8000);
  for (let i = 0; i < limit; i++) if (buf[i] === 0) return true;
  return false;
}

// --- builtin backend -------------------------------------------------------

/** Zero-dependency counter. Always available. */
export class BuiltinCounter implements Counter {
  readonly name = "builtin";

  async count(dir: string): Promise<FileCount[]> {
    const files = await walk(dir);
    const results: FileCount[] = [];
    for (const file of files) {
      const rel = path.relative(dir, file).split(path.sep).join("/");
      const syntax = detectLanguage(rel);
      if (!syntax) continue;
      const buf = await readFile(file);
      if (looksBinary(buf)) continue;
      const { code, comment, blank } = countText(buf.toString("utf8"), syntax);
      results.push({ path: rel, language: syntax.name, code, comment, blank });
    }
    return results;
  }
}

// --- cloc backend ----------------------------------------------------------

interface ClocEntry {
  blank: number;
  comment: number;
  code: number;
  language?: string;
}

/** Parse `cloc --json --by-file` output into FileCount[]. */
export function parseClocJson(json: string, baseDir?: string): FileCount[] {
  const data = JSON.parse(json) as Record<string, ClocEntry | unknown>;
  const out: FileCount[] = [];
  for (const [key, value] of Object.entries(data)) {
    if (key === "header" || key === "SUM") continue;
    const entry = value as ClocEntry;
    if (typeof entry?.code !== "number") continue;
    let rel = key;
    if (baseDir) {
      rel = path.relative(baseDir, key);
      if (rel.startsWith("..")) rel = key; // not under baseDir; keep as-is
    }
    rel = rel.replace(/^\.\//, "").split(path.sep).join("/");
    out.push({
      path: rel,
      language: entry.language ?? "unknown",
      code: entry.code,
      comment: entry.comment,
      blank: entry.blank,
    });
  }
  return out;
}

/** Counter backed by a system `cloc` binary. More accurate, ~250 languages. */
export class ClocCounter implements Counter {
  readonly name = "cloc";
  constructor(private readonly bin = "cloc") {}

  async count(dir: string): Promise<FileCount[]> {
    // cloc does not follow symlinks by default, which is what we want when
    // scanning an extracted (untrusted) tree — so no symlink flag is passed.
    const { stdout } = await execFileAsync(
      this.bin,
      ["--json", "--by-file", "--quiet", dir],
      { maxBuffer: 64 * 1024 * 1024 },
    );
    // cloc prints nothing for an empty tree; treat that as no files.
    if (!stdout.trim()) return [];
    return parseClocJson(stdout, dir);
  }
}

/** True if a `cloc` binary is callable on PATH. */
export async function isClocAvailable(bin = "cloc"): Promise<boolean> {
  try {
    await execFileAsync(bin, ["--version"]);
    return true;
  } catch {
    return false;
  }
}

/**
 * Pick the best available counter: cloc if installed (more accurate), else the
 * builtin counter so the tool always works out of the box.
 */
export async function getCounter(): Promise<Counter> {
  if (await isClocAvailable()) return new ClocCounter();
  return new BuiltinCounter();
}
