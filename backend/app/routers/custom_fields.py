import sqlite3

from fastapi import APIRouter, Depends, HTTPException

from app import db
from app.dependencies import CurrentUser, get_current_user, require_admin
from app.schemas_custom_fields import CreateCustomFieldRequest, CustomFieldOut, CustomFieldsResponse
from app.services.auth_service import new_id, now_iso

router = APIRouter(prefix="/custom-fields", tags=["custom-fields"])


def _to_custom_field_out(row: sqlite3.Row) -> CustomFieldOut:
    return CustomFieldOut(id=row["id"], name=row["name"], field_type=row["field_type"], created_at=row["created_at"])


@router.get("", response_model=CustomFieldsResponse)
def list_custom_fields(current_user: CurrentUser = Depends(get_current_user)) -> CustomFieldsResponse:
    rows = db.list_custom_field_definitions()
    return CustomFieldsResponse(fields=[_to_custom_field_out(r) for r in rows])


@router.post("", response_model=CustomFieldOut)
def create_custom_field(
    body: CreateCustomFieldRequest, current_user: CurrentUser = Depends(require_admin)
) -> CustomFieldOut:
    field_id = new_id()
    try:
        db.create_custom_field_definition(id=field_id, name=body.name, field_type=body.field_type, created_at=now_iso())
    except sqlite3.IntegrityError:
        raise HTTPException(status_code=400, detail="A custom field with that name already exists.")
    return _to_custom_field_out(db.get_custom_field_definition(field_id))


@router.delete("/{field_id}")
def delete_custom_field(field_id: str, current_user: CurrentUser = Depends(require_admin)) -> dict:
    if db.get_custom_field_definition(field_id) is None:
        raise HTTPException(status_code=404, detail="Custom field not found")
    db.delete_custom_field_definition(field_id)
    return {"deleted": True}
