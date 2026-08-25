"""ponytail self-check: history_from_snapshots / daily_entry. Run: python services/test_timeline_store.py"""

from __future__ import annotations

import shutil
import tempfile
from pathlib import Path

from services.timeline_store import TimelineStore


def test_daily_entry_from_snapshots():
    tmp = Path(tempfile.mkdtemp())
    try:
        store = TimelineStore(base_dir=tmp)
        store.append(
            "20260701",
            {"totalTokens": 100, "totalCost": 1.0, "inputTokens": 60, "outputTokens": 40,
             "cacheCreationTokens": 5, "cacheReadTokens": 2},
            [{"modelName": "sonnet", "cost": 0.5, "inputTokens": 30, "outputTokens": 20,
              "cacheCreationTokens": 2, "cacheReadTokens": 1, "costEstimated": False}],
        )
        # 같은 날 두 번째(더 나중) 스냅샷 — day_final은 이 값을 써야 함
        store.append(
            "20260701",
            {"totalTokens": 300, "totalCost": 3.0, "inputTokens": 180, "outputTokens": 120,
             "cacheCreationTokens": 10, "cacheReadTokens": 4},
            [{"modelName": "sonnet", "cost": 1.5, "inputTokens": 90, "outputTokens": 60,
              "cacheCreationTokens": 4, "cacheReadTokens": 2, "costEstimated": True}],
        )

        entry = store.daily_entry("20260701")
        assert entry is not None
        assert entry["period"] == "20260701"
        assert entry["totalTokens"] == 300
        assert entry["totalCost"] == 3.0
        assert entry["cacheReadTokens"] == 4
        assert entry["modelsUsed"] == ["sonnet"]
        assert entry["modelBreakdowns"][0]["costEstimated"] is True

        assert store.daily_entry("20260702") is None
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def test_history_from_snapshots_reports_gaps():
    tmp = Path(tempfile.mkdtemp())
    try:
        store = TimelineStore(base_dir=tmp)
        store.append("20260701", {"totalTokens": 10, "totalCost": 0.1})
        store.append("20260703", {"totalTokens": 30, "totalCost": 0.3})
        # 20260702는 비어 있음 (수집 중단 구간 가정)

        entries, missing = store.history_from_snapshots("20260701", "20260703")
        assert missing == ["20260702"]
        assert [e["period"] for e in entries] == ["20260701", "20260703"]

        entries2, missing2 = store.history_from_snapshots("20260701", "20260701")
        assert missing2 == []
        assert len(entries2) == 1
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def test_history_from_snapshots_rejects_inverted_range():
    tmp = Path(tempfile.mkdtemp())
    try:
        store = TimelineStore(base_dir=tmp)
        store.append("20260701", {"totalTokens": 10, "totalCost": 0.1})
        entries, missing = store.history_from_snapshots("20260710", "20260701")
        assert entries == []
        assert missing  # non-empty => caller must NOT treat this as "covered"
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


if __name__ == "__main__":
    test_daily_entry_from_snapshots()
    test_history_from_snapshots_reports_gaps()
    test_history_from_snapshots_rejects_inverted_range()
    print("OK")
