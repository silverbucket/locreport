import { describe, expect, it } from "vitest";
import { parseGitHubRepo } from "../src/github.js";

describe("parseGitHubRepo", () => {
  it("parses https URLs", () => {
    const r = parseGitHubRepo("https://github.com/erikbern/git-of-theseus");
    expect(r).toMatchObject({
      owner: "erikbern",
      name: "git-of-theseus",
      slug: "erikbern/git-of-theseus",
      cloneUrl: "https://github.com/erikbern/git-of-theseus.git",
      htmlUrl: "https://github.com/erikbern/git-of-theseus",
    });
  });

  it("strips a trailing .git and ignores extra path segments", () => {
    expect(parseGitHubRepo("https://github.com/a/b.git/tree/main")).toMatchObject({ slug: "a/b" });
    expect(parseGitHubRepo("https://github.com/a/b.git")).toMatchObject({ name: "b" });
  });

  it("parses scp-style ssh", () => {
    expect(parseGitHubRepo("git@github.com:torvalds/linux.git")).toMatchObject({ slug: "torvalds/linux" });
  });

  it("parses ssh:// URLs", () => {
    expect(parseGitHubRepo("ssh://git@github.com/torvalds/linux.git")).toMatchObject({ slug: "torvalds/linux" });
  });

  it("parses owner/repo shorthand", () => {
    expect(parseGitHubRepo("XAMPPRocky/tokei")).toMatchObject({ slug: "XAMPPRocky/tokei" });
  });

  it("trims surrounding whitespace", () => {
    expect(parseGitHubRepo("  a/b  ")).toMatchObject({ slug: "a/b" });
  });

  // --- rejection / SSRF guard ---------------------------------------------
  it.each([
    "",
    "   ",
    "https://gitlab.com/a/b",
    "https://example.com/a/b",
    "https://github.com.evil.com/a/b",
    "https://github.com/onlyowner",
    "https://github.com/",
    "http://169.254.169.254/latest/meta-data",
    "file:///etc/passwd",
    "ftp://github.com/a/b",
    "git@gitlab.com:a/b.git",
    "javascript:alert(1)",
    "a/b/c/d", // not shorthand, not a URL
  ])("rejects %j", (input) => {
    expect(parseGitHubRepo(input)).toBeNull();
  });

  it("rejects a userinfo host-spoofing attempt", () => {
    // hostname is evil.com, github.com is only in userinfo
    expect(parseGitHubRepo("https://github.com@evil.com/a/b")).toBeNull();
  });

  it("rejects invalid owner/repo characters", () => {
    expect(parseGitHubRepo("https://github.com/bad owner/repo")).toBeNull();
    expect(parseGitHubRepo("https://github.com/a/..")).toBeNull();
  });
});
