import os

from cryptography.fernet import Fernet

# Settings() requires ANTHROPIC_API_KEY and TOKEN_ENCRYPTION_KEY with no
# default. Locally they're satisfied by backend/.env (gitignored); CI has no
# .env at all. Any test that imports a router module ends up evaluating
# get_settings() at import time (e.g. auth.py's
# @limiter.limit(get_settings().auth_rate_limit) decorator argument), so this
# must run before test collection imports those modules — a fixture is too late.
os.environ.setdefault("ANTHROPIC_API_KEY", "test-key-for-pytest")
# A fixed, valid Fernet key (not a secret — test-only, never used outside
# this process) so every test gets the same deterministic encrypt/decrypt
# behaviour regardless of run order.
os.environ.setdefault("TOKEN_ENCRYPTION_KEY", Fernet.generate_key().decode())
