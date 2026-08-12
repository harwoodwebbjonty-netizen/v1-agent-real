from cryptography.fernet import Fernet, InvalidToken

from app.core.config import get_settings

# Marks an already-encrypted value so migration 032 and any mixed-state read
# during rollout can tell it apart from legacy plaintext without guessing.
_ENC_PREFIX = "enc:v1:"


class TokenDecryptionError(Exception):
    """Raised when a stored token can't be decrypted with the current key —
    either it was encrypted with a different key, or the ciphertext is
    corrupt. Callers should treat this the same as an expired/revoked
    credential: the connected account needs reconnecting."""


def _fernet() -> Fernet:
    return Fernet(get_settings().token_encryption_key.encode())


def encrypt_token(plaintext: str) -> str:
    """Encrypts a token for storage. Empty strings pass through unchanged —
    Microsoft's OAuth flow doesn't always issue a refresh_token, and an empty
    value needs no protecting."""
    if not plaintext:
        return plaintext
    return _ENC_PREFIX + _fernet().encrypt(plaintext.encode()).decode()


def decrypt_token(value: str) -> str:
    """Decrypts a stored token. A value with no enc:v1: prefix is returned
    as-is (legacy plaintext pre-migration, or an empty refresh_token)."""
    if not value or not value.startswith(_ENC_PREFIX):
        return value
    try:
        return _fernet().decrypt(value[len(_ENC_PREFIX):].encode()).decode()
    except InvalidToken as exc:
        raise TokenDecryptionError(
            "Stored email credentials could not be decrypted — the account needs reconnecting."
        ) from exc
