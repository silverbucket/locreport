"use strict";

const $ = (id) => document.getElementById(id);

/** Resolve a CSS custom property to a concrete color the canvas accepts
 * (handles light-dark() / oklch by reading a probe element's computed color). */
function themeColor(varName) {
  const probe = document.createElement("span");
  probe.style.cssText = `color:var(${varName});position:absolute;visibility:hidden`;
  document.body.appendChild(probe);
  const color = getComputedStyle(probe).color;
  probe.remove();
  return color;
}
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
let view = "role"; // "role" | "pkg" | "age"
let metric = "app";
let cohortRole = "app"; // "app" | "test" | ... | "all"
let stacked = true;

const hasCohort = () => report && report.snapshots.some((s) => s.cohort);

/** Year->lines for a snapshot's cohort, scoped to the selected role. */
function cohortYears(snapshot) {
  if (!snapshot.cohort) return {};
  return cohortRole === "all" ? snapshot.cohort.byYear : snapshot.cohort.byRoleYear[cohortRole] || {};
}

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

/** Latest-snapshot code-age table HTML, or "" if no cohort data. */
function ageTableHtml() {
  const last = report.snapshots[report.snapshots.length - 1];
  const byYear = last ? cohortYears(last) : {};
  const years = Object.keys(byYear).sort();
  if (!years.length) return "";
  const total = years.reduce((s, y) => s + byYear[y], 0);
  const head = "<thead><tr><th>Year</th><th>Lines</th><th>Share</th></tr></thead>";
  const body = years
    .map((y) => {
      const pct = total ? ((byYear[y] / total) * 100).toFixed(1) : "0.0";
      return `<tr><td>${esc(y)}</td><td>${n(byYear[y])}</td><td>${pct}%</td></tr>`;
    })
    .join("");
  return `<table>${head}<tbody>${body}</tbody></table>`;
}

function renderTables() {
  $("table").innerHTML = table(intervalRows(), "Date", "date");
  const pkgRows = packageRows();
  if (pkgRows.length) {
    const last = report.snapshots[report.snapshots.length - 1];
    $("pkg-table").innerHTML = table(pkgRows, "Package", "pkg");
    $("pkg-date").textContent = `(latest snapshot: ${last.date})`;
  }
  const ageHtml = ageTableHtml();
  if (ageHtml) {
    $("age-table").innerHTML = ageHtml;
    $("age-date").textContent = `(latest snapshot: ${report.snapshots[report.snapshots.length - 1].date})`;
  }
  $("role-tables").hidden = view !== "role";
  $("packages").hidden = view !== "pkg" || !pkgRows.length;
  $("age-tables").hidden = view !== "age" || !ageHtml;
}

// ---------------------------------------------------------------------------
// Per-package series (one value per package per snapshot, for a chosen metric)
// ---------------------------------------------------------------------------

function packageSeries(metricKey) {
  const nameById = new Map();
  for (const s of report.snapshots) for (const p of s.byPackage || []) nameById.set(p.id, p.name || "(root)");

  // Numeric value per package per snapshot (0 where the package is absent).
  let entries = [...nameById.keys()].map((id) => ({
    label: nameById.get(id),
    values: report.snapshots.map((s) => {
      const p = (s.byPackage || []).find((x) => x.id === id);
      return p ? summarize(p.byRole)[metricKey] : 0;
    }),
  }));

  // Drop packages that are zero for this metric across the entire timeline.
  entries = entries.filter((e) => e.values.some((v) => v > 0));

  // Largest band at the bottom of the stack (order by peak size over time).
  const peak = (e) => Math.max(...e.values);
  entries.sort((a, b) => peak(b) - peak(a));

  // Collapse the long tail for very large monorepos.
  if (entries.length > MAX_PKG_SERIES) {
    const head = entries.slice(0, MAX_PKG_SERIES - 1);
    const tail = entries.slice(MAX_PKG_SERIES - 1);
    const other = report.snapshots.map((_, i) => tail.reduce((sum, e) => sum + e.values[i], 0));
    head.push({ label: `Other (${tail.length})`, values: other, other: true });
    entries = head;
  }

  // Render zero spans as gaps (null) so a package isn't drawn before it exists
  // or after it's removed — only where it actually has lines.
  return entries.map((e) => ({ ...e, values: e.values.map((v) => (v > 0 ? v : null)) }));
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
  const grid = themeColor("--chart-grid");
  const tick = themeColor("--chart-tick");
  const text = themeColor("--chart-text");
  const cfg = {
    type: "line",
    data: { labels, datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: "index", intersect: false },
      scales: {
        x: { stacked, grid: { color: grid }, ticks: { color: tick } },
        y: {
          stacked,
          grid: { color: grid },
          ticks: { color: tick, callback: (v) => n(v) },
          title: { display: true, text: yTitle, color: tick },
        },
      },
      plugins: {
        legend: { labels: { color: text, boxWidth: 12 }, onClick: legendIsolate },
        tooltip: { callbacks: { label: (c) => `${c.dataset.label}: ${n(c.parsed.y)}` } },
      },
    },
  };
  if (chart) chart.destroy();
  chart = new Chart($("chart"), cfg);
}

// Cohort: one series per author-year, value = surviving lines of that cohort at
// each snapshot. Older years sort to the bottom of the stack.
function cohortSeries() {
  const yearSet = new Set();
  for (const s of report.snapshots) for (const y of Object.keys(cohortYears(s))) yearSet.add(y);
  const years = [...yearSet].sort();
  return years.map((y) => ({
    year: y,
    values: report.snapshots.map((s) => cohortYears(s)[y] || 0),
  }));
}

function ageColor(i, total) {
  // Sequential blue (old) -> red (new).
  const hue = 210 - (total > 1 ? (i / (total - 1)) * 190 : 0);
  return { border: `hsl(${hue} 65% 55%)`, fill: `hsl(${hue} 65% 55% / 0.8)` };
}

function renderChart() {
  const labels = report.snapshots.map((s) => s.date);

  if (view === "age") {
    const series = cohortSeries();
    const datasets = series.map((s, i) => {
      const color = ageColor(i, series.length);
      return {
        label: s.year,
        data: s.values.map((v) => (v > 0 ? v : null)),
        backgroundColor: color.fill,
        borderColor: color.border,
        borderWidth: stacked ? 1 : 2,
        fill: stacked,
        pointRadius: 0,
        tension: 0.2,
      };
    });
    const roleLabel = cohortRole === "all" ? "all counted roles" : METRIC_LABEL[cohortRole];
    drawChart(labels, datasets, `${roleLabel} — code lines by year authored`);
    return;
  }

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
  } else if (view === "age") {
    const last = report.snapshots[report.snapshots.length - 1];
    const byYear = last ? cohortYears(last) : {};
    const lines = ["Year,Lines"];
    for (const y of Object.keys(byYear).sort()) lines.push(`${y},${byYear[y]}`);
    download(`locreport-${repoSlug()}-codeage-${cohortRole}.csv`, lines.join("\n"), "text/csv");
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
    role: cohortRole,
    stacked: stacked ? "1" : "0",
    ...extra,
  });
  history.replaceState(null, "", `?${params}`);
}

function setView(next) {
  view = next;
  $("view-role").classList.toggle("active", view === "role");
  $("view-pkg").classList.toggle("active", view === "pkg");
  $("view-age").classList.toggle("active", view === "age");
  $("metric-wrap").hidden = view !== "pkg";
  $("cohort-role-wrap").hidden = view !== "age";
  syncUrl();
  if (!report) return;
  // Code age needs a (slower) blame pass; fetch it lazily the first time.
  if (view === "age" && !hasCohort()) {
    runAnalysis();
    return;
  }
  render();
}

$("view-role").addEventListener("click", () => setView("role"));
$("view-pkg").addEventListener("click", () => setView("pkg"));
$("view-age").addEventListener("click", () => setView("age"));
$("metric").addEventListener("change", (e) => {
  metric = e.target.value;
  if (report && view === "pkg") renderChart();
  syncUrl();
});
$("cohort-role").addEventListener("change", (e) => {
  cohortRole = e.target.value;
  if (report && view === "age") {
    renderChart();
    renderTables();
  }
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

/** Toggle the "work happening in the background" indicator on the status line. */
function setWorking(on) {
  $("status").classList.toggle("working", on);
}

function runAnalysis() {
  const repoInput = $("repo").value.trim();
  if (!repoInput) return;

  syncUrl();
  const params = new URLSearchParams({ repo: repoInput, interval: $("interval").value });
  if (view === "age") params.set("cohort", "1");

  $("go").disabled = true;
  $("results").hidden = true;
  setStatus("Connecting…");
  setWorking(true);

  const es = new EventSource(`/api/analyze?${params}`);

  es.addEventListener("progress", (e) => {
    const p = JSON.parse(e.data);
    if (p.type === "cloning") setStatus(`Cloning ${p.repo}…`);
    else if (p.type === "updating") setStatus(`Updating cached clone of ${p.repo}…`);
    else if (p.type === "resolved")
      setStatus(`Branch ${p.branch} · counter "${p.counter}" · ${p.snapshots} snapshots${p.cached ? ` (${p.cached} cached)` : ""}…`);
    else if (p.type === "snapshot")
      setStatus(`Analyzing ${p.index}/${p.total} — ${p.date}${p.cached ? " (cached)" : ""}…`);
    else if (p.type === "cohort")
      setStatus(`Computing code age (git blame) ${p.index}/${p.total} — ${p.date}${p.cached ? " (cached)" : ""}…`);
  });

  es.addEventListener("done", (e) => {
    report = JSON.parse(e.data);
    es.close();
    $("go").disabled = false;
    setWorking(false);
    setStatus(`Done — ${report.snapshots.length} snapshots of ${report.repoUrl}`);
    render();
    $("results").hidden = false;
  });

  es.addEventListener("fail", (e) => {
    es.close();
    $("go").disabled = false;
    setWorking(false);
    setStatus(`Error: ${JSON.parse(e.data).message}`, true);
  });

  es.onerror = () => {
    if (es.readyState === EventSource.CLOSED && $("go").disabled) {
      $("go").disabled = false;
      setWorking(false);
      setStatus("Connection closed before completion.", true);
    }
  };
}

$("form").addEventListener("submit", (ev) => {
  ev.preventDefault();
  runAnalysis();
});

// Landing-page example repos: fill the field and run.
for (const el of document.querySelectorAll(".js-example")) {
  el.addEventListener("click", () => {
    $("repo").value = el.dataset.repo;
    runAnalysis();
  });
}

// Re-tint the chart's axes/legend when the OS color scheme flips.
window.matchMedia?.("(prefers-color-scheme: dark)").addEventListener("change", () => {
  if (report) renderChart();
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
  if (q.get("role")) {
    cohortRole = q.get("role");
    $("cohort-role").value = cohortRole;
  }
  if (q.get("stacked") === "0") {
    stacked = false;
    $("stacked").checked = false;
  }
  if (q.get("view") === "pkg") setView("pkg");
  else if (q.get("view") === "age") setView("age");
  if (repo) runAnalysis();
})();
