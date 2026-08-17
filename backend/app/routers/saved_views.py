import json
import sqlite3

from fastapi import APIRouter, Depends, HTTPException

from app import db
from app.dependencies import CurrentUser, get_current_user
from app.routers.leads import _user_name_map
from app.schemas_saved_views import CreateSavedViewRequest, SavedViewOut, SavedViewsResponse
from app.services.auth_service import new_id, now_iso

router = APIRouter(prefix="/saved-views", tags=["saved-views"])


def _to_saved_view_out(row: sqlite3.Row, names: dict[str, str]) -> SavedViewOut:
    return SavedViewOut(
        id=row["id"],
        name=row["name"],
        owner_user_id=row["user_id"],
        owner_name=names.get(row["user_id"]),
        is_shared=bool(row["is_shared"]),
        filters=json.loads(row["filters_json"]),
        created_at=row["created_at"],
    )


@router.get("", response_model=SavedViewsResponse)
def list_saved_views(current_user: CurrentUser = Depends(get_current_user)) -> SavedViewsResponse:
    names = _user_name_map()
    rows = db.list_saved_views(current_user.id)
    return SavedViewsResponse(views=[_to_saved_view_out(r, names) for r in rows])


@router.post("", response_model=SavedViewOut)
def create_saved_view(
    body: CreateSavedViewRequest, current_user: CurrentUser = Depends(get_current_user)
) -> SavedViewOut:
    view_id = new_id()
    db.create_saved_view(
        id=view_id,
        user_id=current_user.id,
        name=body.name,
        is_shared=body.is_shared,
        filters_json=json.dumps(body.filters),
        created_at=now_iso(),
    )
    return _to_saved_view_out(db.get_saved_view(view_id), _user_name_map())


@router.delete("/{view_id}")
def delete_saved_view(view_id: str, current_user: CurrentUser = Depends(get_current_user)) -> dict:
    row = db.get_saved_view(view_id)
    if row is None:
        raise HTTPException(status_code=404, detail="Saved view not found")
    if row["user_id"] != current_user.id and current_user.role != "admin":
        raise HTTPException(status_code=403, detail="You don't have access to this saved view.")
    db.delete_saved_view(view_id)
    return {"deleted": True}
