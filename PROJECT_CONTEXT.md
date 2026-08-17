# Project Overview

CoPilotIQ — a sales-team CRM for cold-calling/prospecting UK companies. Two independent parts in one repo: a chat-based WAT (Workflows/Agents/Tools) framework for manual lookups, and a full desktop CRM app (Tauri + FastAPI backend) that a small sales team uses daily.

# Current Architecture

- `app/` — Tauri desktop app (Rust shell + vanilla TypeScript/Vite frontend). No API keys, no direct Anthropic calls — only talks to the backend over HTTP. Builds macOS/Windows installers via `.github/workflows/release.yml`; ships an auto-updater.
- `backend/` — FastAPI service on the VPS (213.165.88.45), served on port 80 via proxy (8000 is firewalled). Owns all Anthropic API calls, SQLite DB (WAL mode), Companies House integration. Deployed manually via rsync (see CLAUDE.md), not by app releases.
- `workflows/*.md` — five of these are read verbatim as **live backend system prompts** (see CLAUDE.md's "Production AI Prompts" table); two others are chat-only SOPs.
- The chat-based WAT layer (`tools/`, `workflows/` SOPs not listed above, `data/phone_lookups.csv`) is separate from the app/backend and used directly in Claude Code sessions.

# Important Components

- `app/src/style.css` — the authoritative design system (tokens + all styling). `CLAUDE.md`'s Design section summarises it; style.css wins on any disagreement.
- `app/src/views/*.ts` — one file per CRM page (actionCentre=Today, dashboard=Leads, coldCallLists, analytics, winBackCampaign, calendar, activityFeed, aiProspecting, settings, outreach + its sub-views).
- `app/src/components/topBar.ts` — global top-bar wiring (search, bell, user, nav counts).
- `app/src/connection.ts` — the `/health` poll driving both the offline banner and the sidebar footer status dot.
- `backend/app/db.py` — schema + migrations (`CURRENT_SCHEMA_VERSION` + `MIGRATIONS`, append-only, never edit shipped ones).
- `app/src/*Handoff.ts` — tiny shared-module-state handoffs for cross-view "open this specific thing" jumps (`emailWriterHandoff`, `dashboardFilterHandoff`, `opportunityWorkspaceHandoff`, `coldCallListHandoff`). Same pattern each: `setPendingX`/`consumePendingX`, consumed via `subscribeTabs` in the target view.
- `audits/` — point-in-time OS-audit reports checking whether this repo's own docs/memory match reality. Not code; read-only reports.
- `audit/` — distinct from `audits/` above: the 2026-08-12 full product/SaaS-readiness audit (11 docs + reusable scan scripts + JSON results) and its derived `implementation-spec-stage-0.md`. Source of truth for the roadmap currently being executed — see Current Work.
- `backend/app/services/token_crypto.py` — Fernet encryption for OAuth tokens at rest (`TOKEN_ENCRYPTION_KEY`, required setting, no default).

# Data / Database

SQLite at `/opt/v1-agent/backend/data/team.db` on the VPS, WAL mode. Migrations run automatically on backend restart. Companies House filing feed self-prunes to 30 days. Shared lead pool by default — leads outside a list are visible/editable to all users (deliberate).

# Integrations

- Anthropic API (backend only, `backend/.env`)
- Companies House: **two** separate keys — `COMPANIES_HOUSE_API_KEY` (REST, prospecting) and `COMPANIES_HOUSE_STREAM_KEY` (Streaming, live filing feed)
- Mailchimp export (Today page, pending email drafts)
- LinkedIn (chat-tool only, `tools/post_to_linkedin.py` + `linkedin_oauth_setup.py`, credentials via root `.env`)

# Important Project Rules

- `CLAUDE.md` is the single source of truth; `AGENTS.md` is only a pointer to it.
- Any `app/` change needs a version bump in **four** files (`app/package.json`, `app/src-tauri/tauri.conf.json`, `app/src-tauri/Cargo.toml`, the `app` block in `Cargo.lock`) + tag + push — CI fails the build if the tag doesn't match. See CLAUDE.md "Releasing the app."
- Backend deploys are separate (manual rsync) and Claude is blocked from running that command in auto mode — always hand it to the user.
- Editing any of the five production `workflows/*.md` prompts changes real users' live AI calls — see CLAUDE.md's "Production AI Prompts" table before touching any of them.
- `outputs/` and `output/` (two distinct dirs, both hold real client/customer data) must never be committed — both are gitignored as of 2026-08-10.

# Current State

App is at **v0.6.18**; backend has undeployed commits (Stage 0 + Stage 5 + Stage 3's tags migration below, plus the older pre-existing rate-limit throttle) — see Known Issues/Next Steps. A multi-release frontend redesign (v0.5.0 → v0.6.4, ~10 releases) moved the whole CRM to an "editorial operations workspace" look matching an approved design artifact — presentation-only, no feature/backend changes. See `CLAUDE.md`'s Design section for the current visual system.

# Current Work

Executing a full product/SaaS-readiness audit's roadmap (`audit/08-prioritised-roadmap.md`), by explicit user decision: **stay single-tenant** (Stage 1/6 skipped) and **no automation builder** (dropped from Stage 5 per explicit user instruction, 2026-08-12). Working through Stage 0 → 2 → 3 → 4 → 5 → 7, shipping in small verified increments (v0.6.12–v0.6.18 so far).

- **Stage 0 — code done, not yet deployed**: OAuth token encryption (`token_crypto.py`, migration 032) and Sentry error tracking. **Deploy blocker**: `TOKEN_ENCRYPTION_KEY` must be added to the VPS `backend/.env` *before* the next deploy or the backend refuses to start — generate via `python3 -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())"`. Full steps in `audit/implementation-spec-stage-0.md` §4. Two ops-only items still need your sign-off: installing `backend/deploy/backup.sh` on cron, and the DB-growth diagnosis query (both spec'd, not executed).
- **Stage 2 — mostly done**: reconnected the 3 orphaned screens, removed dead `data-admin-only` markup + the redundant Settings PIN gate, built a shared modal component (`components/modal.ts` — `openOverlay`/`confirmDialog`) and migrated **all** hand-rolled overlays onto it (finding 05-11 fully closed), fixed activityFeed.ts/aiProspecting.ts conflating "backend unreachable" with "not configured" (finding 05-14). Still open: the font-size/padding/border-radius token-consolidation pass (58%/31%/39% of declarations bypass the documented scale — large, mechanical, deliberately not yet attempted in one sweep given regression risk with no visual-diff tooling), loading/error-state standardisation on the remaining screens without a real skeleton.
- **Stage 3 — in progress**: kanban drag-and-drop board for Opportunities, a real Cmd/Ctrl+K command palette (nav + lead search), and freeform tags on leads (new `lead_tags` table, migration 034, side-panel chip UI — backend not yet deployed). Still open: saved/shared filter views, custom fields (bigger scope, needs a schema-flexibility decision — a fixed set of extra columns vs. a genuine key/value custom-field system).
- **Stage 4 — started, scoped down by explicit user decision**: shipped a self-service "Connectors" page (v0.6.18, `app/src/views/connectors.ts`) — Email (Connect Gmail/Microsoft, moved out of admin-only Settings; backend was already fully per-user with zero admin gate, this just gave it a reachable home) + Calling (informational only: the existing `tel:` fallback already works, user explicitly declined a named calling-provider integration — no Aircall, no calling-provider adapter, no connector framework abstraction). Nav entry deliberately has no `NAV_PERMISSIONS` entry so every role sees it. Still not started: connector framework groundwork, calendar sync (Google/Outlook) — only pursue if asked again.
- **Stage 5 — mostly done except automation (dropped)**: 5 missing `lead_id` indexes (migration 033), audit-log coverage gaps closed (user create/delete/password-reset, outbound email sends — `backend/tests/test_audit_log_coverage.py`), pipeline/conversion reporting shipped on Analytics (win rate, stage breakdown, reuses the kanban's stage data). **Deferred deliberately**: `/leads` pagination — the whole frontend assumes `state.ts` holds every lead at once for client-side filtering, so backend-only params would be unused plumbing without a bigger frontend rearchitecture.
- **Stage 7 — not started**: AI depth items (e.g. call summarisation — blocked on Stage 4's calling integration existing first).
- **Local dev note**: this Mac's backend `.venv` is Python 3.9, but `schemas_leads.py` uses `X | None` union syntax (3.10+) — any test importing `app.routers.leads` can't collect locally (not new; pre-existing, confirmed via git blame). CI (`backend-tests.yml`) runs 3.11 and is the real verification path for those — confirmed working (a full green run after the tags commit).

# Known Issues

- No Apple notarization (Gatekeeper "damaged app" on new Macs) — needs Apple Developer Program.
- No HTTPS (backend is plain HTTP to an IP) — needs a domain first.
- **DB backups exist but only fire on a schema migration** (`db.init_db()`'s automatic pre-migration backup, `BACKUP_RETENTION_COUNT=10`, uncompressed) — never on a plain restart, so real calendar-based coverage is missing between deploys. `backend/deploy/backup.sh` (cron, gzip'd, `KEEP=14`) was written to fill exactly this gap and was never installed — see Current Work / Stage 0.
- Production DB grew 58MB→1.68GB (~29x) in one month, cause not yet confirmed (see Current Work) — separate from the backup gap.
- Win-back emails have no unsubscribe link (blocked on domain/HTTPS).
- **Activity Feed name/number: RESOLVED and deployed (2026-08-11), verified live.** Two stacked bugs: (1) `COMPANIES_HOUSE_API_KEY` on the VPS was itself invalid — user rotated it, confirmed 200 via direct test. (2) `main.py` was passing a single key into `run_filing_stream()` for both the Streaming connection and the per-event REST follow-ups inside `_process_event()`, which need the separate, non-interchangeable `COMPANIES_HOUSE_API_KEY` — so the REST key was never actually used regardless of validity. Fixed by threading `stream_key`/`rest_api_key` through as distinct params. Deployed; confirmed live: resolved-name count jumped from 30 to 200+ within two minutes of restart, fresh rows showing real names. Also fixes AI Prospecting's CH enrichment, which shares the key path via `activity_refresh_service.py`.
- **New from the above fix, also fixed but not yet deployed**: once the charge feed could actually use `COMPANIES_HOUSE_API_KEY`, it started drawing enough volume (several events/sec, up to 2 REST calls each) to exhaust the whole account-wide CH rate limit (~600/5min) and 429 everything else sharing the key (confirmed live: a Lead Activity refresh call got 429 right after the deploy). Fixed with a 2s minimum-interval throttle scoped to just the stream's own REST calls (`ch_stream_service.py`), not a global limiter.
- **Backend deploy backlog** — not live on the VPS yet: the rate-limit throttle above, plus Stage 0 (OAuth token encryption + Sentry, needs `TOKEN_ENCRYPTION_KEY` set first) and Stage 5 (lead_id indexes + audit-log gaps) from Current Work. (Self-registration, win-back FK fix, and the CH key-separation fix are already deployed.)

# Decisions

- Redesign is presentation-only by explicit instruction: keep every existing feature/button/action; only the visual layer changes.
- `output/` and `outputs/` both stay as separate, gitignored, uncommitted local dirs (not merged/renamed) — their real client data must never enter git history.
- `AGENTS.md` stays a thin pointer, not a duplicate manual — re-collapsed 2026-08-10 after silently reverting once already (see `audits/os-audit-2026-08-10.md`).
- v0.6.5–v0.6.11: worklist/loading-state regression fixes, closed self-registration, identity-panel CSS fix, CI conftest fix, Activity Feed name/number display, win-back FK-constraint 500, Today page worklist improvements, avatar consistency fix, and global session-expiry auto-sign-out. See git log for detail on any of these.
- **2026-08-12: commissioned a full product/SaaS-readiness audit** (`audit/`, 11 docs + scripts) — score 40/100, verdict: mature single-tenant tool, not SaaS-ready (no tenant isolation at all). User decided **stay single-tenant**, skip Stage 1 (multi-tenant foundations) and Stage 6 (commercial launch) — see Current Work for the roadmap now being executed.
- User dropped the automation builder entirely (2026-08-12) — removed from scope, not deferred.
- Shipped **v0.6.12 → v0.6.17** executing the roadmap: Stage 0 backend (token encryption, Sentry — undeployed), Stage 2 (orphaned-screen reconnection, PIN-gate removal, full modal consolidation, offline-vs-unconfigured error-state fix), Stage 3 (kanban Opportunities board, command palette, freeform lead tags — tags migration undeployed), Stage 5 (missing indexes + audit-log gaps, both undeployed; pipeline/conversion reporting on Analytics, shipped). See Current Work for what's still open in each stage, and commit messages / `audit/implementation-spec-stage-0.md` for full technical detail.
- **v0.6.18**: started Stage 4 but explicitly scoped down after asking — user confirmed calling should stay `tel:`-only (their calling app, "Communicator"/communicator.net, has no public API to integrate against — checked live, no dev docs exist) and wanted email connectors live *now*, not the full connector-framework/named-provider work the roadmap originally scoped. Shipped exactly that slice; the framework/calendar-sync/Aircall items in Stage 4 remain genuinely not started.

# Next Steps

1. **Deploy the backend** — Stage 0, Stage 5, and the tags migration (034) are all undeployed, plus the older rate-limit throttle. **Ordering matters**: `TOKEN_ENCRYPTION_KEY` must be added to the VPS `.env` before this deploy or the backend won't start — see Current Work / `audit/implementation-spec-stage-0.md` §4.
2. Install the backup cron and run the DB-growth diagnosis query (both spec'd, need user sign-off — see Current Work).
3. Continue the roadmap: Stage 2 remainder (token consolidation, loading-state standardisation), Stage 3 remainder (saved views, custom fields), then Stage 4 (integrations), 7 (AI depth) — see `audit/08-prioritised-roadmap.md`.
4. Keep this file updated after each meaningful change (see CLAUDE.md's Context Management Rules).
