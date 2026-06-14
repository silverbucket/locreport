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
