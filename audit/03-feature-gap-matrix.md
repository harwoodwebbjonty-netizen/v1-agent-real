# 03 — CRM Feature Gap Matrix

Repo: `/Users/jontyhw/v1 agent` · Commit: `8c923ac5e703928e3f94721e6c11593a5c397f7d` · Evaluated: 2026-08-12

Status definitions (per audit brief): **Complete** (production-ready) / **Present but incomplete** (real backend + UI, missing permissions/error-handling/edge cases) / **Superficial** (UI exists, backend thin or absent) / **Backend only** (API/data model exists, no usable UI) / **Broken/unreliable** / **Missing** / **Not relevant** (deliberately out of scope for this product's target user).

---

## 1. Core CRM records

| Capability | Status | Evidence | Notes |
|---|---|---|---|
| Leads | **Complete** | `leads` table, `leads.py` (26 routes), `dashboard.ts` — best-built screen in the app (real skeleton loading, two distinct empty states, toast on error) | Reference implementation for the rest of the app |
| Contacts (as a distinct object from Leads) | **Not relevant / doesn't exist as a separate object** | No `contacts` table; `contact_name`/`contact_title` are plain fields on `leads` | Reasonable for this product's model (lead = company + one contact), not a gap for this target user |
| Companies (as a distinct object) | **Not relevant / merged into Leads** | Same as above — `leads.company`/`company_number`/`ch_data` fields | Companies House enrichment substitutes for a separate Companies object |
| Deals / Pipelines / Pipeline stages | **Present but incomplete, and effectively unreachable** | `opportunity_stage` field exists (`none/engaged/opportunity/proposal/won/lost`), stage changes via a `<select>` dropdown in `opportunityWorkspace.ts` — **but that entire screen is orphaned from navigation** (see Visual/UX Audit 05-01). No kanban/drag-and-drop UI exists anywhere (confirmed zero `kanban`/`draggable` hits in the frontend) | Data model is real; the only UI for it is unreachable. Effectively **Missing** from a user's actual experience today despite existing in code |
| Activities (unified) | **Present but incomplete** | Call logs, calendar events, email drafts each have their own table/UI; Today (`action-centre.ts`) merges them into one worklist for *pending* items, but there's no single "everything that happened on this lead" activity-log view outside the (also orphaned) Opportunity Workspace's timeline | |
| Tasks | **Present but incomplete** | Modeled as `calendar_events` with a task-like type, not a distinct task entity with due dates independent of a calendar slot | Workable but conflates "task" and "calendar event" |
| Notes | **Present but incomplete** | A `notes-textarea` exists (referenced in Visual/UX audit's focus-state findings); freeform text field, not a threaded/timestamped notes history on most screens | |
| Meetings | **Present but incomplete** | `calendar_events` supports meeting-type entries; no external calendar sync, no video-call link generation, no availability/free-busy | See Integrations doc §5 |
| Calls | **Present but incomplete** | `tel:` click-to-call genuinely works (Visual/UX Audit corrected an earlier draft's claim that this was missing — it's real, at `callQueue.ts`/`opportunityWorkspace.ts`); `call_logs` table for manual outcome entry; no provider integration, no automatic duration/recording capture | See Integrations doc §4 |
| Emails | **Present but incomplete** | Send-only via Gmail/Microsoft OAuth, AI-drafted; no inbox sync, no thread history, no open/click/bounce tracking | See Integrations doc §2 |
| Files/attachments | **Missing** | No file-upload/attachment table or UI found in this pass | |
| Products/services (line items on a deal) | **Not relevant** | This product's deals aren't itemized transactions in the way e-commerce/quote-heavy CRMs need | Reasonable omission for a lead-gen/brokerage sales motion |
| Custom fields | **Missing** | No user-configurable custom-field system found — the schema is fixed, admin-extensible only via a code change/migration | Real gap versus every benchmarked competitor except possibly Close's simpler tiers |
| Tags | **Missing** | No tagging system found on leads | |
| Relationships between records | **Superficial** | `owner_user_id`/`assigned_user_id`/`list_id` are FK-style relationships, but there's no generic "related records" concept (e.g. linking two leads, or a lead to a parent account) | |
| Duplicate detection & merging | **Present but incomplete** | A real dedup/merge function exists (`db.py`'s `_merge_lead`, covers 8 related tables, has an explicit internal-audit-referenced safety comment) with an admin-only `POST /leads/dedup` route — genuine, working backend logic; UI-side triggering/review flow not deep-audited this pass | Backend more mature than typical for this feature's usual "nice to have, rarely built well" status |
| Record ownership | **Complete** | `owner_user_id`/`assigned_user_id`, enforced via `lead_scope` permission logic | |
| Followers/watchers | **Missing** | No watch/follow concept found | |
| Bulk actions | **Present but incomplete** | Bulk CH enrich, bulk dedup, bulk add-to-list exist (admin/permission-gated); no generic bulk-edit-any-field UI | |
| Archiving | **Missing** | No soft-delete/archive state found on leads distinct from `status` values | |
| Record history | **Present but incomplete** | `lead_intelligence_versions` versions AI-generated content; `audit_log` covers a subset of mutation types (see Security doc §4) but not full field-level change history for ordinary lead edits | |

## 2. Sales execution

| Capability | Status | Evidence | Notes |
|---|---|---|---|
| Unified activity timeline | **Backend only** | `getLeadTimeline`/`TimelineEntry` API exists, consumed by `opportunityWorkspace.ts` — **orphaned screen**, so effectively no usable UI today | Same root cause as the pipeline gap above |
| Today/tasks workspace | **Complete** | Action Centre — a genuinely good implementation (real error handling, real empty states) | Strength to keep |
| Follow-up reminders / overdue activities | **Complete** | Core to Action Centre's worklist logic | |
| Sales sequences | **Present but incomplete** | Real multi-step sequence builder + enrollment + scheduler (15-min poll loop, two-layer exception handling — solid backend), gated behind the shared `view_outreach` permission alongside two other tools | |
| Email templates | **Complete** | `email_templates` table + UI in Email Writer | |
| Calling queues | **Present but incomplete** | `callQueue.ts` is fully built (worklist + `tel:` handoff + outcome logging) but **orphaned from navigation** — see Visual/UX Audit 05-01 | Another instance of "built, not reachable" |
| Pipeline drag-and-drop | **Missing** | Confirmed zero kanban/draggable code anywhere; stage changes via `<select>` only, in an unreachable screen | Single largest UX gap versus every one of the 9 benchmarked competitors (all have kanban as a core pattern) |
| Forecasting / deal probability | **Missing** | No probability field or forecast calculation found | |
| Stalled-deal detection | **Missing** | No "time in stage" alerting found | |
| Required stage fields / next-step enforcement | **Missing** | Stage changes are free-form, no validation gate | |
| Lost reasons | **Missing** | `opportunity_stage` includes `lost` but no reason/category field found alongside it | |
| Automated/round-robin assignment | **Missing** | Assignment is manual (`assigned_user_id` set via UI action) | |
| Saved views / personal & shared filters | **Missing** | Filtering exists per-session in the UI state, not persisted as a named, reusable "view" | |
| Mass update | **Present but incomplete** | Overlaps with Bulk actions above — specific bulk operations exist, generic mass-field-edit doesn't | |
| Keyboard shortcuts / command palette | **Missing** | No command-palette pattern found anywhere in `app/src` | Direct gap versus Linear/Notion/Airtable's baseline expectation and Pipedrive/Close/Folk's shortcut systems |
| Global search | **Present but incomplete** | CLAUDE.md documents a ⌘K global search routing into the Leads table via the top bar — real and working per that documentation, but scoped to leads only, not a universal command palette across all record/action types | |

## 3. Reporting and management

| Capability | Status | Evidence | Notes |
|---|---|---|---|
| Personal/team dashboard | **Present but incomplete** | Analytics screen exists with real charts, but has **no independent data fetch or error state** — it reads entirely from whatever `state.ts` cache Dashboard populated, so opening Analytics before Dashboard has ever loaded shows silently empty charts with no messaging | |
| Pipeline value, stage conversion, sales velocity, time-in-stage | **Missing** | No pipeline-value aggregation or conversion-rate calculation found — a direct consequence of the pipeline UI itself being unreachable | |
| Activity volume, contact rate, reply rate, meeting conversion | **Present but incomplete** | Some activity-volume charting exists in Analytics (industry mix, funnel, charge trends); reply/contact-rate metrics not confirmed present | |
| Win rate | **Missing** | Not confirmed present in Analytics' current chart set | |
| Revenue forecast | **Missing** | No revenue field/forecast logic found | |
| Rep performance | **Present but incomplete** | Presence/activity tracking exists (`last_seen_at`, worklist completion) but not a dedicated per-rep performance report | |
| Source attribution | **Missing** | No lead-source tracking/reporting found beyond the informal `source_url` field | |
| Custom reports | **Missing** | Charts are fixed, not user-configurable | |
| Date/user filters, drill-down, export | **Present but incomplete** | Some filtering exists in Analytics; CSV export exists for leads generally (per CLAUDE.md) but not confirmed as an Analytics-specific export path this pass | |

## 4. Administration

| Capability | Status | Evidence | Notes |
|---|---|---|---|
| Team members / invitations | **Present but incomplete** | Admin-created accounts with a password set directly (`users.py`) — no self-serve invite-by-email flow; fine for a small trusted team, a gap for any SaaS lifecycle | See SaaS/Security doc §2 |
| Roles / permissions | **Complete** | Genuinely strong, verified custom RBAC (`roles` table, `permission_service.py`, 0 accidental auth gaps across 124 routes) | One of the strongest backend subsystems in the codebase |
| Teams (groupings of users) | **Missing** | No team/group concept beyond individual role assignment | |
| Pipeline configuration | **Missing** | Stages are a fixed enum (`OpportunityStage`), not admin-configurable | |
| Custom fields | **Missing** | Same as §1 | |
| Data import | **Present but incomplete** | CSV import exists, row-capped (`import_max_rows`), admin-gated | |
| Duplicate rules | **Present but incomplete** | Dedup/merge logic exists and is genuinely solid; not confirmed as a *configurable rule set* (likely a fixed matching heuristic) | |
| Integrations (settings surface) | **Superficial** | Email OAuth connect/disconnect exists in Settings; no unified "Connected Apps" page with health/last-sync/reconnect UX for the other integrations (CH, Mailchimp, Apify are all backend-config-only, invisible to any UI) | See Integrations doc §8 |
| Notification settings | **Missing** | No user-configurable notification preferences found | |
| Branding | **Present but incomplete** | `brand_voice_profiles` exists — this is AI-tone branding (how the AI writes), not visual/white-label branding for a customer's own workspace | Different meaning of "branding" than a multi-tenant SaaS needs |
| Security settings | **Present but incomplete** | Password/session/lockout policy exists at the app-config level (`config.py`), not exposed as a per-org admin-configurable setting (no org to configure per) | |
| Audit logs | **Present but incomplete** | Real, queryable, permission-gated — but uneven coverage (see Security doc §4: role/credit changes logged, user creation/deletion/password-resets and all outbound-email actions are not) | |
| API keys (for customers/third parties) | **Missing** | No concept of an issued API key exists | |
| Webhooks | **Missing** | Confirmed zero webhook code, inbound or outbound | |
| Usage / billing | **Missing** | Credit-limit system exists but is cost-containment, not monetization (see SaaS/Security doc §2) | |
| Data retention / organisation deletion | **Missing** | No retention policy or org-deletion flow (no org to delete) | GDPR-relevant gap, see Security doc §4 |

## 5. Automation

| Capability | Status | Evidence | Notes |
|---|---|---|---|
| Trigger/action workflow builder (generic, user-configurable) | **Missing** | No visual workflow builder exists — every "automation" in this product is a fixed, developer-defined behavior (the sequence scheduler, the activity refresh loop), not user-composable | This is the single largest gap versus HubSpot/Pipedrive/Attio/Zoho/Close's Workflows and monday's Recipes — all 6 of those competitors have a real trigger→action canvas; this product has none |
| Stage-change triggers | **Missing** | No hook fires on `opportunity_stage` change | |
| Assignment rules | **Missing** | Assignment is manual only | |
| Reminder generation | **Present but incomplete** | Today/Action Centre generates reminders from existing due-dates, but this is a fixed algorithm, not a user-configurable rule | |
| Email follow-up automation | **Present but incomplete** | Sequences provide this for one specific use case (multi-step outreach); not generalised to arbitrary trigger conditions | |
| Webhook actions | **Missing** | No webhook framework at all (see Integrations doc §6) | |
| Delays / conditions | **Present but incomplete** | Sequences support step delays internally; not exposed as a general-purpose automation primitive | |
| Retry behaviour | **Complete, for what exists** | The three background loops (sequence scheduler, activity refresh, CH stream) all have genuinely solid two-layer exception handling and, for the CH stream, exponential backoff + idempotent resume — strong engineering, just not exposed as user-facing "automation" | |
| Automation history | **Missing** | No user-visible log of "what did the automation do and when" beyond what's inferable from `email_drafts`/`sequence_enrollments` state | |
| Manual override / loop prevention / safety controls | **Present, implicitly** | Credit limits act as a safety control on AI-driven automation specifically; no generic automation-safety framework since there's no generic automation engine to protect | |

---

## Cross-cutting observation

The pattern across all five groups is consistent: **this product's backend engineering is frequently more mature than its reachable UI surface suggests** (the dedup/merge logic, the CH stream's retry/idempotency design, the RBAC system, the sequence scheduler are all genuinely solid), while **entire categories that competitors treat as table-stakes — kanban pipelines, a generic automation builder, custom fields, saved views, a command palette — are simply absent**, not half-built. The roadmap should treat these as two different kinds of work: *reconnecting* what already exists (the three orphaned screens, which alone would resolve most of the "Missing" pipeline/activity-timeline/call-queue items above) versus *building new* what doesn't (kanban UI, automation builder, custom fields) — the former is far cheaper and should come first.
