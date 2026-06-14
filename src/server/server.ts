import { readFile } from "node:fs/promises";
import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { analyzeRepo } from "../analyze.js";
import { isInterval } from "../intervals.js";
import type { Interval } from "../types.js";
import { BusyError, clientIp, loadLimits, RateLimiter, Semaphore } from "./limits.js";

const ROOT = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const PUBLIC_DIR = path.join(ROOT, "public");
const CHARTJS = path.join(ROOT, "node_modules", "chart.js", "dist", "chart.umd.min.js");

// Self-hosted assets only — no external origins (no SRI/CDN-compromise surface).
const STATIC: Record<string, { file: string; type: string }> = {
  "/": { file: PUBLIC_DIR + "/index.html", type: "text/html; charset=utf-8" },
  "/index.html": { file: PUBLIC_DIR + "/index.html", type: "text/html; charset=utf-8" },
  "/app.js": { file: PUBLIC_DIR + "/app.js", type: "text/javascript; charset=utf-8" },
  "/styles.css": { file: PUBLIC_DIR + "/styles.css", type: "text/css; charset=utf-8" },
  "/vendor/chart.js": { file: CHARTJS, type: "text/javascript; charset=utf-8" },
};

function sse(res: ServerResponse, event: string, data: unknown): void {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

async function serveStatic(res: ServerResponse, entry: { file: string; type: string }): Promise<void> {
  try {
    const body = await readFile(entry.file);
    res.writeHead(200, {
      "content-type": entry.type,
      // Everything is same-origin; lock the CSP down to 'self'.
      "content-security-policy":
        "default-src 'self'; style-src 'self' 'unsafe-inline'; object-src 'none'; base-uri 'none'",
      "x-content-type-options": "nosniff",
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

  // Per-IP rate limit.
  if (!gate.rateLimiter.allow(clientIp(req), Date.now())) {
    sse(res, "fail", { message: "Rate limit exceeded. Please slow down and try again shortly." });
    res.end();
    return;
  }

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
}

export function createServer(): Server {
  const limits = loadLimits();
  // Let the engine's git ops honor the configured timeout.
  if (!process.env.LOCREPORT_GIT_TIMEOUT_MS) process.env.LOCREPORT_GIT_TIMEOUT_MS = String(limits.gitTimeoutMs);
  const gate: Gate = {
    limits,
    semaphore: new Semaphore(limits.maxConcurrent, limits.maxQueue),
    rateLimiter: new RateLimiter(limits.rateMax, limits.rateWindowMs),
  };

  return createHttpServer((req, res) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

    if (req.method === "GET" && url.pathname === "/api/analyze") {
      void handleAnalyze(req, res, url, gate);
      return;
    }

    const entry = STATIC[url.pathname];
    if (req.method === "GET" && entry) {
      void serveStatic(res, entry);
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
