import { describe, expect, it } from "vitest";
import { classifyFiles, aggregateByPackage } from "../src/aggregate.js";
import { detectPackages, type FileReader } from "../src/packages.js";
import type { FileCount } from "../src/types.js";

/** Build a reader from a path->content map. */
function reader(files: Record<string, string>): FileReader {
  return (rel) => (rel in files ? files[rel]! : null);
}

describe("detectPackages — workspace-aware", () => {
  it("uses pnpm-workspace.yaml globs", () => {
    const files = {
      "pnpm-workspace.yaml": "packages:\n  - 'packages/*'\n  - 'apps/*'\n",
      "package.json": '{"name":"root"}',
      "packages/api/package.json": '{"name":"@acme/api"}',
      "packages/api/src/server.ts": "x",
      "apps/web/package.json": '{"name":"@acme/web"}',
      "apps/web/index.ts": "x",
      "packages/api/examples/demo/package.json": '{"name":"demo"}', // nested, NOT a workspace member
    };
    const paths = Object.keys(files);
    const det = detectPackages(paths, reader(files));

    expect(det.mode).toBe("workspace");
    expect(det.assign("packages/api/src/server.ts")).toBe("packages/api");
    expect(det.assign("apps/web/index.ts")).toBe("apps/web");
    // nested non-member files belong to the closest *member* (packages/api)
    expect(det.assign("packages/api/examples/demo/package.json")).toBe("packages/api");
    // root-level files belong to root
    expect(det.assign("package.json")).toBe("");

    // names come from each package.json
    const byId = Object.fromEntries(det.packages.map((p) => [p.id, p.name]));
    expect(byId["packages/api"]).toBe("@acme/api");
    expect(byId["apps/web"]).toBe("@acme/web");
  });

  it("supports npm 'workspaces' arrays in package.json", () => {
    const files = {
      "package.json": '{"name":"root","workspaces":["libs/*"]}',
      "libs/a/package.json": '{"name":"a"}',
      "libs/a/a.ts": "x",
    };
    const det = detectPackages(Object.keys(files), reader(files));
    expect(det.mode).toBe("workspace");
    expect(det.assign("libs/a/a.ts")).toBe("libs/a");
  });

  it("supports Cargo workspace members", () => {
    const files = {
      "Cargo.toml": '[workspace]\nmembers = ["crates/core", "crates/cli"]\n',
      "crates/core/Cargo.toml": "[package]\nname = \"core\"\n",
      "crates/core/src/lib.rs": "x",
    };
    const det = detectPackages(Object.keys(files), reader(files));
    expect(det.mode).toBe("workspace");
    expect(det.assign("crates/core/src/lib.rs")).toBe("crates/core");
  });
});

describe("detectPackages — manifest fallback", () => {
  it("treats every manifest dir as a package when no workspace is declared", () => {
    const files = {
      "services/a/go.mod": "module a",
      "services/a/main.go": "x",
      "services/b/go.mod": "module b",
      "services/b/main.go": "x",
    };
    const det = detectPackages(Object.keys(files), reader(files));
    expect(det.mode).toBe("manifest");
    expect(det.assign("services/a/main.go")).toBe("services/a");
    expect(det.assign("services/b/main.go")).toBe("services/b");
  });

  it("ignores manifests inside vendored dirs", () => {
    const files = {
      "package.json": '{"name":"root"}',
      "src/index.ts": "x",
      "node_modules/dep/package.json": '{"name":"dep"}',
    };
    const det = detectPackages(Object.keys(files), reader(files));
    // only the root manifest exists at root -> no sub-packages -> single
    expect(det.mode).toBe("single");
    expect(det.assign("node_modules/dep/package.json")).toBe("");
  });
});

describe("aggregateByPackage", () => {
  it("buckets classified files per package and sorts root last", () => {
    const files: FileCount[] = [
      { path: "packages/api/src/a.ts", language: "TypeScript", code: 100, comment: 10, blank: 0 },
      { path: "packages/api/test/a.test.ts", language: "TypeScript", code: 40, comment: 0, blank: 0 },
      { path: "apps/web/index.ts", language: "TypeScript", code: 30, comment: 0, blank: 0 },
      { path: "README.md", language: "Markdown", code: 5, comment: 0, blank: 0 },
    ];
    const map = {
      "pnpm-workspace.yaml": "packages:\n  - 'packages/*'\n  - 'apps/*'\n",
    };
    const det = detectPackages([...files.map((f) => f.path), "pnpm-workspace.yaml"], reader(map));
    const out = aggregateByPackage(classifyFiles(files), det);

    const api = out.find((p) => p.id === "packages/api")!;
    expect(api.byRole.app.code).toBe(100);
    expect(api.byRole.test.code).toBe(40);
    const web = out.find((p) => p.id === "apps/web")!;
    expect(web.byRole.app.code).toBe(30);
    // README at root -> root bucket, sorted last
    expect(out[out.length - 1]!.id).toBe("");
    expect(out[out.length - 1]!.byRole.docs.code).toBe(5);
  });
});
