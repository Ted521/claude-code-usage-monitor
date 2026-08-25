"""Plotly charts → JSON (for Plotly.js rendering)."""

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
CHART_MARGIN = dict(l=90, r=72, t=48, b=80)
TOKEN_TICKFORMAT = ".2s"


def _usd_tickformat(values: list[float]) -> str:
    vals = [abs(float(v or 0)) for v in values]
    if not vals or max(vals) < 1000:
        return "$.4f"
    return "$,.2s"


def _decode_bdata(obj: dict[str, Any]) -> list[Any]:
    # ponytail: trust numpy's own dtype-string parsing (it already knows every
    # Plotly-emitted code — i1/i2/i4/i8/u1/u2/u4/u8/f4/f8) instead of a hand-rolled,
    # necessarily-incomplete lookup table that silently defaulted to float64 and
    # crashed/corrupted on any dtype it didn't list (e.g. plotly's compact "i2").
    raw = base64.b64decode(obj["bdata"])
    return np.frombuffer(raw, dtype=np.dtype(obj.get("dtype", "f8"))).tolist()


def _coerce_plotly_arrays(node: Any) -> Any:
    """Plotly dict → FastAPI/Plotly.js compatible (strip bdata/numpy)."""
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
    spec = _coerce_plotly_arrays(fig.to_dict())
    layout = spec.get("layout")
    if isinstance(layout, dict) and isinstance(layout.get("template"), dict):
        layout["template"] = "plotly_white"
    return spec


def _apply_chart_yaxes(fig: go.Figure) -> None:
    fig.update_yaxes(automargin=True)


def _apply_x_unified_hover(fig: go.Figure) -> None:
    fig.update_layout(
        hovermode="x unified",
        hoverdistance=72,
        legend=dict(orientation="h", yanchor="bottom", y=1.02, xanchor="right", x=1),
        margin=dict(CHART_MARGIN),
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
    _apply_chart_yaxes(fig)


def cost_tokens_chart(daily: list[dict]) -> dict[str, Any] | None:
    if not daily:
        return None
    df = pd.DataFrame(
        [
            {
                "Date": d["period"],
                "Cost (USD)": d["totalCost"],
                "Total tokens": d["totalTokens"],
            }
            for d in daily
        ]
    )
    fig = make_subplots(specs=[[{"secondary_y": True}]])
    fig.add_trace(
        go.Scatter(
            x=df["Date"],
            y=df["Cost (USD)"],
            name="Cost (USD)",
            mode="lines+markers",
            line=dict(width=2, color="#1F4E79"),
            marker=dict(size=7),
        ),
        secondary_y=False,
    )
    fig.add_trace(
        go.Scatter(
            x=df["Date"],
            y=df["Total tokens"],
            name="Total tokens",
            mode="lines+markers",
            line=dict(width=2, color="#ED7D31"),
            marker=dict(size=7),
        ),
        secondary_y=True,
    )
    cost_vals = df["Cost (USD)"].tolist()
    fig.update_yaxes(
        title_text="Cost (USD)",
        secondary_y=False,
        tickformat=_usd_tickformat(cost_vals),
    )
    fig.update_yaxes(
        title_text="Total tokens",
        secondary_y=True,
        tickformat=TOKEN_TICKFORMAT,
    )
    _apply_x_unified_hover(fig)
    return _fig_json(fig)


def input_output_bars(daily: list[dict]) -> dict[str, Any] | None:
    if not daily:
        return None
    df = pd.DataFrame(
        [
            {"Date": d["period"], "Input": d["inputTokens"], "Output": d["outputTokens"]}
            for d in daily
        ]
    )
    fig = go.Figure()
    fig.add_trace(
        go.Bar(x=df["Date"], y=df["Input"], name="Input", marker_color="#2E75B6")
    )
    fig.add_trace(
        go.Bar(x=df["Date"], y=df["Output"], name="Output", marker_color="#A9D18E")
    )
    fig.update_layout(
        barmode="group",
        bargap=BAR_BARGAP,
        bargroupgap=BAR_GROUPGAP,
        yaxis_title="Tokens",
        yaxis_tickformat=TOKEN_TICKFORMAT,
    )
    _apply_x_unified_hover(fig)
    return _fig_json(fig)


def _model_breakdown_token_total(mb: dict[str, Any]) -> int:
    return sum(
        int(mb.get(k) or 0)
        for k in (
            "inputTokens",
            "outputTokens",
            "cacheCreationTokens",
            "cacheReadTokens",
        )
    )


def model_cost_bars(daily: list[dict]) -> dict[str, Any] | None:
    rows = []
    for d in daily:
        for mb in d.get("modelBreakdowns") or []:
            rows.append({"Model": mb["modelName"], "Cost (USD)": mb["cost"]})
    if not rows:
        return None
    by_model = (
        pd.DataFrame(rows)
        .groupby("Model", as_index=False)
        .agg({"Cost (USD)": "sum"})
        .sort_values("Cost (USD)", ascending=False)
    )
    cost_vals = by_model["Cost (USD)"].tolist()
    fig = go.Figure(
        data=[
            go.Bar(
                x=by_model["Model"],
                y=by_model["Cost (USD)"],
                marker_color="#4472C4",
            )
        ]
    )
    fig.update_layout(
        bargap=BAR_BARGAP,
        xaxis_title="Model",
        yaxis_title="Cost (USD)",
        yaxis_tickformat=_usd_tickformat(cost_vals),
        height=CHART_HEIGHT,
        margin=dict(CHART_MARGIN),
    )
    _apply_x_unified_hover(fig)
    return _fig_json(fig)


def model_token_bars(daily: list[dict]) -> dict[str, Any] | None:
    """Token bars by model (realtime tab)."""
    rows = []
    for d in daily:
        for mb in d.get("modelBreakdowns") or []:
            rows.append(
                {"Model": mb["modelName"], "Tokens": _model_breakdown_token_total(mb)}
            )
    if not rows:
        return None
    by_model = (
        pd.DataFrame(rows)
        .groupby("Model", as_index=False)
        .agg({"Tokens": "sum"})
        .sort_values("Tokens", ascending=False)
    )
    fig = go.Figure(
        data=[
            go.Bar(
                x=by_model["Model"],
                y=by_model["Tokens"],
                marker_color="#2E75B6",
            )
        ]
    )
    fig.update_layout(
        bargap=BAR_BARGAP,
        xaxis_title="Model",
        yaxis_title="Tokens",
        yaxis_tickformat=TOKEN_TICKFORMAT,
        height=CHART_HEIGHT,
        margin=dict(CHART_MARGIN),
    )
    fig.update_yaxes(automargin=True)
    fig.update_xaxes(type="category")
    return _fig_json(fig)


def timeline_usage_chart(
    points: list[dict[str, Any]], *, incremental: bool
) -> dict[str, Any] | None:
    """Today usage trend (server → Plotly.js)."""
    if not points:
        return None
    labels = [p["label"] for p in points]
    tokens = [p.get("totalTokens") or 0 for p in points]
    costs = [p.get("totalCost") or 0 for p in points]
    mode = "lines+markers" if len(points) >= 2 else "markers"
    fig = make_subplots(specs=[[{"secondary_y": True}]])
    fig.add_trace(
        go.Scatter(
            x=labels,
            y=tokens,
            name="Tokens (incremental)" if incremental else "Tokens (cumulative)",
            mode=mode,
            line=dict(width=2, color="#2E75B6"),
            marker=dict(size=8, color="#2E75B6"),
            fill="tozeroy" if incremental and len(points) >= 2 else "none",
        ),
        secondary_y=False,
    )
    fig.add_trace(
        go.Scatter(
            x=labels,
            y=costs,
            name="Cost (incremental)" if incremental else "Cost (cumulative)",
            mode=mode,
            line=dict(width=2, color="#ED7D31"),
            marker=dict(size=8, color="#ED7D31"),
        ),
        secondary_y=True,
    )
    fig.update_yaxes(
        title_text="Tokens",
        secondary_y=False,
        tickformat=TOKEN_TICKFORMAT,
        automargin=True,
    )
    fig.update_yaxes(
        title_text="Cost (USD)",
        secondary_y=True,
        tickformat=_usd_tickformat(costs),
        automargin=True,
    )
    fig.update_layout(
        hovermode="x unified",
        hoverdistance=72,
        legend=dict(orientation="h", yanchor="bottom", y=1.02, xanchor="right", x=1),
        margin=dict(CHART_MARGIN),
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
    return _fig_json(fig)


def realtime_timeline_charts(timeline: dict[str, list[dict[str, Any]]]) -> dict[str, Any]:
    return {
        "timeline_hourly_inc": timeline_usage_chart(
            timeline.get("hourly_incremental") or [], incremental=True
        ),
        "timeline_hourly_cum": timeline_usage_chart(
            timeline.get("hourly_cumulative") or [], incremental=False
        ),
        "timeline_recent5m_inc": timeline_usage_chart(
            timeline.get("recent_5m_incremental") or [], incremental=True
        ),
        "timeline_recent_cum": timeline_usage_chart(
            timeline.get("cumulative_recent") or [], incremental=False
        ),
    }


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
            margin=dict(CHART_MARGIN),
            xaxis_title="Session",
            yaxis_title="Tokens",
            yaxis_tickformat=TOKEN_TICKFORMAT,
        ),
    )
    fig.update_yaxes(automargin=True)
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
            "Date": d["period"],
            "Input": d["inputTokens"],
            "Output": d["outputTokens"],
            "Cache Create": d["cacheCreationTokens"],
            "Cache Read": d["cacheReadTokens"],
            "Total tokens": d["totalTokens"],
            "Cost (USD)": d["totalCost"],
            "Models": ", ".join(d.get("modelsUsed") or []),
        }
        for d in daily
    ]


def model_detail_rows(daily: list[dict]) -> list[dict]:
    rows = []
    for d in daily:
        for mb in d.get("modelBreakdowns") or []:
            note = "estimated" if mb.get("costEstimated") else ""
            rows.append(
                {
                    "Date": d["period"],
                    "Model": mb["modelName"],
                    "Input": mb["inputTokens"],
                    "Output": mb["outputTokens"],
                    "Cache Read": mb["cacheReadTokens"],
                    "Cost (USD)": mb["cost"],
                    "Note": note or "ccusage",
                }
            )
    return rows
