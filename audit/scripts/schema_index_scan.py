#!/usr/bin/env python3
"""
schema_index_scan.py — READ-ONLY static scan of backend/app/db.py's schema.

Usage:
    python3 audit/scripts/schema_index_scan.py
    (run from repo root; no arguments, no DB connection opened — text only)

What it does:
    Parses `CREATE TABLE` and `CREATE INDEX` statements out of db.py as plain
    text (regex, not a SQL parser — good enough for this codebase's
    consistently-formatted schema), then:
      1. Lists every table and its `*_id`-style foreign-key-shaped columns.
      2. Lists every index and the column(s) it covers.
      3. Flags `*_id` columns with no covering index, cross-referenced against
         how often that exact column name appears in a `WHERE col = ?` /
         `WHERE col IN` pattern elsewhere in db.py — a column filtered on
         often but never indexed is the real risk; one filtered on rarely or
         never is a low-priority theoretical gap.

Caveats (heuristic, not authoritative):
    - Composite indexes are recorded as covering their first column only for
      this report's "is X indexed" check — a column can be effectively
      covered by a multi-column index this script under-credits.
    - SQLite auto-indexes PRIMARY KEY / UNIQUE columns even without an
      explicit CREATE INDEX; this script does not model that, so a `*_id`
      primary key will show as "no explicit index" even though SQLite
      indexes it implicitly. Read `is_primary_key` before treating a finding
      as real.

Writes audit/results/schema_index_scan.json. Exit 0 on success, 1 if db.py
is missing (tool failure).
"""
import json
import re
import subprocess
import sys
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
DB_PY = REPO_ROOT / "backend" / "app" / "db.py"
OUT_PATH = REPO_ROOT / "audit" / "results" / "schema_index_scan.json"

TABLE_RE = re.compile(r"CREATE TABLE(?: IF NOT EXISTS)?\s+(\w+)\s*\((.*?)\)\s*(?:;|\"\"\")", re.DOTALL)
INDEX_RE = re.compile(r"CREATE INDEX(?: IF NOT EXISTS)?\s+(\w+)\s+ON\s+(\w+)\s*\(([^)]*)\)")
COLUMN_RE = re.compile(r"^\s*(\w+)\s+\w+", re.MULTILINE)
WHERE_COL_RE = re.compile(r"WHERE\s+.*?\b(\w+_id)\b\s*(=|IN)", re.IGNORECASE)


def get_commit_hash() -> str:
    try:
        return subprocess.check_output(
            ["git", "-C", str(REPO_ROOT), "rev-parse", "HEAD"], text=True
        ).strip()
    except Exception:
        return "unknown"


def main() -> int:
    if not DB_PY.is_file():
        print(f"TOOL FAILURE: {DB_PY} not found", file=sys.stderr)
        return 1

    text = DB_PY.read_text(encoding="utf-8")

    tables = {}
    for m in TABLE_RE.finditer(text):
        table_name, body = m.group(1), m.group(2)
        cols = []
        for line in body.splitlines():
            line = line.strip().rstrip(",")
            if not line or line.upper().startswith(("PRIMARY KEY", "FOREIGN KEY", "UNIQUE", "CHECK")):
                continue
            col_match = re.match(r"(\w+)\s+(\w+)", line)
            if col_match:
                cols.append({
                    "name": col_match.group(1),
                    "type": col_match.group(2),
                    "is_primary_key": "PRIMARY KEY" in line.upper(),
                })
        tables[table_name] = cols

    indexes = []
    indexed_columns_by_table = {}
    for m in INDEX_RE.finditer(text):
        idx_name, table_name, cols_raw = m.group(1), m.group(2), m.group(3)
        cols = [c.strip() for c in cols_raw.split(",")]
        indexes.append({"index_name": idx_name, "table": table_name, "columns": cols})
        indexed_columns_by_table.setdefault(table_name, set()).update(cols)

    # Frequency of each `*_id` column name appearing in a WHERE clause anywhere in db.py —
    # a rough proxy for "is this column actually filtered on in query functions".
    where_freq = Counter(m.group(1) for m in WHERE_COL_RE.finditer(text))

    gaps = []
    for table_name, cols in tables.items():
        indexed = indexed_columns_by_table.get(table_name, set())
        for col in cols:
            if col["name"].endswith("_id") and col["name"] not in indexed:
                gaps.append({
                    "table": table_name,
                    "column": col["name"],
                    "is_primary_key": col["is_primary_key"],
                    "where_clause_occurrences_in_db_py": where_freq.get(col["name"], 0),
                    "note": "PRIMARY KEY columns are implicitly indexed by SQLite even without "
                            "an explicit CREATE INDEX — not a real gap." if col["is_primary_key"]
                            else None,
                })

    # Sort real (non-PK) gaps by how often they're actually filtered on, most-used first.
    real_gaps = sorted(
        [g for g in gaps if not g["is_primary_key"]],
        key=lambda g: g["where_clause_occurrences_in_db_py"],
        reverse=True,
    )

    output = {
        "metadata": {
            "script": "schema_index_scan.py",
            "commit": get_commit_hash(),
            "generated_at": datetime.now(timezone.utc).isoformat(),
            "method": "regex-based text scan of backend/app/db.py — not a live PRAGMA "
                      "index_list query against the actual database file",
        },
        "summary": {
            "tables_found": len(tables),
            "indexes_found": len(indexes),
            "fk_shaped_columns_without_explicit_index": len(gaps),
            "of_which_primary_key_false_positives": len(gaps) - len(real_gaps),
            "of_which_real_non_pk_gaps": len(real_gaps),
        },
        "real_non_pk_index_gaps_sorted_by_where_usage": real_gaps,
        "all_flagged_including_pk_false_positives": gaps,
        "indexes": indexes,
        "tables": {name: cols for name, cols in tables.items()},
    }

    OUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    OUT_PATH.write_text(json.dumps(output, indent=2), encoding="utf-8")
    print(f"Tables: {len(tables)}, Indexes: {len(indexes)}")
    print(f"FK-shaped columns without an explicit index: {len(gaps)} "
          f"({len(gaps) - len(real_gaps)} are PK false positives, {len(real_gaps)} real)")
    if real_gaps:
        print("Top real gaps by WHERE-clause usage frequency:")
        for g in real_gaps[:8]:
            print(f"  {g['table']}.{g['column']} — referenced in {g['where_clause_occurrences_in_db_py']} WHERE clause(s)")
    print(f"Wrote {OUT_PATH.relative_to(REPO_ROOT)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
