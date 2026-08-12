# 09 — Proposed Product Blueprint

Repo: `/Users/jontyhw/v1 agent` · Commit: `8c923ac5e703928e3f94721e6c11593a5c397f7d` · Evaluated: 2026-08-12

This describes the target shape of the product once the Stage 0–7 roadmap is substantially complete. It is intentionally conservative — built from what already exists plus the specific, evidenced gaps found in this audit, not a generic "what a CRM should have" wishlist. Every module below maps to something already present, already orphaned, or explicitly identified as a real gap elsewhere in this audit.

## Navigation

Keep the current 10-section sidebar structure (it maps cleanly to real daily jobs and isn't the problem — see Visual/UX Audit §2), but:
- **Reconnect Call Queue and Opportunity Workspace as real nav destinations** rather than sub-flows reached only from other screens — Call Queue sits naturally under/near Cold Call Lists; Opportunity Workspace becomes the actual destination when a lead's stage moves to `engaged` or beyond (replacing today's dead-end `<select>`-only stage editor).
- **Retire AI Sales Intelligence as a standalone nav item** and fold its chat/report capability into the lead side-panel and Opportunity Workspace as a tab, rather than a fourteenth top-level destination — this avoids re-adding nav clutter while still recovering the feature's value (see "what to remove/merge" below).
- **Add a command palette (Cmd/Ctrl+K)**, generalising the existing leads-only ⌘K search into a true cross-object launcher (jump to a lead, open a list, start a call, open Settings) — following Linear's "primary, taught navigation method" pattern (Competitor Benchmark §3), appropriate for this product's high-frequency-repetitive-task user.
- **Remove the redundant Settings PIN gate** (Visual/UX Audit 05-03) — the permission system underneath it is the correct, sufficient mechanism.

## Main modules

1. **Today** (Action Centre) — keep as-is; it's the strongest screen in the product.
2. **Leads** (Dashboard) — keep as the shared-pool table view; keep its skeleton-loading/dual-empty-state pattern as the template every other screen should match.
3. **Pipeline** (new, built on the reconnected Opportunity Workspace) — kanban board over `opportunity_stage`, drag-and-drop, with the workspace's existing notes/calls/drafts/AI-history/timeline as the record-detail panel behind each card.
4. **Cold Call Lists + Call Queue** — merge conceptually: Cold Call Lists is list-building, Call Queue is list-working; keep both, make the relationship between them a one-click "start calling" rather than two separately-discovered screens.
5. **Outreach** (Email Writer / Sequences / List Campaign) — keep the grouping, but give each sub-tool its own permission (closing the "one permission covers three tools" gap in Feature Gap Matrix §2) once the RBAC model is org-scoped (Roadmap Stage 1).
6. **Win-back** — keep as-is; a real, working, differentiated feature.
7. **Calendar** — keep, add Google/Outlook two-way sync (Roadmap Stage 4) rather than replacing the CRM-native event model.
8. **Analytics** — give it an independent data fetch and error/empty state (Visual/UX Audit Finding under Analytics) instead of silently depending on Dashboard having loaded first; add pipeline/conversion/velocity reporting once Pipeline (module 3) exists.
9. **AI Prospecting** — keep; genuinely differentiated per the competitor benchmark.
10. **Activity Feed** — keep, fix the silent-failure pattern (show a real error, not a misleading "not configured" message, when the backend is actually unreachable).
11. **Settings** — restructured, see below.

## Record-page structure (the lead/opportunity record)

Standardise on one record-detail pattern (today split between the lead side-panel and the orphaned Opportunity Workspace) with:
- Identity header: company name, stage badge, owner, next-best-action.
- High-priority actions: `tel:` call button, generate email, log outcome — always visible, not buried in a menu.
- A single unified activity timeline (calls, emails, meetings, notes, stage changes) — the `getLeadTimeline` API already exists and already powers this in the orphaned workspace; it just needs to be the default view everywhere a lead is opened, not a special case.
- Editable properties inline (stage dropdown becomes kanban-card drag, other fields inline-edit).
- AI insights (Sales Intelligence) as a tab within this same page, not a separate top-level destination.
- Related records: emails/drafts, call logs, calendar events — already modeled, just needs consistent rendering across every entry point (side-panel vs. full workspace currently diverge).

## Settings structure

Reorganise into four clear groups, matching the distinction the audit brief asks for between records/workflows/reports/administration:
- **Workspace**: team members, invites (once built), roles & permissions (keep — it's the strongest admin subsystem already), teams/groups (new).
- **Connected Apps** (new — see Integrations doc §8): one page per provider category (Email, Calling, Calendar, Data), each showing connection status, last successful sync, scopes granted, reconnect/disconnect — replacing today's bare email-OAuth-only connect/disconnect buttons with no health visibility.
- **Data**: import/export, custom fields (new), duplicate rules, credit limits (keep — genuinely well-built), data retention policy (new, GDPR).
- **Security & Audit**: session policy, audit log (keep, close the coverage gaps in Security doc §4), API keys (new, once a public API exists).

## Integration marketplace

Not a HubSpot/Zoho-scale marketplace (explicitly not recommended — Competitor Benchmark §4) — a small, curated "Connected Apps" surface covering exactly the categories this product's user actually needs: Email (exists), Calendar (Stage 4), Calling (Stage 4, provider-neutral adapter first), and Data (CH — exists; a public API + webhooks for Zapier/Make/n8n only once external customers actually ask for it, Roadmap Stage 6). Built on the `IntegrationProvider`/`IntegrationConnection`/`SyncJob` conceptual model already specified in the Integrations doc §8, generalising the CH stream's proven retry/idempotency pattern rather than each provider reinventing it.

## User roles & organisation management

Keep the existing granular permission-string RBAC model (`roles` table, `permission_service.py`) — it's already more capable than a simple admin/member split and doesn't need replacing. What needs adding (Roadmap Stage 1): an `organisation` object that every user, lead, and permission check scopes to; org-level roles (Admin/Member as defaults, matching the pattern Attio/Close/Folk all use — Competitor Benchmark §1) layered on top of the existing fine-grained permission strings, not replacing them; org creation as part of signup; org-level settings (branding, security policy, integration credentials) instead of today's single global config.

## Core workflows (unchanged in spirit, tightened in execution)

Lead capture (CSV/AI Prospecting) → Cold Call Lists/Call Queue → Pipeline (new) → Win-back/Sequences for re-engagement → Analytics for review. This is already the real shape of how the product is used; the blueprint doesn't change the workflow, it removes the current gaps in executing it (unreachable pipeline UI, inconsistent loading/error states, no saved views).

## Notifications

Currently absent as a concept beyond in-app toasts. Add a lightweight notification centre (overdue task/follow-up reminders, a completed AI Prospecting run, a failed email send) surfaced via the existing top-bar bell icon (already present per CLAUDE.md's documented design, currently routes only to Today) — no need for a heavy pub/sub system given the current single-worker deployment; a polled or session-pushed notification list is sufficient at this scale.

## Reporting

Extend Analytics (module 8 above) with pipeline-stage conversion, sales velocity, and win-rate once Pipeline exists to report on — do not build a generic custom-report builder (Zoho/Salesforce-style) at this stage; it's disproportionate to this product's team size and not requested by the competitor benchmark's "learn from" list.

## Automation

Generalise the existing sequence-scheduler pattern (already has solid two-layer exception handling and a working poll loop) into a genuine trigger→action builder — stage-change and date-based triggers first (matching what reps already do manually via Sequences/Win-back), webhook actions later once the connector framework (Roadmap Stage 4) exists to act on. Do not build Zoho/Salesforce-scale automation depth (Deluge scripting, Flow Builder-equivalent complexity) — Pipedrive's and Close's simpler trigger→condition→delay→action model is the right reference point for this product's team size.

## AI's appropriate role

Keep AI scoped to what it already does well and cheaply: phone/company lookup, email drafting, sales-intelligence research, win-back copy, LinkedIn discovery — all cost-capped, all with the strict tool-free schema-enforced extraction pattern that `sales_intelligence_service.py` already proved out after a real cost incident. Extend it into: AI-assisted stage/next-action suggestions (once Pipeline exists), call summarisation (once a calling provider exists, Roadmap Stage 4/7) — but continue the existing discipline of removing open-ended tool access rather than trying to cap it, whenever a new AI feature's cost/risk profile turns out to be unbounded. Do not add an AI chat-with-your-whole-CRM feature purely to match competitors' "agent" branding (HubSpot's Breeze, Attio's AI Workflows) — none of that was identified as something this product's actual users are asking for, and the competitor benchmark's own lesson from Salesforce/Zoho is that added surface area for its own sake is a cost, not a feature.

## What should be removed, merged, or deferred

- **Remove**: the dead `data-admin-only` HTML attribute; the redundant Settings PIN gate; the duplicate `telHref()` helper (trivial merge into one shared utility); the unused Datagardener config key; the four duplicate modal implementations (merge into one shared component).
- **Merge**: AI Sales Intelligence into the record-page's AI tab rather than keeping it a standalone nav destination; Call Queue and Cold Call Lists' relationship tightened into one continuous flow rather than two separately-discovered screens.
- **Defer**: a public API/webhook framework, Zapier/Make/n8n connectors, a generic custom-report builder, and Salesforce/Zoho-scale automation depth — all real, all legitimate eventually, none needed before the Stage 0–3 foundational work, and several (API/webhooks) actively wasteful to build before tenant-scoping exists to build them against.
