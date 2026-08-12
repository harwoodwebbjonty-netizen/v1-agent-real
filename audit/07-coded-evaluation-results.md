# 07 — Coded Evaluation Results

Repo: `/Users/jontyhw/v1 agent` · Commit: `8c923ac5e703928e3f94721e6c11593a5c397f7d` · Evaluated: 2026-08-12T09:41Z (metadata timestamp recorded at audit start; individual script runs timestamped in their own JSON output)

All scripts below are read-only static analysis or run-existing-test-suite operations. None of them write to, delete from, or modify any file outside `audit/`. The only "execution" performed is running the project's own pre-existing backend test suite (confirmed isolated — see §3) and TypeScript/Vite build tooling (type-checking and bundling are inherently read-only with respect to source).

## 1. Scripts created

| Script | Purpose | Output |
|---|---|---|
| `audit/scripts/backend_route_inventory.py` | Regex scan of `backend/app/routers/*.py` for every route: method, path, auth-dependency presence, pagination hints | `audit/results/backend_routes.json` |
| `audit/scripts/schema_index_scan.py` | Regex scan of `backend/app/db.py`'s `CREATE TABLE`/`CREATE INDEX` statements to find FK-shaped columns with no covering index | `audit/results/schema_index_scan.json` |
| `audit/scripts/misc_scans.py` | Secrets grep, `.gitignore` hygiene, hardcoded-style-value counts, largest-file inventory, TODO/console-log counts, and runs of `pytest`/`tsc --noEmit`/`vite build` | `audit/results/misc_scans.json` |

Each script has a module docstring with usage instructions, states its method and known heuristic limitations inline, records the commit hash and a UTC timestamp in its own output, and exits non-zero only on a genuine tool failure (e.g. a missing directory) — not because it found product issues, per the audit's own instruction to distinguish tool failure from product failure.

Run individually via:
```
python3 audit/scripts/backend_route_inventory.py
python3 audit/scripts/schema_index_scan.py
python3 audit/scripts/misc_scans.py
```
All three were run to completion at the time of writing; all exited 0.

## 2. Backend route inventory results

- **20 router files, 124 routes total.**
- **Auth coverage: 121/124 routes have a recognized auth dependency on first pass; all 3 remaining were manually verified as intentionally public** (`POST /auth/identify` — login itself; `GET /users/names` — slim name+avatar-only pre-auth login picker, confirmed by reading `users.py:20-25`; `GET /email-oauth/{provider}/callback` — protected instead by a single-use CSRF `state` nonce, not a bearer session, confirmed by reading `email_oauth_service.py:69-114`). **Zero accidental unauthenticated endpoints found.**
- The script's first pass also flagged 10 routes as "no auth," 7 of which were **false positives** from the regex's limited vocabulary (it didn't initially recognize `Depends(require_admin)` or a module-level `_manage = require_permission(...)` alias pattern used throughout `roles.py`). The script was corrected in place (added `require_admin` and single-level alias resolution) after manual verification — this is exactly the kind of tool-failure-vs-product-failure distinction the audit asked for: the *initial* 10 was a scanner limitation, not 10 real gaps. Final corrected count: 3, all legitimate.
- **22 GET endpoints look like unbounded collection endpoints with no `limit`/`offset`/`cursor`/`page` parameter** in their signature (heuristic — a true positive was independently confirmed by reading `leads.py:242-247`'s `GET /leads`, which calls `db.list_all_leads_for_user(...)` with no pagination arguments at all, and `users.py:28-31`'s `GET /users` likewise). At current data volumes (order of ~1,000 leads per the project's own tracked state) this is not an active incident, but it is a real, verified scalability gap: every list view in the app currently loads its entire table on every request.

Full per-route detail (method, path, which auth dependency matched, pagination hint) is in `audit/results/backend_routes.json`.

## 3. Test suite results

- **Backend: `pytest tests/ -q` → 40 passed, 0 failed, 2.06–2.23s.** Safety confirmed before running: every one of the 9 test files defines or uses an `isolated_db` fixture (`tmp_path` + `monkeypatch.setattr(db, "DB_PATH", ...)`, confirmed in `tests/conftest.py` and spot-checked in `tests/test_v030_hardening.py:14-18` and `tests/test_sequences.py:11-17`) — the suite never touches `backend/data/team.db`. Safe to have run in full.
- **Frontend: `npx tsc --noEmit` → exit 0, no output.** Clean type-check across the whole `app/src` tree at this commit.
- **Frontend: `npx vite build` → exit 0.** Production build succeeds. One informational warning (not an error) from the bundler: `[INEFFECTIVE_DYNAMIC_IMPORT]` — `api.ts` is dynamically imported in one place (`components/sidePanel.ts`) but also statically imported nearly everywhere else, so the dynamic import has no effect (Vite/Rolldown can't split it into its own chunk). Pre-existing, not introduced by this audit.
- **No test coverage tooling configured** — no `coverage.py`/`pytest-cov` config found for the backend, no test runner at all configured for the frontend (no Jest/Vitest/Playwright in `app/package.json`'s `devDependencies` — confirmed by reading the file directly: only `@tauri-apps/cli`, `typescript`, `vite`). **Frontend test coverage is 0% by construction — there are no frontend tests, not merely low-coverage ones.** Backend coverage is unmeasured (no coverage tool run), though 40 tests across 9 files exist and do meaningfully exercise auth self-registration, DB migrations, sequences, win-back campaign creation, and v0.3.0 hardening changes (test file names read directly from `backend/tests/`).

## 4. Schema/index scan results

- **33 tables, 28 explicit indexes** parsed from `backend/app/db.py`.
- **21 `*_id`-shaped columns have no explicit covering index; 2 are primary keys (false positives — SQLite indexes these implicitly), leaving 19 real gaps.**
- Cross-referencing which of those 19 are actually used in a `WHERE ... = ?` clause elsewhere in `db.py` (a heuristic proxy for "is this column actually queried unindexed," not a precise per-table count — see the script's own documented caveat that this count is global-by-column-name, not scoped per table), the columns most worth prioritizing if/when data volume grows are `lead_phones.lead_id`, `lead_emails.lead_id`, `calendar_events.lead_id`, `ch_charge_feed.lead_id`, and `win_back_emails.lead_id` — all **manually confirmed absent from the indexed-columns list** by direct inspection of every `CREATE INDEX` statement in `db.py` (there are indexes for `lead_intelligence_versions.lead_id`, `email_drafts.lead_id`, `call_logs.lead_id`, `sequence_enrollments.lead_id`, `activity_events.lead_id`, and `lead_linkedin_posts.lead_id` — but not for the five listed above). `lead_phones` and `lead_emails` in particular are queried on every single lead-record view (phones/emails are rendered on every lead card), making them the most impactful of the five despite currently small absolute row counts.
- This is a real, low-urgency-today, worth-fixing-before-scale finding — full detail in `audit/results/schema_index_scan.json`.

## 5. Misc scans results

- **Secrets scan: 0 hits** for `sk-`/`AKIA`/`xox*`-shaped patterns across all of `backend/app` and `app/src`.
- **`.gitignore` hygiene: correct at both root and `backend/` level**; `git ls-files` confirms no real `.env`, `credentials.json`, or `token.json` is tracked (only `backend/.env.example`, a placeholder template).
- **Hardcoded style values in the frontend**: 26 raw hex-color literals and 104 inline `style="..."` attribute occurrences across `app/src/**/*.ts`, concentrated in `aiProspecting.ts` (21 inline styles), `winBackCampaign.ts` (17), `settings.ts` (16), `analytics.ts` (12 inline + 8 hex — the hex ones are Chart.js `backgroundColor` values, including the brand accent `#E31346` hardcoded rather than read from the CSS custom property at render time), `sidePanel.ts` (6 hex), and `avatar.ts` (6 hex — a deliberate distinct fallback-avatar color palette, defensible as intentional rather than a token-system violation). Full per-file breakdown in `audit/results/misc_scans.json`; narrative interpretation in the Visual/UX audit doc.
- **Largest files by line count**: `backend/app/db.py` (2,760 lines — a single file holding the entire schema, all migrations, and every query function; a real maintainability concern, though consistent with SQLite-direct-access codebases that avoid an ORM), `app/src/views/coldCallLists.ts` (1,352), `app/src/api.ts` (1,274 — expected, given it's the single client for ~150 backend functions), `app/src/views/winBackCampaign.ts` (1,028), `app/src/views/aiProspecting.ts` (961), `backend/app/routers/leads.py` (938), `backend/app/routers/win_back.py` (837).
- **Zero TODO/FIXME/HACK/XXX comments and zero `console.log`/`console.debug`/bare `print()` statements** found across the entire frontend and backend source trees — a genuinely clean result indicating good hygiene discipline (no debug leftovers, no unresolved-marker technical debt visible in comments).
- **Production bundle**: a single JS chunk of 527,103 bytes (~151.87KB gzipped per Vite's own report) and a single CSS file of 90,634 bytes, with no code-splitting — every one of the ~15-18 view screens ships in one bundle regardless of which tab a user opens first. Not a problem at the current small-team, desktop-app, LAN-adjacent-VPS scale, but worth tracking if the view count keeps growing.

## 6. Tooling limitations encountered

- **No live browser/UI automation was performed.** This is a native Tauri desktop application, not a website — standard web automation tooling (Playwright/Cypress driving a browser) does not apply directly, and launching+driving the actual compiled desktop binary was judged out of proportion to this audit's read-only, no-dependency-install mandate. Phase 6's 15-workflow click-count/time-to-completion evaluation was therefore done as **static code-path tracing** (reading the actual view/handler code to count clicks and screens a workflow requires) rather than live timed interaction — this is recorded as a tooling limitation, not fabricated as measured data. Where a workflow's code path doesn't exist at all (e.g. "connect an integration" beyond email OAuth, "configure a pipeline" as a distinct concept), it is recorded as **missing**, not estimated.
- **Direct production-database queries were blocked by this environment's own safety controls** (twice attempted, twice denied by the permission classifier, for even a read-only `SELECT count(*)`/`PRAGMA` against the live VPS SQLite file) — see the SaaS/Security doc for the resulting DB-growth finding, which is based on file-size and filesystem observation (`ls`, `df`, `crontab -l`) rather than row-level query data. This is flagged as an explicit, honest limitation rather than worked around.
- **No frontend lint/static-analysis tool is configured** (`app/` has no `.eslintrc*`, `eslint.config.*`, or `biome.json` — confirmed by direct file-existence check) — so "existing lint results" (as the audit spec requests) don't exist to report; this absence is itself recorded as a finding (see Feature Gap Matrix, "Testing & maintainability").
- **Bundle-size/unused-dependency/circular-dependency analysis** was done via the build output and manual import inspection rather than a dedicated tool (no `depcheck`/`madge`/bundle-analyzer configured in the repo, and installing one would have violated the "do not install dependencies" constraint) — the figures reported above (527KB single bundle) come directly from Vite's own build output, not a third-party analyzer.
