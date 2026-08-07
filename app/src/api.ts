import { invoke } from "@tauri-apps/api/core";

export interface PhoneEntry {
  id: string;
  phone_number: string;
  source: "scraped" | "manual";
}

export interface EmailEntry {
  id: string;
  email: string;
  source: "scraped" | "manual";
  verify_status?: "unchecked" | "deliverable" | "risky" | "undeliverable";
  person_match?: "unknown" | "person" | "director" | "generic" | "mismatch";
  verify_detail?: string;
}

export interface Lead {
  id: string;
  timestamp: string;
  company: string;
  phone_number: string;
  source_url: string;
  status: "verified" | "unverified" | "not_found";
  notes: string;
  industry: string;
  contact_status: string;
  lead_notes: string;
  contact_name: string;
  contact_title: string;
  website: string;
  linkedin: string;
  owner_user_id: string | null;
  owner_name: string | null;
  assigned_user_id: string | null;
  assigned_name: string | null;
  list_id: string | null;
  opportunity_stage: OpportunityStage;
  next_best_action: NextBestAction;
  company_number: string | null;
  ch_data: string | null;
  called_at: string | null;
  follow_up_at: string | null;
  priority_score: number;
  priority_breakdown: string | null;
  is_shared: boolean;
  list_name: string | null;
  refresh_tier: string | null;
  next_dg_refresh_at: string | null;
  last_dg_refreshed_at: string | null;
  phones: PhoneEntry[];
  emails: EmailEntry[];
  intelligence: LeadIntelligence | null;
}

export interface ScoreBreakdown {
  company_maturity: number;
  hiring_intensity: number;
  growth_signals: number;
  buying_intent: number;
  accessibility_fit: number;
}

export interface PainPoints {
  operational: string[];
  sales_revenue: string[];
  recruitment_scaling: string[];
}

export interface ObjectionResponse {
  category: "price" | "timing" | "competitor" | "internal_solution" | "other";
  objection: string;
  response: string;
}

export interface LeadIntelligence {
  executive_summary: string;
  sales_summary: string;
  pain_points: PainPoints;
  buying_signals: string[];
  conversation_starters: string[];
  discovery_questions: string[];
  objection_handling: ObjectionResponse[];
  pitch_angle: string;
  call_brief: string;
  score_breakdown: ScoreBreakdown;
  lead_score: number;
  lead_temperature: "Hot" | "Warm" | "Cold";
  confidence_note: string;
  generated_at: string;
  updated_at: string;
  version_count: number;
}

export interface LeadIntelligenceVersion {
  id: string;
  executive_summary: string;
  sales_summary: string;
  pain_points: PainPoints;
  buying_signals: string[];
  conversation_starters: string[];
  discovery_questions: string[];
  objection_handling: ObjectionResponse[];
  pitch_angle: string;
  call_brief: string;
  score_breakdown: ScoreBreakdown;
  lead_score: number;
  lead_temperature: "Hot" | "Warm" | "Cold";
  confidence_note: string;
  created_at: string;
}

export interface LinkedInPost {
  content: string;
  linkedinUrl: string;
  author?: { name?: string };
  postedAt?: { postedAgoText?: string; postedAgoShort?: string; date?: string };
  engagement?: { likes?: number; comments?: number; shares?: number };
}

export interface LeadLinkedInPosts {
  linkedin_url: string;
  posts: LinkedInPost[];
  fetched_at: string | null;
}

export interface LeadList {
  id: string;
  name: string;
  owner_user_id: string;
  owner_name: string | null;
  created_at: string;
  lead_count: number;
}

export type OpportunityStage = "none" | "engaged" | "opportunity" | "proposal" | "won" | "lost";

export interface LeadPatch {
  industry?: string;
  contactStatus?: string;
  leadNotes?: string;
  contactName?: string;
  contactTitle?: string;
  website?: string;
  linkedin?: string;
  opportunityStage?: OpportunityStage;
}

export interface NextBestAction {
  action: string;
  reason: string;
}

// Mirrors the backend's validation — for instant feedback before the round-trip; the backend stays authoritative.
export const PHONE_PATTERN = /^[+]?[0-9\s\-()]{7,20}$/;
export const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export interface UserInfo {
  id: string;
  name: string;
  role: "admin" | "member";
  avatar: string | null;
  last_seen_at: string | null;
  role_id?: string | null;
  role_name?: string;
  permissions?: string[];
  lead_scope?: string;
}

// --- Roles (RBAC) ---

export interface Role {
  id: string;
  name: string;
  permissions: string[];
  lead_scope: string;
  is_system: boolean;
  is_default: boolean;
}

export interface PermissionCatalogue {
  catalogue: Array<{ group: string; items: Array<{ key: string; label: string }> }>;
  lead_scopes: string[];
}

export async function getRoles(): Promise<Role[]> {
  return invoke<Role[]>("list_roles");
}

export async function getRoleCatalogue(): Promise<PermissionCatalogue> {
  return invoke<PermissionCatalogue>("get_role_catalogue");
}

export async function createRole(name: string, permissions: string[], leadScope: string): Promise<Role> {
  return invoke<Role>("create_role", { name, permissions, leadScope });
}

export async function updateRole(roleId: string, name: string, permissions: string[], leadScope: string): Promise<Role> {
  return invoke<Role>("update_role", { roleId, name, permissions, leadScope });
}

export async function deleteRole(roleId: string): Promise<void> {
  await invoke("delete_role", { roleId });
}

export async function setDefaultRole(roleId: string): Promise<void> {
  await invoke("set_default_role", { roleId });
}

export async function assignUserRole(userId: string, roleId: string): Promise<UserInfo> {
  return invoke<UserInfo>("assign_user_role", { userId, roleId });
}

// --- Auth ---
// Name + password sign-in. A new name creates a profile with that password;
// an existing name must supply the matching password.

export async function identify(name: string, password: string, bootstrapToken = ""): Promise<UserInfo> {
  return invoke<UserInfo>("identify", { name, password, bootstrapToken });
}

/** Slim public profile for the pre-auth login picker (name + avatar only). */
export interface UserName {
  name: string;
  avatar: string | null;
}

export async function getUserNames(): Promise<UserName[]> {
  return invoke<UserName[]>("list_user_names");
}

export async function logout(): Promise<void> {
  await invoke("logout");
}

/** Real presence ping — called periodically while the app is open. */
export async function sendHeartbeat(): Promise<void> {
  await invoke("send_heartbeat");
}

export async function getCurrentSession(): Promise<UserInfo | null> {
  return invoke<UserInfo | null>("get_current_session");
}

// --- Team management ---

export async function listTeamMembers(): Promise<UserInfo[]> {
  return invoke<UserInfo[]>("list_team_members");
}

export async function createTeamMember(name: string, role: "admin" | "member"): Promise<UserInfo> {
  return invoke<UserInfo>("create_team_member", { name, role });
}

export async function updateTeamMember(userId: string, patch: { name?: string; role?: "admin" | "member" }): Promise<UserInfo> {
  return invoke<UserInfo>("update_team_member", { userId, ...patch });
}

export async function deleteTeamMember(userId: string): Promise<void> {
  await invoke("delete_team_member", { userId });
}

/** Admin-issued password set/reset (also used to set up legacy accounts that
 * have no password yet). Revokes that user's other sessions. */
export async function adminSetUserPassword(userId: string, password: string): Promise<UserInfo> {
  return invoke<UserInfo>("admin_set_user_password", { userId, password });
}

export interface AuditEntry {
  id: string;
  actor_name: string;
  action: string;
  entity_type: string;
  entity_id: string;
  detail: string;
  created_at: string;
}

/** Admin-only accountability trail (most recent first). */
export async function getAuditLog(limit = 200): Promise<AuditEntry[]> {
  return invoke<AuditEntry[]>("list_audit_log", { limit });
}

export async function setUserAvatar(userId: string, avatar: string | null): Promise<UserInfo> {
  return invoke<UserInfo>("set_user_avatar", { userId, avatar });
}

/** Reads a local file picked via the file dialog and returns it as a data URL. */
export async function readImageAsDataUrl(path: string): Promise<string> {
  return invoke<string>("read_image_as_data_url", { path });
}

// --- Backend connection ---

export async function getBackendBaseUrl(): Promise<string> {
  return invoke<string>("get_backend_base_url");
}

export async function setBackendBaseUrl(url: string): Promise<void> {
  await invoke("set_backend_base_url", { url });
}

export async function checkBackendHealth(): Promise<void> {
  await invoke("check_backend_health");
}

// --- Leads (shared team workspace) ---

export async function lookupCompanyPhone(company: string, listId?: string): Promise<void> {
  await invoke("lookup_company_phone", { company, listId: listId ?? null });
}

export async function getLogEntries(): Promise<Lead[]> {
  return invoke<Lead[]>("get_log_entries");
}

export async function updateLead(id: string, patch: LeadPatch): Promise<Lead> {
  return invoke<Lead>("update_lead", { id, ...patch });
}

export async function assignLead(id: string, assignedUserId: string | null): Promise<Lead> {
  return invoke<Lead>("assign_lead", { id, assignedUserId });
}

// --- Phone numbers (manual CRUD) ---

export async function addLeadPhone(leadId: string, phoneNumber: string): Promise<Lead> {
  return invoke<Lead>("add_lead_phone", { leadId, phoneNumber });
}

export async function updateLeadPhone(leadId: string, phoneId: string, phoneNumber: string): Promise<Lead> {
  return invoke<Lead>("update_lead_phone", { leadId, phoneId, phoneNumber });
}

export async function deleteLeadPhone(leadId: string, phoneId: string): Promise<Lead> {
  return invoke<Lead>("delete_lead_phone", { leadId, phoneId });
}

// --- Email addresses (manual CRUD, fully independent of phones) ---

export async function addLeadEmail(leadId: string, email: string): Promise<Lead> {
  return invoke<Lead>("add_lead_email", { leadId, email });
}

export async function updateLeadEmail(leadId: string, emailId: string, email: string): Promise<Lead> {
  return invoke<Lead>("update_lead_email", { leadId, emailId, email });
}

export async function deleteLeadEmail(leadId: string, emailId: string): Promise<Lead> {
  return invoke<Lead>("delete_lead_email", { leadId, emailId });
}

/** Independent AI email scraper — manual trigger only, never runs automatically. */
export async function scrapeLeadEmail(leadId: string): Promise<Lead> {
  return invoke<Lead>("scrape_lead_email", { leadId });
}

/** Free email checks: domain deliverability (DNS) + does the address match
 * the contact/director or is it a generic inbox. No AI, no paid service. */
export async function verifyLeadEmails(leadId: string): Promise<Lead> {
  return invoke<Lead>("verify_lead_emails", { leadId });
}

export async function exportLogCsv(destPath: string): Promise<void> {
  await invoke("export_log_csv", { destPath });
}

export async function migrateLocalLeadsToTeam(): Promise<number> {
  return invoke<number>("migrate_local_leads_to_team");
}

// --- Cold call lists (private per-user lead lists; admins reach all of them) ---

export async function createLeadList(name: string, forUserId?: string): Promise<LeadList> {
  return invoke<LeadList>("create_lead_list", { name, forUserId });
}

export async function listLeadLists(): Promise<LeadList[]> {
  return invoke<LeadList[]>("list_lead_lists");
}

export async function getListLeads(listId: string): Promise<Lead[]> {
  return invoke<Lead[]>("get_list_leads", { listId });
}

export async function importLeadsCsv(listId: string, csvPath: string): Promise<number> {
  return invoke<number>("import_leads_csv", { listId, csvPath });
}

export async function deleteLeadList(listId: string): Promise<void> {
  return invoke<void>("delete_lead_list", { listId });
}

export async function toggleListLeadCalled(listId: string, leadId: string): Promise<string | null> {
  return invoke<string | null>("toggle_list_lead_called", { listId, leadId });
}

export interface AddLeadsResult {
  added: number;
  skipped: number;
  skipped_details: Array<{ id: string; company: string; list_name: string }>;
}

export async function addLeadsToList(listId: string, leadIds: string[]): Promise<AddLeadsResult> {
  return invoke<AddLeadsResult>("add_leads_to_list", { listId, leadIds });
}

export async function setLeadFollowUp(leadId: string, followUpAt: string | null): Promise<Lead> {
  return invoke<Lead>("set_lead_follow_up", { leadId, followUpAt });
}

/** Toggle whether a lead is in the shared pool. Un-sharing keeps it visible only
 * to its owner, its assigned BDM, and admins. Owner/admin only (enforced backend). */
export async function setLeadShared(leadId: string, isShared: boolean): Promise<Lead> {
  return invoke<Lead>("set_lead_shared", { leadId, isShared });
}

/** Recompute the deterministic priority score for every lead in a list.
 * Free, no AI — returns how many leads were scored. */
export async function scoreLeadList(listId: string): Promise<number> {
  return invoke<number>("score_lead_list", { listId });
}

export async function importLeadsToDashboard(csvPath: string): Promise<number> {
  return invoke<number>("import_leads_to_dashboard", { csvPath });
}

export async function chEnrichAll(): Promise<{ enriched: number; remaining: number }> {
  return invoke<{ enriched: number; remaining: number }>("ch_enrich_all");
}

export interface EnrichStatus {
  running: boolean;
  enriched: number;
  remaining: number;
  failed: number;
}

export async function chEnrichAuto(): Promise<EnrichStatus> {
  return invoke<EnrichStatus>("ch_enrich_auto");
}

export async function chEnrichStatus(): Promise<EnrichStatus> {
  return invoke<EnrichStatus>("ch_enrich_status");
}

export async function chEnrichStop(): Promise<EnrichStatus> {
  return invoke<EnrichStatus>("ch_enrich_stop");
}

export async function dedupLeads(): Promise<number> {
  return invoke<number>("dedup_leads");
}

// --- AI Sales Intelligence — manual trigger only, full version history kept ---

/** Manual trigger only — also used for "Refresh" (same backend action). Never runs automatically. */
export async function generateLeadIntelligence(leadId: string): Promise<Lead> {
  return invoke<Lead>("generate_lead_intelligence", { leadId });
}

export async function getLeadIntelligenceHistory(leadId: string): Promise<LeadIntelligenceVersion[]> {
  return invoke<LeadIntelligenceVersion[]>("get_lead_intelligence_history", { leadId });
}

/** Read-only — reflects whatever's cached from the last intelligence generation. Never triggers a fetch itself. */
export async function getLeadLinkedInPosts(leadId: string): Promise<LeadLinkedInPosts> {
  return invoke<LeadLinkedInPosts>("get_lead_linkedin_posts", { leadId });
}

// --- Lead chat — read-only Q&A about a single lead (pre-existing backend endpoint) ---

export interface ChatTurn {
  role: "user" | "assistant";
  content: string;
}

export async function chatAboutLead(context: string, message: string, history: ChatTurn[]): Promise<string> {
  return invoke<string>("chat_about_lead", { context, message, history });
}

// --- Calendar events — private per-owner, same admin-override pattern as lead lists ---

export interface CalendarEvent {
  id: string;
  owner_user_id: string;
  title: string;
  date: string;
  time: string;
  type: "call" | "followup" | "task";
  lead_id: string | null;
  description: string;
  created_at: string;
  updated_at: string;
}

export interface CalendarEventPatch {
  title?: string;
  date?: string;
  time?: string;
  type?: CalendarEvent["type"];
  leadId?: string;
}

export async function listCalendarEvents(): Promise<CalendarEvent[]> {
  return invoke<CalendarEvent[]>("list_calendar_events");
}

export async function createCalendarEvent(
  title: string,
  date: string,
  time: string,
  type: CalendarEvent["type"],
  leadId?: string
): Promise<CalendarEvent> {
  return invoke<CalendarEvent>("create_calendar_event", { title, date, time, eventType: type, leadId });
}

export async function updateCalendarEvent(id: string, patch: CalendarEventPatch): Promise<CalendarEvent> {
  const { type, ...rest } = patch;
  return invoke<CalendarEvent>("update_calendar_event", { id, ...rest, eventType: type });
}

export async function deleteCalendarEvent(id: string): Promise<void> {
  await invoke("delete_calendar_event", { id });
}

// --- Call logs — shared per-lead history, no owner restriction ---

export type CallOutcome = "connected" | "voicemail" | "no_answer" | "wrong_number" | "other";

export interface CallLog {
  id: string;
  lead_id: string;
  calendar_event_id: string | null;
  outcome: CallOutcome;
  notes: string;
  duration_seconds: number | null;
  created_by: string;
  created_at: string;
}

export async function listCallLogs(leadId: string): Promise<CallLog[]> {
  return invoke<CallLog[]>("list_call_logs", { leadId });
}

export async function createCallLog(
  leadId: string,
  outcome: CallOutcome,
  notes: string,
  durationSeconds?: number,
  calendarEventId?: string
): Promise<CallLog> {
  return invoke<CallLog>("create_call_log", {
    leadId,
    outcome,
    notes,
    durationSeconds,
    calendarEventId,
  });
}

// --- AI Email Writer: brand voice ---

export interface BrandVoice {
  company_name: string;
  company_description: string;
  industry: string;
  target_audience: string;
  core_services: string;
  unique_selling_points: string;
  preferred_writing_style: string;
  preferred_cta_style: string;
  preferred_email_length: string;
  website: string;
  booking_link: string;
  signature: string;
}

export async function getBrandVoice(): Promise<BrandVoice> {
  return invoke<BrandVoice>("get_brand_voice");
}

export async function updateBrandVoice(brandVoice: BrandVoice): Promise<BrandVoice> {
  return invoke<BrandVoice>("update_brand_voice", { brandVoice });
}

// --- Credit limits & usage ---

export interface CreditLimits {
  limit_phone_lookup: number;
  limit_sales_intel: number;
  limit_win_back: number;
  limit_ai_prospecting: number;
  limit_email_writer: number;
  limit_enrichment: number;
  limit_lead_chat: number;
  limit_linkedin_scrape: number;
  limit_linkedin_discovery: number;
}

export interface CreditUsage {
  spend: Record<string, number>;
  limits: CreditLimits;
}

export async function getCreditLimits(): Promise<CreditLimits> {
  return invoke<CreditLimits>("get_credit_limits");
}

export async function saveCreditLimits(limits: CreditLimits): Promise<void> {
  return invoke("save_credit_limits", { limits });
}

export async function getCreditUsage(): Promise<CreditUsage> {
  return invoke<CreditUsage>("get_credit_usage");
}

// --- AI Email Writer: templates (private per creator) ---

export interface EmailTemplate {
  id: string;
  owner_user_id: string;
  owner_name: string | null;
  name: string;
  subject: string;
  body: string;
  tone: string;
  length: string;
  created_at: string;
  updated_at: string;
}

export async function createEmailTemplate(
  name: string,
  subject: string,
  body: string,
  tone: string,
  length: string
): Promise<EmailTemplate> {
  return invoke<EmailTemplate>("create_email_template", { name, subject, body, tone, length });
}

export async function listEmailTemplates(): Promise<EmailTemplate[]> {
  return invoke<EmailTemplate[]>("list_email_templates");
}

export async function updateEmailTemplate(
  id: string,
  patch: { name?: string; subject?: string; body?: string; tone?: string; length?: string }
): Promise<EmailTemplate> {
  return invoke<EmailTemplate>("update_email_template", { id, ...patch });
}

export async function deleteEmailTemplate(id: string): Promise<void> {
  await invoke("delete_email_template", { id });
}

export async function applyEmailTemplate(templateId: string, leadId: string): Promise<{ subject: string; body: string }> {
  return invoke<{ subject: string; body: string }>("apply_email_template", { templateId, leadId });
}

// --- AI Email Writer: drafts (lead-scoped) ---

export const EMAIL_PRESETS = [
  "Cold Outreach",
  "Follow Up",
  "Breakup Email",
  "Meeting Request",
  "Proposal Follow Up",
  "Recruitment Outreach",
  "Partnership Outreach",
  "Re-Engagement",
  "Customer Retention",
  "Custom",
] as const;
export type EmailPreset = (typeof EMAIL_PRESETS)[number];

export const EMAIL_LENGTHS = ["Short", "Medium", "Long"] as const;
export type EmailLength = (typeof EMAIL_LENGTHS)[number];

export interface EmailDraft {
  id: string;
  lead_id: string;
  owner_user_id: string;
  subject: string;
  body: string;
  tone: string;
  length: string;
  status: "draft" | "sent";
  sent_via: string | null;
  sent_at: string | null;
  estimated_open_rate: number | null;
  estimated_reply_rate: number | null;
  estimated_readability_score: number | null;
  created_at: string;
  updated_at: string;
}

/** Manual trigger only — spends Anthropic credits. */
export async function generateEmailDraft(
  leadId: string,
  instruction: string,
  preset: EmailPreset,
  length: EmailLength
): Promise<EmailDraft> {
  return invoke<EmailDraft>("generate_email_draft", { leadId, instruction, preset, length });
}

/** Manual trigger only — spends Anthropic credits. */
export async function refineEmailDraft(draftId: string, instruction: string): Promise<EmailDraft> {
  return invoke<EmailDraft>("refine_email_draft", { draftId, instruction });
}

/** One-click follow-up: drafts from the lead's call notes, company, industry
 * and previous emails. Returns a draft to review and send — never auto-sends.
 * Manual trigger only — spends Anthropic credits. */
export async function generateFollowUpDraft(leadId: string): Promise<EmailDraft> {
  return invoke<EmailDraft>("generate_follow_up_draft", { leadId });
}

export async function updateEmailDraft(id: string, patch: { subject?: string; body?: string }): Promise<EmailDraft> {
  return invoke<EmailDraft>("update_email_draft", { id, ...patch });
}

export async function listEmailDrafts(leadId: string): Promise<EmailDraft[]> {
  return invoke<EmailDraft[]>("list_email_drafts", { leadId });
}

export interface PendingEmailDraft extends EmailDraft {
  lead_company: string;
}

export async function listPendingEmailDrafts(): Promise<PendingEmailDraft[]> {
  return invoke<PendingEmailDraft[]>("list_pending_email_drafts");
}

export async function deleteEmailDraft(id: string): Promise<void> {
  await invoke("delete_email_draft", { id });
}

// --- AI Email Writer: personalisation, CTA suggestions, activity timeline ---

export interface PersonalisationOption {
  hook: string;
  pain_point_observation: string;
  growth_observation: string;
  opportunity_statement: string;
}

/** Manual trigger only — spends Anthropic credits. */
export async function generateEmailPersonalisation(leadId: string, count = 3): Promise<PersonalisationOption[]> {
  return invoke<PersonalisationOption[]>("generate_email_personalisation", { leadId, count });
}

/** Manual trigger only — spends Anthropic credits. */
export async function getEmailCtaSuggestions(leadId: string, goal: string): Promise<string[]> {
  return invoke<string[]>("get_email_cta_suggestions", { leadId, goal });
}

export interface TimelineEntry {
  timestamp: string;
  type: string;
  summary: string;
}

export async function getLeadTimeline(leadId: string): Promise<TimelineEntry[]> {
  return invoke<TimelineEntry[]>("get_lead_timeline", { leadId });
}

// --- AI Email Writer: OAuth email accounts (real sending — Gmail/Microsoft) ---

export type EmailProvider = "gmail" | "microsoft";

export interface EmailOAuthAccount {
  provider: EmailProvider;
  email_address: string;
}

/** Opens the OAuth consent flow in the system browser — never an embedded webview. */
export async function connectEmailAccount(provider: EmailProvider): Promise<void> {
  await invoke("connect_email_account", { provider });
}

export async function listEmailOAuthAccounts(): Promise<EmailOAuthAccount[]> {
  return invoke<EmailOAuthAccount[]>("list_email_oauth_accounts");
}

export async function disconnectEmailOAuthAccount(provider: EmailProvider): Promise<void> {
  await invoke("disconnect_email_oauth_account", { provider });
}

/** Manual trigger only — actually sends the email via the connected account. */
export async function sendEmailDraft(draftId: string, provider: EmailProvider): Promise<EmailDraft> {
  return invoke<EmailDraft>("send_email_draft", { draftId, provider });
}

export async function exportDraftsToMailchimp(
  campaignName: string,
  draftIds?: string[],
): Promise<{ mailchimp_url: string; exported: number; skipped: number }> {
  return invoke<{ mailchimp_url: string; exported: number; skipped: number }>(
    "export_drafts_to_mailchimp",
    { campaignName, draftIds: draftIds ?? null },
  );
}

// --- Sales Sequences — multi-channel automation (email + call/follow-up/reminder tasks) ---

export type SequenceStatus = "draft" | "active" | "paused";
export type SequenceStepType = "email" | "call_task" | "followup_task" | "reminder_task";
export type SequenceEnrollmentStatus = "active" | "completed" | "stopped";

export interface Sequence {
  id: string;
  name: string;
  owner_user_id: string;
  status: SequenceStatus;
  created_at: string;
  updated_at: string;
  step_count: number;
  enrollment_count: number;
}

export interface SequenceStep {
  id: string;
  sequence_id: string;
  step_order: number;
  delay_days: number;
  step_type: SequenceStepType;
  subject_template: string;
  body_template: string;
  created_at: string;
}

export interface SequenceEnrollment {
  id: string;
  sequence_id: string;
  lead_id: string;
  lead_company: string;
  current_step: number;
  status: SequenceEnrollmentStatus;
  last_error: string | null;
  enrolled_at: string;
  next_run_at: string | null;
  created_by: string;
}

export async function listSequences(): Promise<Sequence[]> {
  return invoke<Sequence[]>("list_sequences");
}

export async function createSequence(name: string): Promise<Sequence> {
  return invoke<Sequence>("create_sequence", { name });
}

export async function updateSequence(id: string, patch: { name?: string; status?: SequenceStatus }): Promise<Sequence> {
  return invoke<Sequence>("update_sequence", { id, ...patch });
}

export async function deleteSequence(id: string): Promise<void> {
  await invoke("delete_sequence", { id });
}

export async function listSequenceSteps(sequenceId: string): Promise<SequenceStep[]> {
  return invoke<SequenceStep[]>("list_sequence_steps", { sequenceId });
}

export async function addSequenceStep(
  sequenceId: string,
  delayDays: number,
  stepType: SequenceStepType,
  subjectTemplate: string,
  bodyTemplate: string
): Promise<SequenceStep> {
  return invoke<SequenceStep>("add_sequence_step", { sequenceId, delayDays, stepType, subjectTemplate, bodyTemplate });
}

export async function deleteSequenceStep(sequenceId: string, stepId: string): Promise<void> {
  await invoke("delete_sequence_step", { sequenceId, stepId });
}

export async function listSequenceEnrollments(sequenceId: string): Promise<SequenceEnrollment[]> {
  return invoke<SequenceEnrollment[]>("list_sequence_enrollments", { sequenceId });
}

export async function enrollLeadInSequence(sequenceId: string, leadId: string): Promise<SequenceEnrollment> {
  return invoke<SequenceEnrollment>("enroll_lead_in_sequence", { sequenceId, leadId });
}

export async function stopSequenceEnrollment(sequenceId: string, enrollmentId: string): Promise<void> {
  await invoke("stop_sequence_enrollment", { sequenceId, enrollmentId });
}

// --- AI Prospecting (Companies House automated lead sourcing) ---

export interface ProspectingCriteria {
  name: string;
  sic_codes: string[];
  locations: string[];
  location: string;
  company_type: string;
  incorporated_from: string;
  incorporated_to: string;
  max_results: number;
  min_ch_score: number;
  run_ai_enrichment: boolean;
  credit_limit_gbp: number;
  charge_types: string[];
  active_charges_only: boolean;
  include_satisfied: boolean;
  new_charges_only: boolean;
  charge_registered_from: string;
  charge_registered_to: string;
  min_charges: number;
  max_charges: number;
}

export interface ProspectingStatus {
  configured: boolean;
}

export interface ProspectingRun {
  id: string;
  name: string;
  status: "running" | "complete" | "error";
  criteria: string;
  found: number;
  created: number;
  skipped: number;
  total_available: number;
  error: string | null;
  started_at: string;
  completed_at: string | null;
  list_id: string | null;
}

export interface StartProspectingResponse {
  run_id: string;
  message: string;
}

export async function getProspectingStatus(): Promise<ProspectingStatus> {
  return invoke<ProspectingStatus>("get_prospecting_status");
}

export async function startProspectingRun(criteria: ProspectingCriteria): Promise<StartProspectingResponse> {
  return invoke<StartProspectingResponse>("start_prospecting_run", { criteria });
}

export async function getProspectingRun(runId: string): Promise<ProspectingRun> {
  return invoke<ProspectingRun>("get_prospecting_run", { runId });
}

export async function listProspectingRuns(): Promise<ProspectingRun[]> {
  return invoke<ProspectingRun[]>("list_prospecting_runs");
}

// --- Activity Feed (Companies House) ---

export interface ActivityEvent {
  id: string;
  company_number: string;
  company_name: string;
  lead_id: string | null;
  event_type: string;
  description: string;
  event_data: string | null;
  occurred_at: string;
  detected_at: string;
}

export interface ActivitySummary {
  count: number;
  latest_detected_at: string | null;
  has_recent_24h: boolean;
}

export async function listLeadActivity(leadId: string): Promise<ActivityEvent[]> {
  return invoke<ActivityEvent[]>("list_lead_activity", { leadId });
}

export async function getLeadActivitySummary(leadId: string): Promise<ActivitySummary> {
  return invoke<ActivitySummary>("get_lead_activity_summary", { leadId });
}

export async function triggerLeadRefresh(leadId: string): Promise<void> {
  await invoke("trigger_lead_refresh", { leadId });
}

export async function getGlobalActivityFeed(filters: {
  eventTypes?: string;
  since?: string;
  companyName?: string;
} = {}): Promise<ActivityEvent[]> {
  return invoke<ActivityEvent[]>("get_global_activity_feed", {
    eventTypes: filters.eventTypes ?? null,
    since: filters.since ?? null,
    companyName: filters.companyName ?? null,
  });
}

export async function getBatchActivitySummaries(
  leadIds: string[]
): Promise<Record<string, ActivitySummary>> {
  return invoke<Record<string, ActivitySummary>>("get_batch_activity_summaries", { leadIds });
}

export async function getActivityStatus(): Promise<{ configured: boolean }> {
  return invoke<{ configured: boolean }>("get_activity_status");
}

// --- CH Charge Feed ---

export interface ChCharge {
  id: string;
  company_number: string;
  company_name: string | null;
  filing_type: string;
  charge_description: string | null;
  filing_date: string | null;
  transaction_id: string | null;
  detected_at: string;
  lead_id: string | null;
}

export async function getChargeFeedStatus(): Promise<{ configured: boolean; timepoint: string | null }> {
  return invoke<{ configured: boolean; timepoint: string | null }>("get_charge_feed_status");
}

export async function getChargeFeed(filters: {
  companyName?: string;
  filingTypes?: string;
  since?: string;
  notAdded?: boolean;
  limit?: number;
  offset?: number;
} = {}): Promise<ChCharge[]> {
  return invoke<ChCharge[]>("get_charge_feed", {
    companyName: filters.companyName,
    filingTypes: filters.filingTypes,
    since: filters.since,
    notAdded: filters.notAdded ?? false,
    limit: filters.limit ?? 100,
    offset: filters.offset ?? 0,
  });
}

export async function addChargeAsLead(chargeId: string): Promise<{ lead_id: string; created: boolean }> {
  return invoke<{ lead_id: string; created: boolean }>("add_charge_as_lead", { chargeId });
}

// --- Win-back campaigns ---

export interface WinBackCampaign {
  id: string;
  name: string;
  status: "generating" | "ready" | "error";
  total: number;
  generated: number;
  created_at: string;
  email_instruction: string;
  offer_context: string;
  additional_context: string;
  campaign_links: string;
  signature: string;
}

export interface WinBackEmail {
  id: string;
  campaign_id: string;
  lead_id: string;
  subject: string;
  body: string;
  send_status: "draft" | "sent";
  sent_at: string | null;
  send_method: string | null;
  company: string;
  contact_name: string;
  contact_email: string;
  created_at: string;
}

export interface WinBackCampaignDetail {
  campaign: WinBackCampaign;
  emails: WinBackEmail[];
}

export async function createWinBackCampaign(name: string, leadIds: string[], depth = "standard", emailInstruction = "", offerContext = "", additionalContext = ""): Promise<WinBackCampaign> {
  return invoke<WinBackCampaign>("create_win_back_campaign", { name, leadIds, depth, emailInstruction, offerContext, additionalContext });
}

export async function getWinBackCampaigns(): Promise<WinBackCampaign[]> {
  return invoke<WinBackCampaign[]>("get_win_back_campaigns");
}

export async function getWinBackCampaign(campaignId: string): Promise<WinBackCampaignDetail> {
  return invoke<WinBackCampaignDetail>("get_win_back_campaign", { campaignId });
}

export async function sendWinBackEmail(campaignId: string, emailId: string, provider = "gmail"): Promise<void> {
  await invoke("send_win_back_email", { campaignId, emailId, provider });
}

/** Regenerates only the leads that never got an email (credit ceiling hit,
 * crash) — progress continues from where the campaign stopped. */
export async function resumeWinBackCampaign(campaignId: string): Promise<{ resumed: boolean; remaining: number }> {
  return invoke<{ resumed: boolean; remaining: number }>("resume_win_back_campaign", { campaignId });
}

export async function sendAllWinBackEmails(campaignId: string, provider = "gmail"): Promise<{ sent: number; failed: number }> {
  return invoke("send_all_win_back_emails", { campaignId, provider });
}

export async function exportWinBackMailchimp(campaignId: string, provider = "gmail"): Promise<string> {
  return invoke<string>("export_win_back_mailchimp", { campaignId, provider });
}

export interface WinBackCsvRow {
  company: string;
  contact_name: string;
  email: string;
  phone: string;
  website: string;
  linkedin: string;
  notes: string;
  industry: string;
  deal_owner?: string; // broker who originally arranged the deal (CSV "Deal Owner")
  // Recipient-filter fields (client-side only). closing_date is the raw CSV
  // string (DD/MM/YYYY or YYYY-MM-DD); amount is the raw £ string.
  closing_date?: string;
  stage?: string;
  amount?: string;
  // If both are set, create_win_back_campaign_from_csv reuses this instead of
  // paying for research + email generation again — only set when this row was
  // already previewed under the exact same generation settings.
  preview_subject?: string;
  preview_body?: string;
}

export async function parseWinBackCsv(path: string): Promise<WinBackCsvRow[]> {
  return invoke<WinBackCsvRow[]>("parse_win_back_csv", { path });
}

export async function createWinBackCampaignFromCsv(name: string, rows: WinBackCsvRow[], depth = "standard", emailInstruction = "", offerContext = "", additionalContext = "", campaignLinks = "", campaignLinkText = "", signature = "", sourceRows: WinBackCsvRow[] = []): Promise<WinBackCampaign> {
  return invoke<WinBackCampaign>("create_win_back_campaign_from_csv", { name, rows, sourceRows, depth, emailInstruction, offerContext, additionalContext, campaignLinks, campaignLinkText, signature });
}

export interface WinBackRerunDefaults {
  name: string;
  depth: string;
  email_instruction: string;
  offer_context: string;
  additional_context: string;
  campaign_links: string;
  campaign_link_text: string;
}

export interface WinBackCampaignRows {
  available: boolean;
  rows: WinBackCsvRow[];
  defaults: WinBackRerunDefaults;
}

/** The original uploaded CSV + generation settings for a campaign, so it can be
 * re-run ("Run again") from the same source list. `available` is false for
 * campaigns created before source rows were stored. */
export async function getWinBackCampaignRows(campaignId: string): Promise<WinBackCampaignRows> {
  return invoke<WinBackCampaignRows>("get_win_back_campaign_rows", { campaignId });
}

export async function previewWinBackCampaignEmail(row: WinBackCsvRow, emailInstruction = "", offerContext = "", additionalContext = "", campaignLinks = "", campaignLinkText = "", signature = "", depth = "standard"): Promise<{ subject: string; body: string }> {
  return invoke<{ subject: string; body: string }>("preview_win_back_campaign_email", { row, emailInstruction, offerContext, additionalContext, campaignLinks, campaignLinkText, signature, depth });
}

// --- List email campaigns ---
// A rep emails a whole cold-call list: one idea → a per-lead draft for every
// lead, grouped by status, sent from their own Gmail/Outlook. Per-lead drafts
// are ordinary email_drafts (edit via updateEmailDraft, single-send via
// sendEmailDraft); these calls manage the campaign + its bulk actions.

export interface ListCampaign {
  id: string;
  list_id: string;
  name: string;
  status: "generating" | "ready" | "stopped" | "error";
  total_target: number;
  generated: number;
  created_at: string;
  updated_at: string;
}

export interface ListCampaignDraft {
  id: string;
  lead_id: string;
  company: string;
  contact_name: string;
  contact_status: string;
  contact_email: string;
  subject: string;
  body: string;
  status: string;
  sent_via: string | null;
  sent_at: string | null;
}

export async function createListCampaign(
  listId: string,
  idea: string,
  opts: { name?: string; offers?: string; linkUrl?: string; linkText?: string; signature?: string } = {},
): Promise<ListCampaign> {
  return invoke<ListCampaign>("create_list_campaign", {
    listId,
    name: opts.name ?? "",
    idea,
    offers: opts.offers ?? "",
    linkUrl: opts.linkUrl ?? "",
    linkText: opts.linkText ?? "",
    signature: opts.signature ?? "",
  });
}

export async function getListCampaigns(): Promise<ListCampaign[]> {
  return invoke<ListCampaign[]>("get_list_campaigns");
}

export async function getListCampaign(campaignId: string): Promise<ListCampaign> {
  return invoke<ListCampaign>("get_list_campaign", { campaignId });
}

export async function getListCampaignDrafts(campaignId: string): Promise<ListCampaignDraft[]> {
  return invoke<ListCampaignDraft[]>("get_list_campaign_drafts", { campaignId });
}

export async function resumeListCampaign(campaignId: string): Promise<ListCampaign> {
  return invoke<ListCampaign>("resume_list_campaign", { campaignId });
}

export async function sendAllListCampaign(
  campaignId: string,
  provider: EmailProvider,
): Promise<{ sent: number; failed: number; skipped: number }> {
  return invoke<{ sent: number; failed: number; skipped: number }>("send_all_list_campaign", { campaignId, provider });
}
