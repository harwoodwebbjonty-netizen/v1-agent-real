# 01 — Current System Map

Repo: `/Users/jontyhw/v1 agent` · Commit: `8c923ac5e703928e3f94721e6c11593a5c397f7d` · Evaluated: 2026-08-12

---

## 1. Architecture map

```
┌─────────────────────────────────────────────────────────────────┐
│  DESKTOP CLIENT — Tauri (Rust shell) + vanilla TypeScript/Vite   │
│  app/src/*.ts (~17 views, ~7 shared components, api.ts client)   │
│  app/src-tauri/src/*.rs (Rust commands → reqwest HTTP calls)     │
│  No API keys, no direct AI calls — every write in this audit's   │
│  scope confirmed zero secrets present client-side.               │
└───────────────────────────┬───────────────────────────────────────┘
                             │ HTTPS-in-name-only (plain HTTP to an IP,
                             │ no domain/TLS yet), bearer-token session
                             ▼
┌─────────────────────────────────────────────────────────────────┐
│  BACKEND — FastAPI, single uvicorn worker, systemd-managed        │
│  VPS 213.165.88.45, port 80 via proxy (8000 firewalled)          │
│  20 routers / 124 routes (backend/app/routers/*.py)              │
│  RBAC via custom roles table + permission_service.py             │
│  Rate limiting: slowapi, in-process MemoryStorage (resets on      │
│  restart, not multi-worker-safe)                                  │
│  3 in-process asyncio background loops (sequence scheduler,       │
│  CH activity refresh, CH filing stream) — no external queue/cron  │
└───────┬─────────────┬─────────────┬─────────────┬────────────────┘
        │              │             │             │
        ▼              ▼             ▼             ▼
┌───────────────┐┌─────────────┐┌───────────┐┌─────────────────────┐
│ SQLite (WAL)  ││ Anthropic   ││ Companies ││ Gmail / Microsoft 365│
│ team.db       ││ (Claude) —  ││ House     ││ OAuth (send-only,    │
│ 33 tables,    ││ 8 service   ││ REST +    ││ per-user, plaintext  │
│ 28 indexes,   ││ files call  ││ Streaming ││ token storage — see  │
│ schema v31    ││ it, cost-   ││ (2 keys,  ││ security doc)        │
│ 1.68GB, 29x   ││ capped per  ││ correctly ││                      │
│ growth in 1mo,││ user/month  ││ separated,││ Mailchimp (outbound  │
│ NO working    ││             ││ throttled,││ export only)         │
│ automated     ││             ││ self-     ││                      │
│ backup — see  ││             ││ pruning)  ││ Apify (LinkedIn      │
│ security doc  ││             ││           ││ scraping)            │
└───────────────┘└─────────────┘└───────────┘└─────────────────────┘
```

**No multi-tenant boundary exists anywhere in this diagram** — every box is a single shared instance serving one team. See the SaaS/Security doc §1 for the full implication.

## 2. Data flow — the two most-exercised paths

**Lead lifecycle**: CSV import / AI Prospecting (Companies House search) → `leads` table (owner/assigned/list/stage fields) → Cold Call Lists / Call Queue work the list → `call_logs` + `calendar_events` record activity → Companies House charge-feed stream independently enriches matching leads by `company_number` → Analytics/Action Centre read the same shared `leads` state via a client-side reactive cache (`app/src/state.ts`) rather than each screen fetching independently.

**AI-assisted outreach**: a lead → Sales Intelligence / Email Writer / Win-back service calls Anthropic (workflow prompt loaded from `workflows/*.md` at runtime, per `CLAUDE.md`'s own documented contract) → generates a draft → user reviews → `send_email_draft` uses the connected Gmail/Microsoft OAuth account → `email_drafts` table tracks status. Credit-limit check (`credit_settings`) gates every paid AI call before it fires.

## 3. Route / page inventory (condensed — full per-screen detail with loading/empty/error/permission behaviour is in the Visual/UX Audit and Feature Gap Matrix)

15 `ViewName`s are declared and initialised; only **10 are actually reachable** through the router/nav (see Visual/UX Audit Finding 05-01 for the full evidence — this is the single most important structural finding in the whole audit).

| # | Screen | Reachable? | Primary user | Core job |
|---|---|---|---|---|
|1|Today (`action-centre`)|Yes|Any member|Daily worklist: overdue calls, follow-ups, pending drafts|
|2|Activity Feed|Yes|Any member|Live CH filing/charge stream + team activity log|
|3|AI Prospecting|Yes (nav marked admin-only in HTML, not actually enforced)|Permission-gated|Bulk-discover new companies via CH, auto-enrich|
|4|Leads (`dashboard`)|Yes|Any member|Shared lead pool — lookup/import/enrich/filter/assign|
|5|Cold Call Lists|Yes|Any member (admin sees more)|Build/work named calling lists|
|6|Outreach (Email Writer / List Campaign / Sequences)|Yes, one permission covers all three sub-tools|Permission-gated|AI email drafting, bulk list sends, multi-step sequences|
|7|Win-back|Yes (nav marked admin-only, not enforced)|Permission-gated|CSV-driven re-engagement campaigns|
|8|Calendar|Yes|Any member|CRM-native events, no external sync|
|9|Analytics|Yes|Any member|Charts over the existing lead pool (no independent fetch/error state — depends entirely on Dashboard having loaded first)|
|10|Settings|Yes, most granularly gated screen + a redundant device-local PIN|Mostly admin|Team/roles/audit/credit-limits/brand-voice/backend|
|11|Call Queue|**No — orphaned**|—|Dedicated dialer worklist with `tel:` click-to-call and outcome logging|
|12|Opportunity Workspace|**No — orphaned**|—|Full per-deal workspace: stage, notes, calls, drafts, AI history, timeline|
|13|AI Sales Intelligence|**No — orphaned**|—|Standalone AI chat/report workspace per lead|
|—|Charge Feed|No — intentionally deprecated stub, merged into Activity Feed (documented in-code)|—|—|

## 4. Major data entities

33 tables in `backend/app/db.py` (schema v31). Core entity groups:
- **Identity/access**: `users`, `sessions`, `roles`, `oauth_states`, `audit_log`.
- **CRM core**: `leads` (with `owner_user_id`/`assigned_user_id`/`list_id`/`opportunity_stage`/`company_number`), `lead_phones`, `lead_emails`, `lead_lists`, `lead_intelligence_versions` (+ lock table), `lead_linkedin_posts`.
- **Activity**: `calendar_events`, `call_logs`, `activity_events`, `company_snapshots`.
- **Outreach**: `email_templates`, `email_drafts`, `email_oauth_accounts`, `brand_voice_profiles`, `sequences`/`sequence_steps`/`sequence_enrollments`, `list_email_campaigns`, `win_back_campaigns`/`win_back_emails`.
- **Companies House feed**: `ch_charge_feed`, `ch_stream_state`.
- **Ops**: `prospecting_runs`, `credit_usage`, `user_settings`, `app_flags`, `schema_version`.

No `org_id`/tenant column exists on any table — every row scopes only to `owner_user_id`/`user_id` within the one shared instance (see SaaS/Security doc §1).

## 5. External dependencies

Anthropic (Claude, 8 service call sites), Google & Microsoft OAuth (email send), Companies House REST + Streaming (2 separate keys), Apify (LinkedIn scraping), Mailchimp (outbound export only), and a configured-but-dead Datagardener key (confirmed unwired to any code path). No Slack/Teams, no Zapier/Make/n8n, no public API, no inbound or outbound webhook framework, no calendar-provider sync, no telephony provider — full detail and a recommended connector architecture in the Integrations doc.

## 6. Deployment assumptions

- **Backend**: one VPS (213.165.88.45), one systemd-managed uvicorn worker, SQLite on local disk (WAL mode), served on port 80 via a proxy (port 8000 firewalled). No containerization found. No HTTPS/domain — plain HTTP to a bare IP. Deploys are manual `rsync` (documented in this repo's own `CLAUDE.md`), not CI/CD-automated.
- **Frontend**: Tauri desktop installers (macOS/Windows) built via GitHub Actions (`.github/workflows/release.yml`), distributed via GitHub Releases with an auto-updater; no web/browser deployment target exists — this is desktop-only by construction, not a constraint that was relaxed later.
- **Single-worker is a stated, deliberate, in-code-documented constraint** (`sequences_service.py`'s own module docstring), not an oversight — but it does mean the in-memory rate limiter and the three background loops have no multi-process coordination story if that ever changes.
- **No containerized/reproducible deployment artifact** (no Dockerfile found for the backend) — deployment is "rsync the code, restart the service," which works for one operator managing one VPS but doesn't generalise to provisioning a new customer's isolated environment without more infrastructure work.

---

For deep detail behind every summary line above, see: `04-integrations-architecture.md` (integration/connector detail), `05-visual-ux-audit.md` (per-screen loading/empty/error states, design-token bypass evidence), `06-saas-security-scalability.md` (tenant/security/scalability detail, including the confirmed VPS database-growth finding), and `07-coded-evaluation-results.md` (raw script output and test results).
