mod app_state;
mod auth_client;
mod backend_client;
mod csv_log;

use app_state::StoredSession;
use auth_client::UserInfo;
use backend_client::{EnrichStatus, LeadRecord, WinBackCampaign, WinBackEmail};
use serde::Serialize;
use tauri_plugin_opener::OpenerExt;

#[derive(Serialize)]
struct ChEnrichResult {
    enriched: usize,
    remaining: usize,
}

fn require_session(app_handle: &tauri::AppHandle) -> Result<StoredSession, String> {
    app_state::load_session(app_handle).ok_or_else(|| "Not logged in".to_string())
}

// --- Auth ---

/// Name + password sign-in. A new name creates a profile with that password;
/// an existing name must supply the matching password.
#[tauri::command]
async fn identify(app_handle: tauri::AppHandle, name: String, password: String) -> Result<UserInfo, String> {
    let base_url = app_state::resolve_base_url(&app_handle);
    let (token, user) = auth_client::identify(&base_url, &name, &password).await?;
    app_state::save_session(&app_handle, &StoredSession { token, user: user.clone() })?;
    Ok(user)
}

#[tauri::command]
async fn logout(app_handle: tauri::AppHandle) -> Result<(), String> {
    if let Some(session) = app_state::load_session(&app_handle) {
        let base_url = app_state::resolve_base_url(&app_handle);
        let _ = auth_client::logout(&base_url, &session.token).await;
    }
    app_state::clear_session(&app_handle)
}

#[tauri::command]
async fn send_heartbeat(app_handle: tauri::AppHandle) -> Result<(), String> {
    let session = require_session(&app_handle)?;
    let base_url = app_state::resolve_base_url(&app_handle);
    auth_client::heartbeat(&base_url, &session.token).await
}

#[tauri::command]
fn get_current_session(app_handle: tauri::AppHandle) -> Option<UserInfo> {
    app_state::load_session(&app_handle).map(|s| s.user)
}

// --- Team management ---

/// Public on the backend (no password boundary) — callable before anyone is
/// signed in, since the identity picker needs to show known names.
#[tauri::command]
async fn list_team_members(app_handle: tauri::AppHandle) -> Result<Vec<UserInfo>, String> {
    let base_url = app_state::resolve_base_url(&app_handle);
    auth_client::list_team_members(&base_url).await
}

#[tauri::command]
async fn create_team_member(app_handle: tauri::AppHandle, name: String, role: String) -> Result<UserInfo, String> {
    let session = require_session(&app_handle)?;
    let base_url = app_state::resolve_base_url(&app_handle);
    auth_client::create_team_member(&base_url, &session.token, &name, &role).await
}

#[tauri::command]
async fn update_team_member(
    app_handle: tauri::AppHandle,
    user_id: String,
    name: Option<String>,
    role: Option<String>,
) -> Result<UserInfo, String> {
    let session = require_session(&app_handle)?;
    let base_url = app_state::resolve_base_url(&app_handle);
    auth_client::update_team_member(&base_url, &session.token, &user_id, name.as_deref(), role.as_deref()).await
}

#[tauri::command]
async fn delete_team_member(app_handle: tauri::AppHandle, user_id: String) -> Result<(), String> {
    let session = require_session(&app_handle)?;
    let base_url = app_state::resolve_base_url(&app_handle);
    auth_client::delete_team_member(&base_url, &session.token, &user_id).await
}

#[tauri::command]
async fn set_user_avatar(app_handle: tauri::AppHandle, user_id: String, avatar: Option<String>) -> Result<UserInfo, String> {
    let session = require_session(&app_handle)?;
    let base_url = app_state::resolve_base_url(&app_handle);
    auth_client::set_avatar(&base_url, &session.token, &user_id, avatar.as_deref()).await
}

/// Reads a local image file (picked via the file dialog) and returns it as a
/// data URL, so the frontend can resize/compress it on a canvas before
/// uploading. Read-only — never writes anything.
#[tauri::command]
fn read_image_as_data_url(path: String) -> Result<String, String> {
    use base64::Engine;

    let bytes = std::fs::read(&path).map_err(|e| format!("Could not read image file: {}", e))?;
    let mime = match std::path::Path::new(&path)
        .extension()
        .and_then(|ext| ext.to_str())
        .unwrap_or("")
        .to_lowercase()
        .as_str()
    {
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        _ => "image/png",
    };
    let encoded = base64::engine::general_purpose::STANDARD.encode(bytes);
    Ok(format!("data:{};base64,{}", mime, encoded))
}

// --- Backend connection ---

#[tauri::command]
fn get_backend_base_url(app_handle: tauri::AppHandle) -> String {
    app_state::resolve_base_url(&app_handle)
}

#[tauri::command]
fn set_backend_base_url(app_handle: tauri::AppHandle, url: String) -> Result<(), String> {
    app_state::save_backend_url(&app_handle, &url)
}

#[tauri::command]
async fn check_backend_health(app_handle: tauri::AppHandle) -> Result<(), String> {
    let base_url = app_state::resolve_base_url(&app_handle);
    backend_client::check_health(&base_url).await
}

// --- Leads (shared team workspace — all backed by the SQLite-backed /leads API, never csv_log.rs) ---

#[tauri::command]
async fn lookup_company_phone(app_handle: tauri::AppHandle, company: String, list_id: Option<String>) -> Result<LeadRecord, String> {
    let session = require_session(&app_handle)?;
    let base_url = app_state::resolve_base_url(&app_handle);
    backend_client::create_lead(&base_url, &session.token, &company, list_id.as_deref()).await
}

#[tauri::command]
async fn get_log_entries(app_handle: tauri::AppHandle) -> Result<Vec<LeadRecord>, String> {
    let session = require_session(&app_handle)?;
    let base_url = app_state::resolve_base_url(&app_handle);
    backend_client::list_leads(&base_url, &session.token).await
}

#[tauri::command]
async fn update_lead(
    app_handle: tauri::AppHandle,
    id: String,
    industry: Option<String>,
    contact_status: Option<String>,
    lead_notes: Option<String>,
    contact_name: Option<String>,
    contact_title: Option<String>,
    website: Option<String>,
    linkedin: Option<String>,
    opportunity_stage: Option<String>,
) -> Result<LeadRecord, String> {
    let session = require_session(&app_handle)?;
    let base_url = app_state::resolve_base_url(&app_handle);
    backend_client::update_lead(
        &base_url, &session.token, &id, industry, contact_status, lead_notes, contact_name, contact_title, website, linkedin,
        opportunity_stage,
    )
    .await
}

#[tauri::command]
async fn assign_lead(app_handle: tauri::AppHandle, id: String, assigned_user_id: Option<String>) -> Result<LeadRecord, String> {
    let session = require_session(&app_handle)?;
    let base_url = app_state::resolve_base_url(&app_handle);
    backend_client::assign_lead(&base_url, &session.token, &id, assigned_user_id).await
}

// --- Phone numbers (manual CRUD) ---

#[tauri::command]
async fn add_lead_phone(app_handle: tauri::AppHandle, lead_id: String, phone_number: String) -> Result<LeadRecord, String> {
    let session = require_session(&app_handle)?;
    let base_url = app_state::resolve_base_url(&app_handle);
    backend_client::add_phone(&base_url, &session.token, &lead_id, &phone_number).await
}

#[tauri::command]
async fn update_lead_phone(
    app_handle: tauri::AppHandle,
    lead_id: String,
    phone_id: String,
    phone_number: String,
) -> Result<LeadRecord, String> {
    let session = require_session(&app_handle)?;
    let base_url = app_state::resolve_base_url(&app_handle);
    backend_client::update_phone(&base_url, &session.token, &lead_id, &phone_id, &phone_number).await
}

#[tauri::command]
async fn delete_lead_phone(app_handle: tauri::AppHandle, lead_id: String, phone_id: String) -> Result<LeadRecord, String> {
    let session = require_session(&app_handle)?;
    let base_url = app_state::resolve_base_url(&app_handle);
    backend_client::delete_phone(&base_url, &session.token, &lead_id, &phone_id).await
}

// --- Email addresses (manual CRUD, fully independent of phones) ---

#[tauri::command]
async fn add_lead_email(app_handle: tauri::AppHandle, lead_id: String, email: String) -> Result<LeadRecord, String> {
    let session = require_session(&app_handle)?;
    let base_url = app_state::resolve_base_url(&app_handle);
    backend_client::add_email(&base_url, &session.token, &lead_id, &email).await
}

#[tauri::command]
async fn update_lead_email(
    app_handle: tauri::AppHandle,
    lead_id: String,
    email_id: String,
    email: String,
) -> Result<LeadRecord, String> {
    let session = require_session(&app_handle)?;
    let base_url = app_state::resolve_base_url(&app_handle);
    backend_client::update_email(&base_url, &session.token, &lead_id, &email_id, &email).await
}

#[tauri::command]
async fn delete_lead_email(app_handle: tauri::AppHandle, lead_id: String, email_id: String) -> Result<LeadRecord, String> {
    let session = require_session(&app_handle)?;
    let base_url = app_state::resolve_base_url(&app_handle);
    backend_client::delete_email(&base_url, &session.token, &lead_id, &email_id).await
}

/// Independent AI email scraper — manual trigger only, never runs as a side
/// effect of the phone-lookup flow above.
#[tauri::command]
async fn scrape_lead_email(app_handle: tauri::AppHandle, lead_id: String) -> Result<LeadRecord, String> {
    let session = require_session(&app_handle)?;
    let base_url = app_state::resolve_base_url(&app_handle);
    backend_client::scrape_email(&base_url, &session.token, &lead_id).await
}

// --- AI Sales Intelligence — manual trigger only, full version history kept ---

#[tauri::command]
async fn generate_lead_intelligence(app_handle: tauri::AppHandle, lead_id: String) -> Result<LeadRecord, String> {
    let session = require_session(&app_handle)?;
    let base_url = app_state::resolve_base_url(&app_handle);
    backend_client::generate_intelligence(&base_url, &session.token, &lead_id).await
}

#[tauri::command]
async fn get_lead_intelligence_history(
    app_handle: tauri::AppHandle,
    lead_id: String,
) -> Result<Vec<backend_client::LeadIntelligenceVersion>, String> {
    let session = require_session(&app_handle)?;
    let base_url = app_state::resolve_base_url(&app_handle);
    backend_client::get_intelligence_history(&base_url, &session.token, &lead_id).await
}

// --- Lead chat — read-only Q&A about a single lead (pre-existing backend endpoint) ---

#[tauri::command]
async fn chat_about_lead(
    app_handle: tauri::AppHandle,
    context: String,
    message: String,
    history: Vec<backend_client::ChatTurn>,
) -> Result<String, String> {
    let session = require_session(&app_handle)?;
    let base_url = app_state::resolve_base_url(&app_handle);
    backend_client::chat_about_lead(&base_url, &session.token, &context, &message, history).await
}

// --- Calendar events — private per-owner, same admin-override pattern as lead lists ---

#[tauri::command]
async fn list_calendar_events(app_handle: tauri::AppHandle) -> Result<Vec<backend_client::CalendarEventRecord>, String> {
    let session = require_session(&app_handle)?;
    let base_url = app_state::resolve_base_url(&app_handle);
    backend_client::list_calendar_events(&base_url, &session.token).await
}

#[tauri::command]
async fn create_calendar_event(
    app_handle: tauri::AppHandle,
    title: String,
    date: String,
    time: String,
    event_type: String,
    lead_id: Option<String>,
) -> Result<backend_client::CalendarEventRecord, String> {
    let session = require_session(&app_handle)?;
    let base_url = app_state::resolve_base_url(&app_handle);
    backend_client::create_calendar_event(&base_url, &session.token, &title, &date, &time, &event_type, lead_id.as_deref()).await
}

#[tauri::command]
async fn update_calendar_event(
    app_handle: tauri::AppHandle,
    id: String,
    title: Option<String>,
    date: Option<String>,
    time: Option<String>,
    event_type: Option<String>,
    lead_id: Option<String>,
) -> Result<backend_client::CalendarEventRecord, String> {
    let session = require_session(&app_handle)?;
    let base_url = app_state::resolve_base_url(&app_handle);
    backend_client::update_calendar_event(
        &base_url,
        &session.token,
        &id,
        title.as_deref(),
        date.as_deref(),
        time.as_deref(),
        event_type.as_deref(),
        lead_id.as_deref(),
    )
    .await
}

#[tauri::command]
async fn delete_calendar_event(app_handle: tauri::AppHandle, id: String) -> Result<(), String> {
    let session = require_session(&app_handle)?;
    let base_url = app_state::resolve_base_url(&app_handle);
    backend_client::delete_calendar_event(&base_url, &session.token, &id).await
}

// --- Call logs (shared per-lead history) ---

#[tauri::command]
async fn list_call_logs(app_handle: tauri::AppHandle, lead_id: String) -> Result<Vec<backend_client::CallLogRecord>, String> {
    let session = require_session(&app_handle)?;
    let base_url = app_state::resolve_base_url(&app_handle);
    backend_client::list_call_logs(&base_url, &session.token, &lead_id).await
}

#[tauri::command]
async fn create_call_log(
    app_handle: tauri::AppHandle,
    lead_id: String,
    calendar_event_id: Option<String>,
    outcome: String,
    notes: String,
    duration_seconds: Option<i64>,
) -> Result<backend_client::CallLogRecord, String> {
    let session = require_session(&app_handle)?;
    let base_url = app_state::resolve_base_url(&app_handle);
    backend_client::create_call_log(
        &base_url,
        &session.token,
        &lead_id,
        calendar_event_id.as_deref(),
        &outcome,
        &notes,
        duration_seconds,
    )
    .await
}

// --- Cold call lists (private per-user lead lists; admins reach all of them) ---

#[tauri::command]
async fn create_lead_list(app_handle: tauri::AppHandle, name: String, for_user_id: Option<String>) -> Result<backend_client::LeadList, String> {
    let session = require_session(&app_handle)?;
    let base_url = app_state::resolve_base_url(&app_handle);
    backend_client::create_lead_list(&base_url, &session.token, &name, for_user_id.as_deref()).await
}

#[tauri::command]
async fn list_lead_lists(app_handle: tauri::AppHandle) -> Result<Vec<backend_client::LeadList>, String> {
    let session = require_session(&app_handle)?;
    let base_url = app_state::resolve_base_url(&app_handle);
    backend_client::list_lead_lists(&base_url, &session.token).await
}

#[tauri::command]
async fn get_list_leads(app_handle: tauri::AppHandle, list_id: String) -> Result<Vec<LeadRecord>, String> {
    let session = require_session(&app_handle)?;
    let base_url = app_state::resolve_base_url(&app_handle);
    backend_client::get_list_leads(&base_url, &session.token, &list_id).await
}

/// Reads the user-picked CSV (arbitrary column layout) and bulk-imports it
/// into the given list. Never touches `csv_log.rs`'s own fixed-format log.
#[tauri::command]
async fn delete_lead_list(app_handle: tauri::AppHandle, list_id: String) -> Result<(), String> {
    let session = require_session(&app_handle)?;
    let base_url = app_state::resolve_base_url(&app_handle);
    backend_client::delete_lead_list(&base_url, &session.token, &list_id).await
}

#[tauri::command]
async fn import_leads_csv(app_handle: tauri::AppHandle, list_id: String, csv_path: String) -> Result<usize, String> {
    let session = require_session(&app_handle)?;
    let base_url = app_state::resolve_base_url(&app_handle);
    let rows = csv_log::parse_uploaded_csv(&csv_path)?;
    backend_client::import_leads_to_list(&base_url, &session.token, &list_id, rows).await
}

#[tauri::command]
async fn toggle_list_lead_called(app_handle: tauri::AppHandle, list_id: String, lead_id: String) -> Result<Option<String>, String> {
    let session = require_session(&app_handle)?;
    let base_url = app_state::resolve_base_url(&app_handle);
    backend_client::toggle_list_lead_called(&base_url, &session.token, &list_id, &lead_id).await
}

#[tauri::command]
async fn add_leads_to_list(app_handle: tauri::AppHandle, list_id: String, lead_ids: Vec<String>) -> Result<serde_json::Value, String> {
    let session = require_session(&app_handle)?;
    let base_url = app_state::resolve_base_url(&app_handle);
    backend_client::add_leads_to_list(&base_url, &session.token, &list_id, lead_ids).await
}

#[tauri::command]
async fn set_lead_follow_up(app_handle: tauri::AppHandle, lead_id: String, follow_up_at: Option<String>) -> Result<backend_client::LeadRecord, String> {
    let session = require_session(&app_handle)?;
    let base_url = app_state::resolve_base_url(&app_handle);
    backend_client::set_lead_follow_up(&base_url, &session.token, &lead_id, follow_up_at).await
}

#[tauri::command]
async fn ch_enrich_all(app_handle: tauri::AppHandle) -> Result<ChEnrichResult, String> {
    let session = require_session(&app_handle)?;
    let base_url = app_state::resolve_base_url(&app_handle);
    let (enriched, remaining) = backend_client::ch_enrich_all(&base_url, &session.token).await?;
    Ok(ChEnrichResult { enriched, remaining })
}

#[tauri::command]
async fn ch_enrich_auto(app_handle: tauri::AppHandle) -> Result<EnrichStatus, String> {
    let session = require_session(&app_handle)?;
    let base_url = app_state::resolve_base_url(&app_handle);
    backend_client::ch_enrich_auto(&base_url, &session.token).await
}

#[tauri::command]
async fn ch_enrich_status(app_handle: tauri::AppHandle) -> Result<EnrichStatus, String> {
    let session = require_session(&app_handle)?;
    let base_url = app_state::resolve_base_url(&app_handle);
    backend_client::ch_enrich_status(&base_url, &session.token).await
}

#[tauri::command]
async fn ch_enrich_stop(app_handle: tauri::AppHandle) -> Result<EnrichStatus, String> {
    let session = require_session(&app_handle)?;
    let base_url = app_state::resolve_base_url(&app_handle);
    backend_client::ch_enrich_stop(&base_url, &session.token).await
}

#[tauri::command]
async fn dedup_leads(app_handle: tauri::AppHandle) -> Result<usize, String> {
    let session = require_session(&app_handle)?;
    let base_url = app_state::resolve_base_url(&app_handle);
    backend_client::dedup_leads(&base_url, &session.token).await
}

/// Reads the user-picked CSV and bulk-imports leads into the main dashboard pool.
/// Falls back to the first column if no recognised company header is found.
#[tauri::command]
async fn import_leads_to_dashboard(app_handle: tauri::AppHandle, csv_path: String) -> Result<usize, String> {
    let session = require_session(&app_handle)?;
    let base_url = app_state::resolve_base_url(&app_handle);
    let rows = csv_log::parse_uploaded_csv(&csv_path)?;
    backend_client::import_leads_to_dashboard(&base_url, &session.token, rows).await
}

#[tauri::command]
async fn export_log_csv(app_handle: tauri::AppHandle, dest_path: String) -> Result<(), String> {
    let session = require_session(&app_handle)?;
    let base_url = app_state::resolve_base_url(&app_handle);
    let leads = backend_client::list_leads(&base_url, &session.token).await?;

    let file = std::fs::File::create(&dest_path).map_err(|e| format!("Could not create export file: {}", e))?;
    let mut writer = csv::Writer::from_writer(file);
    writer
        .write_record([
            "company",
            "phone_number",
            "source_url",
            "status",
            "notes",
            "industry",
            "contact_status",
            "lead_notes",
            "owner",
            "assigned_to",
        ])
        .map_err(|e| format!("Could not write CSV header: {}", e))?;
    for lead in leads {
        writer
            .write_record([
                lead.company,
                lead.phone_number,
                lead.source_url,
                lead.status,
                lead.notes,
                lead.industry,
                lead.contact_status,
                lead.lead_notes,
                lead.owner_name.unwrap_or_default(),
                lead.assigned_name.unwrap_or_default(),
            ])
            .map_err(|e| format!("Could not write CSV row: {}", e))?;
    }
    writer.flush().map_err(|e| format!("Could not flush CSV writer: {}", e))
}

// --- AI Email Writer: brand voice ---

#[tauri::command]
async fn get_brand_voice(app_handle: tauri::AppHandle) -> Result<backend_client::BrandVoice, String> {
    let session = require_session(&app_handle)?;
    let base_url = app_state::resolve_base_url(&app_handle);
    backend_client::get_brand_voice(&base_url, &session.token).await
}

#[tauri::command]
async fn update_brand_voice(
    app_handle: tauri::AppHandle,
    brand_voice: backend_client::BrandVoice,
) -> Result<backend_client::BrandVoice, String> {
    let session = require_session(&app_handle)?;
    let base_url = app_state::resolve_base_url(&app_handle);
    backend_client::update_brand_voice(&base_url, &session.token, &brand_voice).await
}

// --- Credit settings ---

#[tauri::command]
async fn get_credit_limits(app_handle: tauri::AppHandle) -> Result<backend_client::CreditLimits, String> {
    let session = require_session(&app_handle)?;
    let base_url = app_state::resolve_base_url(&app_handle);
    backend_client::get_credit_limits(&base_url, &session.token).await
}

#[tauri::command]
async fn save_credit_limits(
    app_handle: tauri::AppHandle,
    limits: backend_client::CreditLimits,
) -> Result<(), String> {
    let session = require_session(&app_handle)?;
    let base_url = app_state::resolve_base_url(&app_handle);
    backend_client::save_credit_limits(&base_url, &session.token, &limits).await
}

#[tauri::command]
async fn get_credit_usage(app_handle: tauri::AppHandle) -> Result<backend_client::CreditUsage, String> {
    let session = require_session(&app_handle)?;
    let base_url = app_state::resolve_base_url(&app_handle);
    backend_client::get_credit_usage(&base_url, &session.token).await
}

// --- AI Email Writer: templates ---

#[tauri::command]
async fn create_email_template(
    app_handle: tauri::AppHandle,
    name: String,
    subject: String,
    body: String,
    tone: String,
    length: String,
) -> Result<backend_client::EmailTemplate, String> {
    let session = require_session(&app_handle)?;
    let base_url = app_state::resolve_base_url(&app_handle);
    backend_client::create_email_template(&base_url, &session.token, &name, &subject, &body, &tone, &length).await
}

#[tauri::command]
async fn list_email_templates(app_handle: tauri::AppHandle) -> Result<Vec<backend_client::EmailTemplate>, String> {
    let session = require_session(&app_handle)?;
    let base_url = app_state::resolve_base_url(&app_handle);
    backend_client::list_email_templates(&base_url, &session.token).await
}

#[tauri::command]
async fn update_email_template(
    app_handle: tauri::AppHandle,
    id: String,
    name: Option<String>,
    subject: Option<String>,
    body: Option<String>,
    tone: Option<String>,
    length: Option<String>,
) -> Result<backend_client::EmailTemplate, String> {
    let session = require_session(&app_handle)?;
    let base_url = app_state::resolve_base_url(&app_handle);
    backend_client::update_email_template(
        &base_url, &session.token, &id, name.as_deref(), subject.as_deref(), body.as_deref(), tone.as_deref(), length.as_deref(),
    )
    .await
}

#[tauri::command]
async fn delete_email_template(app_handle: tauri::AppHandle, id: String) -> Result<(), String> {
    let session = require_session(&app_handle)?;
    let base_url = app_state::resolve_base_url(&app_handle);
    backend_client::delete_email_template(&base_url, &session.token, &id).await
}

#[tauri::command]
async fn apply_email_template(
    app_handle: tauri::AppHandle,
    template_id: String,
    lead_id: String,
) -> Result<backend_client::AppliedEmailTemplate, String> {
    let session = require_session(&app_handle)?;
    let base_url = app_state::resolve_base_url(&app_handle);
    backend_client::apply_email_template(&base_url, &session.token, &template_id, &lead_id).await
}

// --- AI Email Writer: drafts ---

#[tauri::command]
async fn generate_email_draft(
    app_handle: tauri::AppHandle,
    lead_id: String,
    instruction: String,
    preset: String,
    length: String,
) -> Result<backend_client::EmailDraft, String> {
    let session = require_session(&app_handle)?;
    let base_url = app_state::resolve_base_url(&app_handle);
    backend_client::generate_email_draft(&base_url, &session.token, &lead_id, &instruction, &preset, &length).await
}

#[tauri::command]
async fn refine_email_draft(
    app_handle: tauri::AppHandle,
    draft_id: String,
    instruction: String,
) -> Result<backend_client::EmailDraft, String> {
    let session = require_session(&app_handle)?;
    let base_url = app_state::resolve_base_url(&app_handle);
    backend_client::refine_email_draft(&base_url, &session.token, &draft_id, &instruction).await
}

#[tauri::command]
async fn update_email_draft(
    app_handle: tauri::AppHandle,
    id: String,
    subject: Option<String>,
    body: Option<String>,
) -> Result<backend_client::EmailDraft, String> {
    let session = require_session(&app_handle)?;
    let base_url = app_state::resolve_base_url(&app_handle);
    backend_client::update_email_draft(&base_url, &session.token, &id, subject.as_deref(), body.as_deref()).await
}

#[tauri::command]
async fn list_email_drafts(app_handle: tauri::AppHandle, lead_id: String) -> Result<Vec<backend_client::EmailDraft>, String> {
    let session = require_session(&app_handle)?;
    let base_url = app_state::resolve_base_url(&app_handle);
    backend_client::list_email_drafts(&base_url, &session.token, &lead_id).await
}

#[tauri::command]
async fn list_pending_email_drafts(app_handle: tauri::AppHandle) -> Result<Vec<backend_client::PendingEmailDraft>, String> {
    let session = require_session(&app_handle)?;
    let base_url = app_state::resolve_base_url(&app_handle);
    backend_client::list_pending_email_drafts(&base_url, &session.token).await
}

#[tauri::command]
async fn delete_email_draft(app_handle: tauri::AppHandle, id: String) -> Result<(), String> {
    let session = require_session(&app_handle)?;
    let base_url = app_state::resolve_base_url(&app_handle);
    backend_client::delete_email_draft(&base_url, &session.token, &id).await
}

// --- AI Email Writer: personalisation, CTA suggestions, activity timeline ---

#[tauri::command]
async fn generate_email_personalisation(
    app_handle: tauri::AppHandle,
    lead_id: String,
    count: i64,
) -> Result<Vec<backend_client::PersonalisationOption>, String> {
    let session = require_session(&app_handle)?;
    let base_url = app_state::resolve_base_url(&app_handle);
    backend_client::generate_email_personalisation(&base_url, &session.token, &lead_id, count).await
}

#[tauri::command]
async fn get_email_cta_suggestions(app_handle: tauri::AppHandle, lead_id: String, goal: String) -> Result<Vec<String>, String> {
    let session = require_session(&app_handle)?;
    let base_url = app_state::resolve_base_url(&app_handle);
    backend_client::get_email_cta_suggestions(&base_url, &session.token, &lead_id, &goal).await
}

#[tauri::command]
async fn get_lead_timeline(app_handle: tauri::AppHandle, lead_id: String) -> Result<Vec<backend_client::TimelineEntry>, String> {
    let session = require_session(&app_handle)?;
    let base_url = app_state::resolve_base_url(&app_handle);
    backend_client::get_lead_timeline(&base_url, &session.token, &lead_id).await
}

// --- AI Email Writer: OAuth email accounts (real sending — Gmail/Microsoft) ---

/// Fetches the authorization URL from the backend and opens it in the
/// system browser — OAuth consent must never happen in an embedded webview.
#[tauri::command]
async fn connect_email_account(app_handle: tauri::AppHandle, provider: String) -> Result<(), String> {
    let session = require_session(&app_handle)?;
    let base_url = app_state::resolve_base_url(&app_handle);
    let url = backend_client::get_email_oauth_connect_url(&base_url, &session.token, &provider).await?;
    app_handle
        .opener()
        .open_url(&url, None::<String>)
        .map_err(|e| format!("Failed to open browser: {}", e))
}

#[tauri::command]
async fn list_email_oauth_accounts(app_handle: tauri::AppHandle) -> Result<Vec<backend_client::EmailOAuthAccount>, String> {
    let session = require_session(&app_handle)?;
    let base_url = app_state::resolve_base_url(&app_handle);
    backend_client::list_email_oauth_accounts(&base_url, &session.token).await
}

#[tauri::command]
async fn disconnect_email_oauth_account(app_handle: tauri::AppHandle, provider: String) -> Result<(), String> {
    let session = require_session(&app_handle)?;
    let base_url = app_state::resolve_base_url(&app_handle);
    backend_client::disconnect_email_oauth_account(&base_url, &session.token, &provider).await
}

#[tauri::command]
async fn send_email_draft(
    app_handle: tauri::AppHandle,
    draft_id: String,
    provider: String,
) -> Result<backend_client::EmailDraft, String> {
    let session = require_session(&app_handle)?;
    let base_url = app_state::resolve_base_url(&app_handle);
    backend_client::send_email_draft(&base_url, &session.token, &draft_id, &provider).await
}

#[tauri::command]
async fn export_drafts_to_mailchimp(
    app_handle: tauri::AppHandle,
    campaign_name: String,
    draft_ids: Option<Vec<String>>,
) -> Result<serde_json::Value, String> {
    let session = require_session(&app_handle)?;
    let base_url = app_state::resolve_base_url(&app_handle);
    backend_client::export_drafts_to_mailchimp(&base_url, &session.token, &campaign_name, draft_ids).await
}

// --- Sales Sequences ---

#[tauri::command]
async fn list_sequences(app_handle: tauri::AppHandle) -> Result<Vec<backend_client::SequenceRecord>, String> {
    let session = require_session(&app_handle)?;
    let base_url = app_state::resolve_base_url(&app_handle);
    backend_client::list_sequences(&base_url, &session.token).await
}

#[tauri::command]
async fn create_sequence(app_handle: tauri::AppHandle, name: String) -> Result<backend_client::SequenceRecord, String> {
    let session = require_session(&app_handle)?;
    let base_url = app_state::resolve_base_url(&app_handle);
    backend_client::create_sequence(&base_url, &session.token, &name).await
}

#[tauri::command]
async fn update_sequence(
    app_handle: tauri::AppHandle,
    id: String,
    name: Option<String>,
    status: Option<String>,
) -> Result<backend_client::SequenceRecord, String> {
    let session = require_session(&app_handle)?;
    let base_url = app_state::resolve_base_url(&app_handle);
    backend_client::update_sequence(&base_url, &session.token, &id, name.as_deref(), status.as_deref()).await
}

#[tauri::command]
async fn delete_sequence(app_handle: tauri::AppHandle, id: String) -> Result<(), String> {
    let session = require_session(&app_handle)?;
    let base_url = app_state::resolve_base_url(&app_handle);
    backend_client::delete_sequence(&base_url, &session.token, &id).await
}

#[tauri::command]
async fn list_sequence_steps(
    app_handle: tauri::AppHandle,
    sequence_id: String,
) -> Result<Vec<backend_client::SequenceStepRecord>, String> {
    let session = require_session(&app_handle)?;
    let base_url = app_state::resolve_base_url(&app_handle);
    backend_client::list_sequence_steps(&base_url, &session.token, &sequence_id).await
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
async fn add_sequence_step(
    app_handle: tauri::AppHandle,
    sequence_id: String,
    delay_days: i64,
    step_type: String,
    subject_template: String,
    body_template: String,
) -> Result<backend_client::SequenceStepRecord, String> {
    let session = require_session(&app_handle)?;
    let base_url = app_state::resolve_base_url(&app_handle);
    backend_client::add_sequence_step(
        &base_url, &session.token, &sequence_id, delay_days, &step_type, &subject_template, &body_template,
    )
    .await
}

#[tauri::command]
async fn delete_sequence_step(app_handle: tauri::AppHandle, sequence_id: String, step_id: String) -> Result<(), String> {
    let session = require_session(&app_handle)?;
    let base_url = app_state::resolve_base_url(&app_handle);
    backend_client::delete_sequence_step(&base_url, &session.token, &sequence_id, &step_id).await
}

#[tauri::command]
async fn list_sequence_enrollments(
    app_handle: tauri::AppHandle,
    sequence_id: String,
) -> Result<Vec<backend_client::SequenceEnrollmentRecord>, String> {
    let session = require_session(&app_handle)?;
    let base_url = app_state::resolve_base_url(&app_handle);
    backend_client::list_sequence_enrollments(&base_url, &session.token, &sequence_id).await
}

#[tauri::command]
async fn enroll_lead_in_sequence(
    app_handle: tauri::AppHandle,
    sequence_id: String,
    lead_id: String,
) -> Result<backend_client::SequenceEnrollmentRecord, String> {
    let session = require_session(&app_handle)?;
    let base_url = app_state::resolve_base_url(&app_handle);
    backend_client::enroll_lead_in_sequence(&base_url, &session.token, &sequence_id, &lead_id).await
}

#[tauri::command]
async fn stop_sequence_enrollment(
    app_handle: tauri::AppHandle,
    sequence_id: String,
    enrollment_id: String,
) -> Result<(), String> {
    let session = require_session(&app_handle)?;
    let base_url = app_state::resolve_base_url(&app_handle);
    backend_client::stop_sequence_enrollment(&base_url, &session.token, &sequence_id, &enrollment_id).await
}

// --- AI Prospecting ---

#[tauri::command]
async fn get_prospecting_status(app_handle: tauri::AppHandle) -> Result<backend_client::ProspectingStatus, String> {
    let session = require_session(&app_handle)?;
    let base_url = app_state::resolve_base_url(&app_handle);
    backend_client::get_prospecting_status(&base_url, &session.token).await
}

#[tauri::command]
async fn start_prospecting_run(
    app_handle: tauri::AppHandle,
    criteria: backend_client::ProspectingCriteria,
) -> Result<backend_client::StartProspectingResponse, String> {
    let session = require_session(&app_handle)?;
    let base_url = app_state::resolve_base_url(&app_handle);
    backend_client::start_prospecting_run(&base_url, &session.token, &criteria).await
}

#[tauri::command]
async fn get_prospecting_run(
    app_handle: tauri::AppHandle,
    run_id: String,
) -> Result<backend_client::ProspectingRunRecord, String> {
    let session = require_session(&app_handle)?;
    let base_url = app_state::resolve_base_url(&app_handle);
    backend_client::get_prospecting_run(&base_url, &session.token, &run_id).await
}

#[tauri::command]
async fn list_prospecting_runs(app_handle: tauri::AppHandle) -> Result<Vec<backend_client::ProspectingRunRecord>, String> {
    let session = require_session(&app_handle)?;
    let base_url = app_state::resolve_base_url(&app_handle);
    backend_client::list_prospecting_runs(&base_url, &session.token).await
}

// --- Activity Feed (DataGardener) ---

#[tauri::command]
async fn list_lead_activity(
    app_handle: tauri::AppHandle,
    lead_id: String,
) -> Result<Vec<backend_client::ActivityEvent>, String> {
    let session = require_session(&app_handle)?;
    let base_url = app_state::resolve_base_url(&app_handle);
    backend_client::list_lead_activity(&base_url, &session.token, &lead_id).await
}

#[tauri::command]
async fn get_lead_activity_summary(
    app_handle: tauri::AppHandle,
    lead_id: String,
) -> Result<backend_client::ActivitySummary, String> {
    let session = require_session(&app_handle)?;
    let base_url = app_state::resolve_base_url(&app_handle);
    backend_client::get_lead_activity_summary(&base_url, &session.token, &lead_id).await
}

#[tauri::command]
async fn trigger_lead_refresh(
    app_handle: tauri::AppHandle,
    lead_id: String,
) -> Result<(), String> {
    let session = require_session(&app_handle)?;
    let base_url = app_state::resolve_base_url(&app_handle);
    backend_client::trigger_lead_refresh(&base_url, &session.token, &lead_id).await
}

#[tauri::command]
async fn get_global_activity_feed(
    app_handle: tauri::AppHandle,
    event_types: Option<String>,
    since: Option<String>,
    company_name: Option<String>,
) -> Result<Vec<backend_client::ActivityEvent>, String> {
    let session = require_session(&app_handle)?;
    let base_url = app_state::resolve_base_url(&app_handle);
    backend_client::get_global_activity_feed(
        &base_url,
        &session.token,
        event_types.as_deref(),
        since.as_deref(),
        company_name.as_deref(),
    ).await
}

#[tauri::command]
async fn get_batch_activity_summaries(
    app_handle: tauri::AppHandle,
    lead_ids: Vec<String>,
) -> Result<std::collections::HashMap<String, backend_client::ActivitySummary>, String> {
    let session = require_session(&app_handle)?;
    let base_url = app_state::resolve_base_url(&app_handle);
    backend_client::get_batch_activity_summaries(&base_url, &session.token, &lead_ids).await
}

#[tauri::command]
async fn get_activity_status(app_handle: tauri::AppHandle) -> Result<serde_json::Value, String> {
    let session = require_session(&app_handle)?;
    let base_url = app_state::resolve_base_url(&app_handle);
    backend_client::get_activity_status(&base_url, &session.token).await
}

/// One-time, admin-only: imports the legacy local CSV (pre-team-workspace
/// data) into the shared backend. Only place in the app that still reads
/// `csv_log.rs` at runtime.
#[tauri::command]
async fn migrate_local_leads_to_team(app_handle: tauri::AppHandle) -> Result<usize, String> {
    let session = require_session(&app_handle)?;
    let base_url = app_state::resolve_base_url(&app_handle);
    let local_leads = csv_log::read_all(&app_handle)?;

    let payload: Vec<serde_json::Value> = local_leads
        .iter()
        .map(|l| {
            serde_json::json!({
                "company": l.company,
                "phone_number": l.phone_number,
                "source_url": l.source_url,
                "status": l.status,
                "notes": l.notes,
                "timestamp": l.timestamp,
            })
        })
        .collect();

    backend_client::migrate_leads(&base_url, &session.token, payload).await
}

// --- CH Charge Feed ---

#[tauri::command]
async fn get_charge_feed_status(app_handle: tauri::AppHandle) -> Result<serde_json::Value, String> {
    let session = require_session(&app_handle)?;
    let base_url = app_state::resolve_base_url(&app_handle);
    backend_client::get_charge_feed_status(&base_url, &session.token).await
}

#[tauri::command]
async fn get_charge_feed(
    app_handle: tauri::AppHandle,
    company_name: Option<String>,
    filing_types: Option<String>,
    since: Option<String>,
    not_added: bool,
    limit: u32,
    offset: u32,
) -> Result<Vec<backend_client::ChCharge>, String> {
    let session = require_session(&app_handle)?;
    let base_url = app_state::resolve_base_url(&app_handle);
    backend_client::get_charge_feed(
        &base_url,
        &session.token,
        company_name.as_deref(),
        filing_types.as_deref(),
        since.as_deref(),
        not_added,
        limit,
        offset,
    ).await
}

#[tauri::command]
async fn add_charge_as_lead(app_handle: tauri::AppHandle, charge_id: String) -> Result<serde_json::Value, String> {
    let session = require_session(&app_handle)?;
    let base_url = app_state::resolve_base_url(&app_handle);
    backend_client::add_charge_as_lead(&base_url, &session.token, &charge_id).await
}

// --- Win-back campaigns ---

#[derive(Serialize)]
struct WinBackCampaignDetail {
    campaign: WinBackCampaign,
    emails: Vec<WinBackEmail>,
}

#[tauri::command]
async fn create_win_back_campaign(app_handle: tauri::AppHandle, name: String, lead_ids: Vec<String>, depth: String) -> Result<WinBackCampaign, String> {
    let session = require_session(&app_handle)?;
    let base_url = app_state::resolve_base_url(&app_handle);
    backend_client::create_win_back_campaign(&base_url, &session.token, &name, lead_ids, &depth).await
}

#[tauri::command]
async fn get_win_back_campaigns(app_handle: tauri::AppHandle) -> Result<Vec<WinBackCampaign>, String> {
    let session = require_session(&app_handle)?;
    let base_url = app_state::resolve_base_url(&app_handle);
    backend_client::get_win_back_campaigns(&base_url, &session.token).await
}

#[tauri::command]
async fn get_win_back_campaign(app_handle: tauri::AppHandle, campaign_id: String) -> Result<WinBackCampaignDetail, String> {
    let session = require_session(&app_handle)?;
    let base_url = app_state::resolve_base_url(&app_handle);
    let (campaign, emails) = backend_client::get_win_back_campaign(&base_url, &session.token, &campaign_id).await?;
    Ok(WinBackCampaignDetail { campaign, emails })
}

#[tauri::command]
async fn send_win_back_email(app_handle: tauri::AppHandle, campaign_id: String, email_id: String, provider: String) -> Result<(), String> {
    let session = require_session(&app_handle)?;
    let base_url = app_state::resolve_base_url(&app_handle);
    backend_client::send_win_back_email(&base_url, &session.token, &campaign_id, &email_id, &provider).await
}

#[tauri::command]
async fn send_all_win_back_emails(app_handle: tauri::AppHandle, campaign_id: String, provider: String) -> Result<serde_json::Value, String> {
    let session = require_session(&app_handle)?;
    let base_url = app_state::resolve_base_url(&app_handle);
    backend_client::send_all_win_back_emails(&base_url, &session.token, &campaign_id, &provider).await
}

#[tauri::command]
async fn resume_win_back_campaign(app_handle: tauri::AppHandle, campaign_id: String) -> Result<serde_json::Value, String> {
    let session = require_session(&app_handle)?;
    let base_url = app_state::resolve_base_url(&app_handle);
    backend_client::resume_win_back_campaign(&base_url, &session.token, &campaign_id).await
}

#[tauri::command]
async fn export_win_back_mailchimp(app_handle: tauri::AppHandle, campaign_id: String, provider: String) -> Result<String, String> {
    let session = require_session(&app_handle)?;
    let base_url = app_state::resolve_base_url(&app_handle);
    backend_client::export_win_back_mailchimp(&base_url, &session.token, &campaign_id, &provider).await
}

#[tauri::command]
fn parse_win_back_csv(path: String) -> Result<Vec<serde_json::Value>, String> {
    csv_log::parse_uploaded_csv(&path)
}

#[tauri::command]
async fn create_win_back_campaign_from_csv(
    app_handle: tauri::AppHandle,
    name: String,
    rows: Vec<backend_client::WinBackCsvRow>,
    depth: String,
) -> Result<WinBackCampaign, String> {
    let session = require_session(&app_handle)?;
    let base_url = app_state::resolve_base_url(&app_handle);
    backend_client::create_win_back_campaign_from_csv(&base_url, &session.token, &name, rows, &depth).await
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  tauri::Builder::default()
    .plugin(tauri_plugin_dialog::init())
    .plugin(tauri_plugin_opener::init())
    .plugin(tauri_plugin_process::init())
    .setup(|app| {
      if cfg!(debug_assertions) {
        app.handle().plugin(
          tauri_plugin_log::Builder::default()
            .level(log::LevelFilter::Info)
            .build(),
        )?;
      }
      app.handle().plugin(tauri_plugin_updater::Builder::new().build())?;
      Ok(())
    })
    .invoke_handler(tauri::generate_handler![
      identify,
      logout,
      send_heartbeat,
      get_current_session,
      list_team_members,
      create_team_member,
      update_team_member,
      delete_team_member,
      set_user_avatar,
      read_image_as_data_url,
      get_backend_base_url,
      set_backend_base_url,
      check_backend_health,
      lookup_company_phone,
      get_log_entries,
      update_lead,
      assign_lead,
      add_lead_phone,
      update_lead_phone,
      delete_lead_phone,
      add_lead_email,
      update_lead_email,
      delete_lead_email,
      scrape_lead_email,
      generate_lead_intelligence,
      get_lead_intelligence_history,
      chat_about_lead,
      list_calendar_events,
      create_calendar_event,
      update_calendar_event,
      delete_calendar_event,
      list_call_logs,
      create_call_log,
      create_lead_list,
      list_lead_lists,
      get_list_leads,
      delete_lead_list,
      import_leads_csv,
      import_leads_to_dashboard,
      toggle_list_lead_called,
      add_leads_to_list,
      set_lead_follow_up,
      ch_enrich_all,
      ch_enrich_auto,
      ch_enrich_status,
      ch_enrich_stop,
      dedup_leads,
      get_brand_voice,
      update_brand_voice,
      get_credit_limits,
      save_credit_limits,
      get_credit_usage,
      create_email_template,
      list_email_templates,
      update_email_template,
      delete_email_template,
      apply_email_template,
      generate_email_draft,
      refine_email_draft,
      update_email_draft,
      list_email_drafts,
      list_pending_email_drafts,
      delete_email_draft,
      generate_email_personalisation,
      get_email_cta_suggestions,
      get_lead_timeline,
      connect_email_account,
      list_email_oauth_accounts,
      disconnect_email_oauth_account,
      send_email_draft,
      export_drafts_to_mailchimp,
      list_sequences,
      create_sequence,
      update_sequence,
      delete_sequence,
      list_sequence_steps,
      add_sequence_step,
      delete_sequence_step,
      list_sequence_enrollments,
      enroll_lead_in_sequence,
      stop_sequence_enrollment,
      get_prospecting_status,
      start_prospecting_run,
      get_prospecting_run,
      list_prospecting_runs,
      list_lead_activity,
      get_lead_activity_summary,
      trigger_lead_refresh,
      get_global_activity_feed,
      get_batch_activity_summaries,
      get_activity_status,
      get_charge_feed_status,
      get_charge_feed,
      add_charge_as_lead,
      export_log_csv,
      migrate_local_leads_to_team,
      create_win_back_campaign,
      get_win_back_campaigns,
      get_win_back_campaign,
      send_win_back_email,
      send_all_win_back_emails,
      resume_win_back_campaign,
      export_win_back_mailchimp,
      parse_win_back_csv,
      create_win_back_campaign_from_csv
    ])
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}
