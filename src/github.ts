/**
 * GitHub-only repo URL handling.
 *
 * We deliberately accept ONLY github.com repositories. This doubles as an
 * SSRF guard: the analyzer clones whatever URL it is handed, so we never want
 * to hand it an arbitrary internal host. Everything that isn't a recognizable
 * github.com repo is rejected.
 */

export interface GitHubRepo {
  owner: string;
  name: string;
  /** Canonical "owner/name". */
  slug: string;
  /** HTTPS clone URL we will actually pass to git. */
  cloneUrl: string;
  /** Canonical web URL. */
  htmlUrl: string;
}

// GitHub owner and repo name constraints.
// Owner: alphanumeric or single hyphens. Repo: word chars, dots, hyphens.
const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/;
const REPO = /^[A-Za-z0-9_.-]{1,100}$/;

function cleanRepoName(name: string): string {
  return name.replace(/\.git$/i, "");
}

function build(owner: string, name: string): GitHubRepo | null {
  const repo = cleanRepoName(name);
  if (!OWNER.test(owner) || !REPO.test(repo)) return null;
  // Reject the pathological ".." / "." repo names that pass REPO.
  if (repo === "." || repo === "..") return null;
  const slug = `${owner}/${repo}`;
  return {
    owner,
    name: repo,
    slug,
    cloneUrl: `https://github.com/${slug}.git`,
    htmlUrl: `https://github.com/${slug}`,
  };
}

/**
 * Parse a user-supplied reference into a GitHub repo, or return null if it is
 * not an acceptable github.com repository.
 *
 * Accepts:
 *   - https://github.com/owner/repo[.git][/...]
 *   - git@github.com:owner/repo.git
 *   - ssh://git@github.com/owner/repo.git
 *   - owner/repo (shorthand)
 */
export function parseGitHubRepo(input: string): GitHubRepo | null {
  const raw = input.trim();
  if (!raw) return null;

  // scp-like SSH form: git@github.com:owner/repo.git
  const scp = /^git@github\.com:([^/]+)\/(.+)$/i.exec(raw);
  if (scp) return build(scp[1]!, firstSegment(scp[2]!));

  // URL forms (https / ssh / git).
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      return null;
    }
    if (!["https:", "http:", "ssh:", "git:"].includes(url.protocol)) return null;
    // Hostname must be exactly github.com (no userinfo tricks, no subdomains).
    if (url.hostname.toLowerCase() !== "github.com") return null;
    const parts = url.pathname.replace(/^\/+/, "").split("/");
    if (parts.length < 2) return null;
    return build(parts[0]!, parts[1]!);
  }

  // Shorthand: owner/repo
  const short = /^([^/\s]+)\/([^/\s]+)$/.exec(raw);
  if (short) return build(short[1]!, short[2]!);

  return null;
}

function firstSegment(path: string): string {
  return path.replace(/^\/+/, "").split("/")[0]!;
}

/**
 * Result of a GitHub repo metadata lookup. `unavailable` (rate limit, network
 * error, unexpected status) is deliberately distinct from `not_found` so the
 * caller can treat it as best-effort and fall back rather than failing.
 */
export type RepoInfo =
  | { kind: "ok"; sizeKb: number; defaultBranch: string; private: boolean }
  | { kind: "not_found" }
  | { kind: "unavailable"; status?: number };

const GITHUB_API = "https://api.github.com";

/**
 * Look up a repo's metadata via the GitHub REST API — notably `size` (KB), used
 * to reject oversized repos before cloning. Talks only to api.github.com (a
 * hardcoded host, so no SSRF surface). Uses `GITHUB_TOKEN` when set for a higher
 * rate limit. Never throws: transport/HTTP problems are reported as a result so
 * the caller can fall back to the post-clone size guard.
 */
export async function fetchRepoInfo(repo: GitHubRepo, opts: { token?: string; timeoutMs?: number } = {}): Promise<RepoInfo> {
  const url = `${GITHUB_API}/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}`;
  const headers: Record<string, string> = {
    accept: "application/vnd.github+json",
    "user-agent": "locreport",
    "x-github-api-version": "2022-11-28",
  };
  const token = opts.token ?? process.env.GITHUB_TOKEN;
  if (token) headers.authorization = `Bearer ${token}`;

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), opts.timeoutMs ?? 10_000);
  try {
    const res = await fetch(url, { headers, signal: ac.signal });
    if (res.status === 404) return { kind: "not_found" };
    if (!res.ok) return { kind: "unavailable", status: res.status };
    const data = (await res.json()) as { size?: number; default_branch?: string; private?: boolean };
    return {
      kind: "ok",
      sizeKb: typeof data.size === "number" ? data.size : 0,
      defaultBranch: typeof data.default_branch === "string" ? data.default_branch : "",
      private: data.private === true,
    };
  } catch {
    return { kind: "unavailable" }; // network error / timeout / abort
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Decide, from repo metadata, whether cloning should be blocked. Throws for a
 * missing or over-limit repo; returns (allowing the clone) otherwise — including
 * when info is `unavailable`, which deliberately falls through to the post-clone
 * size guard so GitHub API flakiness can't block analyses.
 */
export function assertRepoWithinLimit(info: RepoInfo, slug: string, maxRepoMb: number): void {
  if (info.kind === "not_found") throw new Error(`Repository not found: ${slug}`);
  if (info.kind === "ok" && info.sizeKb / 1024 > maxRepoMb) {
    throw new Error(`Repository too large: ${Math.round(info.sizeKb / 1024)} MB exceeds the ${maxRepoMb} MB limit`);
  }
}
