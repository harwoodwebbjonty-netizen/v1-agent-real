#!/usr/bin/env python3
"""
backend_route_inventory.py — READ-ONLY static scan of backend/app/routers/*.py.

Usage:
    python3 audit/scripts/backend_route_inventory.py
    (run from repo root; no arguments, no network, no DB access)

What it does:
    For every @router.<method>("path", ...) decorator found in
    backend/app/routers/*.py, extracts the route block (from the decorator to
    the next decorator or EOF) and heuristically checks:
      - HTTP method + path
      - router-level prefix (from `APIRouter(prefix=...)`)
      - whether the function signature contains an auth dependency
        (Depends(get_current_user) / Depends(require_permission(...)) /
        Depends(bearer_scheme))
      - whether the signature/body suggests pagination (limit/offset/cursor/
        page parameter names) — a heuristic only, not authoritative
      - whether the return type looks like a collection (List[...] / list[...])

This is purely textual/regex analysis of source files already on disk. It does
not import the application, does not open the database, and makes no network
calls. It writes only to audit/results/backend_routes.json.

Exit code: 0 if the scan completed and wrote output. 1 if the routers
directory could not be found (tool failure, not a product finding).
"""
import json
import re
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
ROUTERS_DIR = REPO_ROOT / "backend" / "app" / "routers"
OUT_PATH = REPO_ROOT / "audit" / "results" / "backend_routes.json"

DECORATOR_RE = re.compile(r'@router\.(get|post|put|patch|delete)\(\s*"([^"]*)"', re.IGNORECASE)
PREFIX_RE = re.compile(r'APIRouter\([^)]*prefix\s*=\s*"([^"]*)"', re.DOTALL)
AUTH_PATTERNS = [
    ("get_current_user", re.compile(r"Depends\(\s*get_current_user\s*\)")),
    ("require_permission", re.compile(r"Depends\(\s*require_permission\(")),
    ("require_admin", re.compile(r"Depends\(\s*require_admin\s*\)")),
    ("bearer_scheme_only", re.compile(r"Depends\(\s*bearer_scheme\s*\)")),
]
# Module-level aliases like `_manage = require_permission("manage_roles")` used
# as `Depends(_manage)` — resolved per-file below so they count as authenticated.
ALIAS_DEF_RE = re.compile(r"^(\w+)\s*=\s*require_permission\(", re.MULTILINE)
PAGINATION_RE = re.compile(r"\b(limit|offset|cursor|page)\s*:", re.IGNORECASE)
COLLECTION_RETURN_RE = re.compile(r"->\s*(List|list)\[")


def get_commit_hash() -> str:
    try:
        return subprocess.check_output(
            ["git", "-C", str(REPO_ROOT), "rev-parse", "HEAD"], text=True
        ).strip()
    except Exception:
        return "unknown"


def main() -> int:
    if not ROUTERS_DIR.is_dir():
        print(f"TOOL FAILURE: routers dir not found at {ROUTERS_DIR}", file=sys.stderr)
        return 1

    files = sorted(ROUTERS_DIR.glob("*.py"))
    results = []
    total_routes = 0
    routes_without_auth = []
    routes_with_pagination_hint = 0
    collection_routes_without_pagination = []

    for f in files:
        text = f.read_text(encoding="utf-8")
        prefix_match = PREFIX_RE.search(text)
        prefix = prefix_match.group(1) if prefix_match else ""
        permission_aliases = ALIAS_DEF_RE.findall(text)
        alias_pattern = (
            re.compile(r"Depends\(\s*(" + "|".join(re.escape(a) for a in permission_aliases) + r")\s*\)")
            if permission_aliases else None
        )

        matches = list(DECORATOR_RE.finditer(text))
        file_routes = []
        for i, m in enumerate(matches):
            start = m.start()
            end = matches[i + 1].start() if i + 1 < len(matches) else len(text)
            block = text[start:end]

            method = m.group(1).upper()
            path = m.group(2)
            full_path = (prefix + path) if not path.startswith(prefix) else path

            auth_hits = [name for name, pat in AUTH_PATTERNS if pat.search(block)]
            if alias_pattern and alias_pattern.search(block):
                auth_hits.append("require_permission_via_module_alias")
            has_pagination = bool(PAGINATION_RE.search(block))
            looks_collection = bool(COLLECTION_RETURN_RE.search(block)) or (
                method == "GET" and path.rstrip("/").count("/") <= 1 and "{" not in path
            )

            entry = {
                "file": str(f.relative_to(REPO_ROOT)),
                "method": method,
                "path": full_path,
                "auth_dependencies_found": auth_hits,
                "has_any_auth_dependency": bool(auth_hits),
                "pagination_hint_found": has_pagination,
                "looks_like_collection_endpoint": looks_collection,
            }
            file_routes.append(entry)
            total_routes += 1
            if not auth_hits:
                routes_without_auth.append(entry)
            if has_pagination:
                routes_with_pagination_hint += 1
            if looks_collection and not has_pagination:
                collection_routes_without_pagination.append(entry)

        results.append({
            "file": str(f.relative_to(REPO_ROOT)),
            "router_prefix": prefix,
            "route_count": len(file_routes),
            "routes": file_routes,
        })

    output = {
        "metadata": {
            "script": "backend_route_inventory.py",
            "commit": get_commit_hash(),
            "generated_at": datetime.now(timezone.utc).isoformat(),
            "method": "regex-based static scan of decorator + function-signature text; "
                      "heuristic, not a full Python AST/type analysis",
        },
        "summary": {
            "router_files_scanned": len(files),
            "total_routes": total_routes,
            "routes_without_recognized_auth_dependency": len(routes_without_auth),
            "routes_with_pagination_hint": routes_with_pagination_hint,
            "collection_endpoints_without_pagination_hint": len(collection_routes_without_pagination),
        },
        "routes_without_recognized_auth_dependency": routes_without_auth,
        "collection_endpoints_without_pagination_hint": collection_routes_without_pagination,
        "files": results,
    }

    OUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    OUT_PATH.write_text(json.dumps(output, indent=2), encoding="utf-8")
    print(f"Scanned {len(files)} router files, {total_routes} routes.")
    print(f"Routes with no recognized auth dependency: {len(routes_without_auth)} "
          f"(review manually — some are intentionally public, e.g. /health, /auth/identify)")
    print(f"Collection-looking GET endpoints with no pagination hint: {len(collection_routes_without_pagination)}")
    print(f"Wrote {OUT_PATH.relative_to(REPO_ROOT)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
