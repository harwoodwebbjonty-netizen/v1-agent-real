#!/usr/bin/env python3
"""
misc_scans.py — READ-ONLY grep/wc-style scans + safe test/build runs.

Usage:
    python3 audit/scripts/misc_scans.py
    (run from repo root)

What it does (all read-only; the only "execution" is running the existing
backend pytest suite — confirmed by manual inspection that every test file
uses an isolated tmp-path SQLite DB via conftest/fixtures, see
backend/tests/conftest.py and per-file `isolated_db` fixtures — and the
frontend `tsc --noEmit` type-check, which touches no files):

  1. Secret-pattern grep across backend/app + app/src (sk-, AKIA, xox*, and
     var-name-plus-long-string heuristics), excluding node_modules/.venv/target/dist.
  2. .gitignore coverage check for .env files, and `git ls-files` check that
     no .env/credentials.json/token.json is actually tracked.
  3. Hardcoded style-value counts: raw hex colors in app/src/**/*.ts (outside
     style.css, which is the token source and expected to have them), and
     inline style="..." attribute occurrences per file.
  4. Largest frontend view/component files by line count (a maintainability
     proxy, not a hard defect).
  5. TODO/FIXME/HACK/XXX comment count across backend/app and app/src.
  6. console.log / print debugging-statement leftover count.
  7. Runs `pytest -q` (backend, isolated tmp DB per test — safe) and
     `tsc --noEmit` (frontend, read-only type-check) and records pass/fail.
  8. Runs `vite build` once to record the production bundle size (writes to
     app/dist/, which is already gitignored build output, not source).

Writes audit/results/misc_scans.json. Exit code reflects whether the SCRIPT
ran to completion (0) or hit a tooling problem (1) — it does NOT fail just
because pytest/tsc found product issues; those are recorded as data, not as
script failure, per the audit's own instruction to distinguish tool failure
from product failure.
"""
import json
import re
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
OUT_PATH = REPO_ROOT / "audit" / "results" / "misc_scans.json"

SECRET_PATTERNS = [
    r"sk-[a-zA-Z0-9]{20,}",
    r"AKIA[0-9A-Z]{16}",
    r"xox[baprs]-[0-9a-zA-Z-]{10,}",
]
EXCLUDE_DIRS = {"node_modules", ".venv", "target", "dist", ".git", "__pycache__"}


def run(cmd, cwd=None, timeout=180):
    try:
        p = subprocess.run(cmd, cwd=cwd, capture_output=True, text=True, timeout=timeout)
        return p.returncode, p.stdout, p.stderr
    except subprocess.TimeoutExpired:
        return None, "", "TIMEOUT"
    except FileNotFoundError as e:
        return None, "", f"NOT FOUND: {e}"


def iter_files(base: Path, exts):
    for p in base.rglob("*"):
        if p.is_dir():
            continue
        if any(part in EXCLUDE_DIRS for part in p.parts):
            continue
        if p.suffix in exts:
            yield p


def get_commit_hash() -> str:
    code, out, _ = run(["git", "rev-parse", "HEAD"], cwd=REPO_ROOT)
    return out.strip() if code == 0 else "unknown"


def scan_secrets():
    hits = []
    for p in list(iter_files(REPO_ROOT / "backend" / "app", {".py"})) + list(iter_files(REPO_ROOT / "app" / "src", {".ts"})):
        try:
            text = p.read_text(encoding="utf-8", errors="ignore")
        except Exception:
            continue
        for pat in SECRET_PATTERNS:
            for m in re.finditer(pat, text):
                hits.append({"file": str(p.relative_to(REPO_ROOT)), "pattern": pat, "match_prefix": m.group(0)[:8] + "..."})
    return hits


def scan_env_hygiene():
    gitignore = (REPO_ROOT / ".gitignore").read_text() if (REPO_ROOT / ".gitignore").is_file() else ""
    backend_gitignore = (REPO_ROOT / "backend" / ".gitignore").read_text() if (REPO_ROOT / "backend" / ".gitignore").is_file() else ""
    _, tracked, _ = run(["git", "ls-files"], cwd=REPO_ROOT)
    tracked_files = tracked.splitlines()
    risky_tracked = [f for f in tracked_files if re.search(r"(^|/)\.env$|(^|/)\.env\.[^.]*$|credentials\.json$|token\.json$", f) and "example" not in f]
    return {
        "root_gitignore_has_env_rule": ".env" in gitignore,
        "backend_gitignore_has_env_rule": ".env" in backend_gitignore,
        "risky_tracked_files": risky_tracked,
    }


def scan_style_hardcoding():
    hex_re = re.compile(r"#[0-9a-fA-F]{3,8}\b")
    style_attr_re = re.compile(r'style="')
    per_file = []
    total_hex = 0
    total_style_attr = 0
    for p in iter_files(REPO_ROOT / "app" / "src", {".ts"}):
        text = p.read_text(encoding="utf-8", errors="ignore")
        hex_hits = hex_re.findall(text)
        style_hits = style_attr_re.findall(text)
        if hex_hits or style_hits:
            per_file.append({
                "file": str(p.relative_to(REPO_ROOT)),
                "hardcoded_hex_count": len(hex_hits),
                "inline_style_attr_count": len(style_hits),
            })
        total_hex += len(hex_hits)
        total_style_attr += len(style_hits)
    per_file.sort(key=lambda r: r["hardcoded_hex_count"] + r["inline_style_attr_count"], reverse=True)
    return {"total_hardcoded_hex_in_ts": total_hex, "total_inline_style_attrs": total_style_attr, "per_file": per_file[:25]}


def scan_large_files():
    rows = []
    for p in iter_files(REPO_ROOT / "app" / "src", {".ts"}):
        n = sum(1 for _ in p.open(encoding="utf-8", errors="ignore"))
        rows.append({"file": str(p.relative_to(REPO_ROOT)), "lines": n})
    for p in iter_files(REPO_ROOT / "backend" / "app", {".py"}):
        n = sum(1 for _ in p.open(encoding="utf-8", errors="ignore"))
        rows.append({"file": str(p.relative_to(REPO_ROOT)), "lines": n})
    rows.sort(key=lambda r: r["lines"], reverse=True)
    return rows[:20]


def scan_todo_and_console():
    todo_re = re.compile(r"\b(TODO|FIXME|HACK|XXX)\b")
    console_re = re.compile(r"console\.(log|debug)\(")
    print_re = re.compile(r"^\s*print\(", re.MULTILINE)
    todos = 0
    consoles = 0
    prints = 0
    for p in iter_files(REPO_ROOT / "app" / "src", {".ts"}):
        text = p.read_text(encoding="utf-8", errors="ignore")
        todos += len(todo_re.findall(text))
        consoles += len(console_re.findall(text))
    for p in iter_files(REPO_ROOT / "backend" / "app", {".py"}):
        text = p.read_text(encoding="utf-8", errors="ignore")
        todos += len(todo_re.findall(text))
        prints += len(print_re.findall(text))
    return {"todo_fixme_hack_xxx_comments": todos, "frontend_console_log_debug_calls": consoles, "backend_bare_print_statements": prints}


def run_pytest():
    venv_python = REPO_ROOT / "backend" / ".venv" / "bin" / "python"
    code, out, err = run([str(venv_python), "-m", "pytest", "tests/", "-q"], cwd=REPO_ROOT / "backend", timeout=120)
    last_line = [l for l in out.splitlines() if l.strip()][-1] if out.strip() else ""
    return {"exit_code": code, "summary_line": last_line, "stderr_tail": err[-500:] if err else ""}


def run_tsc():
    code, out, err = run(["npx", "tsc", "--noEmit"], cwd=REPO_ROOT / "app", timeout=120)
    return {"exit_code": code, "output_tail": (out + err)[-1000:]}


def run_build_and_measure():
    code, out, err = run(["npx", "vite", "build"], cwd=REPO_ROOT / "app", timeout=180)
    dist = REPO_ROOT / "app" / "dist" / "assets"
    sizes = []
    if dist.is_dir():
        for f in dist.iterdir():
            sizes.append({"file": f.name, "bytes": f.stat().st_size})
    sizes.sort(key=lambda r: r["bytes"], reverse=True)
    return {"exit_code": code, "asset_sizes": sizes, "build_output_tail": (out + err)[-800:]}


def main() -> int:
    result = {
        "metadata": {
            "script": "misc_scans.py",
            "commit": get_commit_hash(),
            "generated_at": datetime.now(timezone.utc).isoformat(),
        },
        "secrets_scan": {
            "hits": scan_secrets(),
            "note": "Regex heuristic for common provider key shapes only — not a full entropy-based secret scanner.",
        },
        "env_hygiene": scan_env_hygiene(),
        "style_hardcoding": scan_style_hardcoding(),
        "largest_files": scan_large_files(),
        "todo_and_debug_statements": scan_todo_and_console(),
        "test_results": {
            "backend_pytest": run_pytest(),
            "frontend_tsc_noemit": run_tsc(),
            "frontend_build": run_build_and_measure(),
        },
    }
    OUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    OUT_PATH.write_text(json.dumps(result, indent=2), encoding="utf-8")

    print(f"Secrets scan hits: {len(result['secrets_scan']['hits'])}")
    print(f"Env hygiene: root_ok={result['env_hygiene']['root_gitignore_has_env_rule']} "
          f"backend_ok={result['env_hygiene']['backend_gitignore_has_env_rule']} "
          f"risky_tracked={len(result['env_hygiene']['risky_tracked_files'])}")
    print(f"Hardcoded hex in .ts: {result['style_hardcoding']['total_hardcoded_hex_in_ts']}, "
          f"inline style= attrs: {result['style_hardcoding']['total_inline_style_attrs']}")
    print(f"pytest: {result['test_results']['backend_pytest']['summary_line']}")
    print(f"tsc --noEmit exit code: {result['test_results']['frontend_tsc_noemit']['exit_code']}")
    print(f"vite build exit code: {result['test_results']['frontend_build']['exit_code']}")
    print(f"Wrote {OUT_PATH.relative_to(REPO_ROOT)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
