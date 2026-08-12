# 08 — Prioritised Roadmap

Repo: `/Users/jontyhw/v1 agent` · Commit: `8c923ac5e703928e3f94721e6c11593a5c397f7d` · Evaluated: 2026-08-12

Scoring: `Priority = (User value × 3) + (Commercial value × 3) + (Risk reduction × 2) + (Strategic differentiation × 2) − (Effort × 2) − Technical dependency`. All 1–5 scales. **P0** = required before any external customer use · **P1** = required for a credible SaaS launch · **P2** = improves adoption/competitiveness · **P3** = optional enhancement. Dependencies are sequenced so visual/design-system work never precedes the information-architecture/component-system work it depends on, and so SaaS-lifecycle work never precedes the tenant-isolation foundation it depends on.

---

## Stage 0 — Critical stabilisation (do first, independent of every other stage)

| Item | UV | CV | RR | SD | Eff | Dep | Priority | Tier |
|---|---|---|---|---|---|---|---|---|
| Diagnose DB growth cause (table-size breakdown) + install the existing `backup.sh` on a real cron schedule | 3 | 4 | 5 | 1 | 1 | 1 | **32** | **P0** |
| Encrypt OAuth `access_token`/`refresh_token` at rest | 2 | 4 | 5 | 1 | 3 | 2 | **21** | **P0** |
| Add a minimal hosted error-tracker (even a free-tier Sentry equivalent) to the backend | 2 | 3 | 4 | 1 | 2 | 1 | **20** | **P0** |

**Reason**: none of these depend on any product decision (SaaS or not) — they're fixing an active risk to the deployment that exists today. **Acceptance criteria**: nightly backups verified present for 7 consecutive days with the correct `KEEP` pruning; a documented answer for which table(s) drove the 29x growth; tokens unreadable from a raw DB file copy; at least one real exception visible in the error-tracker dashboard within a week of install. **Affected areas**: `backend/deploy/`, `backend/app/services/email_oauth_service.py`, `backend/app/db.py`, ops/VPS config — no frontend changes.

## Stage 1 — SaaS foundations (only pursue if multi-tenant SaaS is the actual near-term goal — see Executive Summary Action 8)

| Item | UV | CV | RR | SD | Eff | Dep | Priority | Tier |
|---|---|---|---|---|---|---|---|---|
| Design + migrate an `organisations`/tenant column onto every table, backfilled with one org for the current team | 2 | 5 | 5 | 3 | 5 | 1 | **24** | **P1** |
| Self-serve signup + email verification + org creation flow | 3 | 5 | 2 | 2 | 4 | 4 | **19** | **P1** |
| Billing/subscription/plan-entitlement layer (Stripe or equivalent) | 2 | 5 | 1 | 2 | 5 | 5 | **12** | **P1** |
| Email-based team invites (replacing admin-hand-creates-account) | 3 | 3 | 1 | 1 | 2 | 2 | **16** | **P1** |
| GDPR: data retention policy + export + erasure tooling | 2 | 3 | 4 | 1 | 3 | 1 | **18** | **P0/P1 boundary — treat as P0 if any real customer data is onboarded before full SaaS launch** |

**Reason**: this is the largest, most foundational block of *new* work in the whole audit — tenant-scoping must land before self-serve signup or billing mean anything, since without it a second organisation's signup would just be a second set of users sharing the first org's data. **Dependencies**: tenant-scoping blocks everything else in this stage and blocks Stage 4/5's "per-tenant integration credentials"/"tenant-level feature flags" items. **Affected areas**: every table in `backend/app/db.py`, every query function, every router's auth dependency (`CurrentUser` needs an `org_id`), and the RBAC model (`permission_service.py`) needs org-scoping added — this is genuinely the single largest engineering effort identified anywhere in this audit.

## Stage 2 — Design system and information architecture (before any broad visual redesign)

| Item | UV | CV | RR | SD | Eff | Dep | Priority | Tier |
|---|---|---|---|---|---|---|---|---|
| Reconnect or deliberately retire the 3 orphaned screens (Call Queue, Opportunity Workspace, AI Sales Intelligence) | 5 | 3 | 2 | 2 | 1 | 1 | **33** | **P0** (it's a routing fix, not a redesign — cheapest high-impact item in the whole audit) |
| Remove the dead `data-admin-only` markup + the redundant Settings PIN gate | 2 | 1 | 2 | 1 | 1 | 1 | **10** | **P2** |
| Token-bypass consolidation pass (`font-size`/`padding`/`border-radius` → existing scale) | 3 | 2 | 1 | 1 | 3 | 1 | **13** | **P1** |
| Build one shared modal/dialog component, retire the 4 duplicate implementations | 3 | 2 | 1 | 1 | 2 | 1 | **15** | **P1** |
| Standardise loading/error-state pattern across all screens (skeleton + toast, matching Dashboard's reference implementation) | 4 | 2 | 2 | 1 | 3 | 1 | **16** | **P1** |

**Reason this stage precedes Stage 3's kanban work**: a kanban pipeline built on today's inconsistent component/token base would just be a 15th screen with its own bespoke styling — reconnecting navigation and consolidating the shared component/token layer first means every subsequent feature (kanban included) is cheaper and more consistent to build. **Dependencies**: the orphaned-screen reconnection is a prerequisite for Stage 3's pipeline work, since Opportunity Workspace *is* where the pipeline UI belongs.

## Stage 3 — Core CRM workflow improvements

| Item | UV | CV | RR | SD | Eff | Dep | Priority | Tier |
|---|---|---|---|---|---|---|---|---|
| Kanban/drag-and-drop pipeline view over `opportunity_stage`, inside the reconnected Opportunity Workspace | 5 | 4 | 1 | 3 | 4 | 2 | **31** | **P1** |
| Command palette (Cmd/Ctrl+K) generalised beyond today's leads-only ⌘K search | 3 | 2 | 1 | 2 | 3 | 1 | **15** | **P2** |
| Custom fields on leads | 3 | 3 | 1 | 2 | 4 | 2 | **17** | **P2** |
| Tags | 2 | 2 | 1 | 1 | 2 | 1 | **11** | **P2** |
| Saved/shared filter views | 3 | 2 | 1 | 1 | 3 | 1 | **14** | **P2** |
| File/attachment support | 2 | 2 | 1 | 1 | 3 | 1 | **10** | **P2** |

**Dependencies**: pipeline UI depends on Stage 2's orphaned-screen reconnection. Custom fields/tags depend on no particular prior stage but are more valuable once a second organisation with different data needs actually exists (Stage 1) — building them purely for the current single team is lower leverage than building them once schema flexibility is genuinely needed.

## Stage 4 — Email, calling and calendar integrations

| Item | UV | CV | RR | SD | Eff | Dep | Priority | Tier |
|---|---|---|---|---|---|---|---|---|
| Generalise the CH stream's retry/backoff/idempotency pattern into a reusable connector framework (`SyncJob`/`SyncCursor`, see Integrations doc §8) | 2 | 3 | 2 | 3 | 4 | 2 | **17** | **P1** |
| Provider-neutral calling adapter on top of the existing working `tel:` fallback | 4 | 3 | 1 | 3 | 3 | 2 | **21** | **P1** |
| First named calling provider (Aircall) | 4 | 4 | 1 | 2 | 4 | 3 | **19** | **P2** |
| Google/Outlook Calendar two-way sync (reuses the proven email-OAuth CSRF pattern) | 3 | 3 | 1 | 2 | 3 | 1 | **17** | **P2** |
| "Connected Apps" settings page (connection health, last sync, reconnect/disconnect UX) | 2 | 3 | 2 | 1 | 3 | 2 | **13** | **P2** |

**Reason for sequencing**: the connector framework should exist before the second and third named providers are added, or each one re-derives the CH stream's retry/idempotency logic from scratch again (exactly what happened the first time, per the Integrations doc's core finding).

## Stage 5 — Reporting, automation and administration

| Item | UV | CV | RR | SD | Eff | Dep | Priority | Tier |
|---|---|---|---|---|---|---|---|---|
| Pagination on the 22 unbounded list endpoints + the 5 missing `lead_id` indexes | 2 | 2 | 3 | 1 | 2 | 1 | **17** | **P1** |
| Close the audit-log coverage gaps (user create/delete/password-reset, all outbound-email actions) | 2 | 2 | 4 | 1 | 2 | 1 | **17** | **P1** |
| Generic trigger→action workflow builder | 3 | 3 | 1 | 3 | 5 | 3 | **17** | **P2** |
| Pipeline/forecast reporting (stage conversion, sales velocity, win rate) | 3 | 3 | 1 | 2 | 3 | 3 | **17** | **P2** |
| Round-robin/automated lead assignment | 2 | 2 | 1 | 1 | 3 | 1 | **9** | **P3** |

**Dependencies**: pipeline reporting depends on Stage 3's kanban/pipeline work actually existing to report on.

## Stage 6 — Commercial launch readiness

| Item | UV | CV | RR | SD | Eff | Dep | Priority | Tier |
|---|---|---|---|---|---|---|---|---|
| Public API + issued API keys | 2 | 4 | 1 | 2 | 4 | 4 | **14** | **P2** |
| Outbound/inbound webhook framework | 2 | 4 | 1 | 2 | 4 | 4 | **14** | **P2** |
| Zapier/Make/n8n connector | 1 | 3 | 1 | 1 | 3 | 4 | **6** | **P3** |
| Admin-impersonation / secure support-access model | 1 | 2 | 3 | 1 | 3 | 3 | **8** | **P3** |
| HTTPS/domain for the backend | 2 | 3 | 4 | 1 | 2 | 1 | **18** | **P1 — should move earlier if any real customer traffic is planned** |

**Dependencies**: everything in this stage assumes Stage 1's tenant-scoping is already done — a public API or webhook framework built against a single-tenant backend would need rebuilding, not extending, once tenancy is added.

## Stage 7 — Differentiation and AI capabilities

| Item | UV | CV | RR | SD | Eff | Dep | Priority | Tier |
|---|---|---|---|---|---|---|---|---|
| Deepen the Companies House prospecting/enrichment engine (already a genuine differentiator per the competitor benchmark) | 3 | 4 | 1 | 4 | 3 | 1 | **24** | **P2** |
| AI call-summary/transcription once a calling provider exists (Stage 4) | 3 | 3 | 1 | 3 | 4 | 4 | **14** | **P3** |
| AI-assisted workflow/automation suggestions (Attio/HubSpot-style "Breeze"-equivalent) | 2 | 3 | 1 | 3 | 4 | 5 | **11** | **P3** |

**Reason this is last, not first**: every item here compounds value that only exists once the foundational and core-workflow stages are in place — an AI call-summary feature is worthless without a calling provider integration to summarise calls from (Stage 4), and AI workflow suggestions need a workflow builder to suggest into (Stage 5).

---

## Cross-stage dependency summary

```
Stage 0 (stabilise) ──┬──> Stage 1 (SaaS foundations, IF pursuing multi-tenant SaaS)
                       │         │
                       │         ▼
                       └──> Stage 2 (IA/design-system) ──> Stage 3 (core CRM workflow)
                                                                  │
                                                    Stage 4 (integrations) <──┘
                                                                  │
                                                          Stage 5 (reporting/automation)
                                                                  │
                                                Stage 1 must precede ──> Stage 6 (commercial launch)
                                                                  │
                                                          Stage 7 (differentiation/AI)
```

Stage 0 is unconditional. Stage 1 is conditional on a real product decision (see Executive Summary Action 8) — if the answer is "stay single-tenant, keep improving the internal tool," skip Stage 1 and Stage 6 entirely and go Stage 0 → 2 → 3 → 4 → 5 → 7, which is a substantially smaller, faster, lower-risk program of work than the full SaaS path.
