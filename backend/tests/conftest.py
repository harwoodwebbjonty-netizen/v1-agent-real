import os

# Settings() requires ANTHROPIC_API_KEY with no default. Locally it's satisfied
# by backend/.env (gitignored); CI has no .env at all. Any test that imports a
# router module ends up evaluating get_settings() at import time (e.g. auth.py's
# @limiter.limit(get_settings().auth_rate_limit) decorator argument), so this
# must run before test collection imports those modules — a fixture is too late.
os.environ.setdefault("ANTHROPIC_API_KEY", "test-key-for-pytest")
