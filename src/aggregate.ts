import { classify, type Rule } from "./classifier.js";
import type { PackageDetection } from "./packages.js";
import type { Bucket, ClassifiedFile, FileCount, PackageSnapshot, Role } from "./types.js";

const ALL_ROLES: Role[] = ["app", "test", "config", "docs", "data", "build", "vendored"];

export function classifyFiles(files: FileCount[], rules?: Rule[]): ClassifiedFile[] {
  return files.map((f) => ({ ...f, role: classify(f.path, rules) }));
}

function emptyBucket(): Bucket {
  return { code: 0, comment: 0, blank: 0, files: 0 };
}

function addInto(byRole: Record<Role, Bucket>, f: ClassifiedFile): void {
  const b = byRole[f.role];
  b.code += f.code;
  b.comment += f.comment;
  b.blank += f.blank;
  b.files += 1;
}

function emptyByRole(): Record<Role, Bucket> {
  return Object.fromEntries(ALL_ROLES.map((r) => [r, emptyBucket()])) as Record<Role, Bucket>;
}

function countedCode(byRole: Record<Role, Bucket>): number {
  let total = 0;
  for (const r of ALL_ROLES) if (r !== "build" && r !== "vendored") total += byRole[r].code;
  return total;
}

/** Aggregate classified files into one bucket per role (all roles present). */
export function aggregateByRole(files: ClassifiedFile[]): Record<Role, Bucket> {
  const byRole = emptyByRole();
  for (const f of files) addInto(byRole, f);
  return byRole;
}

/**
 * Aggregate classified files into one role-breakdown per package, using the
 * detection's file->package assignment. Packages with no files are omitted.
 * Sorted by counted (non-excluded) code descending, root last.
 */
export function aggregateByPackage(files: ClassifiedFile[], detection: PackageDetection): PackageSnapshot[] {
  const byId = new Map<string, Record<Role, Bucket>>();
  for (const f of files) {
    const id = detection.assign(f.path);
    let byRole = byId.get(id);
    if (!byRole) {
      byRole = emptyByRole();
      byId.set(id, byRole);
    }
    addInto(byRole, f);
  }

  const nameOf = new Map(detection.packages.map((p) => [p.id, p.name]));
  const result: PackageSnapshot[] = [];
  for (const [id, byRole] of byId) {
    result.push({ id, name: nameOf.get(id) ?? id, byRole });
  }
  result.sort((a, b) => {
    if (a.id === "" && b.id !== "") return 1; // root last
    if (b.id === "" && a.id !== "") return -1;
    return countedCode(b.byRole) - countedCode(a.byRole);
  });
  return result;
}
