# Company Phone Lookup — Backend

FastAPI service that owns the entire "find a company's phone number" workflow
(research with Claude's `web_search`/`web_fetch` tools, then structured
extraction). The desktop app has no API key and never calls Anthropic
directly — it only calls this service.

## Run locally

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env   # then fill in your real ANTHROPIC_API_KEY
uvicorn app.main:app --reload --port 8000
```

## API

`POST /lookup-company-phone`

```json
// request
{ "company": "Acme Ltd" }

// response (always this shape, even on failure — see notes)
{
  "company": "Acme Ltd",
  "phone_number": "01234 567890",
  "source_url": "https://acme.example.com/contact",
  "status": "verified",
  "notes": "Confirmed on official Contact page"
}
```

Rate limited per-IP (`RATE_LIMIT` env var, default `10/minute`) via `slowapi`.

## Structure

- `app/main.py` — route + rate limiting wiring
- `app/services/anthropic_service.py` — the two-phase Anthropic call
- `app/services/usage_log.py` — append-only request log (seed for future billing)
- `app/dependencies.py` — `get_current_user` is a no-op placeholder today; swap in real auth here later without touching routes
- `app/core/config.py` — settings (env-only secrets) + loads the system prompt from `../workflows/find_company_phone_number.md`
