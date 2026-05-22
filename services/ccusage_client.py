"""ccusage CLI 래퍼."""

from __future__ import annotations

import json
import subprocess
import sys
from datetime import date

CCUSAGE_TIMEOUT_SEC = 180


def today_yyyymmdd() -> str:
    return date.today().strftime("%Y%m%d")


def run_ccusage_json(subcommand: str, extra_args: list[str] | None = None) -> dict:
    cmd = ["npx", "--yes", "ccusage", subcommand, "-j"]
    if extra_args:
        cmd.extend(extra_args)

    run_kwargs: dict = {
        "capture_output": True,
        "text": True,
        "timeout": CCUSAGE_TIMEOUT_SEC,
    }
    if sys.platform == "win32":
        run_kwargs["shell"] = True
    else:
        run_kwargs["shell"] = False

    try:
        result = subprocess.run(cmd, **run_kwargs)
    except subprocess.TimeoutExpired as e:
        raise RuntimeError(
            f"ccusage 조회가 {CCUSAGE_TIMEOUT_SEC}초 안에 끝나지 않았습니다. "
            f"`npx --yes ccusage {subcommand} -j`를 확인하세요."
        ) from e
    except FileNotFoundError as e:
        raise RuntimeError(
            "npx를 찾을 수 없습니다. Node.js 설치 및 PATH를 확인하세요."
        ) from e

    if result.returncode != 0 or not result.stdout.strip():
        detail = (result.stderr or result.stdout or "").strip()
        raise RuntimeError(
            f"ccusage `{subcommand}` 실행 실패. "
            f"`npx --yes ccusage {subcommand} -j` 확인."
            + (f"\n\n{detail}" if detail else "")
        )
    return json.loads(result.stdout)


def fetch_daily(since: str | None = None, until: str | None = None) -> dict:
    from services.local_cost import apply_half_claude_estimate

    extra: list[str] = []
    if since:
        extra += ["--since", since]
    if until:
        extra += ["--until", until]
    data = run_ccusage_json("daily", extra or None)
    return apply_half_claude_estimate(data)


def fetch_blocks_active(since: str | None = None) -> dict:
    extra = ["--active"]
    if since:
        extra += ["--since", since]
    return run_ccusage_json("blocks", extra)


def fetch_session(since: str | None = None, until: str | None = None) -> dict:
    extra: list[str] = []
    if since:
        extra += ["--since", since]
    if until:
        extra += ["--until", until]
    return run_ccusage_json("session", extra or None)


def fetch_realtime_bundle() -> dict:
    today = today_yyyymmdd()
    return {
        "daily": fetch_daily(since=today, until=today),
        "blocks": fetch_blocks_active(since=today),
        "sessions": fetch_session(since=today, until=today),
    }
