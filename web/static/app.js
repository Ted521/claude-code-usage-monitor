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

  function plot(elId, figJson) {
    const el = document.getElementById(elId);
    if (!el) return;
    if (!figJson) {
      el.innerHTML = "<p class='meta'>표시할 차트 데이터가 없습니다.</p>";
      return;
    }
    const layout = {
      ...figJson.layout,
      template: figJson.layout?.template || "plotly_white",
      paper_bgcolor: "#ffffff",
      plot_bgcolor: "#ffffff",
    };
    Plotly.react(el, figJson.data, layout, { responsive: true });
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

    $("#history-meta").textContent = payload.updated_at
      ? `마지막 갱신: ${fmtUpdatedAt(payload.updated_at)} · 상태: ${payload.status}`
      : `상태: ${payload.status}`;

    if (payload.status === "loading") {
      showBanner("🔄 기록 데이터 조회 중… (화면은 계속 사용 가능)");
    } else {
      hideBanner();
    }

    if (payload.status === "error" && !payload.daily?.length) {
      $("#history-metrics").innerHTML = `<p class="meta">${payload.error}</p>`;
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

    const charts = payload.charts || {};
    plot("chart-cost-tokens", charts.cost_tokens);
    plot("chart-io", charts.input_output);
    plot("chart-model-cost", charts.model_cost);
    renderTable("history-table", payload.table || []);
    renderTable("models-detail-table", payload.models || []);
  }

  function applyRealtime(payload) {
    const prev = lastRealtimeJson;
    lastRealtimeJson = payload;

    $("#rt-title").textContent = `오늘 · ${payload.today || new Date().toISOString().slice(0, 10)}`;
    $("#realtime-meta").textContent = payload.updated_at
      ? `마지막 갱신: ${fmtUpdatedAt(payload.updated_at)}`
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

    plot("chart-rt-sessions", payload.charts?.sessions);
    renderTable("session-table", payload.session_table || []);
    renderTable("rt-model-table", payload.model_rows || []);
  }

  async function fetchHistory() {
    const params = new URLSearchParams();
    const since = sinceParam();
    const until = untilParam();
    if (since) params.set("since", since);
    if (until) params.set("until", until);
    params.set("ttl", $("#history-ttl").value);
    if (historyForce) params.set("force", "true");
    try {
      const data = await apiGet(`/api/v1/usage/history?${params}`);
      applyHistory(data);
    } catch (e) {
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
    } else {
      fetchRealtime();
      scheduleRealtime();
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
    });
    $("#use-until").addEventListener("change", (e) => {
      $("#until-date").disabled = !e.target.checked;
    });
  }

  function initSubTabs() {
    $$(".sub-tab").forEach((btn) => {
      btn.addEventListener("click", () => {
        const sub = btn.dataset.sub;
        $$(".sub-tab").forEach((b) => b.classList.toggle("active", b === btn));
        $("#history-sub-trend").classList.toggle("active", sub === "trend");
        $("#history-sub-table").classList.toggle("active", sub === "table");
        $("#history-sub-models").classList.toggle("active", sub === "models");
      });
    });
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

    startPoll();
    setView("history");
  }

  document.addEventListener("DOMContentLoaded", init);
})();
