"""Plotly 차트 → JSON (Plotly.js 렌더링용)."""

from __future__ import annotations

import base64
from typing import Any

import numpy as np
import pandas as pd
import plotly.graph_objects as go
from plotly.subplots import make_subplots

BAR_BARGAP = 0.45
BAR_GROUPGAP = 0.12
CHART_HEIGHT = 520

_DTYPE_MAP = {
    "f8": np.float64,
    "f4": np.float32,
    "i4": np.int32,
    "u4": np.uint32,
}


def _decode_bdata(obj: dict[str, Any]) -> list[Any]:
    dtype = _DTYPE_MAP.get(obj.get("dtype", "f8"), np.float64)
    raw = base64.b64decode(obj["bdata"])
    return np.frombuffer(raw, dtype=dtype).tolist()


def _coerce_plotly_arrays(node: Any) -> Any:
    """Plotly dict → FastAPI/Plotly.js 호환 (bdata·numpy 제거)."""
    if isinstance(node, np.ndarray):
        return node.tolist()
    if isinstance(node, np.generic):
        return node.item()
    if isinstance(node, dict):
        if "bdata" in node and "dtype" in node:
            return _decode_bdata(node)
        return {k: _coerce_plotly_arrays(v) for k, v in node.items()}
    if isinstance(node, (list, tuple)):
        return [_coerce_plotly_arrays(x) for x in node]
    return node


def _fig_json(fig: go.Figure) -> dict[str, Any]:
    return _coerce_plotly_arrays(fig.to_dict())


def _apply_x_unified_hover(fig: go.Figure) -> None:
    fig.update_layout(
        hovermode="x unified",
        hoverdistance=72,
        legend=dict(orientation="h", yanchor="bottom", y=1.02, xanchor="right", x=1),
        margin=dict(l=48, r=48, t=48, b=80),
        height=CHART_HEIGHT,
    )
    fig.update_xaxes(
        type="category",
        showspikes=True,
        spikemode="across",
        spikesnap="cursor",
        spikecolor="rgba(31,78,121,0.55)",
        spikethickness=1.5,
        spikedash="solid",
    )


def cost_tokens_chart(daily: list[dict]) -> dict[str, Any] | None:
    if not daily:
        return None
    df = pd.DataFrame(
        [
            {
                "날짜": d["period"],
                "비용(USD)": d["totalCost"],
                "총 토큰": d["totalTokens"],
            }
            for d in daily
        ]
    )
    fig = make_subplots(specs=[[{"secondary_y": True}]])
    fig.add_trace(
        go.Scatter(
            x=df["날짜"],
            y=df["비용(USD)"],
            name="비용(USD)",
            mode="lines+markers",
            line=dict(width=2, color="#1F4E79"),
            marker=dict(size=7),
        ),
        secondary_y=False,
    )
    fig.add_trace(
        go.Scatter(
            x=df["날짜"],
            y=df["총 토큰"],
            name="총 토큰",
            mode="lines+markers",
            line=dict(width=2, color="#ED7D31"),
            marker=dict(size=7),
        ),
        secondary_y=True,
    )
    fig.update_yaxes(title_text="비용 (USD)", secondary_y=False, tickformat=".4f")
    fig.update_yaxes(title_text="총 토큰", secondary_y=True, tickformat=",")
    _apply_x_unified_hover(fig)
    return _fig_json(fig)


def input_output_bars(daily: list[dict]) -> dict[str, Any] | None:
    if not daily:
        return None
    df = pd.DataFrame(
        [
            {"날짜": d["period"], "Input": d["inputTokens"], "Output": d["outputTokens"]}
            for d in daily
        ]
    )
    fig = go.Figure()
    fig.add_trace(
        go.Bar(x=df["날짜"], y=df["Input"], name="Input", marker_color="#2E75B6")
    )
    fig.add_trace(
        go.Bar(x=df["날짜"], y=df["Output"], name="Output", marker_color="#A9D18E")
    )
    fig.update_layout(
        barmode="group",
        bargap=BAR_BARGAP,
        bargroupgap=BAR_GROUPGAP,
        yaxis_title="토큰",
        yaxis_tickformat=",",
    )
    _apply_x_unified_hover(fig)
    return _fig_json(fig)


def model_cost_bars(daily: list[dict]) -> dict[str, Any] | None:
    rows = []
    for d in daily:
        for mb in d.get("modelBreakdowns") or []:
            rows.append({"모델": mb["modelName"], "비용(USD)": mb["cost"]})
    if not rows:
        return None
    by_model = (
        pd.DataFrame(rows)
        .groupby("모델", as_index=False)
        .agg({"비용(USD)": "sum"})
        .sort_values("비용(USD)", ascending=False)
    )
    fig = go.Figure(
        data=[
            go.Bar(
                x=by_model["모델"],
                y=by_model["비용(USD)"],
                marker_color="#4472C4",
            )
        ]
    )
    fig.update_layout(
        bargap=BAR_BARGAP,
        xaxis_title="모델",
        yaxis_title="비용 (USD)",
        yaxis_tickformat=".4f",
        height=CHART_HEIGHT,
        margin=dict(l=48, r=48, t=48, b=80),
    )
    _apply_x_unified_hover(fig)
    return _fig_json(fig)


def session_tokens_bars(sessions: list[dict]) -> dict[str, Any] | None:
    if not sessions:
        return None
    sorted_s = sorted(sessions, key=lambda x: x["totalTokens"], reverse=True)
    labels = [
        (s["period"][:8] + "…") if len(s["period"]) > 8 else s["period"]
        for s in sorted_s
    ]
    fig = go.Figure(
        data=[
            go.Bar(
                x=labels,
                y=[s["totalTokens"] for s in sorted_s],
                marker_color="#2E75B6",
            )
        ],
        layout=dict(
            height=360,
            margin=dict(l=48, r=48, t=32, b=96),
            xaxis_title="세션",
            yaxis_title="토큰",
            yaxis_tickformat=",",
        ),
    )
    return _fig_json(fig)


def history_charts(daily_data: dict) -> dict[str, Any]:
    daily = daily_data.get("daily") or []
    return {
        "cost_tokens": cost_tokens_chart(daily),
        "input_output": input_output_bars(daily),
        "model_cost": model_cost_bars(daily),
    }


def daily_table_rows(daily: list[dict]) -> list[dict]:
    return [
        {
            "날짜": d["period"],
            "Input": d["inputTokens"],
            "Output": d["outputTokens"],
            "Cache Create": d["cacheCreationTokens"],
            "Cache Read": d["cacheReadTokens"],
            "총 토큰": d["totalTokens"],
            "비용(USD)": d["totalCost"],
            "모델": ", ".join(d.get("modelsUsed") or []),
        }
        for d in daily
    ]


def model_detail_rows(daily: list[dict]) -> list[dict]:
    rows = []
    for d in daily:
        for mb in d.get("modelBreakdowns") or []:
            rows.append(
                {
                    "날짜": d["period"],
                    "모델": mb["modelName"],
                    "Input": mb["inputTokens"],
                    "Output": mb["outputTokens"],
                    "Cache Read": mb["cacheReadTokens"],
                    "비용(USD)": mb["cost"],
                }
            )
    return rows
