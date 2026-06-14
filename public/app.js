"use strict";

const $ = (id) => document.getElementById(id);
const EXCLUDED = new Set(["build", "vendored"]);
const COUNTED = [
  ["app", "App", "#4f8cff"],
  ["test", "Tests", "#2dd4bf"],
  ["config", "Config", "#f59e0b"],
  ["docs", "Docs", "#a78bfa"],
  ["data", "Data", "#f472b6"],
];

let chart = null;

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
          // First column is text (date / repo-controlled package name) → escape.
          const val = k === firstKey ? esc(r[firstKey]) : n(r[k]);
          return `<td${cls}>${val}</td>`;
        })
        .join("");
      return `<tr>${tds}</tr>`;
    })
    .join("");
  return `<table>${thead}<tbody>${body}</tbody></table>`;
}

function renderChart(report) {
  const labels = report.snapshots.map((s) => s.date);
  const summaries = report.snapshots.map((s) => summarize(s.byRole));
  const datasets = COUNTED.map(([key, label, color]) => ({
    label,
    data: summaries.map((s) => s[key]),
    backgroundColor: color + "cc",
    borderColor: color,
    borderWidth: 1,
    fill: true,
    pointRadius: 0,
    tension: 0.2,
  }));

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
          title: { display: true, text: "Lines of code", color: "#98a2b3" },
        },
      },
      plugins: {
        legend: { labels: { color: "#e6e9ef" } },
        tooltip: { callbacks: { label: (c) => `${c.dataset.label}: ${n(c.parsed.y)}` } },
      },
    },
  };

  if (chart) chart.destroy();
  chart = new Chart($("chart"), cfg);
}

function renderTables(report) {
  const rows = report.snapshots.map((s) => ({ date: s.date, ...summarize(s.byRole) }));
  $("table").innerHTML = table(rows, "Date", "date");

  const last = report.snapshots[report.snapshots.length - 1];
  const pkgs = last && last.byPackage;
  if (pkgs && pkgs.length) {
    const pkgRows = pkgs.map((p) => ({ pkg: p.name || "(root)", ...summarize(p.byRole) }));
    $("pkg-table").innerHTML = table(pkgRows, "Package", "pkg");
    $("pkg-date").textContent = `(latest snapshot: ${last.date})`;
    $("packages").hidden = false;
  } else {
    $("packages").hidden = true;
  }
}

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

  const params = new URLSearchParams({
    repo,
    interval: $("interval").value,
    byPackage: $("byPackage").checked ? "1" : "0",
  });

  $("go").disabled = true;
  $("results").hidden = true;
  setStatus("Connecting…");

  const es = new EventSource(`/api/analyze?${params}`);

  es.addEventListener("progress", (e) => {
    const ev = JSON.parse(e.data);
    if (ev.type === "cloning") setStatus(`Cloning ${ev.repo}…`);
    else if (ev.type === "resolved")
      setStatus(`Branch ${ev.branch} · counter "${ev.counter}" · ${ev.snapshots} snapshots…`);
    else if (ev.type === "snapshot") setStatus(`Analyzing ${ev.index}/${ev.total} — ${ev.date}…`);
  });

  es.addEventListener("done", (e) => {
    const report = JSON.parse(e.data);
    es.close();
    $("go").disabled = false;
    setStatus(`Done — ${report.snapshots.length} snapshots of ${report.repoUrl}`);
    renderChart(report);
    renderTables(report);
    $("results").hidden = false;
  });

  es.addEventListener("fail", (e) => {
    es.close();
    $("go").disabled = false;
    setStatus(`Error: ${JSON.parse(e.data).message}`, true);
  });

  es.onerror = () => {
    // Fires on network drop or server close without a 'done'/'fail'.
    if (es.readyState === EventSource.CLOSED && $("go").disabled) {
      $("go").disabled = false;
      setStatus("Connection closed before completion.", true);
    }
  };
});
