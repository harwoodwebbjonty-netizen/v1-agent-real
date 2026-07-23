import sqlite3
from typing import List

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from app import db
from app.dependencies import CurrentUser, get_current_user
from app.routers.leads import _to_lead_out, _user_name_map, get_activity_context
from app.schemas_leads import (
    CreateLeadListRequest,
    ImportLeadsRequest,
    ImportLeadsResponse,
    LeadListOut,
    LeadListResponse,
    LeadListsResponse,
)
from app.services.auth_service import new_id, now_iso


router = APIRouter(prefix="/lead-lists", tags=["lead-lists"])


def _to_lead_list_out(row: sqlite3.Row, names: dict[str, str]) -> LeadListOut:
    return LeadListOut(
        id=row["id"],
        name=row["name"],
        owner_user_id=row["owner_user_id"],
        owner_name=names.get(row["owner_user_id"]),
        created_at=row["created_at"],
        lead_count=db.count_leads_in_list(row["id"]),
    )


def _require_list_access(row: sqlite3.Row, current_user: CurrentUser) -> None:
    if row["owner_user_id"] != current_user.id and current_user.role != "admin":
        raise HTTPException(status_code=403, detail="You don't have access to this list.")


@router.post("", response_model=LeadListOut)
def create_lead_list(body: CreateLeadListRequest, current_user: CurrentUser = Depends(get_current_user)) -> LeadListOut:
    list_id = new_id()
    owner_id = body.for_user_id if (body.for_user_id and current_user.role == "admin") else current_user.id
    db.create_lead_list(id=list_id, name=body.name, owner_user_id=owner_id, created_at=now_iso())
    return _to_lead_list_out(db.get_lead_list(list_id), _user_name_map())


@router.get("", response_model=LeadListsResponse)
def list_lead_lists(current_user: CurrentUser = Depends(get_current_user)) -> LeadListsResponse:
    names = _user_name_map()
    rows = db.list_lead_lists() if current_user.role == "admin" else db.list_lead_lists(current_user.id)
    return LeadListsResponse(lists=[_to_lead_list_out(r, names) for r in rows])


@router.get("/{list_id}/leads", response_model=LeadListResponse)
def get_list_leads(list_id: str, current_user: CurrentUser = Depends(get_current_user)) -> LeadListResponse:
    lead_list = db.get_lead_list(list_id)
    if lead_list is None:
        raise HTTPException(status_code=404, detail="List not found")
    _require_list_access(lead_list, current_user)
    names = _user_name_map()
    activity = get_activity_context()
    return LeadListResponse(leads=[_to_lead_out(r, names, activity) for r in db.list_leads(list_id=list_id)])


@router.post("/{list_id}/import-csv", response_model=ImportLeadsResponse)
def import_leads_csv(
    list_id: str, body: ImportLeadsRequest, current_user: CurrentUser = Depends(get_current_user)
) -> ImportLeadsResponse:
    lead_list = db.get_lead_list(list_id)
    if lead_list is None:
        raise HTTPException(status_code=404, detail="List not found")
    _require_list_access(lead_list, current_user)

    imported = 0
    created_at = now_iso()
    for entry in body.leads:
        company = entry.get("company")
        if not company:
            continue
        lead_id = new_id()
        actual_lead_id = db.create_lead(
            id=lead_id,
            timestamp=entry.get("timestamp") or created_at,
            company=company,
            phone_number=entry.get("phone_number", ""),
            source_url=entry.get("source_url", ""),
            status=entry.get("status", "unverified"),
            notes=entry.get("notes", ""),
            owner_user_id=lead_list["owner_user_id"],
            created_at=created_at,
            list_id=list_id,
        )
        imported_details = {
            key: value.strip()
            for key, value in {
                "website": entry.get("website") or entry.get("source_url") or "",
                "linkedin": entry.get("linkedin") or "",
            }.items()
            if isinstance(value, str) and value.strip()
        }
        db.update_lead_fields(actual_lead_id, imported_details, created_at)
        phone = entry.get("phone_number", "").strip()
        if phone and phone != "not_found":
            db.add_phone_ignore_duplicate(
                id=new_id(), lead_id=actual_lead_id, phone_number=phone, source="imported", created_at=created_at
            )
        imported += 1
    return ImportLeadsResponse(imported=imported)


@router.delete("/{list_id}")
def delete_lead_list(list_id: str, current_user: CurrentUser = Depends(get_current_user)) -> dict:
    lead_list = db.get_lead_list(list_id)
    if lead_list is None:
        raise HTTPException(status_code=404, detail="List not found")
    _require_list_access(lead_list, current_user)
    db.delete_lead_list(list_id)
    return {"deleted": True}


@router.patch("/{list_id}/leads/{lead_id}/toggle-called")
def toggle_lead_called(
    list_id: str, lead_id: str, current_user: CurrentUser = Depends(get_current_user)
) -> dict:
    lead_list = db.get_lead_list(list_id)
    if lead_list is None:
        raise HTTPException(status_code=404, detail="List not found")
    _require_list_access(lead_list, current_user)
    new_called_at = db.toggle_lead_called(lead_id, list_id, now_iso())
    return {"called_at": new_called_at}


class AddLeadsRequest(BaseModel):
    lead_ids: List[str]


@router.post("/{list_id}/add-leads")
def add_leads_to_list(
    list_id: str, body: AddLeadsRequest, current_user: CurrentUser = Depends(get_current_user)
) -> dict:
    lead_list = db.get_lead_list(list_id)
    if lead_list is None:
        raise HTTPException(status_code=404, detail="List not found")
    _require_list_access(lead_list, current_user)
    return db.add_leads_to_list(body.lead_ids, list_id)
