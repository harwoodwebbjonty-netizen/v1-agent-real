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

App is at **v0.6.6** (frontend); backend has NOT yet been redeployed to the VPS with the v0.6.6 auth.py change (see Next Steps — deploy command must be run manually, Claude is blocked from running it). A multi-release frontend redesign (v0.5.0 → v0.6.4, ~10 releases) moved the whole CRM to an "editorial operations workspace" look matching an approved design artifact — presentation-only, no feature/backend changes. See `CLAUDE.md`'s Design section for the current visual system (grouped nav, footer identity block, system-sans typography, numbered sections, timeline-rail worklist, editorial tables/panels).

# Current Work

A full 18-section production-readiness audit was completed (2026-08-11, read-only, not saved to a file — exists only in that chat session). Its "Immediately" tier: (1) close open self-registration — done, (2) fix unguarded `Promise.all` calls — done, (3) confirm/fix identity-panel clipping regression — still open, not yet investigated.

Also open: `activityFeed.ts` rows show company name or number, never both — `renderChRow` (~line 146, falls back via `??`) and `renderDgRow` (~line 203, name only, no fallback). Documented, not fixed.

# Known Issues

- No Apple notarization (Gatekeeper "damaged app" on new Macs) — needs Apple Developer Program.
- No HTTPS (backend is plain HTTP to an IP) — needs a domain first.
- No automated DB backups on the VPS.
- Win-back emails have no unsubscribe link (blocked on domain/HTTPS).
- Identity-panel clipping regression (from the 2026-08-11 audit) — not yet investigated.
- **v0.6.6 backend fix not yet deployed to the VPS** — `auth.py`'s self-registration close only takes effect once `backend/app/` is rsynced and the service restarted (see CLAUDE.md "Deploying the backend").

# Decisions

- Redesign is presentation-only by explicit instruction: keep every existing feature/button/action; only the visual layer changes.
- `output/` and `outputs/` both stay as separate, gitignored, uncommitted local dirs (not merged/renamed) — their real client data must never enter git history.
- `AGENTS.md` stays a thin pointer, not a duplicate manual — re-collapsed 2026-08-10 after silently reverting once already (see `audits/os-audit-2026-08-10.md`).
- Fixed the "no leads/no worklist" regression, shipped as **v0.6.5**: three call sites (`dashboard.ts`, `actionCentre.ts`, `callQueue.ts`) ran `Promise.all([refreshLeads(), ...])` with no `.catch`; a single rejection (e.g. session expiry) silently left `dashboard.ts`'s `isInitialLoad` flag stuck `true` forever, so the Leads table showed permanent loading skeletons with no error. Now caught + surfaced via `showToast`, and `isInitialLoad` still flips on failure so it falls through to the proper empty state. Verified live with Playwright (mocked `window.__TAURI_INTERNALS__.invoke` to reject) showing the before/after contrast.
- Closed self-registration, shipped as **v0.6.6** (frontend) — backend not yet deployed: `POST /auth/identify` ([auth.py](backend/app/routers/auth.py)) used to silently create a new "member" account for any unrecognized name+password with no admin involvement; since the backend is plain HTTP on a public IP and the lead pool is shared across all members, anyone reaching it could self-register into real client data. Now only the very first account on a fresh deployment (bootstrap-token gated) can be created this way — everyone else must already exist (admin creates via `POST /users` + `POST /users/{id}/set-password`, the pre-existing safe path). Frontend gate added in `identitySwitcher.ts`'s `join()` so the "Create profile" modal no longer opens for unknown names once the team roster is non-empty; shows a toast instead. Covered by a new regression suite, `backend/tests/test_auth_self_registration.py` (4 tests, all passing alongside the other 30 backend tests). Also verified live with Playwright against the real frontend.

# Next Steps

1. **Deploy the backend** — the v0.6.6 `auth.py` self-registration fix is committed but not live on the VPS. Hand the user the rsync+restart command from CLAUDE.md, then verify `/health` and do a quick manual check that an unknown name is now rejected.
2. Investigate and fix the identity-panel clipping regression (last open item from the 2026-08-11 audit's "Immediately" tier).
3. Fix the Activity Feed name/number finding (see Current Work).
4. Keep this file updated after each meaningful change (see CLAUDE.md's Context Management Rules) — it was created 2026-08-10 and has no history before that.
