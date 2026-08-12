# 04 — Integrations Architecture Audit

Repo: `/Users/jontyhw/v1 agent` · Commit: `8c923ac5e703928e3f94721e6c11593a5c397f7d` · Evaluated: 2026-08-12

Status legend used throughout: **Confirmed** (code read directly, cited file:line) / **Inferred** (reasonable, not directly verified) / **Unverified** (could not check).

---

## 1. Current integration inventory

| Integration | Direction | Auth model | Scope | Status |
|---|---|---|---|---|
| Google Gmail (send) | Outbound only | OAuth 2.0 Authorization Code, per-user | `gmail.send` (send-only, not full mailbox) | Confirmed, working |
| Microsoft 365 (send) | Outbound only | OAuth 2.0 Authorization Code, per-user | `Mail.Send offline_access` | Confirmed, working |
| Companies House REST | Inbound (lookups) | HTTP Basic, single shared account-wide API key | Company profile/search/charges/officers | Confirmed, working, rate-limit-aware |
| Companies House Streaming | Inbound (live feed) | HTTP Basic, single shared streaming key | Filing events (charges) | Confirmed, working, self-throttled + self-pruned |
| Anthropic (Claude) | Outbound (AI calls) | API key, backend-only | 8 distinct service call sites | Confirmed, working, cost-capped |
| Apify (LinkedIn scraping) | Outbound | API token | LinkedIn activity/profile scraping | Configured (not deep-audited this pass) |
| Mailchimp | Outbound only | API key | Campaign export | Confirmed outbound-only, no bounce/complaint webhook ingestion |
| Datagardener | — | API key present in config | — | **Confirmed dead**: `config.py:67-70` key is "no longer read by anything"; `lead_scoring_service.py:17` references it as unwired |

**What does not exist at all**: no Slack/Teams notifications, no Zapier/Make/n8n connector, no public API/API-key issuance for third parties, no outbound or inbound webhook framework of any kind, no calendar sync to Google/Outlook Calendar (calendar events are local-only, CRM-native), no telephony/calling *provider* integration (Aircall/RingCentral/Twilio/Dialpad/CloudTalk) — calling works only via manual `tel:` click-to-call with self-reported outcomes (see §4, this part is a real, working strength, not a gap).

---

## 2. Email (Gmail / Microsoft 365)

**Files**: `backend/app/routers/email_oauth.py`, `backend/app/services/email_oauth_service.py`, Rust: `app/src-tauri/src/lib.rs:824-846`.

**Flow**: Standard OAuth 2.0 Authorization Code (no PKCE — correctly, since this is a confidential-client architecture with a server-side `client_secret`, not a public client). The Tauri app never handles OAuth itself: it calls `GET /email-oauth/{provider}/connect` for a consent URL, then hands that URL to the OS's default browser via `opener().open_url()` — **confirmed never an embedded webview** (`lib.rs:822-823` doc comment is explicit about this being deliberate).

**CSRF protection — a genuine strength**: the `state` parameter is `secrets.token_urlsafe(24)`, persisted server-side in an `oauth_states` table, and consumed exactly once (`SELECT` + `DELETE` in one function, `db.py:1199-1205`) before the callback trusts which user initiated the flow. This is textbook-correct OAuth callback security and should be held up as the pattern to reuse for any future provider (calendar, telephony webhooks, etc.) rather than rebuilt per-integration.

**The one real gap — plaintext token storage**: `access_token`/`refresh_token` are stored as raw `TEXT` in `email_oauth_accounts` (`db.py:168-179`) with no encryption layer anywhere in the codebase (confirmed zero hits for `encrypt|fernet|kms|vault` across `backend/app`). Anyone with read access to `team.db` — including, notably, anyone who obtains one of the unencrypted, ungzipped backup copies currently sitting in `/opt/v1-agent/backend/data/backups/` (see §7 and the SaaS/security doc) — has a live, working refresh token into a real user's Gmail or Microsoft account. **This is the single highest-priority integration finding.**

**What's missing versus a "Connected Apps" product surface**: no inbox/sent-mail synchronisation (send-only), no thread history import, no delivery status/opens/clicks/bounces/unsubscribe tracking, no shared inboxes, no domain authentication (SPF/DKIM guidance), no distinction between user-level and org-level connections (there's no org level to distinguish — see §8). What exists is exactly "send an AI-drafted email through my own connected account," which is the actual product need today (win-back campaigns, sequences, one-off email writer) — not a general email-sync platform. This is a reasonable, deliberately scoped MVP, not a half-finished feature.

---

## 3. Companies House (REST + Streaming)

**Files**: `backend/app/services/ch_stream_service.py`, `backend/app/services/companies_house_service.py`, `backend/app/services/activity_refresh_service.py`.

This is the most mature integration in the codebase and demonstrates the team already understands provider-adapter discipline even without a formal framework:

- **Two distinct credentials, correctly separated** (`main.py:126-129`) after a real production incident (git history `ac15eec`, `e277b69`) where they were conflated and silently broke REST enrichment while the stream kept running.
- **Self-throttling**: a 2-second minimum interval enforced via an `asyncio.Lock` before any REST call the stream consumer makes, specifically to protect the shared account-wide rate limit (`ch_stream_service.py:26-43`).
- **Exponential backoff with a ceiling** (10s → doubling → capped at 300s) around the entire streaming connection, on both clean disconnects and exceptions.
- **Resumable**: persists CH's own `timepoint` cursor after each processed event, so a restart resumes rather than replays or drops.
- **Idempotent**: `ch_charge_feed.transaction_id` is `UNIQUE`, and duplicate inserts are caught and discarded rather than crashing (`db.py:2697-2711`).
- **Self-pruning**: a 30-day retention loop that preserves any event promoted into a real lead (`lead_id IS NULL` guard).

This is, in miniature, exactly the shape of `SyncCursor` + `SyncJob` + retry policy the conceptual model in §9 formalises — it just exists once, hand-built for one provider, instead of as a reusable pattern. That's the core integration-architecture finding: **the individual engineering is good; there is no shared abstraction, so every new provider (calendar, telephony, a second data-enrichment source) means re-deriving this same retry/backoff/idempotency/cursor design from scratch.**

**Independent finding this audit surfaced**: the CH charge feed (and/or the underlying `team.db` more broadly) is very likely the primary driver of a confirmed, serious operational issue — see §7 — that isn't visible from the code alone.

---

## 4. Calling / telephony

**Confirmed: manual `tel:` click-to-call exists and is genuinely wired up; no provider integration exists beyond that.** `callQueue.ts:44-45,150` and `opportunityWorkspace.ts:44-45,132` both render a primary "Start Call · {number}" button as an `<a href="tel:...">` — this correctly hands off to the OS's registered calling handler (e.g. a Mac's default calling app or a registered softphone), which is exactly the "manual fallback when no calling provider is connected" pattern the audit spec asks for, already present and functional (the same `telHref()` helper is duplicated verbatim in both files — trivial DRY cleanup, not a defect). A `call_logs` table (`db.py`) and `backend/app/routers/call_logs.py` (2 routes) let a user manually record that a call happened after the fact.

What's genuinely missing is everything *beyond* that manual baseline: no Aircall/RingCentral/Twilio/Dialpad/CloudTalk adapter, no automatic call-outcome/duration capture (the rep must self-report what `tel:` hands off to an external app), no recording link storage, no transcription, and no AI-summary-from-call-audio pipeline. "Call Queue" (`app/src/views/callQueue.ts`) is a worklist UI for *deciding who to call next*, paired with the `tel:` handoff — a reasonable MVP, but every minute of the call itself happens entirely outside the CRM's visibility.

Given the product's stated audience (cold-calling sales teams, corporate-finance brokers), calling is arguably the single most central daily activity, and it is the **least built-out** integration surface in the product. This is the clearest gap between "what this team actually does all day" and "what the software actively assists with" — see the Feature Gap Matrix and Roadmap for how this should be sequenced (a provider-neutral adapter + manual `tel:` fallback first, a single named provider — Aircall is the natural first pick for a small sales team, see competitor benchmark — second).

---

## 5. Calendar

**Confirmed: CRM-native only, no external sync.** `calendar_events` is a local SQLite table (`db.py`), surfaced via `backend/app/routers/calendar.py` (4 routes) and `app/src/views/calendar.ts`. There is no Google Calendar or Outlook Calendar two-way sync, no availability/free-busy lookup, no external meeting-link generation, no duplicate-prevention against a user's real calendar. A rep who also lives in Outlook/Google Calendar day-to-day has two calendars to maintain by hand.

---

## 6. Data & productivity connectors

- **CSV import**: exists (`leads.py` migrate/import path, `import_max_rows` cap in `config.py`) — confirmed present, capped, admin-gated.
- **CSV export**: not confirmed this pass (not directly inspected) — flagged **Unverified**, worth a follow-up read of `leads.py`'s GET endpoints for an export route.
- **Public API / API keys for third-party access**: **confirmed absent**. There is no concept of an issued API key, OAuth "app" registration, or any way for a customer's other tools to pull/push CRM data programmatically, other than the CRM's own internal session-token API (which is not a public/documented integration surface).
- **Zapier / Make / n8n**: none exist. (Note: this repo separately contains an *internal* `n8n/` automation the user runs for lead auto-response — that is the team's own tooling, not a customer-facing n8n connector for the CRM product, and is out of scope for this audit per CLAUDE.md.)
- **Outbound webhooks**: **confirmed absent** — zero webhook-related code found anywhere in `backend/app`.
- **Inbound webhooks**: **confirmed absent** — same grep, zero hits. Mailchimp is push-only; there's no bounce/complaint/unsubscribe webhook receiver, meaning deliverability signals from that one outbound channel are invisible to the CRM today.
- **Slack/Teams notifications**: absent.
- **Data enrichment beyond Companies House**: Apify (LinkedIn) and a dead Datagardener key; no other enrichment provider.

---

## 7. Independent finding: production database growth and backup gap

While verifying the "no automated DB backups" item already flagged in this repo's own `CLAUDE.md`/`PROJECT_CONTEXT.md` Known Issues, this audit checked the VPS directly (read-only `ls`/`df`/`crontab -l`, no data queried or modified):

- **`team.db` has grown from 58MB (12 Jul) to 1.68GB (12 Aug) — roughly 29x in one month**, and was still actively growing at time of writing (last measured size taken minutes before this was written).
- **No cron job installed for either `root` or `appuser`** (`crontab -l` returns "no crontab" for both) — the shell script `backend/deploy/backup.sh` that would automate nightly gzip'd, pruned backups exists in the repo but has never actually been installed on the server, exactly as its own header comments (`chmod +x ...`, `crontab -e`) describe as a manual setup step that was never completed.
- **10 backup snapshots exist on disk** (`/opt/v1-agent/backend/data/backups/`, dated 12 Jul – 7 Aug, **uncompressed**, totaling **7.3GB**) — these are `.db` files, not `.db.gz`, meaning they were produced by the Python `backup_database()` helper (`db.py:817-829`, a plain `shutil.copy2`) rather than the gzip'ing shell script. This points to the backups having been triggered manually/ad-hoc (e.g., before a deploy) rather than on any schedule, and confirms the shell script has likely never run.
- **No backup exists since 7 Aug** — the last 5 days of production data (as of 12 Aug) have no recovery point at all.
- VPS disk headroom is currently fine (87GB total, 15% used, per `df -h`) — this is **not an imminent outage risk today**, but the growth trajectory, combined with zero automated backup and zero disk-usage alerting, is a real disaster-recovery gap: a single bad migration, disk fault, or accidental `DELETE` right now would lose up to 5 days of every lead, call log, email draft, and win-back campaign in the system, for every user.

**Confirmed vs Inferred**: the size figures, absence of cron jobs, and backup-directory contents are all **Confirmed** by direct, read-only inspection. The *cause* of the growth is **Inferred, not confirmed** — this audit was blocked (by this environment's own safety controls) from running a `SELECT count(*)` against the production database to identify which table(s) are actually driving it, so the exact breakdown is not verified. The most plausible candidate, based on existing project history, is the Companies House charge feed (`ch_charge_feed`, populated by the streaming consumer at up to several events/second) — the repo's own `PROJECT_CONTEXT.md` already documents that this exact feed recently started drawing far more volume than before once a key-configuration bug was fixed, to the point of exhausting the account-wide CH rate limit before a throttle was added. A direct table-size breakdown (`SELECT name, SUM(pgsize) FROM dbstat GROUP BY name` or equivalent) is the immediate next step and requires either explicit user permission to query the production DB directly, or a one-off `sqlite3_analyzer`/`.dbinfo` pass the user runs themselves.

This finding is carried into the SaaS/security doc as a **P0 launch blocker** independent of any multi-tenancy work: it's an operational risk to the *current* single-tenant deployment, today, regardless of whether this ever becomes a multi-customer SaaS product.

---

## 8. Recommended connector architecture

The product needs a **provider-adapter framework** so that adding the second, third, and tenth integration doesn't mean re-deriving the CH stream's retry/backoff/idempotency logic from scratch each time, and so a future "Connected Apps" settings page has one consistent data model to render regardless of which provider it's showing. None of this exists today — every integration is a bespoke, hand-wired service file. That's appropriate at the current scale (3 real integrations) and would become a real liability at 6+.

### Conceptual model (not implemented — for planning only)

```
IntegrationProvider
  - id, name, category (email | calling | calendar | data | productivity)
  - auth_type (oauth2 | api_key | basic)
  - capabilities: IntegrationCapability[]
  - scopes_offered, docs_url

IntegrationConnection
  - id, provider_id, owner_scope (user | organisation)  -- see §9, no org scope exists yet
  - owner_id (user_id today; would be org_id for org-level connections)
  - status (connected | needs_reauth | disconnected | error)
  - connected_at, last_health_check_at
  - display_label (e.g. connected email address)

ConnectionCredential
  - connection_id
  - encrypted_access_token, encrypted_refresh_token   -- NOT plaintext, unlike today's email_oauth_accounts
  - expires_at
  - encryption_key_ref (KMS/vault reference, not inline)

IntegrationCapability
  - e.g. "send_email", "sync_calendar", "click_to_call", "enrich_company"
  - which providers under a category implement it, so the UI can say
    "any connected calling provider supports click-to-call" generically

SyncJob
  - connection_id, job_type, status, started_at, finished_at
  - retry_count, next_retry_at
  - the generalised version of what ch_stream_service.py hand-built once

SyncCursor
  - connection_id, cursor_value (e.g. CH's `timepoint`, a Gmail historyId, a Graph delta token)
  - the generalised version of `ch_stream_state`

WebhookSubscription
  - connection_id, external_subscription_id, secret_for_signature_verification
  - expires_at (many providers' webhook subscriptions expire and need renewal —
    e.g. Microsoft Graph subscriptions max out at ~3 days and must be renewed)

IntegrationEvent
  - connection_id, event_type, payload, received_at, processed_at
  - the generalised inbound-webhook/stream-event row (ch_charge_feed is a
    provider-specific instance of this shape today)

IntegrationError
  - connection_id, occurred_at, error_type, message, resolved_at
  - what currently only exists as scattered logger.exception() calls per
    service file — no queryable, user-facing "why did my integration break"
    surface exists anywhere today
```

**Responsibilities**: `IntegrationProvider` is static catalogue data (what CAN be connected). `IntegrationConnection` + `ConnectionCredential` are the per-user/per-org instance of "this specific connection, connected by this specific person." `SyncJob`/`SyncCursor` generalise the CH stream's resume-safe polling pattern to any provider. `WebhookSubscription`/`IntegrationEvent` generalise inbound events (currently only the CH stream has an "event" concept; Mailchimp/email have none). `IntegrationError` is the missing piece that would let a "Connected Apps" settings page show real, per-connection health instead of nothing.

### What a "Connected Apps" settings UX needs that doesn't exist today
Connection status (connected/needs reauth/error), last successful sync timestamp, scopes granted in plain language, a reconnect button, a disconnect button that actually cleans up (does today's `disconnect_email_oauth_account` delete the DB row and revoke server-side, or just delete locally? — **Unverified**, worth confirming), and admin diagnostics for a non-technical user to self-serve "why isn't my email sending" instead of it silently failing into a log file only a developer can read.

---

## 9. Recommended provider order

Sequenced by (a) what this specific team already does daily, (b) what's cheapest to build well versus what needs the full connector framework first, and (c) risk reduction before net-new capability:

1. **Fix the plaintext OAuth token storage** (encrypt at rest) and **the DB backup/growth issue (§7)** — not a new integration, but both must happen before any *more* integrations add more sensitive credentials/data to an unencrypted, unbacked-up database. This is Stage-0/P0 work, not integration work per se.
2. **Provider-neutral calling adapter** — the `tel:` fallback already exists and works (§4); what's missing is the adapter layer above it so a connected provider can supply automatic call-outcome/duration/recording data instead of the rep self-reporting every call. Lowest-complexity next step since it builds on a working baseline rather than starting from zero.
3. **A named calling provider (Aircall)** — once the neutral adapter/call-logging model exists, wire one real provider behind it. Aircall is the standard small-sales-team choice (see competitor benchmark) and has a well-documented webhook-based call-event API that would be the first real test of the `WebhookSubscription`/`IntegrationEvent` model above.
4. **Google/Outlook Calendar two-way sync** — reuses the exact OAuth pattern already proven correct for Gmail/Microsoft email (state-nonce CSRF protection, system-browser consent), so it's the cheapest "second provider" to add relative to how much of the pattern already exists.
5. **Public API + API keys** — only once there's a real second or third customer organisation asking for it (see SaaS-readiness doc); premature before multi-tenancy exists at all.
6. **Zapier/Make/n8n, Slack/Teams notifications** — genuinely "nice to have, low urgency" for this specific customer profile (small sales/broker teams); defer behind the public API, since most no-code connectors are themselves built on top of a public API + webhooks.
