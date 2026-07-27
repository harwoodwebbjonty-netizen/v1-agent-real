import logging
import shutil
import sqlite3
from contextlib import contextmanager
from datetime import datetime, timedelta
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
    """DataGardener-powered activity feed. Append-only snapshots + structured
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
]
CURRENT_SCHEMA_VERSION = 24


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
    try:
        yield conn
        conn.commit()
    finally:
        conn.close()


# --- users ---

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


# --- leads ---

def _find_existing_lead_in_conn(conn: sqlite3.Connection, company_number: Optional[str], company_name: str) -> Optional[sqlite3.Row]:
    if company_number:
        row = conn.execute("SELECT * FROM leads WHERE company_number = ?", (company_number,)).fetchone()
        if row:
            return row
    return conn.execute(
        "SELECT * FROM leads WHERE LOWER(TRIM(company)) = LOWER(TRIM(?))", (company_name,)
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
               (id, timestamp, company, phone_number, source_url, status, notes,
                industry, contact_status, lead_notes, owner_user_id, assigned_user_id, list_id, company_number, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, '', 'New', '', ?, NULL, ?, ?, ?, ?)""",
            (id, timestamp, company, phone_number, source_url, status, notes, owner_user_id, list_id, company_number, created_at, created_at),
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

        # Re-parent child records (IGNORE handles unique constraint conflicts)
        conn.execute("UPDATE OR IGNORE lead_phones SET lead_id = ? WHERE lead_id = ?", (winner_id, loser_id))
        conn.execute("DELETE FROM lead_phones WHERE lead_id = ?", (loser_id,))
        conn.execute("UPDATE OR IGNORE lead_emails SET lead_id = ? WHERE lead_id = ?", (winner_id, loser_id))
        conn.execute("DELETE FROM lead_emails WHERE lead_id = ?", (loser_id,))
        for table in ("lead_intelligence_versions", "call_logs", "email_drafts", "sequence_enrollments"):
            conn.execute(f"UPDATE {table} SET lead_id = ? WHERE lead_id = ?", (winner_id, loser_id))
        conn.execute("UPDATE calendar_events SET lead_id = ? WHERE lead_id = ?", (winner_id, loser_id))
        conn.execute("UPDATE activity_events SET lead_id = ? WHERE lead_id = ?", (winner_id, loser_id))
        conn.execute("DELETE FROM lead_intelligence_locks WHERE lead_id = ?", (loser_id,))
        conn.execute("DELETE FROM leads WHERE id = ?", (loser_id,))


def list_leads(list_id: Optional[str] = None) -> list[sqlite3.Row]:
    with get_connection() as conn:
        if list_id is None:
            return conn.execute("SELECT * FROM leads WHERE list_id IS NULL ORDER BY timestamp").fetchall()
        return conn.execute("SELECT * FROM leads WHERE list_id = ? ORDER BY timestamp", (list_id,)).fetchall()


def list_all_leads_for_user(user_id: str, is_admin: bool) -> list[sqlite3.Row]:
    """Returns all leads visible to the user: shared pool + their own cold-call-list leads.
    Admins see every lead from every list. Includes list_name via LEFT JOIN."""
    with get_connection() as conn:
        if is_admin:
            return conn.execute(
                "SELECT l.*, ll.name AS list_name FROM leads l "
                "LEFT JOIN lead_lists ll ON l.list_id = ll.id ORDER BY l.timestamp"
            ).fetchall()
        return conn.execute(
            "SELECT l.*, ll.name AS list_name FROM leads l "
            "LEFT JOIN lead_lists ll ON l.list_id = ll.id "
            "WHERE l.list_id IS NULL OR l.owner_user_id = ? ORDER BY l.timestamp",
            (user_id,),
        ).fetchall()


def get_lead(lead_id: str) -> Optional[sqlite3.Row]:
    with get_connection() as conn:
        return conn.execute("SELECT * FROM leads WHERE id = ?", (lead_id,)).fetchone()


def update_lead_fields(lead_id: str, fields: dict, updated_at: str) -> None:
    if not fields:
        return
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
               ORDER BY ed.updated_at DESC""",
            (owner_user_id,),
        ).fetchall()


def get_email_draft(draft_id: str) -> Optional[sqlite3.Row]:
    with get_connection() as conn:
        return conn.execute("SELECT * FROM email_drafts WHERE id = ?", (draft_id,)).fetchone()


def update_email_draft_fields(draft_id: str, fields: dict, updated_at: str) -> None:
    if not fields:
        return
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


# --- DataGardener activity feed (append-only snapshots + structured change events) ---

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
    for a DataGardener refresh."""
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
