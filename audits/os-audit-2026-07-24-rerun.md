# OS Audit (re-run) — 2026-07-24

Second run the same day, after the morning audit's fix list was applied. Compare against `audits/os-audit-2026-07-24.md` (the "before"). Still read-only; this report is the only write.

**Knowledge current through:** the code/situational layer is live (2026-07-24, app v0.2.14) **and the always-consulted expertise layer now matches it** — `AGENTS.md` is a pointer, `CLAUDE.md` carries the current design + SOP map, and the hardening memory has been refreshed to v0.2.14 / port 80. The ~12-day expertise-layer lag from the morning run is closed.

| Check | Was (AM) | Now | Worst remaining finding |
|---|---|---|---|
| Routing integrity  | 🔴 RED    | 🟢 GREEN  | `audits/` dir not yet in the CLAUDE.md directory map (trivial) |
| Index truth        | 🟡 YELLOW | 🟢 GREEN  | — MEMORY.md accurate, all entries resolve |
| Freshness          | 🟡 YELLOW | 🟢 GREEN  | — memory refreshed; no frozen feeds |
| Bloat/duplication  | 🟡 YELLOW | 🟢 GREEN  | empty `.claude/` dir (cosmetic) |
| Hygiene            | 🟡 YELLOW | 🟡 YELLOW | real work still uncommitted (awaiting your commit decision) |
| Context placement  | 🔴 RED    | 🟢 GREEN  | — precedence rule now exists |

Secrets remain clean: `.env` untracked, `backend/.env` untracked, no token files on disk.

## Failure-mode exposure

| Mode | Was (AM) | Now | Driven by |
|---|---|---|---|
| Poisoning (false)            | HIGH | **LOW** | design clash resolved; hardening memory refreshed |
| Bloat (too much)             | MED  | **LOW** | duplicate manual collapsed to an 8-line pointer; `outputs/` gitignored |
| Confusion (wrong or missing) | MED  | **LOW** | `n8n/`+`outputs/` mapped, 5 live SOPs + call sites documented; only `audits/` unmapped |
| Clash (contradictory)        | HIGH | **LOW** | single source of truth + explicit precedence rule |

## Since last audit

**Fixed (verified on disk):**
- **The two-manual design clash (was the #1 RED).** `AGENTS.md` is now an 8-line pointer to `CLAUDE.md` with a precedence line and zero design-spec/architecture content (`grep` for quicksand/poppins/4F6BFF/design → none). No agent can read the wrong design from it anymore.
- **Precedence rule added** to `CLAUDE.md:3` — a "Source of truth" block stating CLAUDE.md wins over other docs/memory and that `app/src/style.css` is authoritative for the design system. This closes the Context-placement RED.
- **4 previously-undocumented live SOPs now documented** — `CLAUDE.md` "Production AI Prompts" is a table mapping all five `workflows/*.md` prompts to their exact backend call sites (config.py + the four service files), plus a reverse note that `linkedin_post.md`/`win_back_ui_process.md` are *not* backend prompts.
- **Unmapped dirs mapped** — the CLAUDE.md directory block now lists `outputs/`, `n8n/`, `data/`, `app/`, `backend/`, and the scorecard.
- **Stale memory refreshed** — `project_hardening_status.md` + `MEMORY.md` now say backend deployed / app v0.2.14 / port 80 (the false "VPS backend deploy pending" and `:8000` are gone).
- **`.gitignore` hardened** — `credentials.json`, `token.json` (the manual's claimed-ignored files), plus `outputs/` and `*.inspect.ndjson` (scratch). Verified the rules match, and that no already-tracked file was newly ignored.

**Got worse:** nothing.

**New:**
- **`audits/` is a new top-level dir not yet in the CLAUDE.md map.** Created by this skill; self-describing, so low risk — but by the audit's own "unmapped = invisible" rule it's a (tiny) confusion item. One line to add. **[confusion — trivial]**

## Findings by check

- **Routing — GREEN.** All manual paths resolve; `AGENTS.md`→`CLAUDE.md` precedence explicit; SOP call-site table verified against code. Only gap: add `audits/` to the directory map.
- **Index truth — GREEN.** `MEMORY.md` two entries both resolve; the hardening line now matches reality (v0.2.14, port 80).
- **Freshness — GREEN.** Feed table below; nothing frozen.
- **Bloat/dup — GREEN.** Duplicate 149-line manual → 8-line pointer. `outputs/` (incl. its `*.inspect.ndjson` scratch) gitignored so it won't bloat the repo. Remaining: empty `.claude/` dir (cosmetic; likely reserved for future project skills).
- **Hygiene — YELLOW.** Secrets clean. The one open item: real assets still uncommitted — `n8n/`, `tools/linkedin_env.py`, `tools/linkedin_oauth_setup.py`, `tools/post_to_linkedin.py`, `workflows/linkedin_post.md`, `workflows/win_back_ui_process.md`, plus the doc changes and `audits/`. This is a *pending decision*, not drift — a commit plan was proposed and awaits your go-ahead.
- **Context placement — GREEN.** Precedence rule present; design fact points at code; the 5 SOPs are documented as expertise with call sites; no situational facts baked into always-loaded files.

### Feed freshness

| Feed | Raw date | Ingested | Cadence | Verdict |
|---|---|---|---|---|
| Git / app code | 2026-07-24 | 2026-07-24 | continuous | FRESH |
| 5 live workflow SOPs | 2026-07-23 (win-back) | live-read by backend | on-change | FRESH |
| `outputs/` deliverables | 2026-07-23 | n/a (now gitignored local) | ON-DEMAND | n/a |
| `data/phone_lookups.csv` | 2026-06-26 | n/a | ON-DEMAND | idle by design — still wired to `tools/log_phone_lookup.py` |
| hardening memory | 2026-07-24 (updated) | 2026-07-24 | manual | FRESH |

## Remaining decisions (unchanged from the fix report)

1. **`outputs/`** — keep gitignored (current default; contains customer-email CSVs) or track it?
2. **Commit the uncommitted assets** (LinkedIn tools + n8n + SOPs + docs + `audits/`) now, or review first?
3. **DB backup cron** for `team.db` — set up yet? (Can't verify from here; still on the open list.)
4. **Scorecard** (`WCF_BDE_Weekly_Scorecard.html`) — archive or leave tracked at root? (Now documented either way.)

## Fix list (small — most of the morning list is done)
- **Batch B leftover:** add `audits/` to the CLAUDE.md directory map (one line).
- **Batch D (durability, external):** DB backup cron; Apple notarization; HTTPS domain — real-world gaps, correctly documented in "Known gaps," not resolvable from here.
- Optional cosmetic: remove the empty `.claude/` dir (no commit impact) unless reserved for future skills.
