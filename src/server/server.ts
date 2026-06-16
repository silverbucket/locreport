import { readFile, stat } from "node:fs/promises";
import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { analyzeRepo } from "../analyze.js";
import { isInterval } from "../intervals.js";
import type { Interval } from "../types.js";
import { BusyError, clientIp, InFlightTracker, loadLimits, RateLimiter, Semaphore } from "./limits.js";

const ROOT = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const PUBLIC_DIR = path.join(ROOT, "public");
const CHARTJS = path.join(ROOT, "node_modules", "chart.js", "dist", "chart.umd.min.js");
const INDEX_HTML = path.join(PUBLIC_DIR, "index.html");

const INCLUDES_MARKER = "<!-- locreport:includes -->";
const VERSION_MARKER = "<!-- locreport:version -->";

// App version, read once from package.json (alongside ROOT) and shown in the UI.
let versionCache: string | undefined;
async function appVersion(): Promise<string> {
  if (versionCache !== undefined) return versionCache;
  try {
    const pkg = JSON.parse(await readFile(path.join(ROOT, "package.json"), "utf8")) as { version?: string };
    versionCache = pkg.version && pkg.version !== "0.0.0" ? `v${pkg.version}` : "";
  } catch {
    versionCache = "";
  }
  return versionCache;
}

// Optional operator-provided HTML spliced into the page <head> (analytics tags,
// custom meta, etc.). Gitignored by default and baked into the image at build
// time if present; absent in the published source. See public/includes.example.html.
function includesFile(): string {
  return process.env.LOCREPORT_INCLUDES_FILE
    ? path.resolve(process.env.LOCREPORT_INCLUDES_FILE)
    : path.join(PUBLIC_DIR, "includes.html");
}

// Everything is same-origin, so the default CSP is locked to 'self'. An include
// that pulls in external or inline resources will be blocked by this — operators
// who add such includes can override the document CSP wholesale via LOCREPORT_CSP.
const DEFAULT_CSP = "default-src 'self'; style-src 'self' 'unsafe-inline'; object-src 'none'; base-uri 'none'";
function htmlCsp(): string {
  return process.env.LOCREPORT_CSP?.trim() || DEFAULT_CSP;
}

// Self-hosted assets only — no external origins (no SRI/CDN-compromise surface).
const STATIC: Record<string, { file: string; type: string }> = {
  "/app.js": { file: PUBLIC_DIR + "/app.js", type: "text/javascript; charset=utf-8" },
  "/styles.css": { file: PUBLIC_DIR + "/styles.css", type: "text/css; charset=utf-8" },
  "/favicon.svg": { file: PUBLIC_DIR + "/favicon.svg", type: "image/svg+xml" },
  "/vendor/chart.js": { file: CHARTJS, type: "text/javascript; charset=utf-8" },
};

function sse(res: ServerResponse, event: string, data: unknown): void {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

async function serveStatic(req: IncomingMessage, res: ServerResponse, entry: { file: string; type: string }): Promise<void> {
  try {
    // Assets aren't fingerprinted, so cache briefly + revalidate via a weak
    // ETag (size+mtime). Repeat loads within max-age skip the request; after
    // that a conditional GET gets a cheap 304, and a deploy is picked up fast.
    const st = await stat(entry.file);
    const etag = `W/"${st.size.toString(16)}-${Math.round(st.mtimeMs).toString(16)}"`;
    const headers: Record<string, string> = {
      "content-type": entry.type,
      "content-security-policy": htmlCsp(),
      "x-content-type-options": "nosniff",
      "cache-control": "public, max-age=300",
      etag,
    };
    if (req.headers["if-none-match"] === etag) {
      res.writeHead(304, headers);
      res.end();
      return;
    }
    res.writeHead(200, headers);
    res.end(await readFile(entry.file));
  } catch {
    res.writeHead(404, { "content-type": "text/plain" }).end("Not found");
  }
}

// Serve index.html with the optional includes file spliced into the marker.
// A function replacement avoids `$`-pattern interpretation in the included text.
async function serveIndex(res: ServerResponse): Promise<void> {
  try {
    const html = await readFile(INDEX_HTML, "utf8");
    let includes = "";
    try {
      includes = await readFile(includesFile(), "utf8");
    } catch {
      // No includes file — render the page as-is.
    }
    const version = await appVersion();
    const body = html.replace(INCLUDES_MARKER, () => includes).replace(VERSION_MARKER, () => version);
    res.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "content-security-policy": htmlCsp(),
      "x-content-type-options": "nosniff",
      // Rendered per request (version + includes markers) — never cache it.
      "cache-control": "no-store",
    });
    res.end(body);
  } catch {
    res.writeHead(404, { "content-type": "text/plain" }).end("Not found");
  }
}

interface Gate {
  limits: ReturnType<typeof loadLimits>;
  semaphore: Semaphore;
  rateLimiter: RateLimiter;
  perIp: InFlightTracker;
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer)) as Promise<T>;
}

async function handleAnalyze(req: IncomingMessage, res: ServerResponse, url: URL, gate: Gate): Promise<void> {
  const repo = url.searchParams.get("repo")?.trim() ?? "";
  const intervalRaw = url.searchParams.get("interval") ?? "1y";
  const interval: Interval = isInterval(intervalRaw) ? intervalRaw : "1y";
  // The web UI always wants per-package data so the "By package" view works
  // without a re-run; opt out only with an explicit byPackage=0.
  const byPackage = (url.searchParams.get("byPackage") ?? "1") !== "0";
  const cohort = ["1", "true", "yes"].includes((url.searchParams.get("cohort") ?? "").toLowerCase());
  const branch = url.searchParams.get("branch")?.trim() || undefined;

  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  });

  let closed = false;
  req.on("close", () => {
    closed = true;
  });

  if (!repo) {
    sse(res, "fail", { message: "Missing ?repo parameter." });
    res.end();
    return;
  }

  const ip = clientIp(req, gate.limits.trustProxy);

  // Per-IP rate limit.
  if (!gate.rateLimiter.allow(ip, Date.now())) {
    sse(res, "fail", { message: "Rate limit exceeded. Please slow down and try again shortly." });
    res.end();
    return;
  }

  // Per-IP in-flight cap: one client can't occupy every slot and flood the
  // queue. Counts running + queued analyses for this IP; released in finally.
  if (!gate.perIp.tryEnter(ip, gate.limits.maxPerIp)) {
    sse(res, "fail", { message: "Too many analyses in progress from your address. Let one finish and try again." });
    res.end();
    return;
  }

  try {
    // Bounded concurrency (with a small queue).
    let release: (() => void) | null = null;
    try {
      release = await gate.semaphore.acquire();
    } catch (err) {
      if (err instanceof BusyError) {
        sse(res, "fail", { message: err.message });
        res.end();
        return;
      }
      throw err;
    }

    try {
      const report = await withTimeout(
        analyzeRepo(repo, {
          interval,
          branch,
          byPackage,
          cohort,
          maxRepoMb: gate.limits.maxRepoMb,
          onProgress: (e) => {
            if (!closed) sse(res, "progress", e);
          },
        }),
        gate.limits.analysisTimeoutMs,
        "Analysis timed out.",
      );
      if (!closed) {
        sse(res, "done", report);
        res.end();
      }
    } catch (err) {
      if (!closed) {
        sse(res, "fail", { message: (err as Error).message });
        res.end();
      }
    } finally {
      release();
    }
  } finally {
    gate.perIp.exit(ip);
  }
}

export function createServer(): Server {
  const limits = loadLimits();
  // Let the engine's git ops honor the configured timeout.
  if (!process.env.LOCREPORT_GIT_TIMEOUT_MS) process.env.LOCREPORT_GIT_TIMEOUT_MS = String(limits.gitTimeoutMs);
  const gate: Gate = {
    limits,
    semaphore: new Semaphore(limits.maxConcurrent, limits.maxQueue),
    rateLimiter: new RateLimiter(limits.rateMax, limits.rateWindowMs),
    perIp: new InFlightTracker(),
  };

  return createHttpServer((req, res) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

    if (req.method === "GET" && url.pathname === "/api/analyze") {
      void handleAnalyze(req, res, url, gate);
      return;
    }

    if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
      void serveIndex(res);
      return;
    }

    const entry = STATIC[url.pathname];
    if (req.method === "GET" && entry) {
      void serveStatic(req, res, entry);
      return;
    }

    res.writeHead(404, { "content-type": "text/plain" }).end("Not found");
  });
}

// Start when run directly (not when imported by tests).
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) {
  const port = Number(process.env.PORT ?? 4317);
  createServer().listen(port, () => {
    process.stdout.write(`locreport web UI → http://localhost:${port}\n`);
  });
}
