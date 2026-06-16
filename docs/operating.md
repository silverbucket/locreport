# Running a locreport server

This guide is for running the locreport **web server**, especially one open to
the public. The server clones GitHub repos that visitors ask for, so it comes
with limits that stop one person (or a large repo) from using up all its
resources.

For everyday command-line use, see the [README](../README.md).

## Run it with Docker

Pull and run the image:

```bash
docker run -p 4317:4317 -v locreport-cache:/cache ghcr.io/silverbucket/locreport
```

Or use the included Compose file, which also applies the security settings below:

```bash
docker compose up -d
```

Tags: `:latest` is the newest release, `:1.1.0` pins a version, `:edge` follows
`master`.

The image runs as a non-root user, includes `git` and `cloc`, and stores its
cache in the `/cache` volume.

## Security settings

`docker-compose.yml` locks the container down so a bad repo can't harm the host:

- The root filesystem is read-only; the app only writes to `/cache` and `/tmp`.
- All extra Linux permissions are dropped.
- Memory, CPU, and process count are capped.

Adjust the caps to fit your server, and run `docker compose up` once to check
everything still works. See `docker-compose.yml` for the exact values.

Docker does not limit the size of the cache volume. Set a disk budget with
`LOCREPORT_MAX_CACHE_MB` (see [Cache settings](#cache-settings)), and add a disk
quota if the volume is shared.

## Put it behind a proxy

For a public site, run a reverse proxy (nginx, Caddy, etc.) in front to handle
HTTPS.

locreport limits requests per visitor using their IP address. By default it uses
the network connection's address and **ignores the `X-Forwarded-For` header**,
because anyone can fake that header to get around the limits. When you run behind
a proxy that sets the header, turn on `LOCREPORT_TRUST_PROXY=1` so the real
visitor IP is used.

If you use a proxy but forget this setting, every request looks like it comes
from the proxy, so the per-visitor limits apply to everyone at once.

## Request limits

The server clones repos on demand, so it caps how much work visitors can ask
for. All of these can be set as environment variables.

| Setting | Default | What it does |
| --- | --- | --- |
| `LOCREPORT_MAX_CONCURRENT` | 2 | analyses running at the same time (whole server) |
| `LOCREPORT_MAX_PER_IP` | 2 | analyses one visitor can run or queue at once |
| `LOCREPORT_MAX_QUEUE` | 10 | how many requests can wait before the server says "busy" |
| `LOCREPORT_RATE_MAX` / `LOCREPORT_RATE_WINDOW_MS` | 30 / 60000 | requests per visitor per minute |
| `LOCREPORT_MAX_REPO_MB` | 2048 | reject repos bigger than this |
| `LOCREPORT_GIT_TIMEOUT_MS` | 300000 | time limit for each git command |
| `LOCREPORT_ANALYSIS_TIMEOUT_MS` | 600000 | time limit for one analysis |
| `LOCREPORT_TRUST_PROXY` | off | trust `X-Forwarded-For` (only behind a proxy) |

locreport only accepts `github.com` repos, which also keeps it from being pointed
at other servers.

**Repo size check.** The size limit is checked twice: once before cloning (using
the GitHub API) and once after. The first check needs the GitHub API, so if that
is unavailable the repo is cloned first and rejected after.

**GitHub token.** Without a token, the GitHub API allows only 60 checks per hour,
shared by everyone. On a busy site, set `GITHUB_TOKEN` to raise that limit. The
token only needs read access to public repos.

## Cache settings

locreport caches its work so repeat requests are fast. The cache holds three
things: the cloned repos, the per-commit counts, and the finished reports.

The cache lives at `/cache` in the container (or `~/.cache/locreport` on the
command line). It cleans up after itself:

| Setting | Default | What it does |
| --- | --- | --- |
| `LOCREPORT_CACHE_DIR` | `~/.cache/locreport` | where the cache lives |
| `LOCREPORT_MAX_CACHE_MB` | 5120 | disk budget for cloned repos (0 = no limit) |
| `LOCREPORT_CACHE_MAX_AGE_DAYS` | 30 | delete unused cache files older than this (0 = keep) |
| `LOCREPORT_CACHE_SWEEP_MS` | 21600000 | how often cleanup runs (6 hours) |

When the cloned repos go over the disk budget, the oldest ones are removed. A repo
that is being analyzed right now is never removed, so the cache can briefly go
over budget during a busy spell — leave some headroom.

Cleanup also runs on startup and on a timer to delete old count and report files,
so the cache stays bounded even when the server is idle.

To clear the cache by hand, delete the cache directory.

## Custom page content

You can add your own HTML to the page `<head>` (for example, analytics) without
committing it. Put it in `public/includes.html` — it's git-ignored and added to
the page when present. See
[`public/includes.example.html`](../public/includes.example.html) for an example.

| Setting | Default | What it does |
| --- | --- | --- |
| `LOCREPORT_INCLUDES_FILE` | `public/includes.html` | path to the include file |
| `LOCREPORT_CSP` | locked to your site | override the Content-Security-Policy |

The page normally only allows content from your own site. If your include loads
anything from another site, set `LOCREPORT_CSP` to allow it.

## Public site checklist

1. Use the Compose security settings and test them.
2. Add an HTTPS proxy and set `LOCREPORT_TRUST_PROXY=1`.
3. Set `GITHUB_TOKEN`.
4. Give the cache volume room above `LOCREPORT_MAX_CACHE_MB`.
5. Adjust the request limits to fit your server.
