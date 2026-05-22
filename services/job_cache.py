"""백그라운드 ccusage 조회 + 메모리 캐시."""

from __future__ import annotations

import threading
import time
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any, Callable


@dataclass
class CacheEntry:
    status: str  # idle | loading | ready | error
    updated_at: datetime | None = None
    data: Any = None
    error: str | None = None
    charts: dict[str, Any] | None = None
    extra: dict[str, Any] = field(default_factory=dict)
    refreshing: bool = False


class UsageJobCache:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._entries: dict[str, CacheEntry] = {}

    def _get(self, key: str) -> CacheEntry:
        with self._lock:
            if key not in self._entries:
                self._entries[key] = CacheEntry(status="idle")
            return self._entries[key]

    def snapshot(self, key: str) -> dict[str, Any]:
        entry = self._get(key)
        with self._lock:
            return {
                "status": entry.status,
                "updated_at": (
                    entry.updated_at.isoformat() if entry.updated_at else None
                ),
                "data": entry.data,
                "error": entry.error,
                "charts": entry.charts,
                "extra": entry.extra,
            }

    def ensure(
        self,
        key: str,
        fetcher: Callable[[], tuple[Any, dict[str, Any] | None, dict[str, Any]]],
        *,
        ttl_sec: int,
        force: bool = False,
    ) -> dict[str, Any]:
        """
        fetcher -> (data, charts, extra)
        ttl 지났거나 force이면 백그라운드 갱신 시작.
        """
        entry = self._get(key)
        now = time.time()
        stale = True
        if entry.updated_at and entry.status == "ready":
            stale = (datetime.now() - entry.updated_at).total_seconds() >= ttl_sec

        with self._lock:
            running = entry.status == "loading" or entry.refreshing

        if (force or stale or entry.status in ("idle", "error")) and not running:
            self._start(key, fetcher)

        return self.snapshot(key)

    def _start(
        self,
        key: str,
        fetcher: Callable[[], tuple[Any, dict[str, Any] | None, dict[str, Any]]],
    ) -> None:
        with self._lock:
            entry = self._entries.setdefault(key, CacheEntry(status="idle"))
            if entry.refreshing or entry.status == "loading":
                return
            entry.refreshing = True
            entry.error = None
            # 이미 표시 중인 데이터가 있으면 ready 유지(프론트가 loading으로 차트를 비우지 않게)
            if entry.status != "ready" or entry.data is None:
                entry.status = "loading"

        def worker() -> None:
            try:
                data, charts, extra = fetcher()
                with self._lock:
                    e = self._entries[key]
                    e.status = "ready"
                    e.data = data
                    e.charts = charts
                    e.extra = extra
                    e.error = None
                    e.updated_at = datetime.now()
            except Exception as ex:
                with self._lock:
                    e = self._entries[key]
                    e.status = "error"
                    e.error = str(ex)
                    e.updated_at = datetime.now()
            finally:
                with self._lock:
                    e = self._entries.get(key)
                    if e is not None:
                        e.refreshing = False

        threading.Thread(target=worker, daemon=True).start()


usage_cache = UsageJobCache()
