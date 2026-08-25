"""Flask — 대시보드 UI (Plotly.js + FastAPI fetch)."""

from __future__ import annotations

import os

from flask import Flask, render_template

app = Flask(__name__, template_folder="templates", static_folder="static")

API_BASE_URL = os.getenv("API_BASE_URL", "http://localhost:8000").rstrip("/")
REALTIME_TTL_DEFAULT = int(os.getenv("REALTIME_TTL_SEC", "60"))


@app.route("/")
def index() -> str:
    return render_template(
        "index.html",
        api_base_url=API_BASE_URL,
        realtime_ttl_default=REALTIME_TTL_DEFAULT,
    )


@app.route("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=int(os.getenv("PORT", "5000")), debug=False)
