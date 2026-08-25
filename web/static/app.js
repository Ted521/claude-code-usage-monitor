(function () {
  const cfg = window.APP_CONFIG;
  const API = cfg.apiBaseUrl;

  let activeView = "history";
  let realtimeTimer = null;
  let pollTimer = null;
  let lastHistoryJson = null;
  let lastRealtimeJson = null;
  let realtimeForce = false;
  let historyFetchGen = 0;

  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => document.querySelectorAll(sel);

  function fmtCompact(n) {
    const v = Number(n ?? 0);
    if (!Number.isFinite(v)) return "0";
    const abs = Math.abs(v);
    const sign = v < 0 ? "-" : "";
    if (abs >= 1e6) {
      const scaled = abs / 1e6;
      const digits = scaled >= 100 ? 0 : scaled >= 10 ? 1 : 2;
      return sign + scaled.toFixed(digits).replace(/\.?0+$/, "") + "m";
    }
    if (abs >= 1e3) {
      const scaled = abs / 1e3;
      const digits = scaled >= 100 ? 0 : scaled >= 10 ? 1 : 2;
      return sign + scaled.toFixed(digits).replace(/\.?0+$/, "") + "k";
    }
    if (Number.isInteger(v)) return String(v);
    return v.toLocaleString("en-US", { maximumFractionDigits: 2 });
  }

  function fmtNum(n) {
    return fmtCompact(n);
  }

  function fmtUsd(n) {
    const v = Number(n ?? 0);
    if (!Number.isFinite(v)) return "$0.0000";
    if (Math.abs(v) >= 1000) {
      const compact = fmtCompact(v);
      return compact.startsWith("-") ? "-$" + compact.slice(1) : "$" + compact;
    }
    return "$" + v.toFixed(4);
  }

  const TZ_KST = "Asia/Seoul";
  const dtFmt = new Intl.DateTimeFormat("en-US", {
    timeZone: TZ_KST,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });

  function fmtKst(iso) {
    const d = parseApiTime(iso);
    if (!d || Number.isNaN(d.getTime())) return iso ? String(iso) : "—";
    return dtFmt.format(d);
  }

  function fmtKstRange(startIso, endIso) {
    return `${fmtKst(startIso)} – ${fmtKst(endIso)}`;
  }

  function parseApiTime(iso) {
    if (!iso) return null;
    const s = String(iso).trim();
    if (s.endsWith("Z") || /[+-]\d{2}:?\d{2}$/.test(s)) return new Date(s);
    return new Date(s + "Z");
  }

  function fmtUpdatedAt(iso) {
    const d = parseApiTime(iso);
    return d && !Number.isNaN(d.getTime()) ? dtFmt.format(d) : "—";
  }

  function showBanner(msg) {
    const el = $("#banner");
    el.textContent = msg;
    el.classList.remove("hidden");
  }
  function hideBanner() {
    $("#banner").classList.add("hidden");
  }
  function toast(msg) {
    const el = $("#toast");
    el.textContent = msg;
    el.classList.remove("hidden");
    setTimeout(() => el.classList.add("hidden"), 2800);
  }

  const pendingPlots = new Map();

  function decodePlotlyArray(obj) {
    if (obj == null || typeof obj !== "object" || !obj.bdata) return obj;
    const bin = atob(obj.bdata);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const buf = bytes.buffer;
    if (obj.dtype === "f8") return Array.from(new Float64Array(buf));
    if (obj.dtype === "f4") return Array.from(new Float32Array(buf));
    if (obj.dtype === "i4") return Array.from(new Int32Array(buf));
    return obj;
  }

  function normalizePlotlyFig(figJson) {
    if (!figJson?.data) return figJson;
    return {
      ...figJson,
      data: figJson.data.map((trace) => {
        const t = { ...trace };
        for (const key of ["x", "y", "z", "values", "labels"]) {
          if (t[key] && typeof t[key] === "object" && t[key].bdata) {
            t[key] = decodePlotlyArray(t[key]);
          }
        }
        return t;
      }),
    };
  }

  function isVisible(el) {
    if (!el || !el.isConnected) return false;
    if (el.offsetParent === null) return false;
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  function plotHistory(elId, figJson) {
    const el = document.getElementById(elId);
    if (!el) return;
    pendingPlots.delete(elId);
    if (!figJson?.data?.length) {
      if (typeof Plotly !== "undefined") Plotly.purge(el);
      el.innerHTML = "<p class='meta'>No chart data to display.</p>";
      return;
    }
    const fig = normalizePlotlyFig(figJson);
    const layout = buildPlotlyLayout(fig.layout);
    if (typeof Plotly !== "undefined") Plotly.purge(el);
    el.innerHTML = "";
    return Plotly.newPlot(el, fig.data, layout, { responsive: true })
      .then(() => Plotly.Plots.resize(el))
      .then(() =>
        Plotly.relayout(el, {
          "yaxis.automargin": true,
          "yaxis2.automargin": true,
        })
      )
      .catch((err) => {
        console.error("Plotly history chart failed:", elId, err);
        el.innerHTML = `<p class='meta'>Chart render error: ${err.message || err}</p>`;
      });
  }

  function applyHistoryCharts(charts) {
    const c = charts || {};
    const specs = [
      ["chart-cost-tokens", c.cost_tokens],
      ["chart-io", c.input_output],
      ["chart-model-cost", c.model_cost],
    ];
    for (const [elId, fig] of specs) {
      plotHistory(elId, fig?.data?.length ? fig : null);
    }
  }

  function plot(elId, figJson, options) {
    const opts = options || {};
    const el = document.getElementById(elId);
    if (!el) return;
    if (!figJson) {
      if (opts.preserveIfPlotted && el.classList?.contains("js-plotly-plot")) {
        return;
      }
      if (typeof Plotly !== "undefined" && el.classList?.contains("js-plotly-plot")) {
        Plotly.purge(el);
      }
      pendingPlots.delete(elId);
      el.innerHTML = "<p class='meta'>No chart data to display.</p>";
      return;
    }
    if (!opts.force && !isVisible(el)) {
      pendingPlots.set(elId, figJson);
      return;
    }
    pendingPlots.delete(elId);
    el.innerHTML = "";
    const fig = normalizePlotlyFig(figJson);
    const layout = buildPlotlyLayout(fig.layout);
    Plotly.react(el, fig.data, layout, { responsive: true })
      .then(() => {
        if (typeof Plotly !== "undefined") Plotly.Plots.resize(el);
        return Plotly.relayout(el, {
          "yaxis.automargin": true,
          "yaxis2.automargin": true,
        });
      })
      .catch((err) => {
        console.error("Plotly render failed:", elId, err);
        el.innerHTML = `<p class='meta'>Chart render error: ${err.message || err}</p>`;
      });
  }

  const HISTORY_CHART_IDS = new Set([
    "chart-cost-tokens",
    "chart-io",
    "chart-model-cost",
  ]);

  const SORTABLE_TABLE_IDS = new Set(["history-table", "models-detail-table"]);
  const tableStore = new Map();

  function compareCellValues(a, b) {
    const aEmpty = a == null || a === "";
    const bEmpty = b == null || b === "";
    if (aEmpty && bEmpty) return 0;
    if (aEmpty) return 1;
    if (bEmpty) return -1;
    if (typeof a === "number" && typeof b === "number") return a - b;
    const na = Number(a);
    const nb = Number(b);
    if (
      Number.isFinite(na) &&
      Number.isFinite(nb) &&
      String(a).trim() !== "" &&
      String(b).trim() !== ""
    ) {
      return na - nb;
    }
    return String(a).localeCompare(String(b), undefined, {
      numeric: true,
      sensitivity: "base",
    });
  }

  function sortTableRows(rows, col, dir) {
    const sign = dir === "asc" ? 1 : -1;
    return [...rows].sort(
      (ra, rb) => sign * compareCellValues(ra[col], rb[col])
    );
  }

  function formatTableCell(col, v) {
    if (typeof v === "number" && /cost/i.test(col)) return fmtUsd(v);
    if (typeof v === "number") return fmtNum(v);
    return v ?? "";
  }

  function paintSortableTable(containerId) {
    const el = document.getElementById(containerId);
    const state = tableStore.get(containerId);
    if (!el || !state?.rows?.length) {
      if (el && !state?.rows?.length) el.innerHTML = "<p class='meta'>No data</p>";
      return;
    }
    const { rows, sortCol, sortDir } = state;
    const cols = Object.keys(rows[0]);
    const sorted =
      sortCol && sortDir
        ? sortTableRows(rows, sortCol, sortDir)
        : rows;
    const headerCells = cols
      .map((c) => {
        const active = c === sortCol;
        const aria =
          active && sortDir === "asc"
            ? "ascending"
            : active && sortDir === "desc"
              ? "descending"
              : "none";
        const indicator = active ? (sortDir === "asc" ? " ▲" : " ▼") : "";
        return `<th class="sortable" scope="col" data-col="${escapeHtml(
          c
        )}" aria-sort="${aria}">${escapeHtml(c)}${indicator}</th>`;
      })
      .join("");
    let body = "";
    for (const row of sorted) {
      body +=
        "<tr>" +
        cols.map((c) => `<td>${escapeHtml(formatTableCell(c, row[c]))}</td>`).join("") +
        "</tr>";
    }
    el.innerHTML = `<table class="data"><thead><tr>${headerCells}</tr></thead><tbody>${body}</tbody></table>`;
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function onSortableTableHeaderClick(e) {
    const th = e.target.closest("table.data th.sortable");
    if (!th) return;
    const wrap = th.closest(".table-wrap");
    if (!wrap?.id || !SORTABLE_TABLE_IDS.has(wrap.id)) return;
    const col = th.dataset.col;
    const state = tableStore.get(wrap.id);
    if (!state?.rows?.length || !col) return;
    let dir = "asc";
    if (state.sortCol === col) {
      dir = state.sortDir === "asc" ? "desc" : "asc";
    }
    state.sortCol = col;
    state.sortDir = dir;
    paintSortableTable(wrap.id);
  }

  function flushPendingPlots(root) {
    const scope = root || document;
    for (const [elId, fig] of [...pendingPlots.entries()]) {
      const el = scope.getElementById ? scope.getElementById(elId) : document.getElementById(elId);
      if (!el || !isVisible(el)) continue;
      if (HISTORY_CHART_IDS.has(elId)) plotHistory(elId, fig);
      else plot(elId, fig);
    }
    scope.querySelectorAll?.(".chart.js-plotly-plot").forEach((el) => {
      if (isVisible(el)) Plotly.Plots.resize(el);
    });
  }

  function renderTable(containerId, rows) {
    const el = document.getElementById(containerId);
    if (!rows?.length) {
      tableStore.delete(containerId);
      el.innerHTML = "<p class='meta'>No data</p>";
      return;
    }
    if (SORTABLE_TABLE_IDS.has(containerId)) {
      const prev = tableStore.get(containerId);
      tableStore.set(containerId, {
        rows,
        sortCol: prev?.sortCol ?? null,
        sortDir: prev?.sortDir ?? "asc",
      });
      paintSortableTable(containerId);
      return;
    }
    const cols = Object.keys(rows[0]);
    let html =
      "<table class='data'><thead><tr>" +
      cols.map((c) => `<th>${escapeHtml(c)}</th>`).join("") +
      "</tr></thead><tbody>";
    for (const row of rows) {
      html +=
        "<tr>" +
        cols
          .map((c) => `<td>${escapeHtml(formatTableCell(c, row[c]))}</td>`)
          .join("") +
        "</tr>";
    }
    html += "</tbody></table>";
    el.innerHTML = html;
  }

  function renderMetrics(containerId, items) {
    const el = document.getElementById(containerId);
    el.innerHTML = items
      .map(
        (m) =>
          `<div class="metric"><div class="label">${m.label}</div><div class="value">${m.value}</div></div>`
      )
      .join("");
  }

  function sinceParam() {
    if (!$("#use-since").checked) return null;
    const d = $("#since-date").value;
    if (!d) return null;
    return d.replace(/-/g, "");
  }
  function untilParam() {
    if (!$("#use-until").checked) return null;
    const d = $("#until-date").value;
    if (!d) return null;
    return d.replace(/-/g, "");
  }

  async function apiGet(path) {
    const res = await fetch(`${API}${path}`);
    if (!res.ok) {
      const t = await res.text();
      throw new Error(t || res.statusText);
    }
    return res.json();
  }

  function applyHistory(payload) {
    lastHistoryJson = payload;

    const est = payload.local_cost_estimate;
    const estNote = est?.enabled
      ? ` · local cost est. Sonnet×${Math.round((est.ratio ?? 0.5) * 100)}%`
      : "";
    $("#history-meta").textContent = payload.updated_at
      ? `Last updated: ${fmtUpdatedAt(payload.updated_at)}${estNote}`
      : "—";
    hideBanner();

    const charts = payload.charts || {};

    if (payload.status === "error") {
      $("#history-metrics").innerHTML = `<p class="meta">${payload.error}</p>`;
      plotHistory("chart-cost-tokens", null);
      plotHistory("chart-io", null);
      plotHistory("chart-model-cost", null);
      renderTable("history-table", []);
      renderTable("models-detail-table", []);
      return;
    }

    const totals = payload.totals || {};
    renderMetrics("history-metrics", [
      { label: "Total tokens", value: fmtNum(totals.totalTokens) },
      { label: "Cost (USD)", value: fmtUsd(totals.totalCost) },
      { label: "Input", value: fmtNum(totals.inputTokens) },
      { label: "Output", value: fmtNum(totals.outputTokens) },
      { label: "Cache Read", value: fmtNum(totals.cacheReadTokens) },
    ]);

    applyHistoryCharts(charts);
    renderTable("history-table", payload.table || []);
    renderTable("models-detail-table", payload.models || []);
    scheduleFlushPlots();
  }

  function scheduleFlushPlots() {
    requestAnimationFrame(() => flushPendingPlots());
    setTimeout(() => flushPendingPlots(), 150);
  }

  function applyRealtime(payload) {
    const prev = lastRealtimeJson;
    lastRealtimeJson = payload;

    $("#rt-title").textContent = `Today · ${payload.today || new Date().toISOString().slice(0, 10)}`;
    const estRt = payload.local_cost_estimate;
    const estRtNote = estRt?.enabled
      ? ` · local cost est. Sonnet×${Math.round((estRt.ratio ?? 0.5) * 100)}%`
      : "";
    $("#realtime-meta").textContent = payload.updated_at
      ? `Last updated: ${fmtUpdatedAt(payload.updated_at)}${estRtNote}`
      : "—";

    if (payload.status === "loading") {
      showBanner("🔄 Loading today’s usage…");
    } else if (activeView === "realtime") {
      hideBanner();
    }

    if (payload.status === "error" && !payload.totals) {
      $("#realtime-metrics").innerHTML = `<p class="meta">${payload.error}</p>`;
      return;
    }

    if (
      payload.status === "ready" &&
      prev?.status === "loading" &&
      realtimeForce
    ) {
      toast("Realtime usage updated");
    }
    realtimeForce = false;

    const totals = payload.totals || {};
    renderMetrics("realtime-metrics", [
      { label: "Total tokens", value: fmtNum(totals.totalTokens) },
      { label: "Cost (USD)", value: fmtUsd(totals.totalCost) },
      { label: "Input", value: fmtNum(totals.inputTokens) },
      { label: "Output", value: fmtNum(totals.outputTokens) },
      { label: "Cache Read", value: fmtNum(totals.cacheReadTokens) },
    ]);

    const blocks = payload.blocks?.blocks || [];
    const active = blocks.find((b) => b.isActive);
    const card = $("#active-block");
    if (active) {
      const burn = active.burnRate || {};
      const proj = active.projection || {};
      card.classList.remove("hidden");
      card.innerHTML = `
        <h3>Active session block</h3>
        <div class="metrics">
          <div class="metric"><div class="label">Block cost</div><div class="value">${fmtUsd(active.costUSD)}</div></div>
          <div class="metric"><div class="label">Block tokens</div><div class="value">${fmtNum(active.totalTokens)}</div></div>
          <div class="metric"><div class="label">Burn rate</div><div class="value">${fmtNum(burn.tokensPerMinute)} tok/min</div></div>
          <div class="metric"><div class="label">Projected cost</div><div class="value">$${(proj.totalCost ?? 0).toFixed(2)}</div></div>
        </div>
        <p class="meta">Window ${fmtKstRange(active.startTime, active.endTime)} · ${(active.models || []).join(", ")}</p>`;
    } else {
      card.classList.add("hidden");
    }

    renderRtTimeline();
    plotRtModel("chart-rt-model-tokens", payload.charts?.model_tokens);
    renderTable("rt-model-table", payload.model_rows || []);
    renderTable("session-table", payload.session_table || []);
    scheduleFlushPlots();
  }

  function pickTimelineChart(charts, granularity, mode) {
    if (!charts) return null;
    if (granularity === "recent_5m") {
      return mode === "incremental"
        ? charts.timeline_recent5m_inc
        : charts.timeline_recent_cum;
    }
    return mode === "incremental"
      ? charts.timeline_hourly_inc
      : charts.timeline_hourly_cum;
  }

  function buildPlotlyLayout(figLayout) {
    const raw = figLayout || {};
    const layout = { ...raw };
    if (typeof layout.template === "object") {
      delete layout.template;
    }
    layout.template =
      typeof layout.template === "string" ? layout.template : "plotly_white";
    layout.paper_bgcolor = "#ffffff";
    layout.plot_bgcolor = "#ffffff";
    layout.autosize = true;
    if (layout.margin && typeof layout.margin === "object") {
      layout.margin.l = Math.max(layout.margin.l || 0, 90);
      layout.margin.r = Math.max(layout.margin.r || 0, 72);
    } else {
      layout.margin = { l: 90, r: 72, t: 48, b: 80 };
    }
    if (layout.yaxis && typeof layout.yaxis === "object") {
      layout.yaxis.automargin = true;
    }
    if (layout.yaxis2 && typeof layout.yaxis2 === "object") {
      layout.yaxis2.automargin = true;
    }
    return layout;
  }

  function buildRtTimelineLayout(figLayout) {
    return buildPlotlyLayout(figLayout);
  }

  function plotRtModel(elId, figJson) {
    const el = document.getElementById(elId);
    if (!el) return;
    pendingPlots.delete(elId);
    if (!figJson?.data?.length) {
      if (typeof Plotly !== "undefined") Plotly.purge(el);
      el.innerHTML = "<p class='meta'>No model chart data to display.</p>";
      return;
    }
    const fig = normalizePlotlyFig(figJson);
    const layout = buildPlotlyLayout(fig.layout);
    if (typeof Plotly !== "undefined") Plotly.purge(el);
    el.innerHTML = "";
    return Plotly.newPlot(el, fig.data, layout, { responsive: true })
      .then(() => Plotly.Plots.resize(el))
      .then(() => Plotly.relayout(el, { "yaxis.automargin": true }))
      .catch((err) => {
        console.error("Plotly model chart failed:", err);
        el.innerHTML = `<p class='meta'>Chart render error: ${err.message || err}</p>`;
      });
  }

  function plotRtTimeline(figJson) {
    const el = document.getElementById("chart-rt-timeline");
    if (!el) return;
    pendingPlots.delete("chart-rt-timeline");
    if (!figJson?.data?.length) {
      if (typeof Plotly !== "undefined") Plotly.purge(el);
      el.innerHTML = "<p class='meta'>No chart data to display.</p>";
      return;
    }
    const fig = normalizePlotlyFig(figJson);
    const layout = buildRtTimelineLayout(fig.layout);
    if (typeof Plotly !== "undefined") {
      Plotly.purge(el);
    }
    el.innerHTML = "";
    return Plotly.newPlot(el, fig.data, layout, { responsive: true })
      .then(() => {
        Plotly.Plots.resize(el);
        return Plotly.relayout(el, {
          "yaxis.automargin": true,
          "yaxis2.automargin": true,
        });
      })
      .catch((err) => {
        console.error("Plotly timeline failed:", err);
        el.innerHTML = `<p class='meta'>Chart render error: ${err.message || err}</p>`;
      });
  }

  function rtTimelineLabel(gran, mode) {
    const g = gran === "recent_5m" ? "Last 2 hours · 5 min" : "Hourly (today)";
    const m = mode === "incremental" ? "Incremental" : "Cumulative";
    return `${g} · ${m}`;
  }

  function renderRtTimeline() {
    const statusEl = $("#rt-timeline-status");
    const gran =
      document.getElementById("rt-timeline-granularity")?.value || "hour";
    const mode = document.getElementById("rt-timeline-mode")?.value || "incremental";

    if (!lastRealtimeJson) {
      if (statusEl) statusEl.textContent = "Loading data…";
      fetchRealtime();
      return;
    }

    if (statusEl) statusEl.textContent = rtTimelineLabel(gran, mode);

    const fig = pickTimelineChart(lastRealtimeJson.charts, gran, mode);
    if (!fig) {
      const el = document.getElementById("chart-rt-timeline");
      if (!el) return;
      const meta = lastRealtimeJson.timeline_meta || {};
      const n = meta.snapshot_lines ?? 0;
      let msg = "No chart data to display.";
      if (n > 0 && gran === "recent_5m") {
        const last = meta.last_snapshot_at
          ? fmtKst(meta.last_snapshot_at)
          : "—";
        msg =
          `${fmtNum(n)} snapshots — last 2 hours bucket is empty. Last record: ${last}`;
      } else if (n > 0) {
        msg = `${fmtNum(n)} snapshots — try another interval/display or refresh.`;
      } else if (lastRealtimeJson.status === "loading") {
        msg = "Loading usage…";
      } else {
        msg = "No snapshots for today yet.";
      }
      if (typeof Plotly !== "undefined") Plotly.purge(el);
      el.innerHTML = `<p class='meta'>${msg}</p>`;
      if (statusEl) statusEl.textContent = `${rtTimelineLabel(gran, mode)} — ${msg}`;
      return;
    }

    plotRtTimeline(fig);
  }

  function onRtTimelineControlChange() {
    renderRtTimeline();
  }

  async function fetchHistory() {
    const gen = ++historyFetchGen;
    const params = new URLSearchParams();
    const since = sinceParam();
    const until = untilParam();
    if (since) params.set("since", since);
    if (until) params.set("until", until);
    try {
      const data = await apiGet(`/api/v1/usage/history?${params}`);
      if (gen !== historyFetchGen) return;
      applyHistory(data);
    } catch (e) {
      if (gen !== historyFetchGen) return;
      showBanner(`API error: ${e.message}`);
    }
  }

  async function fetchRealtime() {
    const params = new URLSearchParams();
    params.set("ttl", String(cfg.realtimeTtlDefault));
    if (realtimeForce) params.set("force", "true");
    try {
      const data = await apiGet(`/api/v1/usage/realtime?${params}`);
      applyRealtime(data);
    } catch (e) {
      showBanner(`API error: ${e.message}`);
    }
  }

  function scheduleRealtime() {
    clearInterval(realtimeTimer);
    realtimeTimer = setInterval(() => {
      if (activeView === "realtime") fetchRealtime();
    }, cfg.realtimeIntervalMs);
  }

  // ponytail: history has no auto-refresh — one fetch per tab-open/date-change/Refresh click.
  // Realtime keeps polling while "loading" since that page is meant to auto-update.
  function startPoll() {
    clearInterval(pollTimer);
    pollTimer = setInterval(() => {
      if (activeView === "realtime" && lastRealtimeJson?.status === "loading") {
        fetchRealtime();
      }
    }, cfg.pollMs);
  }

  function setView(view) {
    activeView = view;
    $$(".tab").forEach((t) => t.classList.toggle("active", t.dataset.view === view));
    $("#view-history").classList.toggle("active", view === "history");
    $("#view-realtime").classList.toggle("active", view === "realtime");
    hideBanner();
    if (view === "history") {
      fetchHistory();
      scheduleFlushPlots();
    } else {
      fetchRealtime();
      scheduleRealtime();
      scheduleFlushPlots();
      if (lastRealtimeJson) {
        setTimeout(() => renderRtTimeline(), 50);
      }
    }
  }

  function initDates() {
    const today = new Date();
    const iso = today.toISOString().slice(0, 10);
    const ago = new Date(today);
    ago.setDate(ago.getDate() - 30);
    $("#since-date").value = ago.toISOString().slice(0, 10);
    $("#until-date").value = iso;
    $("#use-since").addEventListener("change", (e) => {
      $("#since-date").disabled = !e.target.checked;
      scheduleHistoryFromDates();
    });
    $("#use-until").addEventListener("change", (e) => {
      $("#until-date").disabled = !e.target.checked;
      scheduleHistoryFromDates();
    });
    $("#since-date").addEventListener("change", scheduleHistoryFromDates);
    $("#until-date").addEventListener("change", scheduleHistoryFromDates);
  }

  function initSubTabs() {
    $$(".sub-tab").forEach((btn) => {
      btn.addEventListener("click", () => {
        const sub = btn.dataset.sub;
        $$(".sub-tab").forEach((b) => b.classList.toggle("active", b === btn));
        $("#history-sub-trend").classList.toggle("active", sub === "trend");
        $("#history-sub-table").classList.toggle("active", sub === "table");
        $("#history-sub-models").classList.toggle("active", sub === "models");
        requestAnimationFrame(() => flushPendingPlots());
      });
    });
  }

  let historyDateTimer = null;
  function scheduleHistoryFromDates() {
    clearTimeout(historyDateTimer);
    historyDateTimer = setTimeout(fetchHistory, 400);
  }

  function init() {
    initDates();
    initSubTabs();

    $$(".tab").forEach((btn) => {
      btn.addEventListener("click", () => setView(btn.dataset.view));
    });

    $("#btn-history-refresh").addEventListener("click", fetchHistory);
    $("#btn-realtime-refresh").addEventListener("click", () => {
      realtimeForce = true;
      fetchRealtime();
    });

    document.addEventListener("click", onSortableTableHeaderClick);

    const granSel = document.getElementById("rt-timeline-granularity");
    const modeSel = document.getElementById("rt-timeline-mode");
    if (granSel) granSel.addEventListener("change", onRtTimelineControlChange);
    if (modeSel) modeSel.addEventListener("change", onRtTimelineControlChange);

    startPoll();
    setView("history");
  }

  document.addEventListener("DOMContentLoaded", init);
})();
