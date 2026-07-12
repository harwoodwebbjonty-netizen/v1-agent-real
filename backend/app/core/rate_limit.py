from slowapi import Limiter
from slowapi.util import get_remote_address
from starlette.requests import Request


def _key_by_user(request: Request) -> str:
    """Rate-limit per signed-in user (bearer token), not per IP — a whole
    office behind one NAT would otherwise share a single bucket."""
    auth = request.headers.get("authorization", "")
    if auth.lower().startswith("bearer "):
        return auth[7:]
    return get_remote_address(request)


limiter = Limiter(key_func=_key_by_user)
