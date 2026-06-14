import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer } from "../src/server/server.js";

let server: Server;
let base: string;

beforeAll(async () => {
  server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  base = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("static serving", () => {
  it("serves the index page with a locked-down CSP", async () => {
    const res = await fetch(`${base}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const csp = res.headers.get("content-security-policy") ?? "";
    expect(csp).toContain("default-src 'self'");
    expect(csp).not.toContain("cdn.jsdelivr.net"); // no external origins
    expect(await res.text()).toContain("locreport");
  });

  it("serves the self-hosted Chart.js bundle", async () => {
    const res = await fetch(`${base}/vendor/chart.js`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("javascript");
    expect((await res.text()).length).toBeGreaterThan(1000);
  });

  it("404s unknown paths", async () => {
    expect((await fetch(`${base}/nope`)).status).toBe(404);
  });
});

describe("/api/analyze SSE", () => {
  it("emits a 'fail' event for an invalid (non-GitHub) repo, without cloning", async () => {
    const res = await fetch(`${base}/api/analyze?repo=${encodeURIComponent("https://gitlab.com/a/b")}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const body = await res.text();
    expect(body).toContain("event: fail");
    expect(body).toContain("valid GitHub repository");
  });

  it("reports a missing repo parameter", async () => {
    const body = await (await fetch(`${base}/api/analyze`)).text();
    expect(body).toContain("event: fail");
    expect(body).toContain("Missing");
  });
});

describe("rate limiting", () => {
  let rlServer: Server;
  let rlBase: string;

  beforeAll(async () => {
    process.env.LOCREPORT_RATE_MAX = "1";
    rlServer = createServer();
    await new Promise<void>((resolve) => rlServer.listen(0, "127.0.0.1", resolve));
    rlBase = `http://127.0.0.1:${(rlServer.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    delete process.env.LOCREPORT_RATE_MAX;
    await new Promise<void>((resolve) => rlServer.close(() => resolve()));
  });

  it("blocks a second request from the same client within the window", async () => {
    // Both use a rejected-but-well-formed repo so they fail fast without cloning.
    const q = `repo=${encodeURIComponent("https://gitlab.com/a/b")}`;
    const first = await (await fetch(`${rlBase}/api/analyze?${q}`)).text();
    const second = await (await fetch(`${rlBase}/api/analyze?${q}`)).text();
    expect(first).not.toContain("Rate limit");
    expect(first).toContain("valid GitHub repository");
    expect(second).toContain("Rate limit");
  });
});
