import json

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from app import db
from app.core.permissions import (
    DEFAULT_LEAD_SCOPE,
    LEAD_SCOPES,
    PERMISSION_CATALOGUE,
    valid_permissions,
)
from app.dependencies import CurrentUser, require_permission
from app.services.auth_service import new_id, now_iso

router = APIRouter(prefix="/roles", tags=["roles"])

# Everything here requires the manage_roles permission (admin always has it).
_manage = require_permission("manage_roles")


class RoleOut(BaseModel):
    id: str
    name: str
    permissions: list[str]
    lead_scope: str
    is_system: bool
    is_default: bool


class RoleRequest(BaseModel):
    name: str
    permissions: list[str] = []
    lead_scope: str = DEFAULT_LEAD_SCOPE


def _to_role_out(row) -> RoleOut:
    try:
        perms = json.loads(row["permissions"])
    except (ValueError, TypeError):
        perms = []
    return RoleOut(
        id=row["id"], name=row["name"], permissions=perms, lead_scope=row["lead_scope"],
        is_system=bool(row["is_system"]), is_default=bool(row["is_default"]),
    )


def _clean_scope(scope: str) -> str:
    return scope if scope in LEAD_SCOPES else DEFAULT_LEAD_SCOPE


@router.get("/catalogue")
def get_catalogue(admin: CurrentUser = Depends(_manage)) -> dict:
    return {"catalogue": PERMISSION_CATALOGUE, "lead_scopes": list(LEAD_SCOPES)}


@router.get("")
def list_roles(admin: CurrentUser = Depends(_manage)) -> dict:
    return {"roles": [_to_role_out(r).model_dump() for r in db.list_roles()]}


@router.post("", response_model=RoleOut)
def create_role(body: RoleRequest, admin: CurrentUser = Depends(_manage)) -> RoleOut:
    name = body.name.strip()
    if not name:
        raise HTTPException(status_code=400, detail="Role name is required.")
    if db.get_role_by_name(name) is not None:
        raise HTTPException(status_code=400, detail="A role with that name already exists.")
    role_id = new_id()
    db.create_role(role_id, name, json.dumps(valid_permissions(body.permissions)), _clean_scope(body.lead_scope), now_iso())
    db.record_audit(admin.id, admin.name, "create", "role", role_id, detail=name)
    return _to_role_out(db.get_role(role_id))


@router.patch("/{role_id}", response_model=RoleOut)
def update_role(role_id: str, body: RoleRequest, admin: CurrentUser = Depends(_manage)) -> RoleOut:
    role = db.get_role(role_id)
    if role is None:
        raise HTTPException(status_code=404, detail="Role not found")
    if role["id"] == "role-admin":
        raise HTTPException(status_code=400, detail="The Admin role can't be edited — it always has full access.")
    name = body.name.strip()
    if not name:
        raise HTTPException(status_code=400, detail="Role name is required.")
    clash = db.get_role_by_name(name)
    if clash is not None and clash["id"] != role_id:
        raise HTTPException(status_code=400, detail="A role with that name already exists.")
    db.update_role(role_id, name, json.dumps(valid_permissions(body.permissions)), _clean_scope(body.lead_scope))
    db.record_audit(admin.id, admin.name, "update", "role", role_id, detail=name)
    return _to_role_out(db.get_role(role_id))


@router.delete("/{role_id}")
def delete_role(role_id: str, admin: CurrentUser = Depends(_manage)) -> dict:
    role = db.get_role(role_id)
    if role is None:
        raise HTTPException(status_code=404, detail="Role not found")
    if role["is_system"]:
        raise HTTPException(status_code=400, detail="Built-in roles can't be deleted.")
    # Move anyone on this role to the default role so they aren't left role-less.
    default = db.get_default_role()
    fallback = default["id"] if default and default["id"] != role_id else "role-member"
    with db.get_connection() as conn:
        conn.execute("UPDATE users SET role_id = ? WHERE role_id = ?", (fallback, role_id))
    db.delete_role(role_id)
    db.record_audit(admin.id, admin.name, "delete", "role", role_id, detail=role["name"])
    return {"deleted": True}


@router.post("/{role_id}/default")
def make_default(role_id: str, admin: CurrentUser = Depends(_manage)) -> dict:
    if db.get_role(role_id) is None:
        raise HTTPException(status_code=404, detail="Role not found")
    db.set_default_role(role_id)
    db.record_audit(admin.id, admin.name, "set_default", "role", role_id)
    return {"ok": True}
