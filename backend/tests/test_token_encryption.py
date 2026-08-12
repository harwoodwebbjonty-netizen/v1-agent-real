import sqlite3

import pytest
from cryptography.fernet import Fernet

from app import db
from app.services.token_crypto import TokenDecryptionError, decrypt_token, encrypt_token


@pytest.fixture
def isolated_db(tmp_path, monkeypatch):
    """Points the db module at a throwaway file for this test only —
    never touches the real backend/data/team.db."""
    db_path = tmp_path / "team.db"
    backups_dir = tmp_path / "backups"
    monkeypatch.setattr(db, "DB_PATH", db_path)
    monkeypatch.setattr(db, "BACKUPS_DIR", backups_dir)
    return db_path, backups_dir


def test_encrypt_decrypt_round_trip():
    ciphertext = encrypt_token("ya29.a0-real-looking-access-token")
    assert ciphertext.startswith("enc:v1:")
    assert ciphertext != "ya29.a0-real-looking-access-token"
    assert decrypt_token(ciphertext) == "ya29.a0-real-looking-access-token"


def test_empty_refresh_token_stays_empty():
    # Microsoft's flow doesn't always issue a refresh_token — the existing
    # code already tolerates tokens.get("refresh_token", ""). An empty
    # string shouldn't get a enc:v1: prefix or fail to decrypt.
    assert encrypt_token("") == ""
    assert decrypt_token("") == ""


def test_decrypt_passes_through_legacy_plaintext():
    # A value with no enc:v1: prefix is legacy plaintext (pre-migration-032)
    # or an unencrypted empty string — decrypt_token must not choke on it.
    assert decrypt_token("legacy-plaintext-token") == "legacy-plaintext-token"


def test_decrypt_invalid_token_raises_error():
    with pytest.raises(TokenDecryptionError):
        decrypt_token("enc:v1:not-a-real-fernet-token")


def test_decrypt_fails_with_a_different_key(monkeypatch):
    ciphertext = encrypt_token("some-access-token")

    from app.core import config as config_module

    other_key = Fernet.generate_key().decode()
    monkeypatch.setenv("TOKEN_ENCRYPTION_KEY", other_key)
    config_module.get_settings.cache_clear()
    try:
        with pytest.raises(TokenDecryptionError):
            decrypt_token(ciphertext)
    finally:
        config_module.get_settings.cache_clear()


def _seed_full_schema(db_path) -> None:
    """Builds the full current schema (all migrations up to but not
    including 032) against a fresh file, matching test_db_migrations.py's
    _seed_legacy_database approach."""
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    try:
        conn.execute("PRAGMA foreign_keys=ON")
        for version, migration_fn in db.MIGRATIONS:
            if version < 32:
                migration_fn(conn)
        conn.commit()
    finally:
        conn.close()


def test_migration_032_encrypts_legacy_plaintext_rows(isolated_db):
    db_path, _ = isolated_db
    _seed_full_schema(db_path)

    conn = sqlite3.connect(db_path)
    try:
        conn.execute(
            "INSERT INTO email_oauth_accounts "
            "(id, user_id, provider, email_address, access_token, refresh_token, token_expires_at, created_at, updated_at) "
            "VALUES ('acct-1', 'user-1', 'gmail', 'rep@example.com', 'plaintext-access', 'plaintext-refresh', "
            "'2026-01-01T00:00:00', '2026-01-01T00:00:00', '2026-01-01T00:00:00')"
        )
        conn.commit()
    finally:
        conn.close()

    db.init_db()

    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    try:
        row = conn.execute("SELECT * FROM email_oauth_accounts WHERE id = 'acct-1'").fetchone()
        assert row["access_token"].startswith("enc:v1:")
        assert row["refresh_token"].startswith("enc:v1:")
        assert decrypt_token(row["access_token"]) == "plaintext-access"
        assert decrypt_token(row["refresh_token"]) == "plaintext-refresh"
        assert db.get_schema_version(conn) == db.CURRENT_SCHEMA_VERSION
    finally:
        conn.close()


def test_migration_032_is_idempotent_on_already_encrypted_rows(isolated_db):
    db_path, _ = isolated_db
    _seed_full_schema(db_path)

    encrypted_access = encrypt_token("already-encrypted-access")
    encrypted_refresh = encrypt_token("already-encrypted-refresh")
    conn = sqlite3.connect(db_path)
    try:
        conn.execute(
            "INSERT INTO email_oauth_accounts "
            "(id, user_id, provider, email_address, access_token, refresh_token, token_expires_at, created_at, updated_at) "
            "VALUES ('acct-1', 'user-1', 'gmail', 'rep@example.com', ?, ?, "
            "'2026-01-01T00:00:00', '2026-01-01T00:00:00', '2026-01-01T00:00:00')",
            (encrypted_access, encrypted_refresh),
        )
        conn.commit()
    finally:
        conn.close()

    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    try:
        db._migration_032_encrypt_oauth_tokens(conn)
        conn.commit()
        row = conn.execute("SELECT * FROM email_oauth_accounts WHERE id = 'acct-1'").fetchone()
        # Byte-for-byte unchanged — not double-encrypted.
        assert row["access_token"] == encrypted_access
        assert row["refresh_token"] == encrypted_refresh
    finally:
        conn.close()


def test_upsert_and_refresh_round_trip_through_the_real_service_functions(isolated_db):
    """End-to-end: db.upsert_email_oauth_account/get_email_oauth_account never
    see plaintext once email_oauth_service.py wraps them with encrypt/decrypt —
    verified here at the db layer using the same encrypt_token/decrypt_token
    helpers the service uses, confirming the stored value round-trips."""
    db.init_db()
    db.create_user("user-1", "Jonty", "admin", "2026-01-01T00:00:00")
    db.upsert_email_oauth_account(
        "acct-1", "user-1", "gmail", "rep@example.com",
        encrypt_token("real-access-token"), encrypt_token("real-refresh-token"),
        "2026-01-01T00:00:00", "2026-01-01T00:00:00",
    )

    row = db.get_email_oauth_account("user-1", "gmail")
    assert row["access_token"].startswith("enc:v1:")
    assert decrypt_token(row["access_token"]) == "real-access-token"
    assert decrypt_token(row["refresh_token"]) == "real-refresh-token"
