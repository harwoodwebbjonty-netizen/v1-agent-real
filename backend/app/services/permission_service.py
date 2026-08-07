"""Resolve a user row into their effective permissions + lead scope.

Admin (users.role == 'admin') is the built-in super-role: always every
permission, always the full shared-pool scope, regardless of role_id. Everyone
else resolves through their assigned role (falling back to the default role, then
the built-in Member role).
"""

import json

from app import db
from app.core.permissions import ALL_PERMISSIONS, MEMBER_PERMISSIONS


def resolve_user_access(user_row) -> tuple[frozenset, str, str]:
    """Returns (permissions, lead_scope, role_name)."""
    if user_row["role"] == "admin":
        return frozenset(ALL_PERMISSIONS), "all_shared", "Admin"

    role_id = user_row["role_id"] if "role_id" in user_row.keys() else None
    role = db.get_role(role_id) if role_id else None
    if role is None:
        role = db.get_default_role() or db.get_role("role-member")
    if role is None:
        return frozenset(MEMBER_PERMISSIONS), "all_shared", "Member"

    try:
        perms = frozenset(json.loads(role["permissions"]))
    except (ValueError, TypeError):
        perms = frozenset()
    return perms, role["lead_scope"], role["name"]
