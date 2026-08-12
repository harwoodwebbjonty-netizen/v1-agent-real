# 00 — Executive Summary

Repo: `/Users/jontyhw/v1 agent` · Commit: `8c923ac5e703928e3f94721e6c11593a5c397f7d` · Evaluated: 2026-08-12

---

## Overall verdict

This is a **well-engineered single-tenant internal sales tool with a genuinely strong backend core**, not a half-built product. The RBAC/permissions system, the Companies House streaming integration, SQL-injection defences, OAuth CSRF handling, AI cost controls, and the migration strategy are all built to a standard well above what "internal tool" usually implies. But it is currently **architecturally incapable of serving more than one customer organisation** — there is no tenant concept anywhere in the schema — and it carries a handful of specific, confirmed operational and security gaps (an unmanaged, rapidly-growing production database with no working backups; OAuth tokens stored in plaintext; zero observability) that would need fixing regardless of any SaaS ambitions. Separately, and more visibly, the frontend has accumulated real, measurable design-system drift (58% of font-size declarations bypass the documented type scale) and — the single most consequential UX finding in this audit — **three fully-built screens (Call Queue, Opportunity Workspace, AI Sales Intelligence) are structurally unreachable through any navigation path in the shipped app**, including the only working pipeline/kanban-adjacent UI that exists.

## Current maturity level

**Mature single-tenant internal tool. Pre-MVP for multi-tenant SaaS.** Comparable in backend engineering discipline to a well-run Series-A internal platform team's output; comparable in SaaS-readiness to a product that has never been asked the question "what happens when a second customer signs up."

## Top five reasons it feels homemade

1. **Three finished features are invisible.** Call Queue, Opportunity Workspace, and AI Sales Intelligence are fully coded — real data fetching, real empty states, real error handling — but the router's view list and the sidebar navigation simply don't include them. A shipped commercial product essentially never has this; it's the clearest single fingerprint of "internal tool that outgrew its own navigation" in the whole codebase. (Visual/UX Audit, Finding 05-01)
2. **The design-token system is well-designed and inconsistently followed.** 58% of `font-size` declarations, 39% of `border-radius` declarations, and 31%+ of `padding` declarations bypass the documented 6/2/8-step scales, fragmenting into 20+ undocumented one-off sizes. The system itself isn't the problem — the discipline of using it is. (Visual/UX Audit §3)
3. **No pipeline visualisation exists**, despite `opportunity_stage` being a real, first-class field on every lead. Every one of the 9 CRM products benchmarked treats a kanban/drag-and-drop pipeline as non-negotiable table stakes; this product's only stage-management UI is a `<select>` dropdown on a screen nobody can currently open. (Feature Gap Matrix §2; Competitor Benchmark §2)
4. **Four different hand-rolled ways to show a modal, two different ways to render a progress bar** — no shared overlay/dialog component exists anywhere in `app/src/components/`, despite that directory otherwise being well-organised. Small, but exactly the kind of inconsistency a user (or a careful engineer) notices without being able to say why. (Visual/UX Audit §4)
5. **Loading and error feedback is inconsistent across screens** — 2 of ~15 reachable screens have a real skeleton loader; the rest show blank content or a plain "Loading…" string, and two screens (Activity Feed, AI Prospecting) silently swallow backend failures into a misleading "not configured" message instead of telling the user something actually broke. (Visual/UX Audit §5)

## Top SaaS blockers

1. **No multi-tenant data isolation exists at all** — confirmed by a repo-wide grep returning zero hits for `workspace`/`tenant`/`organisation_id` across the entire backend. Every table scopes to a single shared `users` table. This is the dominant reason the SaaS-readiness category scores near zero below — nothing else in this list matters if a second customer's data could ever become visible to the first. (SaaS/Security doc §1)
2. **The production database has grown ~29x in one month (58MB → 1.68GB) with no working automated backup** — confirmed directly on the VPS (no cron job installed for either `root` or `appuser`; the last available backup is 5+ days stale at time of writing). This is a present-tense risk to the *current* single-customer deployment, independent of any SaaS decision, and should be fixed first regardless of what's decided about multi-tenancy. (SaaS/Security doc §3)
3. **OAuth access/refresh tokens are stored in plaintext** in the database — confirmed zero encryption-at-rest anywhere in the codebase. Combined with finding #2 (unencrypted backup copies sitting on disk), this is a real, present exposure of connected users' actual Gmail/Microsoft accounts. (SaaS/Security doc §4)
4. **No self-serve account lifecycle exists**: no signup, no billing/subscription/plan-gating, no email-based invites, no trial. This is the single largest unit of genuinely *new* engineering in the whole audit — not a fix to existing code, a system that doesn't exist yet. (SaaS/Security doc §2)
5. **Zero observability** — no error-tracking/APM service of any kind; the only signal of a production problem today is a user noticing and reporting it. (SaaS/Security doc §3)

## Top five strengths — retain and build on these

1. **The custom RBAC/permissions system** — a real `roles` table, granular per-permission gating, correctly enforced with zero accidental unauthenticated endpoints found across all 124 backend routes (three deliberate, correctly-justified exceptions, independently verified). This is a genuine foundation to layer org-scoping onto later.
2. **The Companies House streaming integration** — two correctly-separated credentials (fixed after a real incident), self-throttling to protect a shared rate limit, exponential backoff, resumable cursor-based recovery, and idempotent duplicate-safe inserts. This is, in miniature, exactly the shape a generalised connector framework should formalise.
3. **Security fundamentals** — parameterized SQL throughout with an explicit allowlist guard on the one dynamic-column-name query path, correctly-implemented OAuth CSRF protection (single-use random state nonce), zero hardcoded secrets anywhere in the repo or git history, and a demonstrated pattern of *removing* a risky AI tool-use capability entirely (rather than trying to under-cap it) when a real cost-blowout incident happened.
4. **The Today/Action Centre worklist and the Leads/Dashboard screen** — both are the reference implementation the rest of the app should be brought up to: real skeleton loading, distinct empty states for "nothing here" vs. "over-filtered," and toast-based error surfacing on every failure path.
5. **A working Companies House-driven prospecting/enrichment engine** — independently validated by the competitor benchmark as a legitimate, differentiated value axis (Apollo.io's entire market position rests on the equivalent capability), not a nice-to-have.

## Top ten recommended actions

1. Fix the production database backup gap and diagnose the growth cause — P0, independent of everything else, cheap relative to its risk.
2. Encrypt OAuth tokens at rest (or, minimum viable, move to a proper secrets/KMS reference) before any more customers' credentials are stored.
3. Reconnect (or deliberately, visibly retire) the three orphaned screens — the cheapest, highest-leverage UX fix available, since the code already exists.
4. Build a real kanban pipeline view over the existing `opportunity_stage` data and the now-reconnected Opportunity Workspace.
5. Consolidate the design-token bypass — a mechanical audit-and-remap pass on `font-size`/`padding`/`border-radius`, no visual redesign required first.
6. Build one shared modal/dialog component and retire the four duplicate implementations.
7. Add basic observability (even a minimal hosted error-tracker) before taking on any external users.
8. Decide, explicitly, whether multi-tenant SaaS is the actual near-term goal — if yes, tenant-scoping the schema is the largest, most foundational piece of new work in this entire audit and should be sequenced before any other SaaS-lifecycle work (billing, self-serve signup) begins.
9. Add pagination to the ~22 unbounded list endpoints and the 5 confirmed missing indexes on `*_id` columns — cheap now, expensive to retrofit under load later.
10. Close the GDPR gap (data retention policy, export, erasure) before onboarding any customer's real prospect data, independent of the multi-tenancy question.

## Final score: 40 / 100

See Phase-7 scoring detail and per-category breakdown in `results/audit-results.json` and the reasoning embedded throughout each numbered doc. The dominant factor holding the total down is the 15-point-weighted Multi-Tenant SaaS Readiness category scoring almost at zero (confirmed architectural absence, not partial credit) — every other category scores in the 35–75% range, reflecting a product that is meaningfully more capable than its total score alone suggests, *for the one team it currently serves*.

## Is it currently safe to sell to external customers?

**No.** Not because the code is poor — much of it is genuinely good — but because (a) there is no mechanism to keep two customers' data apart at all, (b) the current single deployment has an active, unaddressed data-loss risk, and (c) a connected customer's real email credentials would sit unencrypted in that same at-risk database. Any one of these three would be disqualifying on its own; together they are unambiguous. This is a "close the P0 list first" situation, not a "needs polish" one — and the P0 list itself is short, concrete, and largely independent of the much larger, more optional SaaS-lifecycle build-out (billing, self-serve signup, invites) that would come after.
