from functools import lru_cache
from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict

REPO_ROOT = Path(__file__).resolve().parents[3]
WORKFLOW_PATH = REPO_ROOT / "workflows" / "find_company_phone_number.md"


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8")

    anthropic_api_key: str
    model: str = "claude-sonnet-4-6"
    extraction_model: str = "claude-haiku-4-5-20251001"
    rate_limit: str = "10/minute"
    max_pause_turn_continuations: int = 3

    # AI Email Writer — real sending via OAuth. Empty by default; the
    # Connect buttons return a clear "not configured" error until these are
    # filled in with real credentials from Google Cloud Console / Azure AD.
    google_oauth_client_id: str = ""
    google_oauth_client_secret: str = ""
    microsoft_oauth_client_id: str = ""
    microsoft_oauth_client_secret: str = ""
    oauth_redirect_base_url: str = "http://localhost:8000"

    # Companies House API — free official UK government API, register at
    # https://developer.company-information.service.gov.uk
    # Required for AI Prospecting; leave empty to disable the feature.
    companies_house_api_key: str = ""

    # DataGardener API — powers the Recent Activity Feed (charge changes,
    # director/PSC events, risk alerts). Leave empty to disable the feature
    # — all activity dots stay grey and no background refreshes run.
    datagardener_api_key: str = ""

    # Mailchimp — optional, for win-back campaign export. Leave empty to
    # disable; the export button returns a clear "not configured" error.
    mailchimp_api_key: str = ""
    mailchimp_audience_id: str = ""


@lru_cache
def get_settings() -> Settings:
    return Settings()


@lru_cache
def get_workflow_text() -> str:
    return WORKFLOW_PATH.read_text()
