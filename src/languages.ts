import type { Syntax } from "./linecount.js";

/**
 * Language detection by extension / filename, with each language's comment
 * syntax. This table is intentionally pragmatic: it covers the languages that
 * dominate real repos. Files whose language we can't identify are skipped by
 * the builtin counter (cloc, when present, covers far more).
 */

const C_STYLE: Pick<Syntax, "line" | "block"> = { line: ["//"], block: [["/*", "*/"]] };
const HASH: Pick<Syntax, "line" | "block"> = { line: ["#"], block: [] };
const DASH_SQL: Pick<Syntax, "line" | "block"> = { line: ["--"], block: [["/*", "*/"]] };

interface Lang extends Pick<Syntax, "line" | "block"> {
  name: string;
}

// Map of lowercase extension (without dot) -> language.
const BY_EXT: Record<string, Lang> = {
  // C-family
  js: { name: "JavaScript", ...C_STYLE },
  mjs: { name: "JavaScript", ...C_STYLE },
  cjs: { name: "JavaScript", ...C_STYLE },
  jsx: { name: "JSX", ...C_STYLE },
  ts: { name: "TypeScript", ...C_STYLE },
  mts: { name: "TypeScript", ...C_STYLE },
  cts: { name: "TypeScript", ...C_STYLE },
  tsx: { name: "TSX", ...C_STYLE },
  java: { name: "Java", ...C_STYLE },
  c: { name: "C", ...C_STYLE },
  h: { name: "C/C++ Header", ...C_STYLE },
  cc: { name: "C++", ...C_STYLE },
  cpp: { name: "C++", ...C_STYLE },
  cxx: { name: "C++", ...C_STYLE },
  hpp: { name: "C++ Header", ...C_STYLE },
  hh: { name: "C++ Header", ...C_STYLE },
  cs: { name: "C#", ...C_STYLE },
  go: { name: "Go", ...C_STYLE },
  rs: { name: "Rust", ...C_STYLE },
  swift: { name: "Swift", ...C_STYLE },
  kt: { name: "Kotlin", ...C_STYLE },
  kts: { name: "Kotlin", ...C_STYLE },
  scala: { name: "Scala", ...C_STYLE },
  dart: { name: "Dart", ...C_STYLE },
  m: { name: "Objective-C", ...C_STYLE },
  mm: { name: "Objective-C++", ...C_STYLE },
  php: { name: "PHP", line: ["//", "#"], block: [["/*", "*/"]] },
  groovy: { name: "Groovy", ...C_STYLE },
  proto: { name: "Protocol Buffers", ...C_STYLE },
  zig: { name: "Zig", line: ["//"], block: [] },

  // Hash-comment family
  py: { name: "Python", ...HASH },
  rb: { name: "Ruby", line: ["#"], block: [["=begin", "=end"]] },
  sh: { name: "Shell", ...HASH },
  bash: { name: "Shell", ...HASH },
  zsh: { name: "Shell", ...HASH },
  pl: { name: "Perl", line: ["#"], block: [["=pod", "=cut"]] },
  pm: { name: "Perl", line: ["#"], block: [["=pod", "=cut"]] },
  r: { name: "R", ...HASH },
  yml: { name: "YAML", ...HASH },
  yaml: { name: "YAML", ...HASH },
  toml: { name: "TOML", ...HASH },
  ini: { name: "INI", line: [";", "#"], block: [] },
  cfg: { name: "INI", line: [";", "#"], block: [] },
  conf: { name: "Config", ...HASH },
  properties: { name: "Properties", ...HASH },
  env: { name: "Dotenv", ...HASH },
  tf: { name: "Terraform", line: ["#", "//"], block: [["/*", "*/"]] },
  dockerfile: { name: "Dockerfile", ...HASH },
  ex: { name: "Elixir", ...HASH },
  exs: { name: "Elixir", ...HASH },

  // Data formats (no comments in strict JSON; JSON5/JSONC allow them).
  json: { name: "JSON", line: [], block: [] },
  geojson: { name: "JSON", line: [], block: [] },
  json5: { name: "JSON5", ...C_STYLE },
  jsonc: { name: "JSON5", ...C_STYLE },

  // SQL family
  sql: { name: "SQL", ...DASH_SQL },

  // Misc
  lua: { name: "Lua", line: ["--"], block: [["--[[", "]]"]] },
  hs: { name: "Haskell", line: ["--"], block: [["{-", "-}"]] },
  clj: { name: "Clojure", line: [";"], block: [] },
  cljs: { name: "Clojure", line: [";"], block: [] },
  lisp: { name: "Lisp", line: [";"], block: [] },
  el: { name: "Emacs Lisp", line: [";"], block: [] },
  vim: { name: "Vim Script", line: ['"'], block: [] },

  // Stylesheets
  css: { name: "CSS", line: [], block: [["/*", "*/"]] },
  scss: { name: "SCSS", ...C_STYLE },
  sass: { name: "Sass", ...C_STYLE },
  less: { name: "LESS", ...C_STYLE },

  // Markup
  html: { name: "HTML", line: [], block: [["<!--", "-->"]] },
  htm: { name: "HTML", line: [], block: [["<!--", "-->"]] },
  xml: { name: "XML", line: [], block: [["<!--", "-->"]] },
  vue: { name: "Vue", line: ["//"], block: [["/*", "*/"], ["<!--", "-->"]] },
  svelte: { name: "Svelte", line: ["//"], block: [["/*", "*/"], ["<!--", "-->"]] },
  md: { name: "Markdown", line: [], block: [["<!--", "-->"]] },
  markdown: { name: "Markdown", line: [], block: [["<!--", "-->"]] },
  rst: { name: "reStructuredText", line: [], block: [] },
  adoc: { name: "AsciiDoc", line: ["//"], block: [] },
};

// Special filenames (no useful extension).
const BY_NAME: Record<string, Lang> = {
  dockerfile: { name: "Dockerfile", ...HASH },
  makefile: { name: "Makefile", ...HASH },
  rakefile: { name: "Ruby", ...HASH },
  gemfile: { name: "Ruby", ...HASH },
  ".env": { name: "Dotenv", ...HASH },
  ".gitignore": { name: "Ignore List", ...HASH },
  ".dockerignore": { name: "Ignore List", ...HASH },
};

function toSyntax(lang: Lang): Syntax {
  return { name: lang.name, line: lang.line, block: lang.block };
}

/** Detect a file's language/comment-syntax from its path, or null if unknown. */
export function detectLanguage(path: string): Syntax | null {
  const file = path.split("/").pop() ?? path;
  const lower = file.toLowerCase();

  const byName = BY_NAME[lower];
  if (byName) return toSyntax(byName);

  // Dockerfile.web, makefile.inc, etc.
  for (const prefix of ["dockerfile", "makefile"]) {
    if (lower.startsWith(prefix + ".")) {
      const lang = BY_NAME[prefix]!;
      return toSyntax(lang);
    }
  }

  const dot = lower.lastIndexOf(".");
  if (dot === -1) return null;
  const ext = lower.slice(dot + 1);
  const byExt = BY_EXT[ext];
  return byExt ? toSyntax(byExt) : null;
}
