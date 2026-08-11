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

App is at **v0.6.9** (frontend); backend has NOT yet been redeployed to the VPS with the v0.6.6 auth.py change or the win-back fix (see Next Steps — deploy command must be run manually, Claude is blocked from running it). A multi-release frontend redesign (v0.5.0 → v0.6.4, ~10 releases) moved the whole CRM to an "editorial operations workspace" look matching an approved design artifact — presentation-only, no feature/backend changes. See `CLAUDE.md`'s Design section for the current visual system (grouped nav, footer identity block, system-sans typography, numbered sections, timeline-rail worklist, editorial tables/panels).

# Current Work

The 2026-08-11 production-readiness audit's "Immediately" tier and Activity Feed finding are done (see Decisions). Since then, two live-reported bugs surfaced and were fixed: the Activity Feed name/number display was correct but exposed a real backend data problem (see Known Issues — CH API key), and a win-back campaign 500 error (see Decisions). **Three backend commits (v0.6.6 self-registration, and two unversioned backend-only fixes) are still not deployed to the VPS** — see Next Steps.

# Known Issues

- No Apple notarization (Gatekeeper "damaged app" on new Macs) — needs Apple Developer Program.
- No HTTPS (backend is plain HTTP to an IP) — needs a domain first.
- No automated DB backups on the VPS.
- Win-back emails have no unsubscribe link (blocked on domain/HTTPS).
- **`COMPANIES_HOUSE_API_KEY` on the VPS has been invalid since at least 2026-07-12** (confirmed via prod logs: every CH REST call returns 401, zero 200s in the last 24h). This is the *actual* root cause behind "Activity Feed only shows numbers, not names" — 1,467,084 of 1,467,114 `ch_charge_feed` rows have `company_name == company_number` because name resolution has been silently falling back for a month. It also feeds AI Prospecting's enrichment (officers/charges/PSC/filing-history all use the same key), so prospecting scoring has likely been running on empty CH profile data for the same month. **Needs the user to regenerate the key in their Companies House Developer Hub account and update it in `/opt/v1-agent/backend/.env`** — not something fixable in code. (`COMPANIES_HOUSE_STREAM_KEY` is separate and working fine.)
- **Backend deploy backlog** — see Next Steps.

# Decisions

- Redesign is presentation-only by explicit instruction: keep every existing feature/button/action; only the visual layer changes.
- `output/` and `outputs/` both stay as separate, gitignored, uncommitted local dirs (not merged/renamed) — their real client data must never enter git history.
- `AGENTS.md` stays a thin pointer, not a duplicate manual — re-collapsed 2026-08-10 after silently reverting once already (see `audits/os-audit-2026-08-10.md`).
- Fixed the "no leads/no worklist" regression, shipped as **v0.6.5**: three call sites (`dashboard.ts`, `actionCentre.ts`, `callQueue.ts`) ran `Promise.all([refreshLeads(), ...])` with no `.catch`; a single rejection (e.g. session expiry) silently left `dashboard.ts`'s `isInitialLoad` flag stuck `true` forever, so the Leads table showed permanent loading skeletons with no error. Now caught + surfaced via `showToast`, and `isInitialLoad` still flips on failure so it falls through to the proper empty state. Verified live with Playwright (mocked `window.__TAURI_INTERNALS__.invoke` to reject) showing the before/after contrast.
- Closed self-registration, shipped as **v0.6.6** (frontend) — backend not yet deployed: `POST /auth/identify` ([auth.py](backend/app/routers/auth.py)) used to silently create a new "member" account for any unrecognized name+password with no admin involvement; since the backend is plain HTTP on a public IP and the lead pool is shared across all members, anyone reaching it could self-register into real client data. Now only the very first account on a fresh deployment (bootstrap-token gated) can be created this way — everyone else must already exist (admin creates via `POST /users` + `POST /users/{id}/set-password`, the pre-existing safe path). Frontend gate added in `identitySwitcher.ts`'s `join()` so the "Create profile" modal no longer opens for unknown names once the team roster is non-empty; shows a toast instead. Covered by a new regression suite, `backend/tests/test_auth_self_registration.py` (4 tests, all passing alongside the other 30 backend tests). Also verified live with Playwright against the real frontend.
- Fixed the identity-panel clipping regression, shipped as **v0.6.7**: `.identity-panel-new .search-input` had `flex: 1` but no `min-width: 0`, so its intrinsic content width refused to shrink and pushed the "Join" button past the panel's right edge; `.app-sidebar`'s `overflow: hidden` (added in the v0.5.0 redesign, needed for the width-collapse transition) then hard-clipped it, cutting the button off mid-label. Root cause confirmed with a Playwright screenshot before fixing. Fix is the standard flexbox one-liner (`min-width: 0`) rather than touching the sidebar's `overflow: hidden`, which other things may depend on. Verified with a before/after screenshot — Join button fully visible after the fix.
- The v0.6.6 push exposed a latent CI gap (fixed same day, not version-tagged since it's test-only): `backend/tests/` had no `conftest.py`, so any test importing a router module (my new `test_auth_self_registration.py` was the first) evaluated `get_settings()` at import time via `auth.py`'s `@limiter.limit(get_settings().auth_rate_limit)` decorator argument — which requires `ANTHROPIC_API_KEY`, satisfied locally by `backend/.env` (gitignored) but absent in CI, breaking collection for the *whole* suite. Fixed with `backend/tests/conftest.py` setting a dummy key via `os.environ.setdefault` before collection; confirmed by temporarily removing `backend/.env` locally and re-running — same failure reproduced, then fixed. Pushed straight to `main` (backend-only, no version bump needed).
- Fixed the Activity Feed name/number finding, shipped as **v0.6.8**: `renderChRow` ([activityFeed.ts](app/src/views/activityFeed.ts)) fell back to showing company_number only when name was null (never both); `renderDgRow` showed name only, never the number, even though `ActivityEvent.company_number` is always present. Both rows now show name + number (new shared `.company-number` CSS class, mono per the design system's convention for operational/data text). Verified live with Playwright + screenshot on both tabs — display logic is correct; the "still only shows numbers" the user then saw live is the CH API key issue above, not this code.
- Fixed a win-back "Generate Campaign" 500, pushed to `main` (backend-only, no version bump): `create_campaign_from_csv` ([win_back.py](backend/app/routers/win_back.py)) inserted `win_back_emails` rows (FK → `win_back_campaigns.id`) for rows reusing a cached preview *before* the parent `win_back_campaigns` row existed (that insert happened after the whole loop). Any campaign with at least one cached-preview row hit `sqlite3.IntegrityError: FOREIGN KEY constraint failed` and 500'd — confirmed via production logs, reproduced locally by reverting the fix and running the new test, then fixed by deferring those inserts until after the campaign row is created. `backend/tests/test_win_back_campaign_from_csv.py` (2 tests) added.
- Today page changes, shipped as **v0.6.9** (frontend only): (1) Worklist rows now have a real completion action — call/follow-up rows backed by a calendar event get a "Done" button (`deleteEvent`, confirm dialog; doesn't log a call outcome, that's still Call Queue/Cold Call Lists' job) — follow-ups with no backing event (purely `next_best_action`-driven) and research rows don't get one, since there's nothing real to mark done without doing the actual work. Draft rows get a real "Delete" button — `deleteEmailDraft` existed in `api.ts` but had no UI anywhere before this. (2) "Next calls" no longer implies it's the whole calling task list — added a "Carry on calling" strip above it showing the rep's own most-recent in-progress `LeadList` (owner match, `called < total`) with live progress, using the new `coldCallListHandoff` to jump straight into that list's detail view; "Start calling" does the same. (3) Added an "Upcoming" list (next 6 calendar events with `date > today`, all types) below "Next calls" so future items are visible without opening the Calendar tab.

# Next Steps

1. **Deploy the backend** — three commits are live on `main` but not on the VPS: v0.6.6's self-registration close, the win-back campaign 500 fix, and the conftest.py CI fix (no-op in prod, ships along for free). Hand the user the rsync+restart command from CLAUDE.md, then verify `/health`, that an unknown name is rejected, and that generating a win-back campaign with a cached-preview row no longer 500s.
2. **Companies House REST API key** — needs the user to regenerate `COMPANIES_HOUSE_API_KEY` (see Known Issues) and update the VPS `.env`; not fixable from here.
3. Keep this file updated after each meaningful change (see CLAUDE.md's Context Management Rules) — it was created 2026-08-10 and has no history before that.
