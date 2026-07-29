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
    # Win-back emails are written by this model specifically. Kept separate from
    # extraction_model (Haiku, shared by phone-lookup, email/LinkedIn discovery,
    # enrichment and research extraction) so the win-back copy can use a stronger
    # writer for a more natural, human voice without changing those cheaper tools.
    win_back_writer_model: str = "claude-sonnet-4-6"
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

    # Companies House REST API key — used for AI Prospecting, company lookups,
    # and enrichment. Register at developer.company-information.service.gov.uk.
    # Leave empty to disable prospecting.
    companies_house_api_key: str = ""

    # Companies House Streaming API key — separate key type for the live filing
    # stream (charge feed). Falls back to companies_house_api_key if not set.
    companies_house_stream_key: str = ""

    # Legacy — DataGardener has been replaced by Companies House as the
    # activity-feed source (see ch_service.py). This key is no longer read by
    # anything; the feed now runs on COMPANIES_HOUSE_API_KEY. Kept only so an
    # existing DATAGARDENER_API_KEY in a .env doesn't raise on load.
    datagardener_api_key: str = ""

    # Mailchimp — optional, for win-back campaign export. Leave empty to
    # disable; the export button returns a clear "not configured" error.
    mailchimp_api_key: str = ""
    mailchimp_audience_id: str = ""
    # Fallback "from" address for Mailchimp campaigns when no OAuth account is
    # connected. Must be a verified sender domain in your Mailchimp account.
    mailchimp_from_email: str = ""

    # Apify — runs the "LinkedIn Profile Posts scraper" actor to pull real post
    # content into sales-intelligence research. Get the token from Apify
    # Console → Settings → Integrations, and the actor ID from the specific
    # actor's page → API tab (format "username/actor-name"). Leave either
    # empty to disable — LinkedIn enrichment silently no-ops.
    apify_api_token: str = ""
    apify_linkedin_actor_id: str = ""


@lru_cache
def get_settings() -> Settings:
    return Settings()


@lru_cache
def get_workflow_text() -> str:
    return WORKFLOW_PATH.read_text()
