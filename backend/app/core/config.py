from functools import lru_cache
from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict

REPO_ROOT = Path(__file__).resolve().parents[3]
WORKFLOW_PATH = REPO_ROOT / "workflows" / "find_company_phone_number.md"


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8")

    anthropic_api_key: str
    model: str = "claude-sonnet-4-6"
    rate_limit: str = "10/minute"
    max_pause_turn_continuations: int = 5


@lru_cache
def get_settings() -> Settings:
    return Settings()


@lru_cache
def get_workflow_text() -> str:
    return WORKFLOW_PATH.read_text()
