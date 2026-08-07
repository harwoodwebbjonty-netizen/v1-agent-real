"""CSV import safety — row caps + spreadsheet formula-injection neutralisation.

Imported values are stored verbatim and later flow into the UI and Mailchimp/CSV
exports, so a cell starting with = + - @ (or a control char) could execute as a
formula in a downstream spreadsheet. We prefix such values with a single quote,
the standard neutralisation, and cap the row count to bound spend/DoS.
"""

from fastapi import HTTPException

from app.core.config import get_settings

_FORMULA_PREFIXES = ("=", "+", "-", "@", "\t", "\r")


def sanitize_cell(value):
    if isinstance(value, str) and value and value[0] in _FORMULA_PREFIXES:
        return "'" + value
    return value


def sanitize_import_row(entry: dict) -> dict:
    """Return a copy of an import row with every string cell neutralised."""
    if not isinstance(entry, dict):
        return entry
    return {k: sanitize_cell(v) for k, v in entry.items()}


def enforce_import_row_cap(rows) -> None:
    cap = get_settings().import_max_rows
    if len(rows) > cap:
        raise HTTPException(
            status_code=413,
            detail=f"Too many rows in one import ({len(rows)}). The limit is {cap}.",
        )
