import logging
import shutil
import sqlite3
from contextlib import contextmanager
from datetime import datetime
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


# Ordered (version, migration_fn) pairs. Append new entries here for future
# schema changes — never edit or remove an existing entry once released.
MIGRATIONS: list[tuple[int, Callable[[sqlite3.Connection], None]]] = [
    (1, _migration_001_baseline),
    (2, _migration_002_call_logs),
    (3, _migration_003_opportunity_stage),
    (4, _migration_004_sequences),
    (5, _migration_005_presence),
]
CURRENT_SCHEMA_VERSION = 5


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


def create_user(id: str, name: str, role: str, created_at: str) -> None:
    with get_connection() as conn:
        conn.execute(
            "INSERT INTO users (id, name, role, created_at) VALUES (?, ?, ?, ?)",
            (id, name, role, created_at),
        )


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
) -> None:
    with get_connection() as conn:
        conn.execute(
            """INSERT INTO leads
               (id, timestamp, company, phone_number, source_url, status, notes,
                industry, contact_status, lead_notes, owner_user_id, assigned_user_id, list_id, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, '', 'New', '', ?, NULL, ?, ?, ?)""",
            (id, timestamp, company, phone_number, source_url, status, notes, owner_user_id, list_id, created_at, created_at),
        )


def list_leads(list_id: Optional[str] = None) -> list[sqlite3.Row]:
    with get_connection() as conn:
        if list_id is None:
            return conn.execute("SELECT * FROM leads WHERE list_id IS NULL ORDER BY timestamp").fetchall()
        return conn.execute("SELECT * FROM leads WHERE list_id = ? ORDER BY timestamp", (list_id,)).fetchall()


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
