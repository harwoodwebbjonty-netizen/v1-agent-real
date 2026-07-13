# Agent Instructions

You're working inside the **WAT framework** (Workflows, Agents, Tools). This architecture separates concerns so that probabilistic AI handles reasoning while deterministic code handles execution. That separation is what makes this system reliable.

## The WAT Architecture

**Layer 1: Workflows (The Instructions)**
- Markdown SOPs stored in `workflows/`
- Each workflow defines the objective, required inputs, which tools to use, expected outputs, and how to handle edge cases
- Written in plain language, the same way you'd brief someone on your team

**Layer 2: Agents (The Decision-Maker)**
- This is your role. You're responsible for intelligent coordination.
- Read the relevant workflow, run tools in the correct sequence, handle failures gracefully, and ask clarifying questions when needed
- You connect intent to execution without trying to do everything yourself
- Example: If you need to pull data from a website, don't attempt it directly. Read `workflows/scrape_website.md`, figure out the required inputs, then execute `tools/scrape_single_site.py`

**Layer 3: Tools (The Execution)**
- Python scripts in `tools/` that do the actual work
- API calls, data transformations, file operations, database queries
- Credentials and API keys are stored in `.env`
- These scripts are consistent, testable, and fast

**Why this matters:** When AI tries to handle every step directly, accuracy drops fast. If each step is 90% accurate, you're down to 59% success after just five steps. By offloading execution to deterministic scripts, you stay focused on orchestration and decision-making where you excel.

## How to Operate

**1. Look for existing tools first**
Before building anything new, check `tools/` based on what your workflow requires. Only create new scripts when nothing exists for that task.

**2. Learn and adapt when things fail**
When you hit an error:
- Read the full error message and trace
- Fix the script and retest (if it uses paid API calls or credits, check with me before running again)
- Document what you learned in the workflow (rate limits, timing quirks, unexpected behavior)
- Example: You get rate-limited on an API, so you dig into the docs, discover a batch endpoint, refactor the tool to use it, verify it works, then update the workflow so this never happens again

**3. Keep workflows current**
Workflows should evolve as you learn. When you find better methods, discover constraints, or encounter recurring issues, update the workflow. That said, don't create or overwrite workflows without asking unless I explicitly tell you to. These are your instructions and need to be preserved and refined, not tossed after one use.

## The Self-Improvement Loop

Every failure is a chance to make the system stronger:
1. Identify what broke
2. Fix the tool
3. Verify the fix works
4. Update the workflow with the new approach
5. Move on with a more robust system

This loop is how the framework improves over time.

## File Structure

**What goes where:**
- **Deliverables**: Final outputs go to cloud services (Google Sheets, Slides, etc.) where I can access them directly
- **Intermediates**: Temporary processing files that can be regenerated

**Directory layout:**
```
.tmp/           # Temporary files (scraped data, intermediate exports). Regenerated as needed.
tools/          # Python scripts for deterministic execution
workflows/      # Markdown SOPs defining what to do and how
.env            # API keys and environment variables (NEVER store secrets anywhere else)
credentials.json, token.json  # Google OAuth (gitignored)
```

**Core principle:** Local files are just for processing. Anything I need to see or use lives in cloud services. Everything in `.tmp/` is disposable.

## Desktop App + Backend (added alongside the WAT framework)

This repo also contains a standalone desktop app, separate from the chat-based WAT workflow above:

- `backend/` — FastAPI service that owns all Anthropic API calls for the "find company phone number" task. Reads `ANTHROPIC_API_KEY` from its own `backend/.env` (never committed). See `backend/README.md`.
- `app/` — Tauri (Rust + vanilla TypeScript/Vite) desktop app. Contains **no API keys and no direct Anthropic calls** — it only calls the backend over HTTP. Builds installers for macOS/Windows via `.github/workflows/release.yml`.

These two have their own logs: the app writes lookups to the OS app-data directory (not this repo's `data/`), while `tools/log_phone_lookup.py` + `data/phone_lookups.csv` remain the separate log for manual, chat-based lookups using this repo's `workflows/find_company_phone_number.md` SOP directly in a Claude Code session. The desktop app's backend also reads that same SOP file (as its system prompt) so the logic stays in one place.

## Desktop App Operations — ALWAYS check this list

These are hard-won rules. When I ask for a change, check whether any of these
steps apply and **call out anything I've missed** before finishing.

### Releasing the app (after ANY app/ change)
1. Bump `version` in `app/src-tauri/tauri.conf.json` — CI **fails the build**
   if the tag doesn't match this version (guard added after v0.1.70/71
   silently published into the old release).
2. Commit, tag `v<version>`, push main **and** the tag. CI builds take
   ~15–20 min; the auto-updater only sees the release once `latest.json`
   uploads at the end.
3. Verify: `gh api repos/harwoodwebbjonty-netizen/v1-agent-real/releases`
   should show the new tag with 9 assets.

### Deploying the backend (after ANY backend/ change)
App releases do **not** deploy the backend — it must be pushed to the VPS
separately, and Claude is blocked from doing this in auto mode, so always
give me this command and remind me to run it:

```
rsync -az -e "ssh -i ~/.ssh/v1_agent_vps" "/Users/jontyhw/v1 agent/backend/app/" root@213.165.88.45:/opt/v1-agent/backend/app/ && ssh -i ~/.ssh/v1_agent_vps root@213.165.88.45 "systemctl restart phone-lookup-backend"
```

Verify after deploy: `curl http://213.165.88.45/health` → `{"status":"ok"}`.
**The backend is served on port 80 via a proxy — port 8000 is firewalled.**
New DB migrations run automatically on service restart.

### System facts (don't rediscover these)
- **Auth**: name + password (min 4 chars). Legacy accounts are claimed by
  their first post-password login. First-ever profile = admin. Sessions
  last 30 days in `session.json` in the app-data dir.
- **Admin-only** (backend-enforced + hidden from members' sidebar):
  Settings, Win-back, starting AI Prospecting runs, credit-limit changes,
  team management, lead migration. Members keep all calling/sales tools.
- **Credit limits**: every paid feature has a per-user monthly ceiling.
  Unset = default (£20 most features, £50 prospecting, £10 lead chat) —
  never unlimited. Batch jobs stopped at the ceiling are resumable:
  win-back campaigns via the Resume button (campaigns from before v0.1.79
  can't resume — no stored lead list), prospecting via "Run again"
  (dedupe skips existing leads free).
- **Companies House needs TWO keys**: `COMPANIES_HOUSE_API_KEY` (REST, for
  prospecting) and `COMPANIES_HOUSE_STREAM_KEY` (Streaming, for the live
  filing feed). Both in the VPS `backend/.env`.
- **DB**: SQLite at `/opt/v1-agent/backend/data/team.db`, WAL mode,
  migrations in `backend/app/db.py` (bump `CURRENT_SCHEMA_VERSION`, append
  to `MIGRATIONS`, never edit shipped ones). CH feed self-prunes to 30 days.
- **Design**: light-only (no theme toggle), font ui-rounded, text colours
  limited to blue/green/red + neutrals, coloured per-section nav icons.

### Known gaps — flag these when relevant
- No Apple notarization: new Mac users hit Gatekeeper "damaged app"
  (needs Apple Developer Program, $99/yr). Windows: SmartScreen warning.
- No HTTPS: backend is plain HTTP to an IP (needs a domain first).
- No automated DB backups on the VPS (script prepared? check before
  assuming).
- Shared lead pool: leads outside a list are visible/editable to ALL
  users — deliberate, but flag it when it interacts with a change.
- Win-back emails have no unsubscribe link (blocked on domain/HTTPS).

## Bottom Line

You sit between what I want (workflows) and what actually gets done (tools). Your job is to read instructions, make smart decisions, call the right tools, recover from errors, and keep improving the system as you go.

Stay pragmatic. Stay reliable. Keep learning.
