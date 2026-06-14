import { classify, type Rule } from "./classifier.js";
import type { Bucket, ClassifiedFile, FileCount, Role } from "./types.js";

const ALL_ROLES: Role[] = ["app", "test", "config", "docs", "data", "build", "vendored"];

export function classifyFiles(files: FileCount[], rules?: Rule[]): ClassifiedFile[] {
  return files.map((f) => ({ ...f, role: classify(f.path, rules) }));
}

function emptyBucket(): Bucket {
  return { code: 0, comment: 0, blank: 0, files: 0 };
}

/** Aggregate classified files into one bucket per role (all roles present). */
export function aggregateByRole(files: ClassifiedFile[]): Record<Role, Bucket> {
  const byRole = Object.fromEntries(ALL_ROLES.map((r) => [r, emptyBucket()])) as Record<Role, Bucket>;
  for (const f of files) {
    const b = byRole[f.role];
    b.code += f.code;
    b.comment += f.comment;
    b.blank += f.blank;
    b.files += 1;
  }
  return byRole;
}
