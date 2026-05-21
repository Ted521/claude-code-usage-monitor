"""FastAPI — ccusage 데이터 API (비동기 백그라운드 조회)."""

from __future__ import annotations

import os
from typing import Any

from contextlib import asynccontextmanager

from fastapi import FastAPI, Query
from fastapi.middleware.cors import CORSMiddleware

from services import charts
from services.ccusage_client import (
    fetch_daily,
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

DEFAULT_HISTORY_TTL = int(os.getenv("HISTORY_TTL_SEC", "60"))
DEFAULT_REALTIME_TTL = int(os.getenv("REALTIME_TTL_SEC", "60"))


def _history_key(since: str | None, until: str | None) -> str:
    return f"history:{since or ''}:{until or ''}"


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/api/v1/usage/history")
def get_history(
    since: str | None = Query(None, description="YYYYMMDD"),
    until: str | None = Query(None, description="YYYYMMDD"),
    force: bool = Query(False),
    ttl: int = Query(DEFAULT_HISTORY_TTL, ge=10, le=3600),
) -> dict[str, Any]:
    key = _history_key(since, until)

    def fetcher() -> tuple[dict, dict | None, dict]:
        data = fetch_daily(since=since, until=until)
        return data, charts.history_charts(data), {
            "table": charts.daily_table_rows(data.get("daily") or []),
            "models": charts.model_detail_rows(data.get("daily") or []),
        }

    snap = usage_cache.ensure(key, fetcher, ttl_sec=ttl, force=force)
    data = snap.get("data") or {}
    return {
        "status": snap["status"],
        "updated_at": snap["updated_at"],
        "error": snap["error"],
        "totals": data.get("totals"),
        "daily": data.get("daily"),
        "charts": snap.get("charts"),
        "table": (snap.get("extra") or {}).get("table"),
        "models": (snap.get("extra") or {}).get("models"),
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
            timeline_store.append(today, totals)
        timeline = timeline_store.build_timeline(today)
        return (
            bundle,
            {"model_cost": charts.model_cost_bars(daily.get("daily") or [])},
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
    return {
        "status": snap["status"],
        "updated_at": snap["updated_at"],
        "error": snap["error"],
        "today": day,
        "totals": daily.get("totals"),
        "daily": daily.get("daily"),
        "blocks": bundle.get("blocks"),
        "sessions": bundle.get("sessions"),
        "charts": snap.get("charts"),
        "session_table": (snap.get("extra") or {}).get("session_table"),
        "model_rows": (snap.get("extra") or {}).get("model_rows"),
        "timeline": timeline,
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
            "세션": (s["period"][:8] + "…") if len(s["period"]) > 8 else s["period"],
            "에이전트": s.get("agent", ""),
            "총 토큰": s["totalTokens"],
            "비용(USD)": s["totalCost"],
            "Input": s["inputTokens"],
            "Output": s["outputTokens"],
            "모델": ", ".join(s.get("modelsUsed") or []),
        }
        for s in sorted(sessions, key=lambda x: x["totalTokens"], reverse=True)
    ]
