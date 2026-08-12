import json
import logging
import re
import secrets
import shutil
import sqlite3
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Callable, Iterator, Optional

logger = logging.getLogger("app.db")

DB_PATH = Path(__file__).resolve().parents[1] / "data" / "team.db"
BACKUPS_DIR = DB_PATH.parent / "backups"
BACKUP_RETENTION_COUNT = 10

SCHEMA = """
CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    name TEXT UNIQUE NOT NULL,
    role TEXT NOT NULL,
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS leads (
    id TEXT PRIMARY KEY,
    timestamp TEXT NOT NULL,
    company TEXT NOT NULL,
    phone_number TEXT NOT NULL,
    source_url TEXT NOT NULL,
    status TEXT NOT NULL,
    notes TEXT NOT NULL,
    industry TEXT NOT NULL DEFAULT '',
    contact_status TEXT NOT NULL DEFAULT 'New',
    lead_notes TEXT NOT NULL DEFAULT '',
    owner_user_id TEXT,
    assigned_user_id TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS lead_phones (
    id TEXT PRIMARY KEY,
    lead_id TEXT NOT NULL,
    phone_number TEXT NOT NULL,
    source TEXT NOT NULL DEFAULT 'manual',
    created_at TEXT NOT NULL,
    UNIQUE(lead_id, phone_number)
);

CREATE TABLE IF NOT EXISTS lead_emails (
    id TEXT PRIMARY KEY,
    lead_id TEXT NOT NULL,
    email TEXT NOT NULL,
    source TEXT NOT NULL DEFAULT 'manual',
    created_at TEXT NOT NULL,
    UNIQUE(lead_id, email)
);

CREATE TABLE IF NOT EXISTS lead_lists (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    owner_user_id TEXT NOT NULL,
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS lead_intelligence_versions (
    id TEXT PRIMARY KEY,
    lead_id TEXT NOT NULL,
    executive_summary TEXT NOT NULL DEFAULT '',
    sales_summary TEXT NOT NULL DEFAULT '',
    pain_points TEXT NOT NULL DEFAULT '{}',
    buying_signals TEXT NOT NULL DEFAULT '[]',
    conversation_starters TEXT NOT NULL DEFAULT '[]',
    discovery_questions TEXT NOT NULL DEFAULT '[]',
    objection_handling TEXT NOT NULL DEFAULT '[]',
    pitch_angle TEXT NOT NULL DEFAULT '',
    call_brief TEXT NOT NULL DEFAULT '',
    score_breakdown TEXT NOT NULL DEFAULT '{}',
    lead_score INTEGER NOT NULL DEFAULT 0,
    lead_temperature TEXT NOT NULL DEFAULT '',
    confidence_note TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_lead_intelligence_versions_lead_id ON lead_intelligence_versions(lead_id);

CREATE TABLE IF NOT EXISTS lead_intelligence_locks (
    lead_id TEXT PRIMARY KEY,
    locked_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS calendar_events (
    id TEXT PRIMARY KEY,
    owner_user_id TEXT NOT NULL,
    title TEXT NOT NULL,
    date TEXT NOT NULL,
    time TEXT NOT NULL DEFAULT '',
    type TEXT NOT NULL,
    lead_id TEXT,
    description TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_calendar_events_owner ON calendar_events(owner_user_id);

CREATE TABLE IF NOT EXISTS brand_voice_profiles (
    user_id TEXT PRIMARY KEY,
    company_name TEXT NOT NULL DEFAULT '',
    company_description TEXT NOT NULL DEFAULT '',
    industry TEXT NOT NULL DEFAULT '',
    target_audience TEXT NOT NULL DEFAULT '',
    core_services TEXT NOT NULL DEFAULT '',
    unique_selling_points TEXT NOT NULL DEFAULT '',
    preferred_writing_style TEXT NOT NULL DEFAULT '',
    preferred_cta_style TEXT NOT NULL DEFAULT '',
    preferred_email_length TEXT NOT NULL DEFAULT '',
    website TEXT NOT NULL DEFAULT '',
    booking_link TEXT NOT NULL DEFAULT '',
    signature TEXT NOT NULL DEFAULT '',
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS email_templates (
    id TEXT PRIMARY KEY,
    owner_user_id TEXT NOT NULL,
    name TEXT NOT NULL,
    subject TEXT NOT NULL,
    body TEXT NOT NULL,
    tone TEXT NOT NULL DEFAULT '',
    length TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS email_drafts (
    id TEXT PRIMARY KEY,
    lead_id TEXT NOT NULL,
    owner_user_id TEXT NOT NULL,
    subject TEXT NOT NULL,
    body TEXT NOT NULL,
    tone TEXT NOT NULL DEFAULT '',
    length TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'draft',
    sent_via TEXT,
    sent_at TEXT,
    estimated_open_rate REAL,
    estimated_reply_rate REAL,
    estimated_readability_score REAL,
    campaign_id TEXT,
    sequence_id TEXT,
    sequence_step INTEGER,
    ab_test_group TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_email_drafts_lead_id ON email_drafts(lead_id);

CREATE TABLE IF NOT EXISTS email_oauth_accounts (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    provider TEXT NOT NULL,
    email_address TEXT NOT NULL,
    access_token TEXT NOT NULL,
    refresh_token TEXT NOT NULL,
    token_expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(user_id, provider)
);
"""


def _migration_001_baseline(conn: sqlite3.Connection) -> None:
    """Everything built across every feature so far. Already fully
    idempotent (CREATE TABLE IF NOT EXISTS + PRAGMA table_info checks before
    each ALTER) — safe to run against a brand-new database or an existing
    one that already has all of this; never destructive either way."""
    conn.executescript(SCHEMA)
    user_columns = {row["name"] for row in conn.execute("PRAGMA table_info(users)")}
    if "avatar" not in user_columns:
        conn.execute("ALTER TABLE users ADD COLUMN avatar TEXT")

    lead_columns = {row["name"] for row in conn.execute("PRAGMA table_info(leads)")}
    for column in ("contact_name", "website", "linkedin", "contact_title"):
        if column not in lead_columns:
            conn.execute(f"ALTER TABLE leads ADD COLUMN {column} TEXT DEFAULT ''")
    if "list_id" not in lead_columns:
        conn.execute("ALTER TABLE leads ADD COLUMN list_id TEXT")


def _migration_002_call_logs(conn: sqlite3.Connection) -> None:
    """Real call outcome tracking for the Call Queue. Shared per-lead
    history like lead_intelligence_versions (no owner-based access
    restriction) — created_by is attribution, not a visibility boundary."""
    conn.executescript(
        """
        CREATE TABLE IF NOT EXISTS call_logs (
            id TEXT PRIMARY KEY,
            lead_id TEXT NOT NULL,
            calendar_event_id TEXT,
            outcome TEXT NOT NULL,
            notes TEXT NOT NULL DEFAULT '',
            duration_seconds INTEGER,
            created_by TEXT NOT NULL,
            created_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_call_logs_lead_id ON call_logs(lead_id);
        """
    )


def _migration_003_opportunity_stage(conn: sqlite3.Connection) -> None:
    """Opportunity is a lifecycle stage on top of the existing lead, not a
    separate disconnected entity — nothing about lead identity/APIs changes."""
    lead_columns = {row["name"] for row in conn.execute("PRAGMA table_info(leads)")}
    if "opportunity_stage" not in lead_columns:
        conn.execute("ALTER TABLE leads ADD COLUMN opportunity_stage TEXT NOT NULL DEFAULT 'none'")


def _migration_004_sequences(conn: sqlite3.Connection) -> None:
    """Multi-channel sales sequences (email + call/follow-up/reminder
    tasks). Sending reuses the existing OAuth send path; non-email steps
    create real calendar tasks rather than performing anything themselves."""
    conn.executescript(
        """
        CREATE TABLE IF NOT EXISTS sequences (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            owner_user_id TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'draft',
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS sequence_steps (
            id TEXT PRIMARY KEY,
            sequence_id TEXT NOT NULL,
            step_order INTEGER NOT NULL,
            delay_days INTEGER NOT NULL,
            step_type TEXT NOT NULL,
            subject_template TEXT NOT NULL DEFAULT '',
            body_template TEXT NOT NULL DEFAULT '',
            created_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_sequence_steps_sequence_id ON sequence_steps(sequence_id);

        CREATE TABLE IF NOT EXISTS sequence_enrollments (
            id TEXT PRIMARY KEY,
            sequence_id TEXT NOT NULL,
            lead_id TEXT NOT NULL,
            current_step INTEGER NOT NULL DEFAULT 0,
            status TEXT NOT NULL DEFAULT 'active',
            last_error TEXT,
            enrolled_at TEXT NOT NULL,
            next_run_at TEXT,
            created_by TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_sequence_enrollments_sequence_id ON sequence_enrollments(sequence_id);
        CREATE INDEX IF NOT EXISTS idx_sequence_enrollments_lead_id ON sequence_enrollments(lead_id);
        """
    )


def _migration_005_presence(conn: sqlite3.Connection) -> None:
    """Real presence — updated by a heartbeat while the app is open, not a
    fabricated "online" flag. Nullable: nobody has ever sent a heartbeat
    until they're running a build new enough to send one."""
    user_columns = {row["name"] for row in conn.execute("PRAGMA table_info(users)")}
    if "last_seen_at" not in user_columns:
        conn.execute("ALTER TABLE users ADD COLUMN last_seen_at TEXT")


def _migration_006_ai_prospecting(conn: sqlite3.Connection) -> None:
    """Companies House company number on leads (for dedup + profile link)
    and a table tracking AI Prospecting run status/results."""
    lead_columns = {row["name"] for row in conn.execute("PRAGMA table_info(leads)")}
    if "company_number" not in lead_columns:
        conn.execute("ALTER TABLE leads ADD COLUMN company_number TEXT")
    if "ch_data" not in lead_columns:
        conn.execute("ALTER TABLE leads ADD COLUMN ch_data TEXT")
    conn.executescript(
        """
        CREATE TABLE IF NOT EXISTS prospecting_runs (
            id TEXT PRIMARY KEY,
            owner_user_id TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'running',
            criteria TEXT NOT NULL DEFAULT '{}',
            found INTEGER NOT NULL DEFAULT 0,
            created INTEGER NOT NULL DEFAULT 0,
            skipped INTEGER NOT NULL DEFAULT 0,
            error TEXT,
            started_at TEXT NOT NULL,
            completed_at TEXT
        );
        """
    )


def _migration_007_prospecting_named_lists(conn: sqlite3.Connection) -> None:
    """Add name + list_id to prospecting_runs so each run can create a named
    Cold Call List and all its leads are grouped under it."""
    run_columns = {row["name"] for row in conn.execute("PRAGMA table_info(prospecting_runs)")}
    if "name" not in run_columns:
        conn.execute("ALTER TABLE prospecting_runs ADD COLUMN name TEXT NOT NULL DEFAULT ''")
    if "list_id" not in run_columns:
        conn.execute("ALTER TABLE prospecting_runs ADD COLUMN list_id TEXT")


def _migration_008_activity_feed(conn: sqlite3.Connection) -> None:
    """Companies House-powered activity feed. Append-only snapshots + structured
    change events for each lead's Companies House company number. Three new
    columns on leads control the tiered background refresh schedule."""
    conn.executescript(
        """
        CREATE TABLE IF NOT EXISTS company_snapshots (
            id TEXT PRIMARY KEY,
            company_number TEXT NOT NULL,
            snapshot_json TEXT NOT NULL,
            fetched_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_snapshots_company ON company_snapshots(company_number);

        CREATE TABLE IF NOT EXISTS activity_events (
            id TEXT PRIMARY KEY,
            company_number TEXT NOT NULL,
            company_name TEXT NOT NULL,
            lead_id TEXT,
            event_type TEXT NOT NULL,
            description TEXT NOT NULL,
            event_data TEXT,
            occurred_at TEXT NOT NULL,
            detected_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_activity_company ON activity_events(company_number);
        CREATE INDEX IF NOT EXISTS idx_activity_lead ON activity_events(lead_id);
        CREATE INDEX IF NOT EXISTS idx_activity_detected ON activity_events(detected_at);

        CREATE TABLE IF NOT EXISTS ch_charge_feed (
            id TEXT PRIMARY KEY,
            company_number TEXT NOT NULL,
            company_name TEXT,
            filing_type TEXT NOT NULL,
            charge_description TEXT,
            filing_date TEXT,
            transaction_id TEXT UNIQUE,
            event_data TEXT,
            detected_at TEXT NOT NULL,
            lead_id TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_ch_charge_detected ON ch_charge_feed(detected_at);
        CREATE INDEX IF NOT EXISTS idx_ch_charge_company ON ch_charge_feed(company_number);

        CREATE TABLE IF NOT EXISTS ch_stream_state (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
        );
        """
    )
    lead_columns = {row["name"] for row in conn.execute("PRAGMA table_info(leads)")}
    if "refresh_tier" not in lead_columns:
        conn.execute("ALTER TABLE leads ADD COLUMN refresh_tier TEXT DEFAULT 'C'")
    if "next_dg_refresh_at" not in lead_columns:
        conn.execute("ALTER TABLE leads ADD COLUMN next_dg_refresh_at TEXT")
    if "last_dg_refreshed_at" not in lead_columns:
        conn.execute("ALTER TABLE leads ADD COLUMN last_dg_refreshed_at TEXT")


def _migration_009_called_at(conn: sqlite3.Connection) -> None:
    """Per-list-lead 'called' tracking. Scoped correctly because each lead
    belongs to exactly one list via list_id — so a nullable timestamp on the
    lead row is per-person per-lead without needing a separate join table."""
    lead_columns = {row["name"] for row in conn.execute("PRAGMA table_info(leads)")}
    if "called_at" not in lead_columns:
        conn.execute("ALTER TABLE leads ADD COLUMN called_at TEXT")


def _migration_010_follow_up(conn: sqlite3.Connection) -> None:
    """Scheduled follow-up date: salesperson can snooze a lead and have it
    resurface at the top of their cold call list on the target date."""
    lead_columns = {row["name"] for row in conn.execute("PRAGMA table_info(leads)")}
    if "follow_up_at" not in lead_columns:
        conn.execute("ALTER TABLE leads ADD COLUMN follow_up_at TEXT")


def _migration_011_win_back(conn: sqlite3.Connection) -> None:
    """Win-back campaign manager: bulk AI-generated re-engagement emails for
    dormant or lost leads, with optional Mailchimp export."""
    conn.executescript(
        """
        CREATE TABLE IF NOT EXISTS win_back_campaigns (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            created_by TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'generating',
            total INTEGER NOT NULL DEFAULT 0,
            generated INTEGER NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS win_back_emails (
            id TEXT PRIMARY KEY,
            campaign_id TEXT NOT NULL REFERENCES win_back_campaigns(id),
            lead_id TEXT NOT NULL,
            subject TEXT,
            body TEXT,
            send_status TEXT NOT NULL DEFAULT 'draft',
            sent_at TEXT,
            send_method TEXT,
            created_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_win_back_emails_campaign ON win_back_emails(campaign_id);
        """
    )


def _migration_012_credit_tracking(conn: sqlite3.Connection) -> None:
    """Credit usage tracking and per-user credit limit settings."""
    conn.executescript(
        """
        CREATE TABLE IF NOT EXISTS credit_usage (
            id TEXT PRIMARY KEY,
            user_id TEXT NOT NULL,
            feature TEXT NOT NULL,
            amount_gbp REAL NOT NULL,
            created_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_credit_usage_user ON credit_usage(user_id, created_at);

        CREATE TABLE IF NOT EXISTS user_settings (
            user_id TEXT NOT NULL,
            key TEXT NOT NULL,
            value TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            PRIMARY KEY (user_id, key)
        );
        """
    )


def _migration_013_prospecting_total_available(conn: sqlite3.Connection) -> None:
    """Add total_available to prospecting_runs (total CH companies matching the query)."""
    cols = {row["name"] for row in conn.execute("PRAGMA table_info(prospecting_runs)")}
    if "total_available" not in cols:
        conn.execute("ALTER TABLE prospecting_runs ADD COLUMN total_available INTEGER NOT NULL DEFAULT 0")


def _migration_014_ch_stream_state(conn: sqlite3.Connection) -> None:
    """CH filing stream state table and charge feed table — added to migration 008
    after that version had already shipped, so databases already at v8+ need this
    catch-up migration to get the missing tables."""
    conn.executescript(
        """
        CREATE TABLE IF NOT EXISTS ch_charge_feed (
            id TEXT PRIMARY KEY,
            company_number TEXT NOT NULL,
            company_name TEXT,
            filing_type TEXT NOT NULL,
            charge_description TEXT,
            filing_date TEXT,
            transaction_id TEXT UNIQUE,
            event_data TEXT,
            detected_at TEXT NOT NULL,
            lead_id TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_ch_charge_detected ON ch_charge_feed(detected_at);
        CREATE INDEX IF NOT EXISTS idx_ch_charge_company ON ch_charge_feed(company_number);

        CREATE TABLE IF NOT EXISTS ch_stream_state (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
        );
        """
    )


def _migration_016_campaign_resume(conn: sqlite3.Connection) -> None:
    """Persist the full lead list + depth on win-back campaigns so a campaign
    stopped mid-generation (credit ceiling, crash) can resume with just the
    leads that never got an email. NULL lead_ids = pre-resume campaign."""
    cols = {row["name"] for row in conn.execute("PRAGMA table_info(win_back_campaigns)")}
    if "lead_ids" not in cols:
        conn.execute("ALTER TABLE win_back_campaigns ADD COLUMN lead_ids TEXT")
    if "depth" not in cols:
        conn.execute("ALTER TABLE win_back_campaigns ADD COLUMN depth TEXT DEFAULT 'standard'")


def _migration_017_email_verification(conn: sqlite3.Connection) -> None:
    """Deliverability + person-match verification results on lead emails.
    verify_status: unchecked | deliverable | risky | undeliverable
    person_match: unknown | person | director | generic | mismatch"""
    cols = {row["name"] for row in conn.execute("PRAGMA table_info(lead_emails)")}
    for col, decl in [
        ("verify_status", "TEXT NOT NULL DEFAULT 'unchecked'"),
        ("person_match", "TEXT NOT NULL DEFAULT 'unknown'"),
        ("verify_detail", "TEXT NOT NULL DEFAULT ''"),
        ("verified_at", "TEXT"),
    ]:
        if col not in cols:
            conn.execute(f"ALTER TABLE lead_emails ADD COLUMN {col} {decl}")


def _migration_018_win_back_email_instruction(conn: sqlite3.Connection) -> None:
    """Store the campaign-specific email direction so resumed work keeps the
    same brief as the original generation run."""
    cols = {row["name"] for row in conn.execute("PRAGMA table_info(win_back_campaigns)")}
    if "email_instruction" not in cols:
        conn.execute("ALTER TABLE win_back_campaigns ADD COLUMN email_instruction TEXT NOT NULL DEFAULT ''")


def _migration_019_win_back_campaign_brief(conn: sqlite3.Connection) -> None:
    """Keep campaign-only offer and context notes separate from the CRM lead
    record. These notes shape a generation run but never overwrite lead data."""
    cols = {row["name"] for row in conn.execute("PRAGMA table_info(win_back_campaigns)")}
    for column in ("offer_context", "additional_context"):
        if column not in cols:
            conn.execute(f"ALTER TABLE win_back_campaigns ADD COLUMN {column} TEXT NOT NULL DEFAULT ''")


def _migration_020_win_back_links_and_signature(conn: sqlite3.Connection) -> None:
    """Campaign-level CTA links and signature. These stay separate from lead
    records and are applied consistently to every generated draft."""
    cols = {row["name"] for row in conn.execute("PRAGMA table_info(win_back_campaigns)")}
    for column in ("campaign_links", "signature"):
        if column not in cols:
            conn.execute(f"ALTER TABLE win_back_campaigns ADD COLUMN {column} TEXT NOT NULL DEFAULT ''")


def _migration_021_win_back_link_text(conn: sqlite3.Connection) -> None:
    """Optional display text for the campaign link — when set, the pasted
    URL is rendered as a clickable hyperlink instead of a bare address."""
    cols = {row["name"] for row in conn.execute("PRAGMA table_info(win_back_campaigns)")}
    if "campaign_link_text" not in cols:
        conn.execute("ALTER TABLE win_back_campaigns ADD COLUMN campaign_link_text TEXT NOT NULL DEFAULT ''")


def _migration_022_lead_linkedin_posts(conn: sqlite3.Connection) -> None:
    """Cached LinkedIn post data fetched via Apify, per lead. Mirrors
    lead_intelligence_versions' shape (one row per fetch, latest wins) but
    stays a separate table since it has its own cache window and its own
    real-money credit-tracked cost, independent of sales-intel spend."""
    conn.executescript(
        """
        CREATE TABLE IF NOT EXISTS lead_linkedin_posts (
            id TEXT PRIMARY KEY,
            lead_id TEXT NOT NULL,
            linkedin_url TEXT NOT NULL DEFAULT '',
            posts_json TEXT NOT NULL DEFAULT '[]',
            created_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_lead_linkedin_posts_lead_id ON lead_linkedin_posts(lead_id);
        """
    )


def _migration_023_win_back_deal_owner(conn: sqlite3.Connection) -> None:
    """Persist the CSV broker so resumed campaigns keep the same sender."""
    cols = {row["name"] for row in conn.execute("PRAGMA table_info(leads)")}
    if "deal_owner" not in cols:
        conn.execute("ALTER TABLE leads ADD COLUMN deal_owner TEXT NOT NULL DEFAULT ''")


def _migration_024_win_back_source_rows(conn: sqlite3.Connection) -> None:
    """Store the uploaded CSV rows (as JSON) on the campaign so it can be
    re-run ('Run again') from the same source list — including the filter
    fields (stage/closing_date/amount) that are otherwise only client-side."""
    cols = {row["name"] for row in conn.execute("PRAGMA table_info(win_back_campaigns)")}
    if "source_rows_json" not in cols:
        conn.execute("ALTER TABLE win_back_campaigns ADD COLUMN source_rows_json TEXT NOT NULL DEFAULT ''")


def _migration_015_user_passwords(conn: sqlite3.Connection) -> None:
    """Add password_hash to users. NULL means a legacy account that predates
    passwords — the next successful identify for that name sets its password
    (first-login claim), after which the password is required."""
    cols = {row["name"] for row in conn.execute("PRAGMA table_info(users)")}
    if "password_hash" not in cols:
        conn.execute("ALTER TABLE users ADD COLUMN password_hash TEXT")


def _migration_025_list_email_campaigns(conn: sqlite3.Connection) -> None:
    """List Email Campaigns: a rep picks a cold-call list, types one idea, and
    the tool generates a per-lead email (grouped by lead status). The per-lead
    email content lives in email_drafts (tagged with campaign_id); this table
    only holds the campaign itself + its progress so a credit-stopped run can
    resume, mirroring win_back_campaigns."""
    conn.executescript(
        """
        CREATE TABLE IF NOT EXISTS list_email_campaigns (
            id TEXT PRIMARY KEY,
            list_id TEXT NOT NULL,
            owner_user_id TEXT NOT NULL,
            name TEXT NOT NULL DEFAULT '',
            idea TEXT NOT NULL DEFAULT '',
            offers TEXT NOT NULL DEFAULT '',
            link_url TEXT NOT NULL DEFAULT '',
            link_text TEXT NOT NULL DEFAULT '',
            signature TEXT NOT NULL DEFAULT '',
            status TEXT NOT NULL DEFAULT 'generating',
            total_target INTEGER NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_list_email_campaigns_owner ON list_email_campaigns(owner_user_id);
        CREATE INDEX IF NOT EXISTS idx_email_drafts_campaign ON email_drafts(campaign_id);
        """
    )


def _migration_033_lead_id_indexes(conn: sqlite3.Connection) -> None:
    """Five FK-shaped lead_id columns had no explicit index (audit
    schema_index_scan.py) despite being queried on every lead-record render
    (lead_phones/lead_emails — every card) or regularly elsewhere. Not an
    active incident at today's data volume, but cheap to fix now rather than
    retrofit under load later."""
    conn.executescript(
        """
        CREATE INDEX IF NOT EXISTS idx_lead_phones_lead_id ON lead_phones(lead_id);
        CREATE INDEX IF NOT EXISTS idx_lead_emails_lead_id ON lead_emails(lead_id);
        CREATE INDEX IF NOT EXISTS idx_calendar_events_lead_id ON calendar_events(lead_id);
        CREATE INDEX IF NOT EXISTS idx_ch_charge_feed_lead_id ON ch_charge_feed(lead_id);
        CREATE INDEX IF NOT EXISTS idx_win_back_emails_lead_id ON win_back_emails(lead_id);
        """
    )


def _migration_032_encrypt_oauth_tokens(conn: sqlite3.Connection) -> None:
    """Re-encrypts any plaintext access_token/refresh_token left over from
    before Fernet encryption was added (audit F-04 / Stage 0). Idempotent —
    the enc:v1: prefix marks already-encrypted values, so re-running this is
    a safe no-op on rows already migrated (never happens in practice since a
    migration only runs once, but cheap insurance)."""
    from app.services.token_crypto import encrypt_token

    rows = conn.execute("SELECT id, access_token, refresh_token FROM email_oauth_accounts").fetchall()
    for row in rows:
        already_done = row["access_token"].startswith("enc:v1:") and (
            not row["refresh_token"] or row["refresh_token"].startswith("enc:v1:")
        )
        if already_done:
            continue
        conn.execute(
            "UPDATE email_oauth_accounts SET access_token = ?, refresh_token = ? WHERE id = ?",
            (encrypt_token(row["access_token"]), encrypt_token(row["refresh_token"]), row["id"]),
        )


def _migration_031_roles(conn: sqlite3.Connection) -> None:
    """RBAC: custom roles with per-permission toggles + lead scope. Seeds two
    built-in roles (Admin = all permissions; Member = today's member access) and
    maps existing users onto them so nothing changes for anyone on upgrade."""
    from app.core.permissions import ALL_PERMISSIONS, MEMBER_PERMISSIONS

    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS roles (
            id TEXT PRIMARY KEY,
            name TEXT UNIQUE NOT NULL,
            permissions TEXT NOT NULL DEFAULT '[]',
            lead_scope TEXT NOT NULL DEFAULT 'all_shared',
            is_system INTEGER NOT NULL DEFAULT 0,
            is_default INTEGER NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL
        )
        """
    )
    ucols = {r["name"] for r in conn.execute("PRAGMA table_info(users)")}
    if "role_id" not in ucols:
        conn.execute("ALTER TABLE users ADD COLUMN role_id TEXT")

    now = datetime.now(timezone.utc).isoformat()
    existing = {r["name"] for r in conn.execute("SELECT name FROM roles")}
    if "Admin" not in existing:
        conn.execute(
            "INSERT INTO roles (id, name, permissions, lead_scope, is_system, is_default, created_at) "
            "VALUES ('role-admin', 'Admin', ?, 'all_shared', 1, 0, ?)",
            (json.dumps(ALL_PERMISSIONS), now),
        )
    if "Member" not in existing:
        conn.execute(
            "INSERT INTO roles (id, name, permissions, lead_scope, is_system, is_default, created_at) "
            "VALUES ('role-member', 'Member', ?, 'all_shared', 1, 1, ?)",
            (json.dumps(MEMBER_PERMISSIONS), now),
        )
    # Map existing accounts onto the built-in roles.
    conn.execute("UPDATE users SET role_id = 'role-admin' WHERE role = 'admin' AND (role_id IS NULL OR role_id = '')")
    conn.execute("UPDATE users SET role_id = 'role-member' WHERE role != 'admin' AND (role_id IS NULL OR role_id = '')")


def _migration_030_audit_log(conn: sqlite3.Connection) -> None:
    """Accountability trail for a shared multi-user DB (audit M6): who changed
    what, when. actor_name is denormalised so entries survive user deletion."""
    conn.executescript(
        """
        CREATE TABLE IF NOT EXISTS audit_log (
            id TEXT PRIMARY KEY,
            actor_id TEXT,
            actor_name TEXT NOT NULL DEFAULT '',
            action TEXT NOT NULL,
            entity_type TEXT NOT NULL DEFAULT '',
            entity_id TEXT NOT NULL DEFAULT '',
            detail TEXT NOT NULL DEFAULT '',
            created_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_log(created_at);
        CREATE INDEX IF NOT EXISTS idx_audit_actor ON audit_log(actor_id);
        """
    )


def _migration_029_company_norm_and_flags(conn: sqlite3.Connection) -> None:
    """Index-backed dedup (audit C4): a normalised company column replaces the
    unindexable LOWER(TRIM(company)) full scan on every insert. Plus a tiny
    key/value flags table so one-time startup backfills don't run every boot (M7)."""
    lcols = {r["name"] for r in conn.execute("PRAGMA table_info(leads)")}
    if "company_norm" not in lcols:
        conn.execute("ALTER TABLE leads ADD COLUMN company_norm TEXT")
        conn.execute("UPDATE leads SET company_norm = lower(trim(company))")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_leads_company_norm ON leads(company_norm)")
    conn.execute(
        "CREATE TABLE IF NOT EXISTS app_flags (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL)"
    )


def _migration_028_leads_hot_indexes(conn: sqlite3.Connection) -> None:
    """Indexes on the most-filtered leads columns — every list render, insert-time
    dedup, and the refresh scheduler previously full-scanned `leads` (audit H6)."""
    conn.executescript(
        """
        CREATE INDEX IF NOT EXISTS idx_leads_list_id ON leads(list_id);
        CREATE INDEX IF NOT EXISTS idx_leads_owner ON leads(owner_user_id);
        CREATE INDEX IF NOT EXISTS idx_leads_assigned ON leads(assigned_user_id);
        CREATE INDEX IF NOT EXISTS idx_leads_company_number ON leads(company_number);
        CREATE INDEX IF NOT EXISTS idx_leads_next_dg_refresh ON leads(next_dg_refresh_at);
        """
    )


def _migration_027_auth_hardening_and_sharing(conn: sqlite3.Connection) -> None:
    """v0.3.0 security hardening: per-account login lockout counters, optional
    lead sharing (so a lead can be assigned to a specific BDM and kept private
    instead of visible to the whole shared pool), and an OAuth CSRF-state store.
    `is_shared` defaults to 1 so every existing lead keeps today's behaviour."""
    ucols = {r["name"] for r in conn.execute("PRAGMA table_info(users)")}
    if "failed_login_attempts" not in ucols:
        conn.execute("ALTER TABLE users ADD COLUMN failed_login_attempts INTEGER NOT NULL DEFAULT 0")
    if "locked_until" not in ucols:
        conn.execute("ALTER TABLE users ADD COLUMN locked_until TEXT")
    lcols = {r["name"] for r in conn.execute("PRAGMA table_info(leads)")}
    if "is_shared" not in lcols:
        conn.execute("ALTER TABLE leads ADD COLUMN is_shared INTEGER NOT NULL DEFAULT 1")
    conn.executescript(
        """
        CREATE TABLE IF NOT EXISTS oauth_states (
            state TEXT PRIMARY KEY,
            user_id TEXT NOT NULL,
            provider TEXT NOT NULL,
            created_at TEXT NOT NULL
        );
        """
    )


def _migration_026_lead_priority(conn: sqlite3.Connection) -> None:
    """Deterministic lead-prioritisation score (0–100) so the highest-value
    companies sort to the top of the cold-call sheet. Computed for free from
    Companies House data already on the lead (charges, SIC, age) plus call/email
    contact history and recent activity — no AI, no credits. priority_breakdown
    stores the per-signal JSON for transparency. Distinct from the AI lead_score
    in lead_intelligence_versions, which is paid and sparse."""
    lead_columns = {row["name"] for row in conn.execute("PRAGMA table_info(leads)")}
    if "priority_score" not in lead_columns:
        conn.execute("ALTER TABLE leads ADD COLUMN priority_score INTEGER NOT NULL DEFAULT 0")
    if "priority_breakdown" not in lead_columns:
        conn.execute("ALTER TABLE leads ADD COLUMN priority_breakdown TEXT NOT NULL DEFAULT '{}'")


# Ordered (version, migration_fn) pairs. Append new entries here for future
# schema changes — never edit or remove an existing entry once released.
MIGRATIONS: list[tuple[int, Callable[[sqlite3.Connection], None]]] = [
    (1, _migration_001_baseline),
    (2, _migration_002_call_logs),
    (3, _migration_003_opportunity_stage),
    (4, _migration_004_sequences),
    (5, _migration_005_presence),
    (6, _migration_006_ai_prospecting),
    (7, _migration_007_prospecting_named_lists),
    (8, _migration_008_activity_feed),
    (9, _migration_009_called_at),
    (10, _migration_010_follow_up),
    (11, _migration_011_win_back),
    (12, _migration_012_credit_tracking),
    (13, _migration_013_prospecting_total_available),
    (14, _migration_014_ch_stream_state),
    (15, _migration_015_user_passwords),
    (16, _migration_016_campaign_resume),
    (17, _migration_017_email_verification),
    (18, _migration_018_win_back_email_instruction),
    (19, _migration_019_win_back_campaign_brief),
    (20, _migration_020_win_back_links_and_signature),
    (21, _migration_021_win_back_link_text),
    (22, _migration_022_lead_linkedin_posts),
    (23, _migration_023_win_back_deal_owner),
    (24, _migration_024_win_back_source_rows),
    (25, _migration_025_list_email_campaigns),
    (26, _migration_026_lead_priority),
    (27, _migration_027_auth_hardening_and_sharing),
    (28, _migration_028_leads_hot_indexes),
    (29, _migration_029_company_norm_and_flags),
    (30, _migration_030_audit_log),
    (31, _migration_031_roles),
    (32, _migration_032_encrypt_oauth_tokens),
    (33, _migration_033_lead_id_indexes),
]
CURRENT_SCHEMA_VERSION = 33


def get_schema_version(conn: sqlite3.Connection) -> int:
    table_exists = conn.execute(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='schema_version'"
    ).fetchone()
    if not table_exists:
        return 0
    row = conn.execute("SELECT version FROM schema_version LIMIT 1").fetchone()
    return row["version"] if row else 0


def set_schema_version(conn: sqlite3.Connection, version: int) -> None:
    conn.execute("CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)")
    conn.execute("DELETE FROM schema_version")
    conn.execute("INSERT INTO schema_version (version) VALUES (?)", (version,))


def run_pending_migrations(conn: sqlite3.Connection, current: int, target: int) -> None:
    for version, migration_fn in MIGRATIONS:
        if version > current and version <= target:
            logger.info("Running migration %d", version)
            migration_fn(conn)
            set_schema_version(conn, version)
            logger.info("Migration %d complete", version)


def _check_integrity(conn: sqlite3.Connection) -> bool:
    result = conn.execute("PRAGMA integrity_check").fetchone()
    return result is not None and result[0] == "ok"


def backup_database() -> Optional[Path]:
    """Copies the live database to backend/data/backups/. Returns None
    (no-op) if there's no existing database file yet — nothing to back up
    on a brand-new install."""
    if not DB_PATH.exists():
        return None
    BACKUPS_DIR.mkdir(parents=True, exist_ok=True)
    timestamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    backup_path = BACKUPS_DIR / f"team-{timestamp}.db"
    shutil.copy2(DB_PATH, backup_path)
    logger.info("Created backup at %s", backup_path)
    _prune_old_backups()
    return backup_path


def _validate_backup(path: Path) -> bool:
    if not path.exists() or path.stat().st_size == 0:
        return False
    try:
        test_conn = sqlite3.connect(path)
        try:
            result = test_conn.execute("PRAGMA integrity_check").fetchone()
            return result is not None and result[0] == "ok"
        finally:
            test_conn.close()
    except sqlite3.Error:
        return False


def _prune_old_backups(keep: int = BACKUP_RETENTION_COUNT) -> None:
    if not BACKUPS_DIR.exists():
        return
    backups = sorted(BACKUPS_DIR.glob("team-*.db"), key=lambda p: p.stat().st_mtime, reverse=True)
    for old_backup in backups[keep:]:
        old_backup.unlink()
        logger.info("Pruned old backup %s", old_backup)


def restore_database(backup_path: Path) -> None:
    """Restores the live database from a backup file. Validates the backup
    first (refuses a corrupt file) and saves a pre-restore safety copy of
    whatever is currently live, so a bad restore is itself recoverable."""
    if not _validate_backup(backup_path):
        raise ValueError(f"Backup at {backup_path} failed validation — refusing to restore.")

    if DB_PATH.exists():
        safety_copy = DB_PATH.parent / f"team-pre-restore-{datetime.now().strftime('%Y%m%d-%H%M%S')}.db"
        shutil.copy2(DB_PATH, safety_copy)
        logger.info("Saved pre-restore safety copy to %s", safety_copy)

    shutil.copy2(backup_path, DB_PATH)
    logger.info("Restored database from %s", backup_path)


def init_db() -> None:
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    db_existed = DB_PATH.exists()

    with get_connection() as conn:
        if db_existed and not _check_integrity(conn):
            logger.error("Database integrity check failed on startup — aborting without modifying schema.")
            raise RuntimeError("Database integrity check failed. The database was not modified. See logs.")

        current = get_schema_version(conn)
        target = CURRENT_SCHEMA_VERSION

        if current >= target:
            logger.info("Schema up to date at version %d — no migration, no backup.", current)
            return

        logger.info("Schema at version %d, target version %d — migration required.", current, target)
        # `db_existed` was captured before `get_connection()` ever ran —
        # sqlite3.connect() creates an empty file on first connect, so
        # checking DB_PATH.exists() again at this point would always be
        # true and back up a file that didn't really exist a moment ago.
        backup_path = backup_database() if db_existed else None
        if backup_path is not None and not _validate_backup(backup_path):
            logger.error("Backup validation failed for %s — aborting migration. Database untouched.", backup_path)
            raise RuntimeError(f"Backup validation failed for {backup_path}. Migration aborted.")
        if backup_path is not None:
            logger.info("Backup validated at %s", backup_path)

        run_pending_migrations(conn, current, target)

        if not _check_integrity(conn):
            logger.error("Post-migration integrity check failed!")
            raise RuntimeError("Post-migration integrity check failed. A pre-migration backup is available to restore from.")
        logger.info("Migration complete, schema now at version %d. Post-migration integrity check passed.", target)


@contextmanager
def get_connection() -> Iterator[sqlite3.Connection]:
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    # WAL lets readers proceed during writes; busy_timeout makes concurrent
    # writers wait instead of failing immediately with "database is locked"
    # (multiple users + four background loops all share this one file).
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA busy_timeout=5000")
    # Enforce declared foreign keys (off by default per-connection in SQLite).
    # New tables declare FKs; child-table cleanup on merge/delete is also explicit.
    conn.execute("PRAGMA foreign_keys=ON")
    try:
        yield conn
        conn.commit()
    finally:
        conn.close()


# --- users ---

def record_audit(
    actor_id: Optional[str], actor_name: str, action: str,
    entity_type: str = "", entity_id: str = "", detail: str = "",
) -> None:
    """Append an audit entry. Best-effort — must never break the caller's action."""
    ts = datetime.now(timezone.utc).isoformat()
    try:
        with get_connection() as conn:
            conn.execute(
                "INSERT INTO audit_log (id, actor_id, actor_name, action, entity_type, entity_id, detail, created_at) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                (secrets.token_hex(12), actor_id, actor_name, action, entity_type, entity_id, detail, ts),
            )
    except Exception:
        logger.exception("Failed to write audit entry (%s %s)", action, entity_type)


def list_audit_log(limit: int = 200, offset: int = 0) -> list[sqlite3.Row]:
    with get_connection() as conn:
        return conn.execute(
            "SELECT * FROM audit_log ORDER BY created_at DESC LIMIT ? OFFSET ?", (limit, offset)
        ).fetchall()


def get_app_flag(key: str) -> Optional[str]:
    with get_connection() as conn:
        row = conn.execute("SELECT value FROM app_flags WHERE key = ?", (key,)).fetchone()
        return row["value"] if row else None


def set_app_flag(key: str, value: str, updated_at: str) -> None:
    with get_connection() as conn:
        conn.execute(
            "INSERT INTO app_flags (key, value, updated_at) VALUES (?, ?, ?) "
            "ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at",
            (key, value, updated_at),
        )


# --- Roles (RBAC) ---

def list_roles() -> list[sqlite3.Row]:
    with get_connection() as conn:
        return conn.execute("SELECT * FROM roles ORDER BY is_system DESC, name").fetchall()


def get_role(role_id: str) -> Optional[sqlite3.Row]:
    with get_connection() as conn:
        return conn.execute("SELECT * FROM roles WHERE id = ?", (role_id,)).fetchone()


def get_role_by_name(name: str) -> Optional[sqlite3.Row]:
    with get_connection() as conn:
        return conn.execute("SELECT * FROM roles WHERE name = ?", (name,)).fetchone()


def create_role(id: str, name: str, permissions_json: str, lead_scope: str, created_at: str) -> None:
    with get_connection() as conn:
        conn.execute(
            "INSERT INTO roles (id, name, permissions, lead_scope, is_system, is_default, created_at) "
            "VALUES (?, ?, ?, ?, 0, 0, ?)",
            (id, name, permissions_json, lead_scope, created_at),
        )


def update_role(role_id: str, name: str, permissions_json: str, lead_scope: str) -> None:
    with get_connection() as conn:
        conn.execute(
            "UPDATE roles SET name = ?, permissions = ?, lead_scope = ? WHERE id = ?",
            (name, permissions_json, lead_scope, role_id),
        )


def delete_role(role_id: str) -> None:
    with get_connection() as conn:
        conn.execute("DELETE FROM roles WHERE id = ? AND is_system = 0", (role_id,))


def set_user_role(user_id: str, role_id: str) -> None:
    with get_connection() as conn:
        conn.execute("UPDATE users SET role_id = ? WHERE id = ?", (role_id, user_id))


def get_default_role() -> Optional[sqlite3.Row]:
    with get_connection() as conn:
        return conn.execute("SELECT * FROM roles WHERE is_default = 1 LIMIT 1").fetchone()


def set_default_role(role_id: str) -> None:
    with get_connection() as conn:
        conn.execute("UPDATE roles SET is_default = 0")
        conn.execute("UPDATE roles SET is_default = 1 WHERE id = ?", (role_id,))


def count_users_with_role(role_id: str) -> int:
    with get_connection() as conn:
        return conn.execute("SELECT COUNT(*) FROM users WHERE role_id = ?", (role_id,)).fetchone()[0]


def count_users() -> int:
    with get_connection() as conn:
        return conn.execute("SELECT COUNT(*) FROM users").fetchone()[0]


def count_admins() -> int:
    with get_connection() as conn:
        return conn.execute("SELECT COUNT(*) FROM users WHERE role = 'admin'").fetchone()[0]


def create_user(id: str, name: str, role: str, created_at: str, password_hash: Optional[str] = None) -> None:
    with get_connection() as conn:
        conn.execute(
            "INSERT INTO users (id, name, role, created_at, password_hash) VALUES (?, ?, ?, ?, ?)",
            (id, name, role, created_at, password_hash),
        )


def set_user_password(user_id: str, password_hash: str) -> None:
    with get_connection() as conn:
        conn.execute("UPDATE users SET password_hash = ? WHERE id = ?", (password_hash, user_id))


def record_login_failure(user_id: str, locked_until: Optional[str]) -> None:
    """Increment the failed-login counter and optionally set a lockout expiry."""
    with get_connection() as conn:
        conn.execute(
            "UPDATE users SET failed_login_attempts = failed_login_attempts + 1, locked_until = ? WHERE id = ?",
            (locked_until, user_id),
        )


def reset_login_failures(user_id: str) -> None:
    with get_connection() as conn:
        conn.execute(
            "UPDATE users SET failed_login_attempts = 0, locked_until = NULL WHERE id = ?", (user_id,)
        )


def list_user_display_names() -> list[sqlite3.Row]:
    """Slim public roster for the login picker — names + avatars only, no ids,
    roles, or activity (which would aid account enumeration/targeting)."""
    with get_connection() as conn:
        return conn.execute("SELECT name, avatar FROM users ORDER BY created_at").fetchall()


def get_user_by_name(name: str) -> Optional[sqlite3.Row]:
    with get_connection() as conn:
        return conn.execute("SELECT * FROM users WHERE name = ?", (name,)).fetchone()


def get_user_by_id(user_id: str) -> Optional[sqlite3.Row]:
    with get_connection() as conn:
        return conn.execute("SELECT * FROM users WHERE id = ?", (user_id,)).fetchone()


def list_users() -> list[sqlite3.Row]:
    with get_connection() as conn:
        return conn.execute("SELECT * FROM users ORDER BY created_at").fetchall()


def update_user(user_id: str, name: Optional[str], role: Optional[str]) -> None:
    if name is not None:
        with get_connection() as conn:
            conn.execute("UPDATE users SET name = ? WHERE id = ?", (name, user_id))
    if role is not None:
        with get_connection() as conn:
            conn.execute("UPDATE users SET role = ? WHERE id = ?", (role, user_id))


def delete_user(user_id: str) -> None:
    with get_connection() as conn:
        conn.execute("DELETE FROM sessions WHERE user_id = ?", (user_id,))
        # Clear the deleted user's ownership/assignment so leads don't keep a
        # dangling user id (audit H5). Both columns are nullable; the leads
        # remain (shared ones stay visible), just unowned/unassigned.
        conn.execute("UPDATE leads SET owner_user_id = NULL WHERE owner_user_id = ?", (user_id,))
        conn.execute("UPDATE leads SET assigned_user_id = NULL WHERE assigned_user_id = ?", (user_id,))
        conn.execute("DELETE FROM users WHERE id = ?", (user_id,))


def update_user_avatar(user_id: str, avatar: Optional[str]) -> None:
    with get_connection() as conn:
        conn.execute("UPDATE users SET avatar = ? WHERE id = ?", (avatar, user_id))


def update_user_last_seen(user_id: str, last_seen_at: str) -> None:
    with get_connection() as conn:
        conn.execute("UPDATE users SET last_seen_at = ? WHERE id = ?", (last_seen_at, user_id))


# --- AI Prospecting (Companies House integration) ---

def get_lead_by_company_number(company_number: str) -> Optional[sqlite3.Row]:
    with get_connection() as conn:
        return conn.execute("SELECT * FROM leads WHERE company_number = ?", (company_number,)).fetchone()


def create_prospecting_run(
    id: str, owner_user_id: str, criteria: str, started_at: str,
    name: str = "", list_id: Optional[str] = None,
) -> None:
    with get_connection() as conn:
        conn.execute(
            """INSERT INTO prospecting_runs
               (id, owner_user_id, status, criteria, found, created, skipped, started_at, name, list_id)
               VALUES (?, ?, 'running', ?, 0, 0, 0, ?, ?, ?)""",
            (id, owner_user_id, criteria, started_at, name, list_id),
        )


def get_prospecting_run(run_id: str) -> Optional[sqlite3.Row]:
    with get_connection() as conn:
        return conn.execute("SELECT * FROM prospecting_runs WHERE id = ?", (run_id,)).fetchone()


def list_prospecting_runs(owner_user_id: str) -> list[sqlite3.Row]:
    with get_connection() as conn:
        return conn.execute(
            "SELECT * FROM prospecting_runs WHERE owner_user_id = ? ORDER BY started_at DESC LIMIT 20",
            (owner_user_id,),
        ).fetchall()


def update_prospecting_run(run_id: str, fields: dict) -> None:
    if not fields:
        return
    columns = ", ".join(f"{key} = ?" for key in fields)
    with get_connection() as conn:
        conn.execute(f"UPDATE prospecting_runs SET {columns} WHERE id = ?", (*fields.values(), run_id))


# --- sessions ---

def create_session(token: str, user_id: str, created_at: str, expires_at: str) -> None:
    with get_connection() as conn:
        conn.execute(
            "INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)",
            (token, user_id, created_at, expires_at),
        )


def get_session(token: str) -> Optional[sqlite3.Row]:
    with get_connection() as conn:
        return conn.execute("SELECT * FROM sessions WHERE token = ?", (token,)).fetchone()


def delete_session(token: str) -> None:
    with get_connection() as conn:
        conn.execute("DELETE FROM sessions WHERE token = ?", (token,))


def delete_other_sessions_for_user(user_id: str, keep_token: Optional[str] = None) -> None:
    """Revoke a user's sessions (all, or all but one) — used after a password
    is set/changed so stolen/older tokens stop working."""
    with get_connection() as conn:
        if keep_token:
            conn.execute("DELETE FROM sessions WHERE user_id = ? AND token != ?", (user_id, keep_token))
        else:
            conn.execute("DELETE FROM sessions WHERE user_id = ?", (user_id,))


# --- OAuth CSRF-state store (email account linking) ---

def create_oauth_state(state: str, user_id: str, provider: str, created_at: str) -> None:
    with get_connection() as conn:
        conn.execute(
            "INSERT INTO oauth_states (state, user_id, provider, created_at) VALUES (?, ?, ?, ?)",
            (state, user_id, provider, created_at),
        )


def consume_oauth_state(state: str) -> Optional[sqlite3.Row]:
    """Return the state row (with the owning user_id) and delete it — one-time use."""
    with get_connection() as conn:
        row = conn.execute("SELECT * FROM oauth_states WHERE state = ?", (state,)).fetchone()
        if row is not None:
            conn.execute("DELETE FROM oauth_states WHERE state = ?", (state,))
        return row


def set_lead_shared(lead_id: str, is_shared: bool, updated_at: str) -> None:
    with get_connection() as conn:
        conn.execute(
            "UPDATE leads SET is_shared = ?, updated_at = ? WHERE id = ?",
            (1 if is_shared else 0, updated_at, lead_id),
        )


# --- leads ---

def _norm_company(name: str) -> str:
    """Normalised company key for dedup — matches the indexed `company_norm`."""
    return (name or "").strip().lower()


def _find_existing_lead_in_conn(conn: sqlite3.Connection, company_number: Optional[str], company_name: str) -> Optional[sqlite3.Row]:
    if company_number:
        row = conn.execute("SELECT * FROM leads WHERE company_number = ?", (company_number,)).fetchone()
        if row:
            return row
    # Index-backed equality on the normalised column (was an unindexable
    # LOWER(TRIM(company)) full scan on every insert — audit C4).
    return conn.execute(
        "SELECT * FROM leads WHERE company_norm = ?", (_norm_company(company_name),)
    ).fetchone()


def create_lead(
    id: str,
    timestamp: str,
    company: str,
    phone_number: str,
    source_url: str,
    status: str,
    notes: str,
    owner_user_id: str,
    created_at: str,
    list_id: Optional[str] = None,
    company_number: Optional[str] = None,
) -> str:
    """Creates a new lead or merges into an existing one. Returns the lead id."""
    with get_connection() as conn:
        existing = _find_existing_lead_in_conn(conn, company_number, company)
        if existing:
            updates = {k: v for k, v in {
                "phone_number": phone_number,
                "source_url": source_url,
                "notes": notes,
                "company_number": company_number,
            }.items() if v and not existing[k]}
            if updates:
                cols = ", ".join(f"{k} = ?" for k in updates)
                conn.execute(
                    f"UPDATE leads SET {cols}, updated_at = ? WHERE id = ?",
                    (*updates.values(), created_at, existing["id"]),
                )
            return existing["id"]
        conn.execute(
            """INSERT INTO leads
               (id, timestamp, company, company_norm, phone_number, source_url, status, notes,
                industry, contact_status, lead_notes, owner_user_id, assigned_user_id, list_id, company_number, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, '', 'New', '', ?, NULL, ?, ?, ?, ?)""",
            (id, timestamp, company, _norm_company(company), phone_number, source_url, status, notes, owner_user_id, list_id, company_number, created_at, created_at),
        )
        return id


_CONTACT_STATUS_RANK: dict[str, int] = {"New": 0, "Contacted": 1, "Replied": 2, "Converted": 3}


def merge_lead_into(winner_id: str, loser_id: str, now: str) -> None:
    """Absorbs loser into winner: fills blank scalar fields, re-parents all child
    records, then deletes the loser. Runs in a single transaction."""
    with get_connection() as conn:
        winner = conn.execute("SELECT * FROM leads WHERE id = ?", (winner_id,)).fetchone()
        loser = conn.execute("SELECT * FROM leads WHERE id = ?", (loser_id,)).fetchone()
        if not winner or not loser:
            return

        # Scalar fields: only overwrite blanks on winner
        scalar_fields = [
            "phone_number", "source_url", "notes", "lead_notes",
            "company_number", "ch_data", "industry",
            "website", "linkedin", "contact_name", "contact_title",
            "assigned_user_id",
        ]
        updates: dict[str, object] = {}
        for field in scalar_fields:
            if not winner[field] and loser[field]:
                updates[field] = loser[field]

        # Take higher contact_status rank
        winner_rank = _CONTACT_STATUS_RANK.get(winner["contact_status"] or "New", 0)
        loser_rank = _CONTACT_STATUS_RANK.get(loser["contact_status"] or "New", 0)
        if loser_rank > winner_rank:
            updates["contact_status"] = loser["contact_status"]

        # Take non-'none' opportunity stage if winner has none
        if (winner["opportunity_stage"] or "none") == "none" and (loser["opportunity_stage"] or "none") != "none":
            updates["opportunity_stage"] = loser["opportunity_stage"]

        if updates:
            cols = ", ".join(f"{k} = ?" for k in updates)
            conn.execute(
                f"UPDATE leads SET {cols}, updated_at = ? WHERE id = ?",
                (*updates.values(), now, winner_id),
            )

        # Re-parent child records (IGNORE handles unique constraint conflicts).
        # UNIQUE(lead_id, …) tables need OR IGNORE + delete-leftovers; the rest
        # are a plain re-parent. This list must cover EVERY table with a lead_id
        # or a merge silently orphans rows (audit H5) — keep it exhaustive.
        conn.execute("UPDATE OR IGNORE lead_phones SET lead_id = ? WHERE lead_id = ?", (winner_id, loser_id))
        conn.execute("DELETE FROM lead_phones WHERE lead_id = ?", (loser_id,))
        conn.execute("UPDATE OR IGNORE lead_emails SET lead_id = ? WHERE lead_id = ?", (winner_id, loser_id))
        conn.execute("DELETE FROM lead_emails WHERE lead_id = ?", (loser_id,))
        for table in (
            "lead_intelligence_versions", "call_logs", "email_drafts", "sequence_enrollments",
            "calendar_events", "activity_events",
            "lead_linkedin_posts", "win_back_emails", "ch_charge_feed",
        ):
            conn.execute(f"UPDATE {table} SET lead_id = ? WHERE lead_id = ?", (winner_id, loser_id))
        conn.execute("DELETE FROM lead_intelligence_locks WHERE lead_id = ?", (loser_id,))
        conn.execute("DELETE FROM leads WHERE id = ?", (loser_id,))


def list_leads(list_id: Optional[str] = None) -> list[sqlite3.Row]:
    with get_connection() as conn:
        if list_id is None:
            return conn.execute("SELECT * FROM leads WHERE list_id IS NULL ORDER BY timestamp").fetchall()
        return conn.execute("SELECT * FROM leads WHERE list_id = ? ORDER BY timestamp", (list_id,)).fetchall()


def list_all_leads_for_user(user_id: str, is_admin: bool, lead_scope: str = "all_shared") -> list[sqlite3.Row]:
    """Returns the leads visible to the user. Admins see everything. Otherwise:
      - lead_scope 'all_shared'  -> shared pool + own + assigned (default);
      - lead_scope 'own_assigned' -> only leads they own or are assigned (BDE-style).
    Includes list_name via LEFT JOIN."""
    with get_connection() as conn:
        if is_admin:
            return conn.execute(
                "SELECT l.*, ll.name AS list_name FROM leads l "
                "LEFT JOIN lead_lists ll ON l.list_id = ll.id ORDER BY l.timestamp"
            ).fetchall()
        if lead_scope == "own_assigned":
            return conn.execute(
                "SELECT l.*, ll.name AS list_name FROM leads l "
                "LEFT JOIN lead_lists ll ON l.list_id = ll.id "
                "WHERE l.owner_user_id = ? OR l.assigned_user_id = ? "
                "ORDER BY l.timestamp",
                (user_id, user_id),
            ).fetchall()
        return conn.execute(
            "SELECT l.*, ll.name AS list_name FROM leads l "
            "LEFT JOIN lead_lists ll ON l.list_id = ll.id "
            "WHERE (l.list_id IS NULL AND l.is_shared = 1) "
            "   OR l.owner_user_id = ? "
            "   OR l.assigned_user_id = ? "
            "ORDER BY l.timestamp",
            (user_id, user_id),
        ).fetchall()


def get_lead(lead_id: str) -> Optional[sqlite3.Row]:
    with get_connection() as conn:
        return conn.execute("SELECT * FROM leads WHERE id = ?", (lead_id,)).fetchone()


_SAFE_COLUMN_RE = re.compile(r"^[a-z_][a-z0-9_]*$")


def _assert_safe_columns(fields: dict) -> None:
    """Defence-in-depth for the dynamic SET builders: reject any key that isn't a
    plain column identifier so a stray raw-dict caller can't inject SQL (audit L4).
    Values are always bound with ?; only names are interpolated."""
    bad = [k for k in fields if not _SAFE_COLUMN_RE.match(k)]
    if bad:
        raise ValueError(f"Illegal column name(s) in update: {bad}")


def update_lead_fields(lead_id: str, fields: dict, updated_at: str) -> None:
    if not fields:
        return
    _assert_safe_columns(fields)
    columns = ", ".join(f"{key} = ?" for key in fields)
    with get_connection() as conn:
        conn.execute(
            f"UPDATE leads SET {columns}, updated_at = ? WHERE id = ?",
            (*fields.values(), updated_at, lead_id),
        )


def assign_lead(lead_id: str, assigned_user_id: Optional[str], updated_at: str) -> None:
    with get_connection() as conn:
        conn.execute(
            "UPDATE leads SET assigned_user_id = ?, updated_at = ? WHERE id = ?",
            (assigned_user_id, updated_at, lead_id),
        )


# --- lead phones (additive — leads.phone_number stays the untouched legacy/primary column) ---

def list_phones(lead_id: str) -> list[sqlite3.Row]:
    with get_connection() as conn:
        return conn.execute(
            "SELECT * FROM lead_phones WHERE lead_id = ? ORDER BY created_at", (lead_id,)
        ).fetchall()


def add_phone(id: str, lead_id: str, phone_number: str, source: str, created_at: str) -> None:
    with get_connection() as conn:
        conn.execute(
            "INSERT INTO lead_phones (id, lead_id, phone_number, source, created_at) VALUES (?, ?, ?, ?, ?)",
            (id, lead_id, phone_number, source, created_at),
        )


def add_phone_ignore_duplicate(id: str, lead_id: str, phone_number: str, source: str, created_at: str) -> None:
    with get_connection() as conn:
        conn.execute(
            "INSERT OR IGNORE INTO lead_phones (id, lead_id, phone_number, source, created_at) VALUES (?, ?, ?, ?, ?)",
            (id, lead_id, phone_number, source, created_at),
        )


def get_phone(phone_id: str) -> Optional[sqlite3.Row]:
    with get_connection() as conn:
        return conn.execute("SELECT * FROM lead_phones WHERE id = ?", (phone_id,)).fetchone()


def update_phone(phone_id: str, phone_number: str) -> None:
    with get_connection() as conn:
        conn.execute("UPDATE lead_phones SET phone_number = ? WHERE id = ?", (phone_number, phone_id))


def delete_phone(phone_id: str) -> None:
    with get_connection() as conn:
        conn.execute("DELETE FROM lead_phones WHERE id = ?", (phone_id,))


# --- lead emails (additive, fully separate from phones) ---

def list_emails(lead_id: str) -> list[sqlite3.Row]:
    with get_connection() as conn:
        return conn.execute(
            "SELECT * FROM lead_emails WHERE lead_id = ? ORDER BY created_at", (lead_id,)
        ).fetchall()


def set_email_verification(email_id: str, status: str, person_match: str, detail: str, verified_at: str) -> None:
    with get_connection() as conn:
        conn.execute(
            "UPDATE lead_emails SET verify_status = ?, person_match = ?, verify_detail = ?, verified_at = ? WHERE id = ?",
            (status, person_match, detail, verified_at, email_id),
        )


def add_email(id: str, lead_id: str, email: str, source: str, created_at: str) -> None:
    with get_connection() as conn:
        conn.execute(
            "INSERT INTO lead_emails (id, lead_id, email, source, created_at) VALUES (?, ?, ?, ?, ?)",
            (id, lead_id, email, source, created_at),
        )


def add_email_ignore_duplicate(id: str, lead_id: str, email: str, source: str, created_at: str) -> None:
    with get_connection() as conn:
        conn.execute(
            "INSERT OR IGNORE INTO lead_emails (id, lead_id, email, source, created_at) VALUES (?, ?, ?, ?, ?)",
            (id, lead_id, email, source, created_at),
        )


def get_email(email_id: str) -> Optional[sqlite3.Row]:
    with get_connection() as conn:
        return conn.execute("SELECT * FROM lead_emails WHERE id = ?", (email_id,)).fetchone()


def update_email(email_id: str, email: str) -> None:
    with get_connection() as conn:
        conn.execute("UPDATE lead_emails SET email = ? WHERE id = ?", (email, email_id))


def delete_email(email_id: str) -> None:
    with get_connection() as conn:
        conn.execute("DELETE FROM lead_emails WHERE id = ?", (email_id,))


# --- lead lists (private cold call lists — leads with list_id stay out of the shared feed) ---

def create_lead_list(id: str, name: str, owner_user_id: str, created_at: str) -> None:
    with get_connection() as conn:
        conn.execute(
            "INSERT INTO lead_lists (id, name, owner_user_id, created_at) VALUES (?, ?, ?, ?)",
            (id, name, owner_user_id, created_at),
        )


def list_lead_lists(owner_user_id: Optional[str] = None) -> list[sqlite3.Row]:
    with get_connection() as conn:
        if owner_user_id is None:
            return conn.execute("SELECT * FROM lead_lists ORDER BY created_at").fetchall()
        return conn.execute(
            "SELECT * FROM lead_lists WHERE owner_user_id = ? ORDER BY created_at", (owner_user_id,)
        ).fetchall()


def get_lead_list(list_id: str) -> Optional[sqlite3.Row]:
    with get_connection() as conn:
        return conn.execute("SELECT * FROM lead_lists WHERE id = ?", (list_id,)).fetchone()


def count_leads_in_list(list_id: str) -> int:
    with get_connection() as conn:
        return conn.execute("SELECT COUNT(*) FROM leads WHERE list_id = ?", (list_id,)).fetchone()[0]


def toggle_lead_called(lead_id: str, list_id: str, now: str) -> Optional[str]:
    """Flips called_at between null (uncalled) and now (called). Returns the new value."""
    with get_connection() as conn:
        row = conn.execute("SELECT called_at FROM leads WHERE id = ?", (lead_id,)).fetchone()
        if not row:
            return None
        new_val: Optional[str] = None if row["called_at"] else now
        conn.execute("UPDATE leads SET called_at = ? WHERE id = ?", (new_val, lead_id))
        return new_val


def delete_lead_list(list_id: str) -> None:
    """Deletes a lead list. Leads are unassigned (list_id → NULL) and kept in the global pool."""
    with get_connection() as conn:
        conn.execute("UPDATE leads SET list_id = NULL WHERE list_id = ?", (list_id,))
        conn.execute("DELETE FROM lead_lists WHERE id = ?", (list_id,))


def add_leads_to_list(lead_ids: list[str], list_id: str) -> dict:
    """Move existing leads into a list. Leads already in a DIFFERENT list are skipped.
    Returns {added, skipped, skipped_details}."""
    if not lead_ids:
        return {"added": 0, "skipped": 0, "skipped_details": []}
    placeholders = ",".join("?" * len(lead_ids))
    with get_connection() as conn:
        conflicts = conn.execute(
            f"""SELECT l.id, l.company, ll.name AS list_name
                FROM leads l
                LEFT JOIN lead_lists ll ON l.list_id = ll.id
                WHERE l.id IN ({placeholders})
                  AND l.list_id IS NOT NULL
                  AND l.list_id != ?""",
            [*lead_ids, list_id],
        ).fetchall()
        conflict_ids = {r["id"] for r in conflicts}
        to_add = [lid for lid in lead_ids if lid not in conflict_ids]
        if to_add:
            add_ph = ",".join("?" * len(to_add))
            conn.execute(
                f"UPDATE leads SET list_id = ? WHERE id IN ({add_ph})",
                [list_id, *to_add],
            )
        return {
            "added": len(to_add),
            "skipped": len(conflict_ids),
            "skipped_details": [
                {"id": r["id"], "company": r["company"], "list_name": r["list_name"] or "another list"}
                for r in conflicts
            ],
        }


def set_lead_follow_up(lead_id: str, follow_up_at: Optional[str]) -> None:
    """Set or clear the follow-up date for a lead."""
    with get_connection() as conn:
        conn.execute("UPDATE leads SET follow_up_at = ? WHERE id = ?", (follow_up_at, lead_id))


def set_lead_priority(lead_id: str, score: int, breakdown_json: str) -> None:
    """Persist the deterministic prioritisation score + per-signal breakdown."""
    with get_connection() as conn:
        conn.execute(
            "UPDATE leads SET priority_score = ?, priority_breakdown = ? WHERE id = ?",
            (score, breakdown_json, lead_id),
        )


# --- AI sales intelligence (append-only version history — never updated, never deleted) ---

_INTELLIGENCE_COLUMNS = (
    "executive_summary",
    "sales_summary",
    "pain_points",
    "buying_signals",
    "conversation_starters",
    "discovery_questions",
    "objection_handling",
    "pitch_angle",
    "call_brief",
    "score_breakdown",
    "lead_score",
    "lead_temperature",
    "confidence_note",
)


def add_lead_intelligence_version(id: str, lead_id: str, fields: dict, created_at: str) -> None:
    columns = ", ".join(_INTELLIGENCE_COLUMNS)
    placeholders = ", ".join("?" for _ in _INTELLIGENCE_COLUMNS)
    values = [fields[col] for col in _INTELLIGENCE_COLUMNS]
    with get_connection() as conn:
        conn.execute(
            f"INSERT INTO lead_intelligence_versions (id, lead_id, {columns}, created_at) "
            f"VALUES (?, ?, {placeholders}, ?)",
            (id, lead_id, *values, created_at),
        )


def get_latest_lead_intelligence(lead_id: str) -> Optional[sqlite3.Row]:
    with get_connection() as conn:
        return conn.execute(
            "SELECT * FROM lead_intelligence_versions WHERE lead_id = ? "
            "ORDER BY created_at DESC, id DESC LIMIT 1",
            (lead_id,),
        ).fetchone()


def add_lead_linkedin_posts(id: str, lead_id: str, linkedin_url: str, posts_json: str, created_at: str) -> None:
    with get_connection() as conn:
        conn.execute(
            "INSERT INTO lead_linkedin_posts (id, lead_id, linkedin_url, posts_json, created_at) "
            "VALUES (?, ?, ?, ?, ?)",
            (id, lead_id, linkedin_url, posts_json, created_at),
        )


def get_latest_lead_linkedin_posts(lead_id: str) -> Optional[sqlite3.Row]:
    with get_connection() as conn:
        return conn.execute(
            "SELECT * FROM lead_linkedin_posts WHERE lead_id = ? "
            "ORDER BY created_at DESC, id DESC LIMIT 1",
            (lead_id,),
        ).fetchone()


def list_lead_intelligence_versions(lead_id: str) -> list[sqlite3.Row]:
    with get_connection() as conn:
        return conn.execute(
            "SELECT * FROM lead_intelligence_versions WHERE lead_id = ? "
            "ORDER BY created_at DESC, id DESC",
            (lead_id,),
        ).fetchall()


def get_lead_intelligence_first_generated_at(lead_id: str) -> Optional[str]:
    with get_connection() as conn:
        row = conn.execute(
            "SELECT MIN(created_at) AS first_at FROM lead_intelligence_versions WHERE lead_id = ?",
            (lead_id,),
        ).fetchone()
        return row["first_at"] if row else None


# --- Batched lead-render lookups (fixes the GET /leads N+1) ---
# Each returns a dict keyed by lead_id, computed in a handful of grouped queries
# over one reused connection — never one query per lead. IN clauses are chunked
# to stay under SQLite's ~999 bound-parameter limit.

def _id_chunks(ids: list[str], size: int = 400):
    for i in range(0, len(ids), size):
        yield ids[i:i + size]


def get_phones_for_leads(lead_ids: list[str]) -> dict[str, list[sqlite3.Row]]:
    result: dict[str, list[sqlite3.Row]] = {lid: [] for lid in lead_ids}
    if not lead_ids:
        return result
    with get_connection() as conn:
        for chunk in _id_chunks(lead_ids):
            ph = ", ".join("?" for _ in chunk)
            for r in conn.execute(
                f"SELECT * FROM lead_phones WHERE lead_id IN ({ph}) ORDER BY created_at", chunk
            ):
                result[r["lead_id"]].append(r)
    return result


def get_emails_for_leads(lead_ids: list[str]) -> dict[str, list[sqlite3.Row]]:
    result: dict[str, list[sqlite3.Row]] = {lid: [] for lid in lead_ids}
    if not lead_ids:
        return result
    with get_connection() as conn:
        for chunk in _id_chunks(lead_ids):
            ph = ", ".join("?" for _ in chunk)
            for r in conn.execute(
                f"SELECT * FROM lead_emails WHERE lead_id IN ({ph}) ORDER BY created_at", chunk
            ):
                result[r["lead_id"]].append(r)
    return result


def get_latest_intelligence_for_leads(lead_ids: list[str]) -> dict[str, sqlite3.Row]:
    """Latest intelligence version per lead. Ordered DESC so the first row seen
    for each lead_id is its most recent (each lead falls in exactly one chunk)."""
    result: dict[str, sqlite3.Row] = {}
    if not lead_ids:
        return result
    with get_connection() as conn:
        for chunk in _id_chunks(lead_ids):
            ph = ", ".join("?" for _ in chunk)
            for r in conn.execute(
                f"SELECT * FROM lead_intelligence_versions WHERE lead_id IN ({ph}) "
                "ORDER BY created_at DESC, id DESC",
                chunk,
            ):
                if r["lead_id"] not in result:
                    result[r["lead_id"]] = r
    return result


def get_intelligence_meta_for_leads(lead_ids: list[str]) -> dict[str, tuple[int, str]]:
    """Per lead: (version_count, first_generated_at)."""
    result: dict[str, tuple[int, str]] = {}
    if not lead_ids:
        return result
    with get_connection() as conn:
        for chunk in _id_chunks(lead_ids):
            ph = ", ".join("?" for _ in chunk)
            for r in conn.execute(
                f"SELECT lead_id, COUNT(*) AS c, MIN(created_at) AS first_at "
                f"FROM lead_intelligence_versions WHERE lead_id IN ({ph}) GROUP BY lead_id",
                chunk,
            ):
                result[r["lead_id"]] = (r["c"], r["first_at"])
    return result


def acquire_intelligence_lock(lead_id: str, locked_at: str) -> None:
    """Raises sqlite3.IntegrityError if a generation is already in progress
    for this lead — the caller turns that into a 409."""
    with get_connection() as conn:
        conn.execute(
            "INSERT INTO lead_intelligence_locks (lead_id, locked_at) VALUES (?, ?)",
            (lead_id, locked_at),
        )


def release_intelligence_lock(lead_id: str) -> None:
    with get_connection() as conn:
        conn.execute("DELETE FROM lead_intelligence_locks WHERE lead_id = ?", (lead_id,))


# --- calendar events (private per-owner — admins can still reach any event by id) ---

def create_calendar_event(
    id: str,
    owner_user_id: str,
    title: str,
    date: str,
    time: str,
    type: str,
    lead_id: Optional[str],
    description: str,
    created_at: str,
) -> None:
    with get_connection() as conn:
        conn.execute(
            """INSERT INTO calendar_events
               (id, owner_user_id, title, date, time, type, lead_id, description, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (id, owner_user_id, title, date, time, type, lead_id, description, created_at, created_at),
        )


def list_calendar_events(owner_user_id: str) -> list[sqlite3.Row]:
    with get_connection() as conn:
        return conn.execute(
            "SELECT * FROM calendar_events WHERE owner_user_id = ? ORDER BY date, time",
            (owner_user_id,),
        ).fetchall()


def get_calendar_event(event_id: str) -> Optional[sqlite3.Row]:
    with get_connection() as conn:
        return conn.execute("SELECT * FROM calendar_events WHERE id = ?", (event_id,)).fetchone()


def update_calendar_event_fields(event_id: str, fields: dict, updated_at: str) -> None:
    if not fields:
        return
    columns = ", ".join(f"{key} = ?" for key in fields)
    with get_connection() as conn:
        conn.execute(
            f"UPDATE calendar_events SET {columns}, updated_at = ? WHERE id = ?",
            (*fields.values(), updated_at, event_id),
        )


def delete_calendar_event(event_id: str) -> None:
    with get_connection() as conn:
        conn.execute("DELETE FROM calendar_events WHERE id = ?", (event_id,))


# --- call logs (shared per-lead history, like lead_intelligence_versions) ---

def create_call_log(
    id: str,
    lead_id: str,
    calendar_event_id: Optional[str],
    outcome: str,
    notes: str,
    duration_seconds: Optional[int],
    created_by: str,
    created_at: str,
) -> None:
    with get_connection() as conn:
        conn.execute(
            """INSERT INTO call_logs
               (id, lead_id, calendar_event_id, outcome, notes, duration_seconds, created_by, created_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
            (id, lead_id, calendar_event_id, outcome, notes, duration_seconds, created_by, created_at),
        )


def list_call_logs_for_lead(lead_id: str) -> list[sqlite3.Row]:
    with get_connection() as conn:
        return conn.execute(
            "SELECT * FROM call_logs WHERE lead_id = ? ORDER BY created_at DESC",
            (lead_id,),
        ).fetchall()


def get_latest_call_log_for_lead(lead_id: str) -> Optional[sqlite3.Row]:
    with get_connection() as conn:
        return conn.execute(
            "SELECT * FROM call_logs WHERE lead_id = ? ORDER BY created_at DESC LIMIT 1",
            (lead_id,),
        ).fetchone()


# --- Bulk activity lookups for Next Best Action — 3 grouped queries total,
# never one query per lead, so list views stay cheap regardless of lead count. ---

def get_latest_call_log_dates() -> dict[str, str]:
    with get_connection() as conn:
        rows = conn.execute("SELECT lead_id, MAX(created_at) AS latest FROM call_logs GROUP BY lead_id").fetchall()
        return {r["lead_id"]: r["latest"] for r in rows}


def get_latest_sent_email_dates() -> dict[str, str]:
    with get_connection() as conn:
        rows = conn.execute(
            "SELECT lead_id, MAX(sent_at) AS latest FROM email_drafts WHERE sent_at IS NOT NULL GROUP BY lead_id"
        ).fetchall()
        return {r["lead_id"]: r["latest"] for r in rows}


def get_latest_past_calendar_dates(today: str) -> dict[str, str]:
    with get_connection() as conn:
        rows = conn.execute(
            "SELECT lead_id, MAX(date) AS latest FROM calendar_events WHERE lead_id IS NOT NULL AND date <= ? GROUP BY lead_id",
            (today,),
        ).fetchall()
        return {r["lead_id"]: r["latest"] for r in rows}


def get_lead_ids_with_call_scheduled(date: str) -> set[str]:
    with get_connection() as conn:
        rows = conn.execute(
            "SELECT DISTINCT lead_id FROM calendar_events WHERE type = 'call' AND date = ? AND lead_id IS NOT NULL",
            (date,),
        ).fetchall()
        return {r["lead_id"] for r in rows}


# --- sales sequences (multi-channel automation: email + call/follow-up/reminder tasks) ---

def create_sequence(id: str, name: str, owner_user_id: str, created_at: str) -> None:
    with get_connection() as conn:
        conn.execute(
            "INSERT INTO sequences (id, name, owner_user_id, status, created_at, updated_at) VALUES (?, ?, ?, 'draft', ?, ?)",
            (id, name, owner_user_id, created_at, created_at),
        )


def list_sequences(owner_user_id: str) -> list[sqlite3.Row]:
    with get_connection() as conn:
        return conn.execute(
            "SELECT * FROM sequences WHERE owner_user_id = ? ORDER BY created_at DESC", (owner_user_id,)
        ).fetchall()


def get_sequence(sequence_id: str) -> Optional[sqlite3.Row]:
    with get_connection() as conn:
        return conn.execute("SELECT * FROM sequences WHERE id = ?", (sequence_id,)).fetchone()


def update_sequence_fields(sequence_id: str, fields: dict, updated_at: str) -> None:
    if not fields:
        return
    columns = ", ".join(f"{key} = ?" for key in fields)
    with get_connection() as conn:
        conn.execute(
            f"UPDATE sequences SET {columns}, updated_at = ? WHERE id = ?",
            (*fields.values(), updated_at, sequence_id),
        )


def delete_sequence(sequence_id: str) -> None:
    with get_connection() as conn:
        conn.execute("DELETE FROM sequence_enrollments WHERE sequence_id = ?", (sequence_id,))
        conn.execute("DELETE FROM sequence_steps WHERE sequence_id = ?", (sequence_id,))
        conn.execute("DELETE FROM sequences WHERE id = ?", (sequence_id,))


def add_sequence_step(
    id: str, sequence_id: str, step_order: int, delay_days: int, step_type: str,
    subject_template: str, body_template: str, created_at: str,
) -> None:
    with get_connection() as conn:
        conn.execute(
            """INSERT INTO sequence_steps
               (id, sequence_id, step_order, delay_days, step_type, subject_template, body_template, created_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
            (id, sequence_id, step_order, delay_days, step_type, subject_template, body_template, created_at),
        )


def list_sequence_steps(sequence_id: str) -> list[sqlite3.Row]:
    with get_connection() as conn:
        return conn.execute(
            "SELECT * FROM sequence_steps WHERE sequence_id = ? ORDER BY step_order", (sequence_id,)
        ).fetchall()


def delete_sequence_step(step_id: str) -> None:
    with get_connection() as conn:
        conn.execute("DELETE FROM sequence_steps WHERE id = ?", (step_id,))


def enroll_lead_in_sequence(id: str, sequence_id: str, lead_id: str, created_by: str, enrolled_at: str, next_run_at: str) -> None:
    with get_connection() as conn:
        conn.execute(
            """INSERT INTO sequence_enrollments
               (id, sequence_id, lead_id, current_step, status, enrolled_at, next_run_at, created_by)
               VALUES (?, ?, ?, 0, 'active', ?, ?, ?)""",
            (id, sequence_id, lead_id, enrolled_at, next_run_at, created_by),
        )


def list_sequence_enrollments(sequence_id: str) -> list[sqlite3.Row]:
    with get_connection() as conn:
        return conn.execute(
            """SELECT se.*, l.company AS lead_company
               FROM sequence_enrollments se
               JOIN leads l ON l.id = se.lead_id
               WHERE se.sequence_id = ?
               ORDER BY se.enrolled_at DESC""",
            (sequence_id,),
        ).fetchall()


def get_sequence_enrollment(enrollment_id: str) -> Optional[sqlite3.Row]:
    with get_connection() as conn:
        return conn.execute("SELECT * FROM sequence_enrollments WHERE id = ?", (enrollment_id,)).fetchone()


def update_enrollment(enrollment_id: str, fields: dict) -> None:
    if not fields:
        return
    columns = ", ".join(f"{key} = ?" for key in fields)
    with get_connection() as conn:
        conn.execute(f"UPDATE sequence_enrollments SET {columns} WHERE id = ?", (*fields.values(), enrollment_id))


def list_due_enrollments(now: str) -> list[sqlite3.Row]:
    """Active enrollments whose next step is due — what the scheduler polls."""
    with get_connection() as conn:
        return conn.execute(
            "SELECT * FROM sequence_enrollments WHERE status = 'active' AND next_run_at IS NOT NULL AND next_run_at <= ?",
            (now,),
        ).fetchall()


# --- brand voice profiles (one row per user — "get your own, or sensible empty defaults") ---

_BRAND_VOICE_COLUMNS = (
    "company_name",
    "company_description",
    "industry",
    "target_audience",
    "core_services",
    "unique_selling_points",
    "preferred_writing_style",
    "preferred_cta_style",
    "preferred_email_length",
    "website",
    "booking_link",
    "signature",
)


def get_brand_voice(user_id: str) -> Optional[sqlite3.Row]:
    with get_connection() as conn:
        return conn.execute("SELECT * FROM brand_voice_profiles WHERE user_id = ?", (user_id,)).fetchone()


def upsert_brand_voice(user_id: str, fields: dict, updated_at: str) -> None:
    columns = ", ".join(_BRAND_VOICE_COLUMNS)
    placeholders = ", ".join("?" for _ in _BRAND_VOICE_COLUMNS)
    update_clause = ", ".join(f"{col} = excluded.{col}" for col in _BRAND_VOICE_COLUMNS)
    values = [fields.get(col, "") for col in _BRAND_VOICE_COLUMNS]
    with get_connection() as conn:
        conn.execute(
            f"""INSERT INTO brand_voice_profiles (user_id, {columns}, updated_at)
                VALUES (?, {placeholders}, ?)
                ON CONFLICT(user_id) DO UPDATE SET {update_clause}, updated_at = excluded.updated_at""",
            (user_id, *values, updated_at),
        )


# --- email templates (private per creator — admins can still reach any by id) ---

def create_email_template(
    id: str, owner_user_id: str, name: str, subject: str, body: str, tone: str, length: str, created_at: str
) -> None:
    with get_connection() as conn:
        conn.execute(
            """INSERT INTO email_templates (id, owner_user_id, name, subject, body, tone, length, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (id, owner_user_id, name, subject, body, tone, length, created_at, created_at),
        )


def list_email_templates(owner_user_id: Optional[str] = None) -> list[sqlite3.Row]:
    with get_connection() as conn:
        if owner_user_id is None:
            return conn.execute("SELECT * FROM email_templates ORDER BY created_at").fetchall()
        return conn.execute(
            "SELECT * FROM email_templates WHERE owner_user_id = ? ORDER BY created_at", (owner_user_id,)
        ).fetchall()


def get_email_template(template_id: str) -> Optional[sqlite3.Row]:
    with get_connection() as conn:
        return conn.execute("SELECT * FROM email_templates WHERE id = ?", (template_id,)).fetchone()


def update_email_template_fields(template_id: str, fields: dict, updated_at: str) -> None:
    if not fields:
        return
    columns = ", ".join(f"{key} = ?" for key in fields)
    with get_connection() as conn:
        conn.execute(
            f"UPDATE email_templates SET {columns}, updated_at = ? WHERE id = ?",
            (*fields.values(), updated_at, template_id),
        )


def delete_email_template(template_id: str) -> None:
    with get_connection() as conn:
        conn.execute("DELETE FROM email_templates WHERE id = ?", (template_id,))


# --- email drafts (lead-scoped — access follows the lead's own visibility rules) ---

_EMAIL_DRAFT_COLUMNS = (
    "subject",
    "body",
    "tone",
    "length",
    "estimated_open_rate",
    "estimated_reply_rate",
    "estimated_readability_score",
    # Nullable: set only by List Email Campaigns to group a campaign's per-lead
    # drafts. Every other caller leaves it absent (→ NULL), unchanged behaviour.
    "campaign_id",
)


def create_email_draft(id: str, lead_id: str, owner_user_id: str, fields: dict, created_at: str) -> None:
    columns = ", ".join(_EMAIL_DRAFT_COLUMNS)
    placeholders = ", ".join("?" for _ in _EMAIL_DRAFT_COLUMNS)
    values = [fields.get(col) for col in _EMAIL_DRAFT_COLUMNS]
    with get_connection() as conn:
        conn.execute(
            f"""INSERT INTO email_drafts (id, lead_id, owner_user_id, {columns}, status, created_at, updated_at)
                VALUES (?, ?, ?, {placeholders}, 'draft', ?, ?)""",
            (id, lead_id, owner_user_id, *values, created_at, created_at),
        )


def list_email_drafts(lead_id: str) -> list[sqlite3.Row]:
    with get_connection() as conn:
        return conn.execute(
            "SELECT * FROM email_drafts WHERE lead_id = ? ORDER BY created_at DESC, id DESC", (lead_id,)
        ).fetchall()


def list_pending_email_drafts(owner_user_id: str) -> list[sqlite3.Row]:
    """This owner's started-but-unsent drafts across every lead — for the
    Action Centre's "emails requiring action" section. Scoped to the
    requesting user, same privacy boundary as every other draft endpoint.
    Joins the lead's company name in directly since that's all the UI
    needs to display the row."""
    with get_connection() as conn:
        return conn.execute(
            """SELECT ed.*, l.company AS lead_company
               FROM email_drafts ed
               JOIN leads l ON l.id = ed.lead_id
               WHERE ed.status = 'draft' AND ed.owner_user_id = ?
                 AND ed.campaign_id IS NULL
               ORDER BY ed.updated_at DESC""",
            (owner_user_id,),
        ).fetchall()


def get_email_draft(draft_id: str) -> Optional[sqlite3.Row]:
    with get_connection() as conn:
        return conn.execute("SELECT * FROM email_drafts WHERE id = ?", (draft_id,)).fetchone()


def update_email_draft_fields(draft_id: str, fields: dict, updated_at: str) -> None:
    if not fields:
        return
    _assert_safe_columns(fields)
    columns = ", ".join(f"{key} = ?" for key in fields)
    with get_connection() as conn:
        conn.execute(
            f"UPDATE email_drafts SET {columns}, updated_at = ? WHERE id = ?",
            (*fields.values(), updated_at, draft_id),
        )


def mark_email_draft_sent(draft_id: str, sent_via: str, sent_at: str) -> None:
    with get_connection() as conn:
        conn.execute(
            "UPDATE email_drafts SET status = 'sent', sent_via = ?, sent_at = ?, updated_at = ? WHERE id = ?",
            (sent_via, sent_at, sent_at, draft_id),
        )


def delete_email_draft(draft_id: str) -> None:
    with get_connection() as conn:
        conn.execute("DELETE FROM email_drafts WHERE id = ?", (draft_id,))


# --- email OAuth accounts (sending-credential storage — tokens never leave the backend) ---

def upsert_email_oauth_account(
    id: str,
    user_id: str,
    provider: str,
    email_address: str,
    access_token: str,
    refresh_token: str,
    token_expires_at: str,
    created_at: str,
) -> None:
    with get_connection() as conn:
        conn.execute(
            """INSERT INTO email_oauth_accounts
               (id, user_id, provider, email_address, access_token, refresh_token, token_expires_at, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
               ON CONFLICT(user_id, provider) DO UPDATE SET
                   email_address = excluded.email_address,
                   access_token = excluded.access_token,
                   refresh_token = excluded.refresh_token,
                   token_expires_at = excluded.token_expires_at,
                   updated_at = excluded.updated_at""",
            (id, user_id, provider, email_address, access_token, refresh_token, token_expires_at, created_at, created_at),
        )


def update_email_oauth_tokens(user_id: str, provider: str, access_token: str, token_expires_at: str, updated_at: str) -> None:
    with get_connection() as conn:
        conn.execute(
            "UPDATE email_oauth_accounts SET access_token = ?, token_expires_at = ?, updated_at = ? "
            "WHERE user_id = ? AND provider = ?",
            (access_token, token_expires_at, updated_at, user_id, provider),
        )


def get_email_oauth_account(user_id: str, provider: str) -> Optional[sqlite3.Row]:
    with get_connection() as conn:
        return conn.execute(
            "SELECT * FROM email_oauth_accounts WHERE user_id = ? AND provider = ?", (user_id, provider)
        ).fetchone()


def list_email_oauth_accounts(user_id: str) -> list[sqlite3.Row]:
    with get_connection() as conn:
        return conn.execute(
            "SELECT * FROM email_oauth_accounts WHERE user_id = ? ORDER BY provider", (user_id,)
        ).fetchall()


def delete_email_oauth_account(user_id: str, provider: str) -> None:
    with get_connection() as conn:
        conn.execute(
            "DELETE FROM email_oauth_accounts WHERE user_id = ? AND provider = ?", (user_id, provider)
        )


# --- Companies House activity feed (append-only snapshots + structured change events) ---

def get_latest_snapshot(company_number: str) -> Optional[sqlite3.Row]:
    with get_connection() as conn:
        return conn.execute(
            "SELECT * FROM company_snapshots WHERE company_number = ? ORDER BY fetched_at DESC LIMIT 1",
            (company_number,),
        ).fetchone()


def save_snapshot(id: str, company_number: str, snapshot_json: str, fetched_at: str) -> None:
    with get_connection() as conn:
        conn.execute(
            "INSERT INTO company_snapshots (id, company_number, snapshot_json, fetched_at) VALUES (?, ?, ?, ?)",
            (id, company_number, snapshot_json, fetched_at),
        )


def save_activity_events(events: list[dict]) -> None:
    """Bulk insert; silently skip exact id duplicates."""
    if not events:
        return
    with get_connection() as conn:
        conn.executemany(
            """INSERT OR IGNORE INTO activity_events
               (id, company_number, company_name, lead_id, event_type, description, event_data, occurred_at, detected_at)
               VALUES (:id, :company_number, :company_name, :lead_id, :event_type, :description, :event_data, :occurred_at, :detected_at)""",
            events,
        )


def list_lead_activity(lead_id: str, limit: int = 50) -> list[sqlite3.Row]:
    with get_connection() as conn:
        return conn.execute(
            "SELECT * FROM activity_events WHERE lead_id = ? ORDER BY detected_at DESC LIMIT ?",
            (lead_id, limit),
        ).fetchall()


def list_global_activity(
    event_types: Optional[list[str]] = None,
    since: Optional[str] = None,
    company_name: Optional[str] = None,
    limit: int = 100,
) -> list[sqlite3.Row]:
    clauses: list[str] = []
    params: list = []
    if event_types:
        placeholders = ", ".join("?" for _ in event_types)
        clauses.append(f"event_type IN ({placeholders})")
        params.extend(event_types)
    if since:
        clauses.append("detected_at >= ?")
        params.append(since)
    if company_name:
        clauses.append("company_name LIKE ?")
        params.append(f"%{company_name}%")
    where = ("WHERE " + " AND ".join(clauses)) if clauses else ""
    with get_connection() as conn:
        return conn.execute(
            f"SELECT * FROM activity_events {where} ORDER BY detected_at DESC LIMIT ?",
            (*params, limit),
        ).fetchall()


def get_lead_activity_summary(lead_id: str) -> dict:
    with get_connection() as conn:
        row = conn.execute(
            "SELECT COUNT(*) AS cnt, MAX(detected_at) AS latest FROM activity_events WHERE lead_id = ?",
            (lead_id,),
        ).fetchone()
    if not row or not row["cnt"]:
        return {"count": 0, "latest_detected_at": None, "has_recent_24h": False}
    from datetime import datetime, timedelta, timezone
    latest = row["latest"]
    has_recent = False
    if latest:
        try:
            cutoff = (datetime.now(timezone.utc) - timedelta(hours=24)).isoformat(timespec="seconds")
            has_recent = latest >= cutoff
        except Exception:
            pass
    return {"count": row["cnt"], "latest_detected_at": latest, "has_recent_24h": has_recent}


def get_batch_activity_summaries(lead_ids: list[str]) -> dict[str, dict]:
    if not lead_ids:
        return {}
    placeholders = ", ".join("?" for _ in lead_ids)
    with get_connection() as conn:
        rows = conn.execute(
            f"SELECT lead_id, COUNT(*) AS cnt, MAX(detected_at) AS latest FROM activity_events "
            f"WHERE lead_id IN ({placeholders}) GROUP BY lead_id",
            lead_ids,
        ).fetchall()
    from datetime import datetime, timedelta, timezone
    cutoff = (datetime.now(timezone.utc) - timedelta(hours=24)).isoformat(timespec="seconds")
    result: dict[str, dict] = {}
    for row in rows:
        latest = row["latest"]
        result[row["lead_id"]] = {
            "count": row["cnt"],
            "latest_detected_at": latest,
            "has_recent_24h": bool(latest and latest >= cutoff),
        }
    return result


def list_due_dg_refreshes(now_iso: str, limit: int = 20) -> list[sqlite3.Row]:
    """Leads with a Companies House number that are due (or not yet scheduled)
    for a Companies House activity refresh."""
    with get_connection() as conn:
        return conn.execute(
            """SELECT * FROM leads
               WHERE company_number IS NOT NULL
               AND (next_dg_refresh_at IS NULL OR next_dg_refresh_at <= ?)
               ORDER BY next_dg_refresh_at ASC NULLS FIRST
               LIMIT ?""",
            (now_iso, limit),
        ).fetchall()


def update_lead_dg_refresh(lead_id: str, tier: str, next_refresh_at: str, last_refreshed_at: str) -> None:
    with get_connection() as conn:
        conn.execute(
            "UPDATE leads SET refresh_tier = ?, next_dg_refresh_at = ?, last_dg_refreshed_at = ? WHERE id = ?",
            (tier, next_refresh_at, last_refreshed_at, lead_id),
        )


# --- win-back campaigns ---

def create_win_back_campaign(
    id: str, name: str, created_by: str, total: int, created_at: str,
    lead_ids_json: Optional[str] = None, depth: str = "standard", email_instruction: str = "",
    offer_context: str = "", additional_context: str = "", campaign_links: str = "", campaign_link_text: str = "", signature: str = "",
    source_rows_json: str = "",
) -> None:
    with get_connection() as conn:
        conn.execute(
            "INSERT INTO win_back_campaigns (id, name, created_by, status, total, generated, created_at, lead_ids, depth, email_instruction, offer_context, additional_context, campaign_links, campaign_link_text, signature, source_rows_json) "
            "VALUES (?, ?, ?, 'generating', ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (id, name, created_by, total, created_at, lead_ids_json, depth, email_instruction, offer_context, additional_context, campaign_links, campaign_link_text, signature, source_rows_json),
        )


def get_win_back_campaigns(user_id: str) -> list[sqlite3.Row]:
    with get_connection() as conn:
        return conn.execute(
            "SELECT * FROM win_back_campaigns WHERE created_by = ? ORDER BY created_at DESC",
            (user_id,),
        ).fetchall()


def get_win_back_campaign(campaign_id: str) -> Optional[sqlite3.Row]:
    with get_connection() as conn:
        return conn.execute(
            "SELECT * FROM win_back_campaigns WHERE id = ?", (campaign_id,)
        ).fetchone()


def get_win_back_emails(campaign_id: str) -> list[sqlite3.Row]:
    """Returns win_back_emails joined with lead contact info, ONE row per lead —
    the most recently generated email for that lead. A CSV that lists the same
    company on several rows could generate several emails for one lead; keeping
    only the latest here means the detail view, the count, and the Mailchimp
    export all show/send a single email per company."""
    with get_connection() as conn:
        return conn.execute(
            """SELECT we.*, l.company, l.contact_name, l.contact_title,
                      (SELECT e.email FROM lead_emails e WHERE e.lead_id = l.id ORDER BY e.created_at LIMIT 1) AS contact_email
               FROM win_back_emails we
               JOIN leads l ON l.id = we.lead_id
               WHERE we.campaign_id = ?
                 AND we.id = (
                     SELECT we2.id FROM win_back_emails we2
                     WHERE we2.campaign_id = we.campaign_id AND we2.lead_id = we.lead_id
                     ORDER BY we2.created_at DESC, we2.id DESC LIMIT 1
                 )
               ORDER BY we.created_at""",
            (campaign_id,),
        ).fetchall()


def count_win_back_emails(campaign_id: str) -> int:
    """Number of DISTINCT leads that have an email — the truthful 'generated'
    count. Counting distinct leads (not rows) means duplicate emails for one
    company can't inflate it, and a run stopped at the credit ceiling can't read
    a full 'X of X' (the stored progress column used to advance even for skipped
    leads)."""
    with get_connection() as conn:
        row = conn.execute(
            "SELECT COUNT(DISTINCT lead_id) AS n FROM win_back_emails WHERE campaign_id = ?",
            (campaign_id,),
        ).fetchone()
        return row["n"] if row else 0


def get_prior_win_back_emails_for_lead(
    lead_id: str, exclude_campaign_id: Optional[str] = None, limit: int = 3
) -> list[sqlite3.Row]:
    """Win-back emails already generated for this lead in OTHER campaigns, most
    recent first. Feeds the next campaign's writer the earlier emails so it does
    not repeat the same subject, opening or hook.

    Deliberately NOT gated on send_status = 'sent': the Mailchimp export path (a
    primary way campaigns go out) never marks its emails 'sent', so filtering on
    that would hide almost every genuine prior send. An email generated for an
    earlier campaign is, in practice, one the contact received — and even for a
    draft that was never sent, steering the new email to a fresh angle costs
    nothing. The current campaign is excluded so a lead's own in-progress email
    is never fed back to itself."""
    with get_connection() as conn:
        return conn.execute(
            """SELECT campaign_id, subject, body, send_status, sent_at, created_at
               FROM win_back_emails
               WHERE lead_id = ?
                 AND (? IS NULL OR campaign_id != ?)
               ORDER BY COALESCE(sent_at, created_at) DESC, id DESC
               LIMIT ?""",
            (lead_id, exclude_campaign_id, exclude_campaign_id, limit),
        ).fetchall()


def upsert_win_back_email(campaign_id: str, lead_id: str, email_id: str, subject: str, body: str, created_at: str) -> None:
    """One email per (campaign, lead). Any existing email for this lead in this
    campaign is replaced, so regenerating a lead never stacks a second row (the
    old INSERT used a fresh id and the ON CONFLICT(id) never fired, which is how
    a company ended up with several drafts)."""
    with get_connection() as conn:
        conn.execute(
            "DELETE FROM win_back_emails WHERE campaign_id = ? AND lead_id = ?",
            (campaign_id, lead_id),
        )
        conn.execute(
            """INSERT INTO win_back_emails (id, campaign_id, lead_id, subject, body, send_status, created_at)
               VALUES (?, ?, ?, ?, ?, 'draft', ?)""",
            (email_id, campaign_id, lead_id, subject, body, created_at),
        )


def update_win_back_campaign_progress(campaign_id: str, generated: int, status: str) -> None:
    with get_connection() as conn:
        conn.execute(
            "UPDATE win_back_campaigns SET generated = ?, status = ? WHERE id = ?",
            (generated, status, campaign_id),
        )


def mark_win_back_email_sent(email_id: str, method: str, sent_at: str) -> None:
    with get_connection() as conn:
        conn.execute(
            "UPDATE win_back_emails SET send_status = 'sent', send_method = ?, sent_at = ? WHERE id = ?",
            (method, sent_at, email_id),
        )


# ---------------------------------------------------------------------------
# List Email Campaigns (per-lead drafts live in email_drafts, tagged campaign_id)
# ---------------------------------------------------------------------------


def create_list_campaign(
    id: str, list_id: str, owner_user_id: str, name: str, idea: str, offers: str,
    link_url: str, link_text: str, signature: str, total_target: int, created_at: str,
) -> None:
    with get_connection() as conn:
        conn.execute(
            """INSERT INTO list_email_campaigns
               (id, list_id, owner_user_id, name, idea, offers, link_url, link_text,
                signature, status, total_target, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'generating', ?, ?, ?)""",
            (id, list_id, owner_user_id, name, idea, offers, link_url, link_text,
             signature, total_target, created_at, created_at),
        )


def get_list_campaign(campaign_id: str) -> Optional[sqlite3.Row]:
    with get_connection() as conn:
        return conn.execute(
            "SELECT * FROM list_email_campaigns WHERE id = ?", (campaign_id,)
        ).fetchone()


def list_list_campaigns(owner_user_id: str) -> list[sqlite3.Row]:
    with get_connection() as conn:
        return conn.execute(
            "SELECT * FROM list_email_campaigns WHERE owner_user_id = ? ORDER BY created_at DESC",
            (owner_user_id,),
        ).fetchall()


def update_list_campaign_status(campaign_id: str, status: str, updated_at: str) -> None:
    with get_connection() as conn:
        conn.execute(
            "UPDATE list_email_campaigns SET status = ?, updated_at = ? WHERE id = ?",
            (status, updated_at, campaign_id),
        )


def count_list_campaign_drafts(campaign_id: str) -> int:
    """DISTINCT leads with a draft in this campaign — the truthful 'generated'
    count, unaffected by any accidental duplicate draft for one lead."""
    with get_connection() as conn:
        row = conn.execute(
            "SELECT COUNT(DISTINCT lead_id) AS n FROM email_drafts WHERE campaign_id = ?",
            (campaign_id,),
        ).fetchone()
        return row["n"] if row else 0


def list_campaign_drafts(campaign_id: str) -> list[sqlite3.Row]:
    """This campaign's drafts joined with each lead's contact info + status, one
    row per draft, ordered by the lead's status then company for grouping."""
    with get_connection() as conn:
        return conn.execute(
            """SELECT ed.*, l.company, l.contact_name, l.contact_status,
                      (SELECT e.email FROM lead_emails e WHERE e.lead_id = l.id
                       ORDER BY e.created_at LIMIT 1) AS contact_email
               FROM email_drafts ed
               JOIN leads l ON l.id = ed.lead_id
               WHERE ed.campaign_id = ?
               ORDER BY l.contact_status, l.company, ed.created_at""",
            (campaign_id,),
        ).fetchall()


def list_campaign_lead_ids_without_draft(campaign_id: str, list_id: str) -> list[str]:
    """Leads on the campaign's list that have no draft yet — used by resume to
    fill only the leads a credit-stopped run never reached."""
    with get_connection() as conn:
        rows = conn.execute(
            """SELECT l.id FROM leads l
               WHERE l.list_id = ?
                 AND NOT EXISTS (
                     SELECT 1 FROM email_drafts ed
                     WHERE ed.campaign_id = ? AND ed.lead_id = l.id
                 )""",
            (list_id, campaign_id),
        ).fetchall()
        return [r["id"] for r in rows]


# ---------------------------------------------------------------------------
# Credit tracking
# ---------------------------------------------------------------------------

CREDIT_FEATURES = ["phone_lookup", "sales_intel", "win_back", "ai_prospecting", "email_writer", "enrichment", "lead_chat", "linkedin_scrape", "linkedin_discovery"]

# Approximate cost per operation (GBP) — used for limit enforcement checks.
# linkedin_scrape's actual spend is variable (Apify bills per post, not per
# call) — this is a conservative pre-flight estimate for a ~10-post fetch;
# the real cost is computed and recorded after each fetch completes.
# linkedin_discovery only ever costs money on its AI-search fallback step —
# the website-scrape route it tries first is free and never charged.
CREDIT_COST = {
    "phone_lookup": 0.03,
    "sales_intel": 0.15,
    # Flat ~$0.20 per generated win-back email, expressed in GBP: £0.16 at
    # ~$1.25/£. Deliberately covers the WHOLE per-email pipeline — research
    # (sales intelligence), the LinkedIn scrape, and the email write — which
    # win_back.py folds into this single charge instead of recording
    # sales_intel / linkedin_scrape separately, so the cost per generated
    # email is an exact, predictable figure and nothing else. Real underlying
    # API/Apify cost sits well under this (~£0.07-0.10), so it's a safe fixed
    # ceiling with margin, not a metered figure. If the USD/GBP rate drifts,
    # adjust this one number.
    "win_back": 0.16,
    "ai_prospecting": 0.15,
    "email_writer": 0.03,
    "enrichment": 0.05,
    "lead_chat": 0.02,
    "linkedin_scrape": 0.02,
    "linkedin_discovery": 0.03,
}

# Per-user monthly ceilings applied when the admin hasn't set an explicit
# limit. Nothing is ever unlimited — a runaway user or bug on a shared API
# key must always hit a ceiling. Admins raise these per user in Settings.
DEFAULT_CREDIT_LIMIT_GBP = {
    "phone_lookup": 20.0,
    "sales_intel": 20.0,
    # Raised to cover a large single-campaign run: at £0.16/email this is
    # ~1560 emails/month (a 1149-lead campaign = ~£184). Win-back is
    # admin-only, so this higher ceiling only ever applies to admins. Note
    # this DEFAULT is overridden by any explicit per-user limit set in
    # Settings → Credit Limits — if an admin has an old £20 override there,
    # they must raise it too.
    "win_back": 250.0,
    "ai_prospecting": 50.0,
    "email_writer": 20.0,
    "enrichment": 20.0,
    "lead_chat": 10.0,
    "linkedin_scrape": 15.0,
    "linkedin_discovery": 10.0,
}


def record_credit_spend(spend_id: str, user_id: str, feature: str, amount_gbp: float, created_at: str) -> None:
    with get_connection() as conn:
        conn.execute(
            "INSERT INTO credit_usage (id, user_id, feature, amount_gbp, created_at) VALUES (?, ?, ?, ?, ?)",
            (spend_id, user_id, feature, amount_gbp, created_at),
        )


def get_monthly_credit_spend(user_id: str) -> dict:
    month_start = datetime.now().strftime("%Y-%m-01T00:00:00")
    with get_connection() as conn:
        rows = conn.execute(
            "SELECT feature, SUM(amount_gbp) as total FROM credit_usage WHERE user_id = ? AND created_at >= ? GROUP BY feature",
            (user_id, month_start),
        ).fetchall()
    return {row["feature"]: row["total"] for row in rows}


def get_user_setting(user_id: str, key: str, default: str = "") -> str:
    with get_connection() as conn:
        row = conn.execute(
            "SELECT value FROM user_settings WHERE user_id = ? AND key = ?",
            (user_id, key),
        ).fetchone()
    return row["value"] if row else default


def set_user_setting(user_id: str, key: str, value: str, updated_at: str) -> None:
    with get_connection() as conn:
        conn.execute(
            "INSERT OR REPLACE INTO user_settings (user_id, key, value, updated_at) VALUES (?, ?, ?, ?)",
            (user_id, key, value, updated_at),
        )


def get_all_user_settings(user_id: str) -> dict:
    with get_connection() as conn:
        rows = conn.execute(
            "SELECT key, value FROM user_settings WHERE user_id = ?", (user_id,)
        ).fetchall()
    return {row["key"]: row["value"] for row in rows}


def check_credit_limit(user_id: str, feature: str) -> tuple[bool, float, float]:
    """Returns (allowed, spent_this_month, limit). An unset/zero limit falls
    back to the feature's default ceiling — never unlimited, since every call
    spends on the org's shared API keys."""
    limit_str = get_user_setting(user_id, f"limit_{feature}", "0")
    try:
        limit = float(limit_str)
    except (ValueError, TypeError):
        limit = 0.0
    if limit <= 0:
        limit = DEFAULT_CREDIT_LIMIT_GBP.get(feature, 20.0)
    spend = get_monthly_credit_spend(user_id).get(feature, 0.0)
    cost = CREDIT_COST.get(feature, 0.0)
    allowed = (spend + cost) <= limit
    return allowed, spend, limit


# ---------------------------------------------------------------------------
# CH Charge Feed
# ---------------------------------------------------------------------------

def get_stream_state(key: str) -> Optional[str]:
    with get_connection() as conn:
        row = conn.execute("SELECT value FROM ch_stream_state WHERE key = ?", (key,)).fetchone()
        return row["value"] if row else None


def set_stream_state(key: str, value: str) -> None:
    with get_connection() as conn:
        conn.execute(
            "INSERT INTO ch_stream_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            (key, value),
        )


def prune_ch_charge_feed(max_age_days: int = 30) -> int:
    """Delete feed events older than the retention window (except ones that
    were promoted to leads). The stream inserts thousands of rows a day, so
    without pruning this table grows unboundedly."""
    cutoff = (datetime.now() - timedelta(days=max_age_days)).strftime("%Y-%m-%dT%H:%M:%S")
    with get_connection() as conn:
        cur = conn.execute(
            "DELETE FROM ch_charge_feed WHERE detected_at < ? AND lead_id IS NULL", (cutoff,)
        )
        return cur.rowcount


def save_ch_charge(event: dict) -> bool:
    """Insert a charge feed event. Returns True if inserted (False if duplicate)."""
    with get_connection() as conn:
        try:
            conn.execute(
                """INSERT INTO ch_charge_feed
                   (id, company_number, company_name, filing_type, charge_description,
                    filing_date, transaction_id, event_data, detected_at, lead_id)
                   VALUES (:id, :company_number, :company_name, :filing_type, :charge_description,
                           :filing_date, :transaction_id, :event_data, :detected_at, NULL)""",
                event,
            )
            return True
        except sqlite3.IntegrityError:
            return False


def list_ch_charges(
    company_name: Optional[str] = None,
    filing_types: Optional[list] = None,
    since: Optional[str] = None,
    not_added: bool = False,
    limit: int = 200,
    offset: int = 0,
) -> list:
    clauses = []
    params: list = []
    if company_name:
        clauses.append("(company_name LIKE ? OR company_number LIKE ?)")
        q = f"%{company_name}%"
        params.extend([q, q])
    if filing_types:
        placeholders = ",".join("?" * len(filing_types))
        clauses.append(f"filing_type IN ({placeholders})")
        params.extend(filing_types)
    if since:
        clauses.append("detected_at >= ?")
        params.append(since)
    if not_added:
        clauses.append("lead_id IS NULL")
    where = f"WHERE {' AND '.join(clauses)}" if clauses else ""
    with get_connection() as conn:
        return conn.execute(
            f"SELECT * FROM ch_charge_feed {where} ORDER BY detected_at DESC LIMIT ? OFFSET ?",
            (*params, limit, offset),
        ).fetchall()


def get_ch_charge(charge_id: str) -> Optional[sqlite3.Row]:
    with get_connection() as conn:
        return conn.execute("SELECT * FROM ch_charge_feed WHERE id = ?", (charge_id,)).fetchone()


def mark_ch_charge_added(charge_id: str, lead_id: str) -> None:
    with get_connection() as conn:
        conn.execute("UPDATE ch_charge_feed SET lead_id = ? WHERE id = ?", (lead_id, charge_id))


def get_company_name_from_leads(company_number: str) -> Optional[str]:
    with get_connection() as conn:
        row = conn.execute(
            "SELECT company FROM leads WHERE company_number = ? LIMIT 1", (company_number,)
        ).fetchone()
        return row["company"] if row else None
