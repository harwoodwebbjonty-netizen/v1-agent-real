# Build prompt — "Team Tracking" (per-salesperson manager review) for makr CRM

> **How to use this:** paste everything from **BUILD PROMPT** down into Claude Code (or another AI
> coding agent) running in the makr CRM repo. It is grounded in the real tables, permissions and
> file paths of this codebase (verified as of 2026-08-18). The appendix lists those facts so the
> agent doesn't have to rediscover them.

---

## BUILD PROMPT

You are working in the **makr CRM** desktop-SaaS monorepo (this repository). Read `CLAUDE.md` first
and follow it. Stack: **FastAPI** backend (`backend/app/`), **Tauri + vanilla TypeScript/Vite**
frontend (`app/src/`), **SQLite** (`backend/app/db.py`). Build a new **admin-only "Team Tracking"**
section: a manager's per-salesperson review, computed entirely from activity the app already logs.
**Additive only — do not change or regress existing features.** Match the existing crimson design
system and conventions (no emoji in UI; stroke SVGs; existing CSS tokens; weight/typography rules in
`CLAUDE.md`).

### 1. Goal
Give a manager (Admin) one place to review how each salesperson is performing, using **automatically
logged data** — no hand entry. Reproduce this proven shape:
**(a)** team KPI strip, **(b)** Needs-attention list, **(c)** Leaderboard with trend / green-streak /
consistency, **(d)** Team-metric rollup, **(e)** Effort-vs-result (efficiency), **(f)** 1-on-1 prep
sheet per rep. Add a **manager settings page** to choose which metrics are active and set each
metric's target / weight / RAG thresholds.

### 2. Who & attribution
- Salespeople = `users` with the **Member** role. Manager = **Admin** (holds every permission).
- Attribute activity per rep: `call_logs.created_by`, `calendar_events.owner_user_id`,
  `leads.assigned_user_id` (fall back to `owner_user_id` when unassigned — put this fallback in one
  documented helper). Leads are a **shared pool**, so always attribute explicitly, never by "who can
  see it".

### 3. Metric catalogue (v1) — CONFIG-DRIVEN
Implement metrics through a **registry** so more can be added later without schema changes. Each
metric defines: `key`, `label`, `group`, `unit` (count | hours | percent), and an aggregation
function; plus manager-editable config: `enabled`, `target` (per week), `weight` (for the weighted
score; `0` = tracked but unweighted), `green` and `amber` RAG thresholds (as % of target). v1:

**Activity group**
- `calls` — COUNT(`call_logs`) by `created_by` in the period.
- `talk_time_hours` — SUM(`call_logs.duration_seconds`) / 3600 (ignore NULLs).
- `connect_rate` — `connected` / total `call_logs` (percent metric, target 100).
- `meetings` — COUNT(`calendar_events` whose `type` denotes a meeting) by `owner_user_id`.

**Pipeline group**
- `leads_worked` — distinct leads the rep advanced in the period (contact_status moved beyond `New`,
  or the lead has a `call_log` / logged activity by them).
- `conversions` — leads reaching `contact_status = 'Converted'` in the period, attributed to the rep.
- `conversion_rate` — `conversions` / `leads_worked` (percent metric).

Design the registry so **Outreach** (win-back / list campaigns / sequences / prospecting) and
**Cost** (`credit_usage` £) groups can be added later by appending registry entries only — no
migration, no UI rewrite. The settings page must render whatever is in the registry.

### 4. Backend
- **Config storage:** store a `team_tracking_config` JSON blob in the existing `app_flags(key,value)`
  table (simplest; one row), OR a dedicated `tracking_metric_config` table — pick one and justify in
  a comment. Shape: `{ metricKey: { enabled, target, weight, green, amber }, leadAttribution:
  "assigned" | "owner" }`. Seed defaults for the v1 metrics on first read. Any schema change goes in
  a **new** migration in `db.py` (bump `CURRENT_SCHEMA_VERSION`, append to `MIGRATIONS`; never edit a
  shipped migration).
- **New permission** `view_team_tracking`: add to `PERMISSION_CATALOGUE` (Sections group) in
  `backend/app/core/permissions.py`. Do **not** add it to `MEMBER_PERMISSIONS`. Enforce it with the
  same permission dependency other admin routers use (see `dependencies.py` /
  `services/permission_service.py`).
- **New router** `backend/app/routers/team_tracking.py`, registered in `backend/app/main.py`:
  - `GET /team-tracking/config` · `PUT /team-tracking/config` — admin-only; read/update metric config.
  - `GET /team-tracking/overview?period=week|month|quarter&from=&to=` — returns, for the window:
    per-rep metric values + weighted score, team rollup (avg per metric), attention flags, and a
    per-rep **weekly score series** (for trend / streak / consistency).
  - Aggregate with SQL `GROUP BY` on the attribution column, bucketing by **ISO week** derived from
    the UTC ISO `created_at` / `date` strings. Only **enabled** metrics contribute to the weighted
    score.
- **Scoring (reuse the scorecard maths):** per rep, `weighted % of target` **normalised by the
  weight actually present** so a blank metric doesn't drag the score down; RAG from the configurable
  green/amber; **trend** = latest period vs previous + a consecutive-decline counter; **green-period
  streak**; **consistency** = stdev of the weekly scores (Steady vs Swingy); **efficiency ratios**
  (e.g. calls per conversion, talk time per call). **Needs-attention** = red **OR** declining ≥2
  periods **OR** no activity logged in the period.

### 5. Frontend
- New view `app/src/views/teamTracking.ts`, modelled on `app/src/views/analytics.ts` (card layout,
  section headers, fetch through `app/src/api.ts`). Register it in `app/src/router.ts` and add a
  **sidebar nav item gated admin-only** exactly like Settings / Win-back / AI Prospecting (hidden for
  Members; backend also 403s).
- Sections, in order:
  1. **KPI strip** — team weighted score, a headline pipeline number, on-track count, needs-attention
     count.
  2. **Needs attention** — red / trending-down / no-activity, each with an "Open 1-on-1" action.
  3. **Leaderboard** — rank, trend sparkline + arrow, green-streak, Steady/Swingy consistency,
     "most improved" ribbon; reps with no data greyed at the bottom.
  4. **Team rollup** — table of avg % of target per metric with a team column + bar, and a weighted
     row. Wrap wide tables in a horizontal-scroll container.
  5. **Effort vs result** — per-rep efficiency cards (calls/conversion, talk/call…), flag outliers.
  6. **1-on-1 prep sheet** — person picker; their latest numbers vs target, a recent-activity
     summary, and **honest, data-driven talking points** (never invent "done"/completed flags —
     surface what the numbers actually show).
  - Controls: **This week / Month / Quarter** period toggle; person filter.
- **Manager settings page/panel** (admin): list every metric from the registry with an enable toggle,
  target, weight, and green/amber inputs, plus the lead-attribution choice; save via
  `PUT /team-tracking/config`. Reuse `app/src/views/settings.ts` / roles-editor form patterns.

### 6. Edge cases
Reps with no logged activity in the window → "no data" state, and listed in needs-attention as
"not updated". Talk time only where `duration_seconds` is present. Bucket all timestamps in a single
timezone (UTC ISO). De-duplicate leads across owner/assigned. Empty team and single-rep teams must
render cleanly. Config with zero enabled metrics → clear empty state, never divide by zero.

### 7. Roles / safety
Admin-only end to end (sidebar hidden **and** backend 403 for Members). **Read-only** over existing
tables — never write to `call_logs` / `leads` / `calendar_events`. No changes to existing endpoints
or views; the existing (aggregate) Analytics view stays exactly as-is.

### 8. Deploy (per `CLAUDE.md` — state both explicitly, don't conflate)
- **Backend:** `rsync` `backend/app/` to the VPS and `systemctl restart phone-lookup-backend` (the
  new migration runs on restart). Verify `curl http://213.165.88.45/health` → `{"status":"ok"}`
  (allow ~30–40s).
- **Frontend:** bump `version` in `app/src-tauri/tauri.conf.json`, commit, tag `v<version>`, push
  main + tag → CI builds the release. An app release does **not** deploy the backend.

### 9. Verification
Seed 2–3 Member users with sample `call_logs`, `leads` (varied `contact_status`) and
`calendar_events`, then confirm:
1. `GET /team-tracking/overview` per-rep aggregates match hand-counted expectations for a week.
2. A Member gets **403** on both endpoints and sees **no** sidebar item.
3. `PUT` then `GET` config round-trips; disabling a metric removes it from the weighted score.
4. Trend / streak / attention flags behave correctly on multi-week data.
5. Existing Analytics and every other view are unchanged.

---

## Appendix — verified codebase facts (as of 2026-08-18)

**Roles / RBAC** — `backend/app/core/permissions.py`
- Salespeople = `users` (Member role); manager = **Admin** (all permissions).
- `PERMISSION_CATALOGUE` (Sections group has `view_today`, `view_activity_feed`, `view_leads`,
  `view_cold_call_lists`, `view_outreach`, `view_calendar`, `view_analytics`, `view_prospecting`,
  `view_win_back`, `view_settings`). `MEMBER_PERMISSIONS` is the members' subset — **do not add**
  `view_team_tracking` to it. Enforced via `dependencies.py` / `services/permission_service.py`.
- `users(id, name, role, role_id, created_at)`; `roles(id, name, permissions, lead_scope,
  is_system, is_default, …)`. `LEAD_SCOPES = ("all_shared", "own_assigned")`.

**Data sources (all in `backend/app/db.py`)**
- `call_logs(id, lead_id, calendar_event_id, outcome, notes, duration_seconds, created_by,
  created_at)`. `outcome ∈ {connected, voicemail, no_answer, wrong_number, other}` (see
  `backend/app/schemas_call_logs.py`).
- `leads(… status, contact_status, owner_user_id, assigned_user_id, created_at, updated_at)`.
  `contact_status` order = `New → Contacted → Replied → Converted`
  (`app/src/constants.ts CONTACT_STATUS_ORDER`). Leads are a shared pool.
- `calendar_events(id, owner_user_id, title, date, time, type, lead_id, …)`.
- Available for later groups: `win_back_emails(campaign_id, send_status, sent_at, send_method)`,
  `list_email_campaigns(owner_user_id, status, total_target)`,
  `sequence_enrollments(created_by, status)`, `prospecting_runs(owner_user_id, found, created)`,
  `credit_usage(user_id, feature, amount_gbp, created_at)`, `audit_log(actor_id, action, …)`.
- `app_flags(key, value, updated_at)` — usable for JSON config. Migrations: bump
  `CURRENT_SCHEMA_VERSION`, append to `MIGRATIONS`, never edit shipped ones.

**Patterns to reuse**
- Backend: routers in `backend/app/routers/*.py`, registered in `backend/app/main.py`; Pydantic
  schemas in `backend/app/schemas_*.py`.
- Frontend: views in `app/src/views/*.ts`, registered in `app/src/router.ts`; API calls via
  `app/src/api.ts`; admin-only sidebar gating already used for Settings / Win-back / AI Prospecting.
- Closest UI template: `app/src/views/analytics.ts` (it is aggregate/all-team — funnel, stage
  breakdown, "Sales Calling by List"; the new view is **per-salesperson** and complementary).
