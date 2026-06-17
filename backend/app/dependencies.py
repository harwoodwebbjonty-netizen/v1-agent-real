from dataclasses import dataclass


@dataclass
class CurrentUser:
    """Placeholder identity. Swap this dependency for real auth (API key /
    JWT / session) later without touching route or service code."""

    id: str = "anonymous"


def get_current_user() -> CurrentUser:
    return CurrentUser()
