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
const TABLE_COLS = [
  ["app", "App"],
  ["test", "Tests"],
  ["config", "Config"],
  ["docs", "Docs"],
  ["data", "Data"],
  ["comments", "Comments"],
  ["countedCode", "Total"],
  ["excluded", "Excl."],
];
// Show every package individually up to this many; only collapse the tail into
// "Other" for genuinely large monorepos (keeps the legend/stack readable).
const MAX_PKG_SERIES = 30;

let chart = null;
let report = null;
let view = "role"; // "role" | "pkg"
let metric = "app";
let stacked = true;

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
  const cols = [[firstKey, firstHeader], ...TABLE_COLS];
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

function intervalRows() {
  return report.snapshots.map((s) => ({ date: s.date, ...summarize(s.byRole) }));
}

function packageRows() {
  const last = report.snapshots[report.snapshots.length - 1];
  return ((last && last.byPackage) || []).map((p) => ({ pkg: p.name || "(root)", ...summarize(p.byRole) }));
}

function renderTables() {
  $("table").innerHTML = table(intervalRows(), "Date", "date");
  const pkgRows = packageRows();
  if (pkgRows.length) {
    const last = report.snapshots[report.snapshots.length - 1];
    $("pkg-table").innerHTML = table(pkgRows, "Package", "pkg");
    $("pkg-date").textContent = `(latest snapshot: ${last.date})`;
  }
  $("role-tables").hidden = view !== "role";
  $("packages").hidden = view !== "pkg" || !pkgRows.length;
}

// ---------------------------------------------------------------------------
// Per-package series (one value per package per snapshot, for a chosen metric)
// ---------------------------------------------------------------------------

function packageSeries(metricKey) {
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

/** Legend click isolates one series; clicking the isolated one restores all. */
function legendIsolate(_e, item, legend) {
  const ci = legend.chart;
  const idx = item.datasetIndex;
  const onlyThis = ci.data.datasets.every((_, i) => ci.isDatasetVisible(i) === (i === idx));
  ci.data.datasets.forEach((_, i) => ci.setDatasetVisibility(i, onlyThis ? true : i === idx));
  ci.update();
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
        x: { stacked, grid: { color: "#262b36" }, ticks: { color: "#98a2b3" } },
        y: {
          stacked,
          grid: { color: "#262b36" },
          ticks: { color: "#98a2b3", callback: (v) => n(v) },
          title: { display: true, text: yTitle, color: "#98a2b3" },
        },
      },
      plugins: {
        legend: { labels: { color: "#e6e9ef", boxWidth: 12 }, onClick: legendIsolate },
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
      borderWidth: stacked ? 1 : 2,
      fill: stacked,
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
      borderWidth: stacked ? 1 : 2,
      fill: stacked,
      pointRadius: 0,
      tension: 0.2,
    };
  });
  drawChart(labels, datasets, `${METRIC_LABEL[metric]} — lines of code`);
}

function render() {
  renderChart();
  renderTables();
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

function repoSlug() {
  try {
    return new URL(report.repoUrl).pathname.replace(/^\/+/, "").replace(/\//g, "-") || "report";
  } catch {
    return "report";
  }
}

function download(name, text, type) {
  const blob = new Blob([text], { type });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

function csvCell(v) {
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function toCsv(rows, firstHeader, firstKey) {
  const cols = [[firstKey, firstHeader], ...TABLE_COLS];
  const lines = [cols.map(([, h]) => csvCell(h)).join(",")];
  for (const r of rows) lines.push(cols.map(([k]) => csvCell(r[k])).join(","));
  return lines.join("\n");
}

function exportCsv() {
  if (!report) return;
  if (view === "pkg") {
    download(`locreport-${repoSlug()}-packages.csv`, toCsv(packageRows(), "Package", "pkg"), "text/csv");
  } else {
    download(`locreport-${repoSlug()}.csv`, toCsv(intervalRows(), "Date", "date"), "text/csv");
  }
}

function exportJson() {
  if (!report) return;
  download(`locreport-${repoSlug()}.json`, JSON.stringify(report, null, 2), "application/json");
}

// ---------------------------------------------------------------------------
// View wiring + shareable URL
// ---------------------------------------------------------------------------

function syncUrl(extra) {
  const params = new URLSearchParams({
    repo: $("repo").value.trim(),
    interval: $("interval").value,
    view,
    metric,
    stacked: stacked ? "1" : "0",
    ...extra,
  });
  history.replaceState(null, "", `?${params}`);
}

function setView(next) {
  view = next;
  $("view-role").classList.toggle("active", view === "role");
  $("view-pkg").classList.toggle("active", view === "pkg");
  $("metric-wrap").hidden = view !== "pkg";
  if (report) render();
  syncUrl();
}

$("view-role").addEventListener("click", () => setView("role"));
$("view-pkg").addEventListener("click", () => setView("pkg"));
$("metric").addEventListener("change", (e) => {
  metric = e.target.value;
  if (report && view === "pkg") renderChart();
  syncUrl();
});
$("stacked").addEventListener("change", (e) => {
  stacked = e.target.checked;
  if (report) renderChart();
  syncUrl();
});
$("dl-csv").addEventListener("click", exportCsv);
$("dl-json").addEventListener("click", exportJson);

function setStatus(msg, isError) {
  const el = $("status");
  el.hidden = false;
  el.textContent = msg;
  el.classList.toggle("error", !!isError);
}

function runAnalysis() {
  const repoInput = $("repo").value.trim();
  if (!repoInput) return;

  syncUrl();
  const params = new URLSearchParams({ repo: repoInput, interval: $("interval").value });

  $("go").disabled = true;
  $("results").hidden = true;
  setStatus("Connecting…");

  const es = new EventSource(`/api/analyze?${params}`);

  es.addEventListener("progress", (e) => {
    const p = JSON.parse(e.data);
    if (p.type === "cloning") setStatus(`Cloning ${p.repo}…`);
    else if (p.type === "updating") setStatus(`Updating cached clone of ${p.repo}…`);
    else if (p.type === "resolved")
      setStatus(`Branch ${p.branch} · counter "${p.counter}" · ${p.snapshots} snapshots${p.cached ? ` (${p.cached} cached)` : ""}…`);
    else if (p.type === "snapshot")
      setStatus(`Analyzing ${p.index}/${p.total} — ${p.date}${p.cached ? " (cached)" : ""}…`);
  });

  es.addEventListener("done", (e) => {
    report = JSON.parse(e.data);
    es.close();
    $("go").disabled = false;
    setStatus(`Done — ${report.snapshots.length} snapshots of ${report.repoUrl}`);
    render();
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
}

$("form").addEventListener("submit", (ev) => {
  ev.preventDefault();
  runAnalysis();
});

// Restore state from a shared URL and auto-run.
(function initFromUrl() {
  const q = new URLSearchParams(location.search);
  const repo = q.get("repo");
  if (repo) $("repo").value = repo;
  if (q.get("interval")) $("interval").value = q.get("interval");
  if (q.get("metric") && METRIC_LABEL[q.get("metric")]) {
    metric = q.get("metric");
    $("metric").value = metric;
  }
  if (q.get("stacked") === "0") {
    stacked = false;
    $("stacked").checked = false;
  }
  if (q.get("view") === "pkg") setView("pkg");
  if (repo) runAnalysis();
})();
