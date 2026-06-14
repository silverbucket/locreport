"use strict";

const $ = (id) => document.getElementById(id);
const EXCLUDED = new Set(["build", "vendored"]);
const ROLE_SERIES = [
  ["app", "App", "#4f8cff"],
  ["test", "Tests", "#2dd4bf"],
  ["config", "Config", "#f59e0b"],
  ["docs", "Docs", "#a78bfa"],
  ["data", "Data", "#f472b6"],
];
const METRIC_LABEL = {
  app: "App code",
  test: "Tests",
  config: "Config",
  docs: "Docs",
  data: "Data",
  comments: "Comments",
  countedCode: "Total (counted)",
};
const MAX_PKG_SERIES = 14; // group the long tail into "Other" beyond this

let chart = null;
let report = null;
let view = "role"; // "role" | "pkg"
let metric = "app";

/** Reduce a role->bucket map to headline numbers (mirrors src/report.ts). */
function summarize(byRole) {
  let comments = 0;
  let countedCode = 0;
  let excluded = 0;
  for (const [role, b] of Object.entries(byRole)) {
    if (EXCLUDED.has(role)) excluded += b.code;
    else {
      countedCode += b.code;
      comments += b.comment;
    }
  }
  return {
    app: byRole.app.code,
    test: byRole.test.code,
    config: byRole.config.code,
    docs: byRole.docs.code,
    data: byRole.data.code,
    comments,
    countedCode,
    excluded,
  };
}

const n = (v) => Number(v).toLocaleString("en-US");

/** Escape text for safe interpolation into HTML (package names are repo-controlled). */
function esc(s) {
  return String(s).replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
  );
}

// ---------------------------------------------------------------------------
// Tables
// ---------------------------------------------------------------------------

function table(rows, firstHeader, firstKey) {
  const cols = [
    [firstKey, firstHeader],
    ["app", "App"],
    ["test", "Tests"],
    ["config", "Config"],
    ["docs", "Docs"],
    ["data", "Data"],
    ["comments", "Comments"],
    ["countedCode", "Total"],
    ["excluded", "Excl.*"],
  ];
  const thead = `<thead><tr>${cols.map(([, h]) => `<th>${h}</th>`).join("")}</tr></thead>`;
  const body = rows
    .map((r) => {
      const tds = cols
        .map(([k]) => {
          const cls = k === "excluded" ? ' class="excl"' : "";
          const val = k === firstKey ? esc(r[firstKey]) : n(r[k]);
          return `<td${cls}>${val}</td>`;
        })
        .join("");
      return `<tr>${tds}</tr>`;
    })
    .join("");
  return `<table>${thead}<tbody>${body}</tbody></table>`;
}

function renderTables() {
  const rows = report.snapshots.map((s) => ({ date: s.date, ...summarize(s.byRole) }));
  $("table").innerHTML = table(rows, "Date", "date");

  const last = report.snapshots[report.snapshots.length - 1];
  const pkgs = (last && last.byPackage) || [];
  if (pkgs.length) {
    const pkgRows = pkgs.map((p) => ({ pkg: p.name || "(root)", ...summarize(p.byRole) }));
    $("pkg-table").innerHTML = table(pkgRows, "Package", "pkg");
    $("pkg-date").textContent = `(latest snapshot: ${last.date})`;
  }
  $("role-tables").hidden = view !== "role";
  $("packages").hidden = view !== "pkg" || !pkgs.length;
}

// ---------------------------------------------------------------------------
// Per-package series (one value per package per snapshot, for a chosen metric)
// ---------------------------------------------------------------------------

function packageSeries(metricKey) {
  // Latest name per id (names can in principle change over time).
  const nameById = new Map();
  for (const s of report.snapshots) for (const p of s.byPackage || []) nameById.set(p.id, p.name || "(root)");

  const ids = [...nameById.keys()];
  const valueById = new Map(
    ids.map((id) => [
      id,
      report.snapshots.map((s) => {
        const p = (s.byPackage || []).find((x) => x.id === id);
        return p ? summarize(p.byRole)[metricKey] : 0;
      }),
    ]),
  );

  const lastOf = (arr) => arr[arr.length - 1] || 0;
  ids.sort((a, b) => lastOf(valueById.get(b)) - lastOf(valueById.get(a)));

  let series = ids.map((id) => ({ label: nameById.get(id), values: valueById.get(id) }));

  // Group the long tail into a single "Other" band for readability.
  if (series.length > MAX_PKG_SERIES) {
    const head = series.slice(0, MAX_PKG_SERIES - 1);
    const tail = series.slice(MAX_PKG_SERIES - 1);
    const other = report.snapshots.map((_, i) => tail.reduce((sum, s) => sum + s.values[i], 0));
    head.push({ label: `Other (${tail.length})`, values: other, other: true });
    series = head;
  }
  return series;
}

// ---------------------------------------------------------------------------
// Charts
// ---------------------------------------------------------------------------

function pkgColor(i, total, isOther) {
  if (isOther) return { border: "#6b7280", fill: "#6b7280cc" };
  const hue = Math.round((i * 360) / Math.max(total, 1));
  return { border: `hsl(${hue} 62% 55%)`, fill: `hsl(${hue} 62% 55% / 0.8)` };
}

function drawChart(labels, datasets, yTitle) {
  const cfg = {
    type: "line",
    data: { labels, datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: "index", intersect: false },
      scales: {
        x: { stacked: true, grid: { color: "#262b36" }, ticks: { color: "#98a2b3" } },
        y: {
          stacked: true,
          grid: { color: "#262b36" },
          ticks: { color: "#98a2b3", callback: (v) => n(v) },
          title: { display: true, text: yTitle, color: "#98a2b3" },
        },
      },
      plugins: {
        legend: { labels: { color: "#e6e9ef", boxWidth: 12 } },
        tooltip: { callbacks: { label: (c) => `${c.dataset.label}: ${n(c.parsed.y)}` } },
      },
    },
  };
  if (chart) chart.destroy();
  chart = new Chart($("chart"), cfg);
}

function renderChart() {
  const labels = report.snapshots.map((s) => s.date);

  if (view === "role") {
    const summaries = report.snapshots.map((s) => summarize(s.byRole));
    const datasets = ROLE_SERIES.map(([key, label, color]) => ({
      label,
      data: summaries.map((s) => s[key]),
      backgroundColor: color + "cc",
      borderColor: color,
      borderWidth: 1,
      fill: true,
      pointRadius: 0,
      tension: 0.2,
    }));
    drawChart(labels, datasets, "Lines of code");
    return;
  }

  const series = packageSeries(metric);
  const datasets = series.map((s, i) => {
    const color = pkgColor(i, series.length, s.other);
    return {
      label: s.label,
      data: s.values,
      backgroundColor: color.fill,
      borderColor: color.border,
      borderWidth: 1,
      fill: true,
      pointRadius: 0,
      tension: 0.2,
    };
  });
  drawChart(labels, datasets, `${METRIC_LABEL[metric]} — lines of code`);
}

// ---------------------------------------------------------------------------
// View wiring
// ---------------------------------------------------------------------------

function setView(next) {
  view = next;
  $("view-role").classList.toggle("active", view === "role");
  $("view-pkg").classList.toggle("active", view === "pkg");
  $("metric-wrap").hidden = view !== "pkg";
  if (!report) return;
  renderChart();
  renderTables();
}

$("view-role").addEventListener("click", () => setView("role"));
$("view-pkg").addEventListener("click", () => setView("pkg"));
$("metric").addEventListener("change", (e) => {
  metric = e.target.value;
  if (report && view === "pkg") renderChart();
});

function setStatus(msg, isError) {
  const el = $("status");
  el.hidden = false;
  el.textContent = msg;
  el.classList.toggle("error", !!isError);
}

$("form").addEventListener("submit", (ev) => {
  ev.preventDefault();
  const repo = $("repo").value.trim();
  if (!repo) return;

  const params = new URLSearchParams({ repo, interval: $("interval").value });

  $("go").disabled = true;
  $("results").hidden = true;
  setStatus("Connecting…");

  const es = new EventSource(`/api/analyze?${params}`);

  es.addEventListener("progress", (e) => {
    const p = JSON.parse(e.data);
    if (p.type === "cloning") setStatus(`Cloning ${p.repo}…`);
    else if (p.type === "resolved")
      setStatus(`Branch ${p.branch} · counter "${p.counter}" · ${p.snapshots} snapshots…`);
    else if (p.type === "snapshot") setStatus(`Analyzing ${p.index}/${p.total} — ${p.date}…`);
  });

  es.addEventListener("done", (e) => {
    report = JSON.parse(e.data);
    es.close();
    $("go").disabled = false;
    setStatus(`Done — ${report.snapshots.length} snapshots of ${report.repoUrl}`);
    renderChart();
    renderTables();
    $("results").hidden = false;
  });

  es.addEventListener("fail", (e) => {
    es.close();
    $("go").disabled = false;
    setStatus(`Error: ${JSON.parse(e.data).message}`, true);
  });

  es.onerror = () => {
    if (es.readyState === EventSource.CLOSED && $("go").disabled) {
      $("go").disabled = false;
      setStatus("Connection closed before completion.", true);
    }
  };
});
