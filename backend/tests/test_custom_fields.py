"""Tests for custom fields on leads (Stage 3 roadmap item) — the genuine
key-value option from the audit's design fork, not a fixed set of extra
columns: db-layer CRUD for both the admin-managed definitions and the
per-lead sparse values, plus the /custom-fields and
/leads/{id}/custom-fields/{field_id} router endpoints."""

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app import db
from app.dependencies import CurrentUser, get_current_user

# Deferred (not module-level): both routers import app.routers.leads (or are
# it), which pulls in schemas_leads.py's `X | None` syntax (3.10+). See
# test_lead_tags.py for the same pattern/reasoning.


@pytest.fixture
def isolated_db(tmp_path, monkeypatch):
    monkeypatch.setattr(db, "DB_PATH", tmp_path / "team.db")
    monkeypatch.setattr(db, "BACKUPS_DIR", tmp_path / "backups")
    db.init_db()
    return tmp_path


def _mk_lead(company="Acme", owner="user-1"):
    lid = db.secrets.token_hex(8)
    db.create_lead(
        id=lid, timestamp="t", company=company, phone_number="", source_url="",
        status="u", notes="", owner_user_id=owner, created_at="t",
    )
    return lid


# --- db-layer ---

def test_create_list_delete_definition(isolated_db):
    db.create_custom_field_definition(id="f1", name="Deal Size", field_type="number", created_at="t")
    db.create_custom_field_definition(id="f2", name="Renewal Date", field_type="date", created_at="t")

    defs = db.list_custom_field_definitions()
    assert [d["name"] for d in defs] == ["Deal Size", "Renewal Date"]

    db.delete_custom_field_definition("f1")
    assert [d["name"] for d in db.list_custom_field_definitions()] == ["Renewal Date"]


def test_set_and_get_custom_field_value(isolated_db):
    db.create_custom_field_definition(id="f1", name="Deal Size", field_type="number", created_at="t")
    lead_id = _mk_lead()

    db.set_custom_field_value(id="v1", lead_id=lead_id, field_id="f1", value="5000")

    assert db.get_custom_field_values(lead_id) == {"f1": "5000"}


def test_set_custom_field_value_upserts(isolated_db):
    db.create_custom_field_definition(id="f1", name="Deal Size", field_type="number", created_at="t")
    lead_id = _mk_lead()

    db.set_custom_field_value(id="v1", lead_id=lead_id, field_id="f1", value="5000")
    db.set_custom_field_value(id="v2", lead_id=lead_id, field_id="f1", value="7500")

    assert db.get_custom_field_values(lead_id) == {"f1": "7500"}


def test_delete_definition_cascades_values(isolated_db):
    db.create_custom_field_definition(id="f1", name="Deal Size", field_type="number", created_at="t")
    lead_id = _mk_lead()
    db.set_custom_field_value(id="v1", lead_id=lead_id, field_id="f1", value="5000")

    db.delete_custom_field_definition("f1")

    assert db.get_custom_field_values(lead_id) == {}


def test_get_custom_field_values_for_leads_batch(isolated_db):
    db.create_custom_field_definition(id="f1", name="Deal Size", field_type="number", created_at="t")
    lead_a = _mk_lead("A")
    lead_b = _mk_lead("B")
    lead_c = _mk_lead("C")
    db.set_custom_field_value(id="v1", lead_id=lead_a, field_id="f1", value="1000")

    result = db.get_custom_field_values_for_leads([lead_a, lead_b, lead_c])

    assert result[lead_a] == {"f1": "1000"}
    assert result[lead_b] == {}
    assert result[lead_c] == {}


def test_get_custom_field_values_for_leads_empty_input(isolated_db):
    assert db.get_custom_field_values_for_leads([]) == {}


# --- router layer: /custom-fields (definitions) ---

@pytest.fixture
def admin_client(isolated_db):
    from app.routers import custom_fields as custom_fields_router

    app = FastAPI()
    app.include_router(custom_fields_router.router)
    app.dependency_overrides[get_current_user] = lambda: CurrentUser(id="admin-1", name="Admin", role="admin")
    yield TestClient(app)
    app.dependency_overrides.clear()


@pytest.fixture
def member_client(isolated_db):
    from app.routers import custom_fields as custom_fields_router

    app = FastAPI()
    app.include_router(custom_fields_router.router)
    app.dependency_overrides[get_current_user] = lambda: CurrentUser(id="user-1", name="Rep", role="member")
    yield TestClient(app)
    app.dependency_overrides.clear()


def test_admin_can_create_custom_field(admin_client):
    resp = admin_client.post("/custom-fields", json={"name": "Deal Size", "field_type": "number"})

    assert resp.status_code == 200
    body = resp.json()
    assert body["name"] == "Deal Size"
    assert body["field_type"] == "number"


def test_member_cannot_create_custom_field(member_client):
    resp = member_client.post("/custom-fields", json={"name": "Deal Size", "field_type": "number"})
    assert resp.status_code == 403


def test_member_can_list_custom_fields(member_client):
    db.create_custom_field_definition(id="f1", name="Deal Size", field_type="number", created_at="t")

    resp = member_client.get("/custom-fields")

    assert resp.status_code == 200
    assert [f["name"] for f in resp.json()["fields"]] == ["Deal Size"]


def test_create_custom_field_rejects_duplicate_name(admin_client):
    admin_client.post("/custom-fields", json={"name": "Deal Size", "field_type": "number"})
    resp = admin_client.post("/custom-fields", json={"name": "Deal Size", "field_type": "text"})
    assert resp.status_code == 400


def test_create_custom_field_rejects_empty_name(admin_client):
    resp = admin_client.post("/custom-fields", json={"name": "  ", "field_type": "text"})
    assert resp.status_code == 422


def test_create_custom_field_rejects_bad_type(admin_client):
    resp = admin_client.post("/custom-fields", json={"name": "X", "field_type": "boolean"})
    assert resp.status_code == 422


def test_member_cannot_delete_custom_field(member_client):
    db.create_custom_field_definition(id="f1", name="Deal Size", field_type="number", created_at="t")
    resp = member_client.delete("/custom-fields/f1")
    assert resp.status_code == 403


def test_admin_can_delete_custom_field(admin_client):
    db.create_custom_field_definition(id="f1", name="Deal Size", field_type="number", created_at="t")
    resp = admin_client.delete("/custom-fields/f1")
    assert resp.status_code == 200
    assert db.get_custom_field_definition("f1") is None


# --- router layer: /leads/{id}/custom-fields/{field_id} (values) ---

@pytest.fixture
def leads_client(isolated_db):
    from app.routers import leads as leads_router

    app = FastAPI()
    app.include_router(leads_router.router)
    app.dependency_overrides[get_current_user] = lambda: CurrentUser(id="user-1", name="Rep", role="admin")
    yield TestClient(app)
    app.dependency_overrides.clear()


def test_set_custom_field_value_via_api(leads_client):
    db.create_custom_field_definition(id="f1", name="Deal Size", field_type="number", created_at="t")
    lead_id = _mk_lead()

    resp = leads_client.put(f"/leads/{lead_id}/custom-fields/f1", json={"value": "5000"})

    assert resp.status_code == 200
    assert resp.json()["custom_fields"] == {"f1": "5000"}


def test_set_custom_field_value_404_on_unknown_field(leads_client):
    lead_id = _mk_lead()
    resp = leads_client.put(f"/leads/{lead_id}/custom-fields/does-not-exist", json={"value": "5000"})
    assert resp.status_code == 404


def test_set_custom_field_value_404_on_unknown_lead(leads_client):
    db.create_custom_field_definition(id="f1", name="Deal Size", field_type="number", created_at="t")
    resp = leads_client.put("/leads/does-not-exist/custom-fields/f1", json={"value": "5000"})
    assert resp.status_code == 404


def test_list_leads_includes_custom_fields(leads_client):
    db.create_custom_field_definition(id="f1", name="Deal Size", field_type="number", created_at="t")
    lead_id = _mk_lead()
    db.set_custom_field_value(id="v1", lead_id=lead_id, field_id="f1", value="5000")

    resp = leads_client.get("/leads")

    lead = next(l for l in resp.json()["leads"] if l["id"] == lead_id)
    assert lead["custom_fields"] == {"f1": "5000"}
