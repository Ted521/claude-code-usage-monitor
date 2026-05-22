(function () {
  const cfg = window.APP_CONFIG;
  const API = cfg.apiBaseUrl;

  let activeView = "history";
  let historyTimer = null;
  let realtimeTimer = null;
  let pollTimer = null;
  let lastHistoryJson = null;
  let lastRealtimeJson = null;
  let historyForce = false;
  let realtimeForce = false;
  let historyFetchGen = 0;

  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => document.querySelectorAll(sel);

  function fmtNum(n) {
    return (n ?? 0).toLocaleString();
  }
  function fmtUsd(n) {
    return "$" + (n ?? 0).toFixed(4);
  }

  const TZ_KST = "Asia/Seoul";
  const dtFmt = new Intl.DateTimeFormat("ko-KR", {
    timeZone: TZ_KST,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });

  /** ccusage ISO(UTC) → 한국 시간 표시 */
  function fmtKst(iso) {
    const d = parseApiTime(iso);
    if (!d || Number.isNaN(d.getTime())) return iso ? String(iso) : "—";
    return dtFmt.format(d);
  }

  function fmtKstRange(startIso, endIso) {
    return `${fmtKst(startIso)} ~ ${fmtKst(endIso)}`;
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

  /** Python Plotly to_json() bdata → 일반 배열 (구 API 응답 호환) */
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

  function historyChartsPresent(charts) {
    if (!charts) return false;
    for (const key of ["cost_tokens", "input_output", "model_cost"]) {
      const fig = charts[key];
      if (fig?.data?.length) return true;
    }
    return false;
  }

  /** loading 중 기존 Plotly 차트를 지우지 않음 (빈 응답·늦게 도착한 요청 방지) */
  function setChartLoading(elId, message) {
    const el = document.getElementById(elId);
    if (!el) return;
    if (el.classList?.contains("js-plotly-plot")) return;
    pendingPlots.delete(elId);
    el.innerHTML = `<p class="meta chart-loading">${message || "차트 불러오는 중…"}</p>`;
  }

  /** 기록·차트 탭 — Plotly.react 멈춤 방지 */
  function plotHistory(elId, figJson) {
    const el = document.getElementById(elId);
    if (!el) return;
    pendingPlots.delete(elId);
    if (!figJson?.data?.length) {
      if (typeof Plotly !== "undefined") Plotly.purge(el);
      el.innerHTML = "<p class='meta'>표시할 차트 데이터가 없습니다.</p>";
      return;
    }
    const fig = normalizePlotlyFig(figJson);
    const layout = buildPlotlyLayout(fig.layout);
    if (typeof Plotly !== "undefined") Plotly.purge(el);
    el.innerHTML = "";
    return Plotly.newPlot(el, fig.data, layout, { responsive: true })
      .then(() => Plotly.Plots.resize(el))
      .catch((err) => {
        console.error("Plotly history chart failed:", elId, err);
        el.innerHTML = `<p class='meta'>차트 렌더 오류: ${err.message || err}</p>`;
      });
  }

  function applyHistoryCharts(charts, loading) {
    const c = charts || {};
    const specs = [
      ["chart-cost-tokens", c.cost_tokens],
      ["chart-io", c.input_output],
      ["chart-model-cost", c.model_cost],
    ];
    for (const [elId, fig] of specs) {
      if (fig?.data?.length) {
        plotHistory(elId, fig);
      } else if (loading) {
        setChartLoading(elId);
      } else {
        plotHistory(elId, null);
      }
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
      el.innerHTML = "<p class='meta'>표시할 차트 데이터가 없습니다.</p>";
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
      })
      .catch((err) => {
        console.error("Plotly render failed:", elId, err);
        el.innerHTML = `<p class='meta'>차트 렌더 오류: ${err.message || err}</p>`;
      });
  }

  const HISTORY_CHART_IDS = new Set([
    "chart-cost-tokens",
    "chart-io",
    "chart-model-cost",
  ]);

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
      el.innerHTML = "<p class='meta'>데이터 없음</p>";
      return;
    }
    const cols = Object.keys(rows[0]);
    let html =
      "<table class='data'><thead><tr>" +
      cols.map((c) => `<th>${c}</th>`).join("") +
      "</tr></thead><tbody>";
    for (const row of rows) {
      html +=
        "<tr>" +
        cols
          .map((c) => {
            const v = row[c];
            const cell =
              typeof v === "number" && c.includes("비용")
                ? v.toFixed(4)
                : typeof v === "number"
                  ? fmtNum(v)
                  : v;
            return `<td>${cell}</td>`;
          })
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
    const prev = lastHistoryJson;
    lastHistoryJson = payload;

    const est = payload.local_cost_estimate;
    const estNote = est?.enabled
      ? ` · 로컬 비용 추정 Sonnet×${Math.round((est.ratio ?? 0.5) * 100)}%`
      : "";
    $("#history-meta").textContent = payload.updated_at
      ? `마지막 갱신: ${fmtUpdatedAt(payload.updated_at)} · 상태: ${payload.status}${estNote}`
      : `상태: ${payload.status}${estNote}`;

    if (payload.status === "loading") {
      showBanner("🔄 기록 데이터 조회 중… (화면은 계속 사용 가능)");
    } else {
      hideBanner();
    }

    const charts = payload.charts || {};
    const hasCharts = historyChartsPresent(charts);
    const loading = payload.status === "loading";

    if (payload.status === "error" && !payload.daily?.length && !hasCharts) {
      $("#history-metrics").innerHTML = `<p class="meta">${payload.error}</p>`;
      plotHistory("chart-cost-tokens", null);
      plotHistory("chart-io", null);
      plotHistory("chart-model-cost", null);
      return;
    }
    if (payload.status === "error" && payload.daily?.length) {
      toast("갱신 실패 — 이전 데이터 표시");
    } else if (
      payload.status === "ready" &&
      prev?.status === "loading" &&
      historyForce
    ) {
      toast("사용량 데이터를 갱신했습니다");
    }
    historyForce = false;

    const totals = payload.totals || {};
    renderMetrics("history-metrics", [
      { label: "총 토큰", value: fmtNum(totals.totalTokens) },
      { label: "비용 (USD)", value: fmtUsd(totals.totalCost) },
      { label: "Input", value: fmtNum(totals.inputTokens) },
      { label: "Output", value: fmtNum(totals.outputTokens) },
      { label: "Cache Read", value: fmtNum(totals.cacheReadTokens) },
    ]);

    applyHistoryCharts(charts, loading && !hasCharts);
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

    $("#rt-title").textContent = `오늘 · ${payload.today || new Date().toISOString().slice(0, 10)}`;
    const estRt = payload.local_cost_estimate;
    const estRtNote = estRt?.enabled
      ? ` · 로컬 비용 추정 Sonnet×${Math.round((estRt.ratio ?? 0.5) * 100)}%`
      : "";
    $("#realtime-meta").textContent = payload.updated_at
      ? `마지막 갱신: ${fmtUpdatedAt(payload.updated_at)}${estRtNote}`
      : "—";

    if (payload.status === "loading") {
      showBanner("🔄 오늘 사용량 조회 중…");
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
      toast("실시간 사용량을 갱신했습니다");
    }
    realtimeForce = false;

    const totals = payload.totals || {};
    renderMetrics("realtime-metrics", [
      { label: "총 토큰", value: fmtNum(totals.totalTokens) },
      { label: "비용 (USD)", value: fmtUsd(totals.totalCost) },
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
        <h3>활성 세션 블록</h3>
        <div class="metrics">
          <div class="metric"><div class="label">블록 비용</div><div class="value">${fmtUsd(active.costUSD)}</div></div>
          <div class="metric"><div class="label">블록 토큰</div><div class="value">${fmtNum(active.totalTokens)}</div></div>
          <div class="metric"><div class="label">소모 속도</div><div class="value">${fmtNum(burn.tokensPerMinute)} tok/분</div></div>
          <div class="metric"><div class="label">예상 비용</div><div class="value">$${(proj.totalCost ?? 0).toFixed(2)}</div></div>
        </div>
        <p class="meta">구간 ${fmtKstRange(active.startTime, active.endTime)} · ${(active.models || []).join(", ")}</p>`;
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
    return layout;
  }

  function buildRtTimelineLayout(figLayout) {
    const layout = buildPlotlyLayout(figLayout);
    if (layout.margin && typeof layout.margin === "object") {
      layout.margin.l = Math.max(layout.margin.l || 0, 80);
      layout.margin.r = Math.max(layout.margin.r || 0, 72);
    } else {
      layout.margin = { l: 80, r: 72, t: 48, b: 80 };
    }
    if (layout.yaxis && typeof layout.yaxis === "object") {
      layout.yaxis.automargin = true;
    }
    if (layout.yaxis2 && typeof layout.yaxis2 === "object") {
      layout.yaxis2.automargin = true;
    }
    return layout;
  }

  /** 실시간 모델별 막대 — react 멈춤 방지 */
  function plotRtModel(elId, figJson) {
    const el = document.getElementById(elId);
    if (!el) return;
    pendingPlots.delete(elId);
    if (!figJson?.data?.length) {
      if (typeof Plotly !== "undefined") Plotly.purge(el);
      el.innerHTML = "<p class='meta'>표시할 모델별 차트 데이터가 없습니다.</p>";
      return;
    }
    const fig = normalizePlotlyFig(figJson);
    const layout = buildPlotlyLayout(fig.layout);
    if (layout.margin && typeof layout.margin === "object") {
      layout.margin.l = Math.max(layout.margin.l || 0, 80);
    } else {
      layout.margin = { l: 80, r: 48, t: 48, b: 80 };
    }
    if (layout.yaxis && typeof layout.yaxis === "object") {
      layout.yaxis.automargin = true;
    }
    if (typeof Plotly !== "undefined") Plotly.purge(el);
    el.innerHTML = "";
    return Plotly.newPlot(el, fig.data, layout, { responsive: true })
      .then(() => Plotly.Plots.resize(el))
      .catch((err) => {
        console.error("Plotly model chart failed:", err);
        el.innerHTML = `<p class='meta'>차트 렌더 오류: ${err.message || err}</p>`;
      });
  }

  /** 실시간 추이 전용 — 구간 전환 시 react 대신 purge+newPlot (멈춤 방지) */
  function plotRtTimeline(figJson) {
    const el = document.getElementById("chart-rt-timeline");
    if (!el) return;
    pendingPlots.delete("chart-rt-timeline");
    if (!figJson?.data?.length) {
      if (typeof Plotly !== "undefined") Plotly.purge(el);
      el.innerHTML = "<p class='meta'>표시할 차트 데이터가 없습니다.</p>";
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
        if (layout.yaxis?.automargin || layout.yaxis2?.automargin) {
          return Plotly.relayout(el, {
            "yaxis.automargin": true,
            "yaxis2.automargin": true,
          });
        }
      })
      .catch((err) => {
        console.error("Plotly timeline failed:", err);
        el.innerHTML = `<p class='meta'>차트 렌더 오류: ${err.message || err}</p>`;
      });
  }

  function rtTimelineLabel(gran, mode) {
    const g = gran === "recent_5m" ? "최근 2시간 · 5분" : "시간별 (오늘)";
    const m = mode === "incremental" ? "증분" : "누적";
    return `${g} · ${m}`;
  }

  function renderRtTimeline() {
    const statusEl = $("#rt-timeline-status");
    const gran =
      document.getElementById("rt-timeline-granularity")?.value || "hour";
    const mode = document.getElementById("rt-timeline-mode")?.value || "incremental";

    if (!lastRealtimeJson) {
      if (statusEl) statusEl.textContent = "데이터를 불러오는 중…";
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
      let msg = "표시할 차트 데이터가 없습니다.";
      if (n > 0 && gran === "recent_5m") {
        const last = meta.last_snapshot_at
          ? fmtKst(meta.last_snapshot_at)
          : "—";
        msg =
          `스냅샷 ${fmtNum(n)}건 — 최근 2시간 구간이 비어 있습니다. 마지막 기록: ${last}`;
      } else if (n > 0) {
        msg = `스냅샷 ${fmtNum(n)}건 — 다른 구간/표시를 선택하거나 새로고침하세요.`;
      } else if (lastRealtimeJson.status === "loading") {
        msg = "사용량 조회 중…";
      } else {
        msg = "오늘 스냅샷이 없습니다.";
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
    params.set("ttl", $("#history-ttl").value);
    if (historyForce) params.set("force", "true");
    try {
      const data = await apiGet(`/api/v1/usage/history?${params}`);
      if (gen !== historyFetchGen) return;
      applyHistory(data);
    } catch (e) {
      if (gen !== historyFetchGen) return;
      showBanner(`API 오류: ${e.message}`);
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
      showBanner(`API 오류: ${e.message}`);
    }
  }

  function scheduleHistory() {
    clearInterval(historyTimer);
    const ttl = parseInt($("#history-ttl").value, 10) * 1000;
    historyTimer = setInterval(() => {
      if (activeView === "history") fetchHistory();
    }, ttl);
  }

  function scheduleRealtime() {
    clearInterval(realtimeTimer);
    realtimeTimer = setInterval(() => {
      if (activeView === "realtime") fetchRealtime();
    }, cfg.realtimeIntervalMs);
  }

  function startPoll() {
    clearInterval(pollTimer);
    pollTimer = setInterval(() => {
      if (activeView === "history") {
        if (lastHistoryJson?.status === "loading") fetchHistory();
      } else if (activeView === "realtime") {
        if (lastRealtimeJson?.status === "loading") fetchRealtime();
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
      scheduleHistory();
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
    historyDateTimer = setTimeout(() => {
      historyForce = true;
      fetchHistory();
    }, 400);
  }

  function init() {
    initDates();
    initSubTabs();

    $$(".tab").forEach((btn) => {
      btn.addEventListener("click", () => setView(btn.dataset.view));
    });

    $("#btn-history-refresh").addEventListener("click", () => {
      historyForce = true;
      fetchHistory();
    });
    $("#btn-realtime-refresh").addEventListener("click", () => {
      realtimeForce = true;
      fetchRealtime();
    });

    $("#history-ttl").addEventListener("change", scheduleHistory);

    const granSel = document.getElementById("rt-timeline-granularity");
    const modeSel = document.getElementById("rt-timeline-mode");
    if (granSel) granSel.addEventListener("change", onRtTimelineControlChange);
    if (modeSel) modeSel.addEventListener("change", onRtTimelineControlChange);

    startPoll();
    setView("history");
  }

  document.addEventListener("DOMContentLoaded", init);
})();
