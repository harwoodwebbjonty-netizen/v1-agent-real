"""Shared read/write helpers for LinkedIn credentials stored in .env.

Only touches clean KEY=VALUE lines — leaves any other existing .env content
(e.g. lines using a different format) untouched.
"""
import re
from pathlib import Path

ENV_PATH = Path(__file__).resolve().parent.parent / ".env"
_KEY_RE = re.compile(r"^([A-Za-z_][A-Za-z0-9_]*)=(.*)$")


def load_env() -> dict:
    values = {}
    if not ENV_PATH.exists():
        return values
    for line in ENV_PATH.read_text().splitlines():
        match = _KEY_RE.match(line)
        if match:
            values[match.group(1)] = match.group(2)
    return values


def set_env(updates: dict) -> None:
    lines = ENV_PATH.read_text().splitlines() if ENV_PATH.exists() else []
    remaining = dict(updates)
    for i, line in enumerate(lines):
        match = _KEY_RE.match(line)
        if match and match.group(1) in remaining:
            lines[i] = f"{match.group(1)}={remaining.pop(match.group(1))}"
    for key, value in remaining.items():
        lines.append(f"{key}={value}")
    ENV_PATH.write_text("\n".join(lines) + "\n")
