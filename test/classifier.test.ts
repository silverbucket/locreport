import { describe, expect, it } from "vitest";
import { classify, classifyExplain } from "../src/classifier.js";
import type { Role } from "../src/types.js";

describe("classify", () => {
  const cases: Array<[string, Role]> = [
    // app
    ["src/index.ts", "app"],
    ["lib/server/router.go", "app"],
    ["app/models/user.rb", "app"],
    ["main.py", "app"],

    // tests
    ["test/foo.test.ts", "test"],
    ["src/__tests__/foo.tsx", "test"],
    ["pkg/router_test.go", "test"],
    ["spec/models/user_spec.rb", "test"],
    ["tests/conftest.py", "test"],
    ["e2e/login.spec.ts", "test"],

    // build / tooling (excluded)
    ["Dockerfile", "build"],
    ["Makefile", "build"],
    [".github/workflows/ci.yml", "build"],
    [".eslintrc.json", "build"],
    ["webpack.config.js", "build"],
    ["tsconfig.json", "build"],
    ["CMakeLists.txt", "build"],
    [".gitignore", "build"],

    // vendored / generated (excluded)
    ["node_modules/left-pad/index.js", "vendored"],
    ["vendor/github.com/x/y.go", "vendored"],
    ["dist/bundle.js", "vendored"],
    ["assets/app.min.js", "vendored"],
    ["api/service.pb.go", "vendored"],
    ["package-lock.json", "vendored"],
    ["go.sum", "vendored"],

    // docs
    ["README.md", "docs"],
    ["docs/guide.rst", "docs"],

    // data
    ["data/cities.json", "data"],
    ["fixtures/sample.csv", "test"], // fixtures dir wins (test) before data

    // config (counted)
    ["config/database.yml", "config"],
    ["app.config.js", "config"],
    [".env.example", "config"],
    ["pyproject.toml", "config"],
    ["package.json", "config"], // manifest classified as config, not data
    ["packages/x/package.json", "config"],
  ];

  it.each(cases)("classifies %s as %s", (path, role) => {
    expect(classify(path)).toBe(role);
  });

  it("normalizes windows separators and leading ./", () => {
    expect(classify("src\\components\\Button.tsx")).toBe("app");
    expect(classify("./src/index.ts")).toBe("app");
  });

  it("precedence: a test file inside node_modules is vendored, not test", () => {
    expect(classify("node_modules/jest/foo.test.js")).toBe("vendored");
  });

  it("precedence: a workflow yaml is build, not config", () => {
    expect(classify(".github/workflows/release.yaml")).toBe("build");
  });

  it("explains its decision", () => {
    expect(classifyExplain("src/index.ts").role).toBe("app");
    expect(classifyExplain("Dockerfile").label).toMatch(/build/i);
  });
});
