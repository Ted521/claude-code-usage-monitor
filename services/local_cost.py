"""로컬(Ollama 등) 모델 비용 추정 — Claude Sonnet 환산 × 비율."""

from __future__ import annotations

import os
import re
from typing import Any

# Claude Sonnet급 공개 단가(USD/1M tokens) — ccusage LiteLLM과 유사한 참고치
_REF_INPUT_PER_M = 3.0
_REF_OUTPUT_PER_M = 15.0
_REF_CACHE_READ_PER_M = 0.30
_REF_CACHE_CREATE_PER_M = 3.75

_CLAUDE_MODEL = re.compile(r"claude", re.I)


def _enabled() -> bool:
    return os.getenv("LOCAL_COST_ESTIMATE_ENABLED", "true").lower() in (
        "1",
        "true",
        "yes",
        "on",
    )


def _ratio() -> float:
    try:
        return max(0.0, float(os.getenv("LOCAL_COST_CLAUDE_RATIO", "0.5")))
    except ValueError:
        return 0.5


def is_claude_model(model_name: str) -> bool:
    return bool(_CLAUDE_MODEL.search(model_name or ""))


def sonnet_equivalent_usd(mb: dict[str, Any]) -> float:
    """동일 토큰을 Sonnet API로 썼을 때의 대략 비용(USD)."""
    return (
        int(mb.get("inputTokens") or 0) / 1_000_000 * _REF_INPUT_PER_M
        + int(mb.get("outputTokens") or 0) / 1_000_000 * _REF_OUTPUT_PER_M
        + int(mb.get("cacheReadTokens") or 0) / 1_000_000 * _REF_CACHE_READ_PER_M
        + int(mb.get("cacheCreationTokens") or 0) / 1_000_000 * _REF_CACHE_CREATE_PER_M
    )


def should_estimate_model(mb: dict[str, Any]) -> bool:
    """ccusage 비용이 없거나 비-Claude 모델이면 추정."""
    name = mb.get("modelName") or ""
    cost = float(mb.get("cost") or 0)
    if is_claude_model(name) and cost > 0:
        return False
    tokens = sum(
        int(mb.get(k) or 0)
        for k in (
            "inputTokens",
            "outputTokens",
            "cacheCreationTokens",
            "cacheReadTokens",
        )
    )
    return tokens > 0 and (cost <= 0 or not is_claude_model(name))


def apply_half_claude_estimate(daily_payload: dict[str, Any]) -> dict[str, Any]:
    """
    로컬 모델 breakdown 비용 = Sonnet 환산 × LOCAL_COST_CLAUDE_RATIO(기본 0.5).
    일별·전체 totals 재계산.
    """
    if not _enabled():
        return daily_payload

    ratio = _ratio()
    daily = daily_payload.get("daily")
    if not isinstance(daily, list):
        return daily_payload

    any_estimated = False
    for day in daily:
        if not isinstance(day, dict):
            continue
        breakdowns = day.get("modelBreakdowns") or []
        day_cost = 0.0
        for mb in breakdowns:
            if not isinstance(mb, dict):
                continue
            base = float(mb.get("cost") or 0)
            if should_estimate_model(mb):
                base = sonnet_equivalent_usd(mb) * ratio
                mb["cost"] = base
                mb["costEstimated"] = True
                mb["costEstimateNote"] = f"Sonnet 환산×{ratio:.0%}"
                any_estimated = True
            else:
                mb["costEstimated"] = False
            day_cost += base
        day["totalCost"] = day_cost

    if any_estimated:
        totals = {
            "totalTokens": 0,
            "totalCost": 0.0,
            "inputTokens": 0,
            "outputTokens": 0,
            "cacheCreationTokens": 0,
            "cacheReadTokens": 0,
        }
        for day in daily:
            if not isinstance(day, dict):
                continue
            totals["totalTokens"] += int(day.get("totalTokens") or 0)
            totals["totalCost"] += float(day.get("totalCost") or 0)
            totals["inputTokens"] += int(day.get("inputTokens") or 0)
            totals["outputTokens"] += int(day.get("outputTokens") or 0)
            totals["cacheCreationTokens"] += int(day.get("cacheCreationTokens") or 0)
            totals["cacheReadTokens"] += int(day.get("cacheReadTokens") or 0)
        daily_payload["totals"] = totals
        daily_payload["localCostEstimate"] = {
            "enabled": True,
            "ratio": ratio,
            "reference": "claude-sonnet-class USD/M tokens",
        }

    return daily_payload
