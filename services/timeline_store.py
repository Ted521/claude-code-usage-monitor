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

    def append(
        self,
        day: str,
        totals: dict[str, Any],
        model_breakdowns: list[dict[str, Any]] | None = None,
    ) -> None:
        if not totals:
            return
        # ponytail: model breakdown written on every minute row (not just the day's last one) —
        # simplest correct option, and history only ever reads the last row of a day anyway.
        models = [
            {
                "modelName": mb["modelName"],
                "cost": float(mb.get("cost") or 0),
                "inputTokens": int(mb.get("inputTokens") or 0),
                "outputTokens": int(mb.get("outputTokens") or 0),
                "cacheCreationTokens": int(mb.get("cacheCreationTokens") or 0),
                "cacheReadTokens": int(mb.get("cacheReadTokens") or 0),
                "costEstimated": bool(mb.get("costEstimated")),
            }
            for mb in (model_breakdowns or [])
            if isinstance(mb, dict) and mb.get("modelName")
        ]
        row = {
            "ts": datetime.now(KST).isoformat(timespec="seconds"),
            "totalTokens": int(totals.get("totalTokens") or 0),
            "totalCost": float(totals.get("totalCost") or 0),
            "inputTokens": int(totals.get("inputTokens") or 0),
            "outputTokens": int(totals.get("outputTokens") or 0),
            "cacheCreationTokens": int(totals.get("cacheCreationTokens") or 0),
            "cacheReadTokens": int(totals.get("cacheReadTokens") or 0),
            "models": models,
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

    def earliest_day(self) -> str | None:
        """가장 오래된 스냅샷 파일의 날짜(YYYYMMDD), 없으면 None."""
        if not self._dir.exists():
            return None
        days = [p.stem for p in self._dir.glob("[0-9]" * 8 + ".jsonl")]
        return min(days) if days else None

    def day_final(self, day: str) -> dict[str, Any] | None:
        """해당 날짜의 마지막 스냅샷(그 날의 최종 누적치)."""
        rows = self._sorted_rows(day)
        return rows[-1][1] if rows else None

    def daily_entry(self, day: str) -> dict[str, Any] | None:
        """ccusage `daily[]` 항목과 동일한 필드 형태로 변환 (history 캐시 우회용)."""
        row = self.day_final(day)
        if row is None:
            return None
        models = row.get("models") or []
        return {
            "period": day,
            "totalTokens": int(row.get("totalTokens") or 0),
            "totalCost": float(row.get("totalCost") or 0),
            "inputTokens": int(row.get("inputTokens") or 0),
            "outputTokens": int(row.get("outputTokens") or 0),
            "cacheCreationTokens": int(row.get("cacheCreationTokens") or 0),
            "cacheReadTokens": int(row.get("cacheReadTokens") or 0),
            "modelsUsed": sorted({m["modelName"] for m in models if m.get("modelName")}),
            "modelBreakdowns": models,
        }

    def history_from_snapshots(
        self, since: str, until: str
    ) -> tuple[list[dict[str, Any]], list[str]]:
        """since/until(YYYYMMDD, 포함) 범위를 로컬 스냅샷만으로 구성.

        Returns (daily_entries, missing_days). missing_days가 비어 있어야 range 전체가
        스냅샷으로 커버된 것 — 하나라도 비면 호출측에서 ccusage로 폴백.
        """
        start = datetime.strptime(since, "%Y%m%d")
        end = datetime.strptime(until, "%Y%m%d")
        if start > end:
            # 뒤집힌 범위 — 빈 while 루프로 "missing 없음(=커버됨)"이 되어버리면
            # 호출측이 합계 0짜리 "ready" 응답을 정상 데이터로 착각한다.
            return [], [since]
        entries: list[dict[str, Any]] = []
        missing: list[str] = []
        d = start
        while d <= end:
            key = d.strftime("%Y%m%d")
            entry = self.daily_entry(key)
            if entry is None:
                missing.append(key)
            else:
                entries.append(entry)
            d += timedelta(days=1)
        return entries, missing

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
