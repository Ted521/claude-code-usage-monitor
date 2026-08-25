"""백그라운드 분 단위 ccusage 스냅샷 (오늘 시간별 차트용)."""

from __future__ import annotations

import logging
import os
import threading
import time

from services.ccusage_client import fetch_daily, today_yyyymmdd
from services.timeline_store import timeline_store

log = logging.getLogger(__name__)

_enabled = os.getenv("MINUTE_SNAPSHOT_ENABLED", "true").lower() in (
    "1",
    "true",
    "yes",
)
_interval = max(30, int(os.getenv("MINUTE_SNAPSHOT_INTERVAL_SEC", "60")))
_thread: threading.Thread | None = None
_stop = threading.Event()


def _tick() -> None:
    today = today_yyyymmdd()
    try:
        data = fetch_daily(since=today, until=today)
        totals = data.get("totals") or {}
        if totals:
            daily_list = data.get("daily") or []
            models = daily_list[0].get("modelBreakdowns") if daily_list else None
            timeline_store.append(today, totals, models)
    except Exception as ex:
        log.warning("minute snapshot failed: %s", ex)


def _loop() -> None:
    while not _stop.is_set():
        _tick()
        _stop.wait(_interval)


def start_minute_scheduler() -> None:
    global _thread
    if not _enabled:
        log.info("minute snapshot scheduler disabled")
        return
    if _thread and _thread.is_alive():
        return
    _stop.clear()
    _thread = threading.Thread(target=_loop, daemon=True, name="minute-snapshot")
    _thread.start()
    log.info("minute snapshot scheduler started (every %ss)", _interval)


def stop_minute_scheduler() -> None:
    _stop.set()
