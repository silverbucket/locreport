import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchRepoInfo, parseGitHubRepo } from "../src/github.js";

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

describe("fetchRepoInfo", () => {
  const repo = parseGitHubRepo("erikbern/git-of-theseus")!;
  afterEach(() => vi.unstubAllGlobals());

  function stubFetch(impl: (url: string, init: RequestInit) => unknown) {
    const mock = vi.fn(impl as never);
    vi.stubGlobal("fetch", mock);
    return mock;
  }

  it("returns size, default branch and visibility on 200", async () => {
    stubFetch(() => ({
      ok: true,
      status: 200,
      json: async () => ({ size: 4096, default_branch: "main", private: false }),
    }));
    expect(await fetchRepoInfo(repo)).toEqual({ kind: "ok", sizeKb: 4096, defaultBranch: "main", private: false });
  });

  it("queries api.github.com for the repo and sends an auth header when given a token", async () => {
    const mock = stubFetch(() => ({ ok: true, status: 200, json: async () => ({ size: 1 }) }));
    await fetchRepoInfo(repo, { token: "secret" });
    const [url, init] = mock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.github.com/repos/erikbern/git-of-theseus");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer secret");
  });

  it("reports a 404 as not_found", async () => {
    stubFetch(() => ({ ok: false, status: 404, json: async () => ({}) }));
    expect(await fetchRepoInfo(repo)).toEqual({ kind: "not_found" });
  });

  it("reports a rate limit (403) as unavailable, not fatal", async () => {
    stubFetch(() => ({ ok: false, status: 403, json: async () => ({}) }));
    expect(await fetchRepoInfo(repo)).toEqual({ kind: "unavailable", status: 403 });
  });

  it("treats a network error as unavailable", async () => {
    stubFetch(() => {
      throw new Error("ENOTFOUND");
    });
    expect(await fetchRepoInfo(repo)).toEqual({ kind: "unavailable" });
  });
});
