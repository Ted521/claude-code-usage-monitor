"""오늘 사용량 분 단위 스냅샷 저장 · 시간/구간별 집계."""

from __future__ import annotations

import json
import os
import threading
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo

KST = ZoneInfo("Asia/Seoul")
DEFAULT_DIR = Path(os.getenv("USAGE_TIMELINE_DIR", "data/timeline"))


class TimelineStore:
    def __init__(self, base_dir: Path | None = None) -> None:
        self._dir = base_dir or DEFAULT_DIR
        self._lock = threading.Lock()

    def _path(self, day: str) -> Path:
        return self._dir / f"{day}.jsonl"

    def append(self, day: str, totals: dict[str, Any]) -> None:
        if not totals:
            return
        row = {
            "ts": datetime.now(KST).isoformat(timespec="seconds"),
            "totalTokens": int(totals.get("totalTokens") or 0),
            "totalCost": float(totals.get("totalCost") or 0),
            "inputTokens": int(totals.get("inputTokens") or 0),
            "outputTokens": int(totals.get("outputTokens") or 0),
        }
        path = self._path(day)
        path.parent.mkdir(parents=True, exist_ok=True)
        with self._lock:
            with path.open("a", encoding="utf-8") as f:
                f.write(json.dumps(row, ensure_ascii=False) + "\n")

    def read_day(self, day: str) -> list[dict[str, Any]]:
        path = self._path(day)
        if not path.exists():
            return []
        rows: list[dict[str, Any]] = []
        with self._lock:
            for line in path.read_text(encoding="utf-8").splitlines():
                line = line.strip()
                if line:
                    rows.append(json.loads(line))
        return rows

    @staticmethod
    def _parse_ts(row: dict[str, Any]) -> datetime | None:
        try:
            ts = datetime.fromisoformat(row["ts"])
        except (KeyError, ValueError):
            return None
        if ts.tzinfo is None:
            return ts.replace(tzinfo=KST)
        return ts.astimezone(KST)

    def _sorted_rows(self, day: str) -> list[tuple[datetime, dict[str, Any]]]:
        parsed: list[tuple[datetime, dict[str, Any]]] = []
        for row in self.read_day(day):
            ts = self._parse_ts(row)
            if ts is not None:
                parsed.append((ts, row))
        parsed.sort(key=lambda x: x[0])
        return parsed

    def hourly_incremental(self, day: str) -> list[dict[str, Any]]:
        """KST 시간대별 증분 (이전 시 마지막 누적 대비)."""
        rows = self._sorted_rows(day)
        if not rows:
            return []

        by_hour: dict[int, list[tuple[datetime, dict[str, Any]]]] = {}
        for ts, row in rows:
            by_hour.setdefault(ts.hour, []).append((ts, row))

        buckets: list[dict[str, Any]] = []
        prev_tokens = 0
        prev_cost = 0.0
        for hour in sorted(by_hour):
            _, last_row = by_hour[hour][-1]
            tokens = int(last_row.get("totalTokens") or 0)
            cost = float(last_row.get("totalCost") or 0)
            buckets.append(
                {
                    "label": f"{hour:02d}:00",
                    "totalTokens": max(0, tokens - prev_tokens),
                    "totalCost": max(0.0, cost - prev_cost),
                }
            )
            prev_tokens = tokens
            prev_cost = cost
        return buckets

    def hourly_cumulative(self, day: str) -> list[dict[str, Any]]:
        """KST 시간대별 마지막 스냅샷 누적값."""
        rows = self._sorted_rows(day)
        if not rows:
            return []

        by_hour: dict[int, tuple[datetime, dict[str, Any]]] = {}
        for ts, row in rows:
            by_hour[ts.hour] = (ts, row)

        return [
            {
                "label": f"{hour:02d}:00",
                "totalTokens": int(by_hour[hour][1].get("totalTokens") or 0),
                "totalCost": float(by_hour[hour][1].get("totalCost") or 0),
            }
            for hour in sorted(by_hour)
        ]

    def recent_binned_incremental(
        self,
        day: str,
        *,
        hours: float = 2,
        bin_minutes: int = 5,
    ) -> list[dict[str, Any]]:
        """최근 N시간, bin_minutes 단위 증분."""
        rows = self._sorted_rows(day)
        if not rows:
            return []

        now = datetime.now(KST)
        cutoff = now - timedelta(hours=hours)
        before = [(ts, row) for ts, row in rows if ts < cutoff]
        in_window = [(ts, row) for ts, row in rows if ts >= cutoff]
        if not in_window:
            # 최근 2시간 내 스냅샷 없음 → 오늘 전체를 5분 bin (재빌드 직후·수집 초기)
            in_window = list(rows)
            before = []

        prev_tokens = int(before[-1][1].get("totalTokens") or 0) if before else 0
        prev_cost = float(before[-1][1].get("totalCost") or 0) if before else 0.0

        bins: dict[datetime, list[tuple[datetime, dict[str, Any]]]] = {}
        for ts, row in in_window:
            slot = ts.replace(
                minute=(ts.minute // bin_minutes) * bin_minutes,
                second=0,
                microsecond=0,
            )
            bins.setdefault(slot, []).append((ts, row))

        buckets: list[dict[str, Any]] = []
        for slot in sorted(bins):
            _, last_row = bins[slot][-1]
            tokens = int(last_row.get("totalTokens") or 0)
            cost = float(last_row.get("totalCost") or 0)
            buckets.append(
                {
                    "label": slot.strftime("%H:%M"),
                    "totalTokens": max(0, tokens - prev_tokens),
                    "totalCost": max(0.0, cost - prev_cost),
                }
            )
            prev_tokens = tokens
            prev_cost = cost
        return buckets

    def cumulative_recent(self, day: str, *, hours: float = 2) -> list[dict[str, Any]]:
        """최근 N시간 스냅샷 누적 곡선 (분 단위, 분당 마지막 값)."""
        rows = self._sorted_rows(day)
        if not rows:
            return []

        now = datetime.now(KST)
        cutoff = now - timedelta(hours=hours)
        in_window = [(ts, row) for ts, row in rows if ts >= cutoff]
        if not in_window:
            in_window = list(rows)

        by_minute: dict[tuple[int, int, int, int, int], tuple[datetime, dict[str, Any]]] = {}
        for ts, row in in_window:
            key = (ts.year, ts.month, ts.day, ts.hour, ts.minute)
            by_minute[key] = (ts, row)

        return [
            {
                "label": ts.strftime("%H:%M"),
                "totalTokens": int(row.get("totalTokens") or 0),
                "totalCost": float(row.get("totalCost") or 0),
            }
            for _, (ts, row) in sorted(by_minute.items(), key=lambda x: x[1][0])
        ]

    def build_timeline(self, day: str) -> dict[str, list[dict[str, Any]]]:
        return {
            "hourly_incremental": self.hourly_incremental(day),
            "hourly_cumulative": self.hourly_cumulative(day),
            "recent_5m_incremental": self.recent_binned_incremental(day),
            "cumulative_recent": self.cumulative_recent(day),
        }


timeline_store = TimelineStore()
