# Stage 0 Implementation Spec — Critical Stabilisation

Derived from `audit/08-prioritised-roadmap.md` Stage 0. Repo: `/Users/jontyhw/v1 agent` · Base commit: `8c923ac5e703928e3f94721e6c11593a5c397f7d`

Scope is strictly the three Stage 0 items — DB backup/growth diagnosis, OAuth token encryption, basic observability. No Stage 1+ (tenant isolation, self-serve signup, billing) is touched. This document is a spec, not a diff — no code has been written yet.

---

## 0. Correction to the original audit — read this first

While researching this spec directly against the current code (a prior research subagent for this task hit a session limit mid-run and was restarted manually), I found something that changes the shape of item 1:

**`db.py` already takes automatic backups — just not on the cadence the audit assumed.** `db.init_db()` (`backend/app/db.py:871-894`) calls `backup_database()` (`db.py:817-829`) **only when a schema migration is about to run** (`current < target` at line 883) — validates the backup before proceeding, aborts the migration if validation fails. This is real, working, well-tested (`backend/tests/test_db_migrations.py` covers it directly: `test_backup_created_when_migration_runs_then_skipped_when_up_to_date`, `test_restore_round_trip`, `test_corrupt_backup_rejected`). Retention is `BACKUP_RETENTION_COUNT = 10` (`db.py:16`), uncompressed, in `backend/data/backups/`.

This exactly explains what the audit observed on the VPS: 10 backup files, irregular dates, no `.gz` extension, nothing in the last 5 days — because the last 5 days had no deploy that bumped `CURRENT_SCHEMA_VERSION`. **It is not a manual/ad hoc mechanism as the audit inferred — it's automatic, but only fires on schema changes, never on an ordinary restart or during weeks of pure runtime.** `backend/deploy/backup.sh` (cron-intended, gzip'd, `KEEP=14`) was written specifically to fill that gap and was never installed. The fix in §1 below is narrower than "add backups from scratch" — it's "install the complementary calendar-based mechanism that was always meant to sit alongside the existing migration-triggered one."

**A specific, plausible root cause for the DB growth surfaced too.** `ch_stream_service.py`'s prune loop (`_prune_loop`, lines 260-270) only logs when it actually deletes something (`if deleted: logger.info(...)`) — and `journalctl -u phone-lookup-backend --since '30 days ago'` shows **zero** "CH feed: pruned" and zero "CH feed prune failed" lines in the last 30 days. `prune_ch_charge_feed()` (`db.py:2685-2694`) only deletes rows where `detected_at < cutoff AND lead_id IS NULL` — it deliberately never prunes an event once it's been promoted to a real lead. If most incoming filing events get matched to an existing lead by `company_number` (which is the whole point of the feed), **every one of those rows is permanently exempt from pruning by design**, and the table grows without bound as the stream keeps ingesting — not a bug, but a design gap the throttle fix didn't address. This is still **Inferred, not Confirmed** (the exact row-count split needs a query this environment blocked me from running directly — see §1.2), but it's now a specific, testable hypothesis rather than a vague "probably the CH feed."

---

## 1. DB backup automation + growth diagnosis

### 1.1 Install the existing cron script (no code change — an ops step)

`backend/deploy/backup.sh` is complete and correct as written — reviewed in full, no changes needed to the script itself. It needs to actually be installed, which per its own header is a manual step and, consistent with this repo's established pattern (`CLAUDE.md`: backend deploys and VPS changes are always handed to the user, never run by Claude in auto mode), should be run by you, not automated by me:

```
ssh -i ~/.ssh/v1_agent_vps root@213.165.88.45 "chmod +x /opt/v1-agent/backend/deploy/backup.sh && (crontab -l 2>/dev/null; echo '30 2 * * * /opt/v1-agent/backend/deploy/backup.sh >> /opt/v1-agent/backend/data/backups/backup.log 2>&1') | crontab -"
```

Run as `root` (matches the systemd service's `appuser` ownership of `backend/data/` — `backup.sh` writes into that same directory, and root has permission to write there; confirm with `ls -la /opt/v1-agent/backend/data/backups/` after the first run that the new `.gz` files are readable/writable as expected — if permission issues appear, install under `crontab -u appuser -e` instead using the same line).

**Note the two retention counts are independent and will now coexist**: the Python migration-triggered mechanism keeps 10 uncompressed snapshots; the new cron mechanism keeps 14 compressed nightly snapshots (`KEEP=14` in the script). Not worth unifying in Stage 0 — they serve different purposes (one is a pre-risky-change safety net, the other is calendar coverage) and unifying them is a Stage 1+-scale refactor for a P3 cleanup, not a blocker.

**Verify** (7 days after install): `ssh ... "ls -la /opt/v1-agent/backend/data/backups/*.gz | tail -7"` shows 7 new dated `.gz` files, and `cat /opt/v1-agent/backend/data/backups/backup.log` shows no errors.

### 1.2 Growth diagnosis (needs your explicit sign-off to run against production data)

This environment's own permission controls blocked a direct read-only `SELECT`/`PRAGMA` against the production DB twice during the original audit. The queries below are genuinely read-only (no `sqlite3 -readonly` write risk), but per this repo's own standing rule, I'm handing them to you rather than trying a third time:

```
ssh -i ~/.ssh/v1_agent_vps root@213.165.88.45 "sqlite3 -readonly /opt/v1-agent/backend/data/team.db \"
SELECT 'ch_charge_feed total' AS label, COUNT(*) FROM ch_charge_feed
UNION ALL SELECT 'ch_charge_feed with lead_id (never pruned)', COUNT(*) FROM ch_charge_feed WHERE lead_id IS NOT NULL
UNION ALL SELECT 'ch_charge_feed without lead_id (prunable)', COUNT(*) FROM ch_charge_feed WHERE lead_id IS NULL
UNION ALL SELECT 'activity_events', COUNT(*) FROM activity_events
UNION ALL SELECT 'company_snapshots', COUNT(*) FROM company_snapshots
UNION ALL SELECT 'lead_intelligence_versions', COUNT(*) FROM lead_intelligence_versions
UNION ALL SELECT 'audit_log', COUNT(*) FROM audit_log
UNION ALL SELECT 'total_db_bytes', (SELECT page_count * page_size FROM pragma_page_count(), pragma_page_size());
\""
```

**If the hypothesis in §0 is confirmed** (a large majority of `ch_charge_feed` rows have `lead_id IS NOT NULL` and the table's row count is in the hundreds of thousands+), the fix is a small, targeted change to `prune_ch_charge_feed()` (`db.py:2685-2694`) — add a *second*, longer retention window for promoted rows (e.g. prune `lead_id IS NOT NULL` rows after 180 days instead of never), not a redesign. **This specific fix is explicitly out of scope for this Stage 0 spec** per your instruction not to touch beyond Stage 0 — flagging it here as the likely, cheap Stage-0.5/Stage-1 follow-up once §1.2's query confirms or rules it out, rather than guessing further without the data.

---

## 2. OAuth token encryption at rest

### 2.1 New dependency

Add to `backend/requirements.txt`:
```
cryptography>=42
```
No existing crypto library is present (`requirements.txt` currently has no `cryptography`/`pynacl`/equivalent — confirmed by direct read). `cryptography`'s `Fernet` is the right tool: authenticated symmetric encryption, one key, simple `encrypt(bytes) -> bytes` / `decrypt(bytes) -> bytes` API, no IV/nonce management needed (Fernet handles that internally). Picked over rolling AES-GCM by hand because Fernet is misuse-resistant by design and this is exactly the kind of place where a hand-rolled crypto mistake would be worse than the plaintext-storage problem it's fixing.

### 2.2 New setting

`backend/app/core/config.py` — add one field to `Settings`, following the exact existing pattern for `anthropic_api_key` (required, no default — the app should refuse to start rather than silently run with an unset encryption key):

```python
    # Symmetric key (Fernet, urlsafe-base64, 32 raw bytes) encrypting OAuth
    # access/refresh tokens at rest in email_oauth_accounts. Generate with:
    #   python3 -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())"
    # Required — no default — matching anthropic_api_key: the app must not
    # start with tokens unprotected. Rotating this key requires re-encrypting
    # every existing row first (see migration 032); losing it makes every
    # connected email account's stored token permanently unrecoverable
    # (each user must simply reconnect — it is not a data-loss event for
    # anything else in the database).
    token_encryption_key: str
```

`backend/.env.example` — add, mirroring the existing comment style:
```
# Encrypts stored Gmail/Microsoft OAuth tokens at rest. Generate with:
#   python3 -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())"
# Required — the backend will not start without this set.
TOKEN_ENCRYPTION_KEY=
```

### 2.3 New module: `backend/app/services/token_crypto.py`

A small, self-contained helper (naming matches existing thin utility modules like `email_format.py`, `template_variables.py` — not suffixed `_service.py` since it has no I/O or business logic of its own):

```python
from cryptography.fernet import Fernet, InvalidToken
from app.core.config import get_settings

_ENC_PREFIX = "enc:v1:"  # marks an already-encrypted value so the migration
                          # and any mixed-state read during rollout can tell
                          # it apart from legacy plaintext without guessing.

def _fernet() -> Fernet:
    return Fernet(get_settings().token_encryption_key.encode())

def encrypt_token(plaintext: str) -> str:
    if not plaintext:
        return plaintext  # empty refresh_token stays empty, never encrypted
    return _ENC_PREFIX + _fernet().encrypt(plaintext.encode()).decode()

def decrypt_token(value: str) -> str:
    if not value or not value.startswith(_ENC_PREFIX):
        return value  # not yet encrypted (shouldn't happen post-migration,
                       # but fail open to plaintext rather than crash a send)
    try:
        return _fernet().decrypt(value[len(_ENC_PREFIX):].encode()).decode()
    except InvalidToken:
        raise OAuthError("Stored email credentials could not be decrypted — the account needs reconnecting.")
```

(`OAuthError` imported from `email_oauth_service.py` — or define a local exception and let `email_oauth_service.py` catch/re-raise as `OAuthError`, to avoid a circular import since `email_oauth_service.py` will import `token_crypto.py`, not the reverse.)

### 2.4 Changes to `email_oauth_service.py` — the only file with call-site changes

Verified by grep: **no file other than `email_oauth_service.py` ever reads `account_row["access_token"]` or `account_row["refresh_token"]`** — every other caller (`win_back.py` ×3, `list_campaigns.py`, `email_writer.py` ×2, `sequences_service.py`) fetches an opaque `account_row` via `db.get_email_oauth_account(...)` and passes it straight into `send_email()`/nothing else touches the token fields directly. This means the encryption boundary is fully contained to three functions in one file:

1. **`handle_oauth_callback`** (`email_oauth_service.py:106-...`) — wrap before the `db.upsert_email_oauth_account(...)` call:
   ```python
   db.upsert_email_oauth_account(
       new_id(), user_id, provider, email_address,
       encrypt_token(tokens["access_token"]),
       encrypt_token(tokens.get("refresh_token", "")),
       expires_at, now_iso(),
   )
   ```
2. **`refresh_token_if_needed`** — decrypt on both read paths, encrypt on the write path:
   ```python
   async def refresh_token_if_needed(account_row) -> str:
       expires_at = datetime.fromisoformat(account_row["token_expires_at"])
       if datetime.now(timezone.utc) < expires_at:
           return decrypt_token(account_row["access_token"])
       ...
       response = await client.post(..., data={"refresh_token": decrypt_token(account_row["refresh_token"]), ...})
       ...
       db.update_email_oauth_tokens(account_row["user_id"], provider, encrypt_token(tokens["access_token"]), new_expires_at, now_iso())
       return tokens["access_token"]  # plaintext — this is the in-memory value about to be used immediately by send_email, never re-read from the DB this call
   ```
3. Add `from app.services.token_crypto import encrypt_token, decrypt_token` to the imports.

`send_email()` itself needs **no change** — it only ever receives the already-decrypted `access_token` string returned by `refresh_token_if_needed`.

### 2.5 Migration 032 — re-encrypt existing plaintext rows

Follows the exact shape of migration 031 (`db.py:619-658`, inline import pattern, idempotent, no destructive ALTER). Appended after `_migration_031_roles`, before the `MIGRATIONS` list:

```python
def _migration_032_encrypt_oauth_tokens(conn: sqlite3.Connection) -> None:
    """Re-encrypts any plaintext access_token/refresh_token left over from
    before Fernet encryption was added (audit F-04 / Stage 0). Idempotent —
    the enc:v1: prefix marks already-encrypted values, so re-running this
    migration (it never re-runs once schema_version advances, but the guard
    is cheap insurance) is a safe no-op on rows already migrated."""
    from app.services.token_crypto import encrypt_token
    rows = conn.execute("SELECT id, access_token, refresh_token FROM email_oauth_accounts").fetchall()
    for row in rows:
        if row["access_token"].startswith("enc:v1:") and (not row["refresh_token"] or row["refresh_token"].startswith("enc:v1:")):
            continue
        conn.execute(
            "UPDATE email_oauth_accounts SET access_token = ?, refresh_token = ? WHERE id = ?",
            (encrypt_token(row["access_token"]), encrypt_token(row["refresh_token"]), row["id"]),
        )
```

Register: `(32, _migration_032_encrypt_oauth_tokens),` appended to `MIGRATIONS`, and `CURRENT_SCHEMA_VERSION = 32`.

No `CREATE TABLE`/`ALTER TABLE` needed — `access_token`/`refresh_token` stay `TEXT`, just longer (Fernet output is base64, roughly 1.4-1.5x the plaintext length plus the `enc:v1:` prefix — negligible for a token-sized string).

**Critical rollout-ordering consequence of `token_encryption_key` having no default**: this migration calls `encrypt_token()`, which calls `get_settings().token_encryption_key` — if that's unset, `Settings()` itself fails to construct (pydantic-settings raises at instantiation, matching today's behaviour for a missing `ANTHROPIC_API_KEY`), so **the whole app refuses to start**, not just this migration. This is deliberate fail-loud behaviour, consistent with how `anthropic_api_key` already works — but it means the rollout order in §4 is not optional, it's load-bearing.

### 2.6 Tests

New `backend/tests/test_token_encryption.py`, matching `test_db_migrations.py`'s `isolated_db` fixture pattern and `test_auth_self_registration.py`'s general style:
- `test_encrypt_decrypt_round_trip` — encrypt then decrypt returns the original plaintext.
- `test_empty_refresh_token_stays_empty` — `encrypt_token("")` returns `""` (Microsoft's flow doesn't always issue a refresh token on every response; the existing code already tolerates `tokens.get("refresh_token", "")`).
- `test_migration_032_encrypts_legacy_plaintext_rows` — seed a row with plaintext (mirroring `_seed_legacy_database`'s approach in `test_db_migrations.py`), run `db.init_db()`, assert the stored value now starts with `enc:v1:` and decrypts back to the original.
- `test_migration_032_is_idempotent_on_already_encrypted_rows` — seed an already-`enc:v1:`-prefixed row, run the migration function directly, assert the stored value is byte-for-byte unchanged (not double-encrypted).
- `test_decrypt_invalid_token_raises_oauth_error` — corrupt an encrypted value, assert `decrypt_token` raises the documented error rather than crashing with a raw `InvalidToken`.

All new tests use the existing `isolated_db`/`tmp_path` fixture — never touch real data, matching every existing test file's confirmed-safe pattern.

---

## 3. Basic observability

### 3.1 New dependency

Add to `backend/requirements.txt`:
```
sentry-sdk>=2.0
```
Recent `sentry-sdk` versions auto-detect and instrument FastAPI/Starlette when those packages are importable — no `[fastapi]` extra needed.

### 3.2 New setting

`config.py` — **optional**, unlike the encryption key, since observability shouldn't be a hard startup requirement in the same way a security-critical encryption key is:
```python
    # Sentry DSN for error tracking. Empty = disabled (sentry_sdk.init is
    # simply not called). Get a DSN by creating a free Sentry project.
    sentry_dsn: str = ""
```
`.env.example`: `SENTRY_DSN=` with a one-line comment.

### 3.3 `main.py` changes — 5 precise insertion points

1. **Init, right after imports, before `app = FastAPI(...)`** (`main.py`, currently line 47):
   ```python
   import sentry_sdk
   _settings = get_settings()
   if _settings.sentry_dsn:
       sentry_sdk.init(dsn=_settings.sentry_dsn, traces_sample_rate=0.0, send_default_pii=False)
   ```
   `traces_sample_rate=0.0` deliberately disables performance tracing — Stage 0 is error visibility only, not APM; `send_default_pii=False` is a deliberate default given this handles real lead/contact personal data (see the GDPR gap already flagged in the audit — don't compound it by defaulting to sending request bodies/user data to a third-party SaaS).

2. **The existing global exception handler** (`main.py:159-167`) — this is the *only* reliable capture point, because it already fully handles every unhandled exception and returns a `JSONResponse`, which means Starlette/Sentry's automatic ASGI-level capture would **never see these** (from the ASGI middleware's perspective, nothing went unhandled — verified by reading the handler, it's a real catch-all, not a passthrough). One line added:
   ```python
   @app.exception_handler(Exception)
   async def unhandled_exception_handler(request: Request, exc: Exception) -> JSONResponse:
       if isinstance(exc, HTTPException):
           raise exc
       logger.exception("Unhandled error on %s %s", request.method, request.url.path)
       sentry_sdk.capture_exception(exc)
       return JSONResponse(status_code=500, content={"detail": "Internal server error"})
   ```
   (`sentry_sdk.capture_exception` is a documented no-op if `init()` was never called — safe to leave unconditional rather than re-checking `_settings.sentry_dsn` here.)

3-4. **The two `main.py` background loops** (`_sequence_scheduler_loop` line 89, `_activity_refresh_loop` line 108) — one line added next to each existing `logger.exception(...)`:
   ```python
   except Exception:  # noqa: BLE001
       logger.exception("Sequence scheduler cycle failed")
       sentry_sdk.capture_exception()
   ```
   (and the equivalent in `_activity_refresh_loop`). These are the two loops the original audit specifically flagged as "silently swallowed and retried, invisible to any monitoring" — this is the exact fix for that finding.

5. **`ch_stream_service.py`'s two loops** (`_prune_loop` line 268, `run_filing_stream`'s outer loop line 288) — same one-line addition next to each existing `logger.exception(...)`, plus `import sentry_sdk` at the top of that file.

### 3.4 Rollout note for observability specifically

Unlike §2, this has no ordering dependency — `sentry_dsn` defaults to `""`/disabled, so the code can deploy safely before you've created a Sentry account, and start reporting the moment you add a real DSN to `.env` and restart. No migration, no data change, fully additive.

---

## 4. Rollout plan (strict order — §2's fail-loud settings requirement makes this non-negotiable)

1. **Local**: implement all code changes above (§2.1-2.6, §3.1-3.3), run `pytest tests/ -q` locally with a real `TOKEN_ENCRYPTION_KEY` set in the local `backend/.env` (generate one with the command in §2.2's comment — a different key from whatever gets used in production, local dev data doesn't need to match prod's key).
2. **Generate the real production key**: run the same `Fernet.generate_key()` one-liner, store the output somewhere durable (a password manager) — **losing this key after step 4 means every connected user's OAuth account becomes unrecoverable and must be manually reconnected; it does not affect any other data**.
3. **On the VPS, before deploying new code**: SSH in and append `TOKEN_ENCRYPTION_KEY=<the generated key>` to `/opt/v1-agent/backend/.env` (and `SENTRY_DSN=<your DSN>` once you've created a Sentry project — can also be added later, it's optional). This must happen *before* step 4, or the new code will fail to start (§2.2's required-field behaviour) — this is the one place where getting the order wrong causes a visible outage rather than a silent gap.
4. **Deploy**: the existing documented flow — `rsync` per `CLAUDE.md`'s "Deploying the backend" section, then `systemctl restart phone-lookup-backend` (or run `backend/deploy/deploy.sh` on the VPS, which already does `pip install -r requirements.txt` + restart + a `/health` check as one step — this will pick up `cryptography`/`sentry-sdk` automatically).
5. **Immediately after restart**: confirm migration 032 ran — `journalctl -u phone-lookup-backend --since '5 minutes ago' | grep -i migration` should show "Running migration 32" and "Migration 32 complete"; confirm `GET /health` returns 200 (per this repo's own documented ~30s startup-window caveat); confirm one connected email account can still successfully send (a real, low-risk smoke test — pick one non-critical test send).
6. **Install the backup cron** (§1.1) — independent of steps 1-5, can happen any time, in either order.
7. **Run the growth-diagnosis query** (§1.2) once you're ready to authorize direct DB access — independent of everything else.
8. **Verify observability**: trigger one deliberate, harmless error path (or wait for a real one) and confirm it appears in the Sentry dashboard within a few minutes.

## 5. What this spec deliberately does not do

No tenant/organisation work, no self-serve signup, no billing, no pagination/index fixes, no GDPR tooling — all correctly deferred to Stage 1+ per your instruction. It also does not fix the `ch_charge_feed` pruning gap identified in §0/§1.2 — that's a one-function follow-up once the diagnosis query confirms it, not part of "critical stabilisation" itself.
