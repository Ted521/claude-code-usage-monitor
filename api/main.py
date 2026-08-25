"""FastAPI — ccusage 데이터 API (비동기 백그라운드 조회)."""

from __future__ import annotations

import os
from datetime import datetime
from typing import Any

from contextlib import asynccontextmanager

from fastapi import FastAPI, Query
from fastapi.middleware.cors import CORSMiddleware

from services import charts, local_cost
from services.ccusage_client import (
    fetch_realtime_bundle,
    today_yyyymmdd,
)
from services.job_cache import usage_cache
from services.minute_scheduler import start_minute_scheduler, stop_minute_scheduler
from services.timeline_store import timeline_store


@asynccontextmanager
async def lifespan(_app: FastAPI):
    start_minute_scheduler()
    yield
    stop_minute_scheduler()


app = FastAPI(title="Claude Usage API", version="1.0.0", lifespan=lifespan)

_cors = os.getenv("CORS_ORIGINS", "*")
app.add_middleware(
    CORSMiddleware,
    allow_origins=[o.strip() for o in _cors.split(",")],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

DEFAULT_REALTIME_TTL = int(os.getenv("REALTIME_TTL_SEC", "60"))


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/api/v1/usage/history")
def get_history(
    since: str | None = Query(None, description="YYYYMMDD"),
    until: str | None = Query(None, description="YYYYMMDD"),
) -> dict[str, Any]:
    """저장된 분단위 스냅샷(data/timeline)만으로 응답 — ccusage는 호출하지 않는다.
    minute_scheduler가 이미 주기적으로 ccusage를 돌려 스냅샷을 쌓아두고 있고, ccusage
    자체도 Claude Code의 세션 로그 정리(cleanupPeriodDays) 때문에 오래된 날짜는 어차피
    다시 물어봐도 못 준다 — 그래서 history는 항상 로컬 파일만 읽는 동기 엔드포인트다
    (별도 캐시/로딩 상태 불필요, 파일 읽기라 그 자체로 빠름)."""
    resolved_since = since or timeline_store.earliest_day() or today_yyyymmdd()
    resolved_until = until or today_yyyymmdd()
    try:
        entries, _missing = timeline_store.history_from_snapshots(
            resolved_since, resolved_until
        )
        data: dict[str, Any] = {
            "daily": entries,
            "totals": local_cost.sum_daily_totals(entries),
        }
        if any(
            mb.get("costEstimated")
            for e in entries
            for mb in (e.get("modelBreakdowns") or [])
        ):
            data["localCostEstimate"] = local_cost.estimate_meta()

        return {
            "status": "ready",
            "updated_at": datetime.now().isoformat(),
            "error": None,
            "totals": data.get("totals"),
            "daily": data.get("daily"),
            "charts": charts.history_charts(data),
            "table": charts.daily_table_rows(entries),
            "models": charts.model_detail_rows(entries),
            "local_cost_estimate": data.get("localCostEstimate"),
        }
    except Exception as ex:
        return {
            "status": "error",
            "updated_at": datetime.now().isoformat(),
            "error": str(ex),
            "totals": None,
            "daily": None,
            "charts": None,
            "table": None,
            "models": None,
            "local_cost_estimate": None,
        }


@app.get("/api/v1/usage/realtime")
def get_realtime(
    force: bool = Query(False),
    ttl: int = Query(DEFAULT_REALTIME_TTL, ge=10, le=3600),
) -> dict[str, Any]:
    key = f"realtime:{today_yyyymmdd()}"

    today = today_yyyymmdd()

    def fetcher() -> tuple[dict, dict | None, dict]:
        bundle = fetch_realtime_bundle()
        sessions = bundle.get("sessions", {}).get("session") or []
        daily = bundle.get("daily") or {}
        totals = daily.get("totals") or {}
        if totals:
            daily_list = daily.get("daily") or []
            models = daily_list[0].get("modelBreakdowns") if daily_list else None
            timeline_store.append(today, totals, models)
        timeline = timeline_store.build_timeline(today)
        daily_list = daily.get("daily") or []
        chart_payload = {
            "model_tokens": charts.model_token_bars(daily_list),
            **charts.realtime_timeline_charts(timeline),
        }
        return (
            bundle,
            chart_payload,
            {
                "today": today,
                "session_table": _session_table_rows(sessions),
                "model_rows": charts.model_detail_rows(daily.get("daily") or []),
                "timeline": timeline,
            },
        )

    snap = usage_cache.ensure(key, fetcher, ttl_sec=ttl, force=force)
    bundle = snap.get("data") or {}
    daily = bundle.get("daily") or {}
    day = (snap.get("extra") or {}).get("today") or today
    # 캐시가 loading이어도 디스크 스냅샷으로 차트 즉시 표시
    timeline = timeline_store.build_timeline(day)
    snapshots = timeline_store.read_day(day)
    last_ts = snapshots[-1].get("ts") if snapshots else None
    daily_list = daily.get("daily") or []
    merged_charts = {
        **(snap.get("charts") or {}),
        **charts.realtime_timeline_charts(timeline),
        "model_tokens": charts.model_token_bars(daily_list),
    }
    return {
        "status": snap["status"],
        "updated_at": snap["updated_at"],
        "error": snap["error"],
        "today": day,
        "totals": daily.get("totals"),
        "daily": daily.get("daily"),
        "blocks": bundle.get("blocks"),
        "sessions": bundle.get("sessions"),
        "charts": merged_charts,
        "session_table": (snap.get("extra") or {}).get("session_table"),
        "model_rows": (snap.get("extra") or {}).get("model_rows"),
        "timeline": timeline,
        "local_cost_estimate": daily.get("localCostEstimate"),
        "timeline_meta": {
            "snapshot_lines": len(snapshots),
            "last_snapshot_at": last_ts,
            "recent_5m_points": len(
                (timeline.get("recent_5m_incremental") or [])
            ),
        },
    }


def _session_table_rows(sessions: list[dict]) -> list[dict]:
    return [
        {
            "Session": (s["period"][:8] + "…") if len(s["period"]) > 8 else s["period"],
            "Agent": s.get("agent", ""),
            "Total tokens": s["totalTokens"],
            "Cost (USD)": s["totalCost"],
            "Input": s["inputTokens"],
            "Output": s["outputTokens"],
            "Models": ", ".join(s.get("modelsUsed") or []),
        }
        for s in sorted(sessions, key=lambda x: x["totalTokens"], reverse=True)
    ]
