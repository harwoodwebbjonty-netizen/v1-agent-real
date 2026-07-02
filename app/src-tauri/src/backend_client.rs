use serde::{Deserialize, Serialize};

/// Compiled-in default backend URL. Not a secret — safe to compile into the
/// app. Can be overridden per-install at runtime (see `app_state.rs`) since
/// deployment/hosting isn't fixed yet for a team workspace — every caller
/// resolves the actual base URL via `app_state::resolve_base_url` and passes
/// it in here explicitly, rather than this module holding global state.
pub fn default_base_url() -> &'static str {
    match option_env!("BACKEND_BASE_URL") {
        Some(url) => url,
        None => "http://localhost:8000",
    }
}

async fn handle_response<T: serde::de::DeserializeOwned>(response: reqwest::Response) -> Result<T, String> {
    if response.status() == reqwest::StatusCode::TOO_MANY_REQUESTS {
        return Err("Rate limit exceeded. Try again shortly.".to_string());
    }
    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        return Err(format!("Backend returned {}: {}", status, body));
    }
    response
        .json::<T>()
        .await
        .map_err(|e| format!("Failed to parse backend response: {}", e))
}

pub async fn check_health(base_url: &str) -> Result<(), String> {
    let client = reqwest::Client::new();
    let url = format!("{}/health", base_url);

    let response = client
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("Failed to reach backend at {}: {}", url, e))?;

    if response.status().is_success() {
        Ok(())
    } else {
        Err(format!("Backend returned {}", response.status()))
    }
}

// --- Shared leads (team workspace) ---

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PhoneRecord {
    pub id: String,
    pub phone_number: String,
    pub source: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EmailRecord {
    pub id: String,
    pub email: String,
    pub source: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NextBestAction {
    pub action: String,
    pub reason: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LeadRecord {
    pub id: String,
    pub timestamp: String,
    pub company: String,
    pub phone_number: String,
    pub source_url: String,
    pub status: String,
    pub notes: String,
    pub industry: String,
    pub contact_status: String,
    pub lead_notes: String,
    pub contact_name: String,
    pub contact_title: String,
    pub website: String,
    pub linkedin: String,
    pub owner_user_id: Option<String>,
    pub owner_name: Option<String>,
    pub assigned_user_id: Option<String>,
    pub assigned_name: Option<String>,
    pub list_id: Option<String>,
    pub opportunity_stage: String,
    pub next_best_action: NextBestAction,
    pub company_number: Option<String>,
    pub ch_data: Option<String>,
    pub phones: Vec<PhoneRecord>,
    pub emails: Vec<EmailRecord>,
    pub intelligence: Option<LeadIntelligence>,
}

#[derive(Deserialize)]
struct LeadListResponse {
    leads: Vec<LeadRecord>,
}

pub async fn list_leads(base_url: &str, token: &str) -> Result<Vec<LeadRecord>, String> {
    let client = reqwest::Client::new();
    let url = format!("{}/leads", base_url);
    let response = client
        .get(&url)
        .header("Authorization", format!("Bearer {}", token))
        .send()
        .await
        .map_err(|e| format!("Failed to reach backend at {}: {}", url, e))?;
    let parsed: LeadListResponse = handle_response(response).await?;
    Ok(parsed.leads)
}

#[derive(Serialize)]
struct CreateLeadRequest<'a> {
    company: &'a str,
    list_id: Option<&'a str>,
}

pub async fn create_lead(base_url: &str, token: &str, company: &str, list_id: Option<&str>) -> Result<LeadRecord, String> {
    let client = reqwest::Client::new();
    let url = format!("{}/leads", base_url);
    let response = client
        .post(&url)
        .header("Authorization", format!("Bearer {}", token))
        .json(&CreateLeadRequest { company, list_id })
        .send()
        .await
        .map_err(|e| format!("Failed to reach backend at {}: {}", url, e))?;
    handle_response(response).await
}

#[derive(Serialize)]
struct UpdateLeadRequest {
    industry: Option<String>,
    contact_status: Option<String>,
    lead_notes: Option<String>,
    contact_name: Option<String>,
    contact_title: Option<String>,
    website: Option<String>,
    linkedin: Option<String>,
    opportunity_stage: Option<String>,
}

#[allow(clippy::too_many_arguments)]
pub async fn update_lead(
    base_url: &str,
    token: &str,
    id: &str,
    industry: Option<String>,
    contact_status: Option<String>,
    lead_notes: Option<String>,
    contact_name: Option<String>,
    contact_title: Option<String>,
    website: Option<String>,
    linkedin: Option<String>,
    opportunity_stage: Option<String>,
) -> Result<LeadRecord, String> {
    let client = reqwest::Client::new();
    let url = format!("{}/leads/{}", base_url, id);
    let response = client
        .patch(&url)
        .header("Authorization", format!("Bearer {}", token))
        .json(&UpdateLeadRequest {
            industry,
            contact_status,
            lead_notes,
            contact_name,
            contact_title,
            website,
            linkedin,
            opportunity_stage,
        })
        .send()
        .await
        .map_err(|e| format!("Failed to reach backend at {}: {}", url, e))?;
    handle_response(response).await
}

#[derive(Serialize)]
struct AssignLeadRequest {
    assigned_user_id: Option<String>,
}

pub async fn assign_lead(base_url: &str, token: &str, id: &str, assigned_user_id: Option<String>) -> Result<LeadRecord, String> {
    let client = reqwest::Client::new();
    let url = format!("{}/leads/{}/assign", base_url, id);
    let response = client
        .post(&url)
        .header("Authorization", format!("Bearer {}", token))
        .json(&AssignLeadRequest { assigned_user_id })
        .send()
        .await
        .map_err(|e| format!("Failed to reach backend at {}: {}", url, e))?;
    handle_response(response).await
}

#[derive(Serialize)]
struct MigrateRequest {
    leads: Vec<serde_json::Value>,
}

#[derive(Deserialize)]
struct MigrateResponse {
    imported: usize,
}

pub async fn migrate_leads(base_url: &str, token: &str, leads: Vec<serde_json::Value>) -> Result<usize, String> {
    let client = reqwest::Client::new();
    let url = format!("{}/leads/migrate", base_url);
    let response = client
        .post(&url)
        .header("Authorization", format!("Bearer {}", token))
        .json(&MigrateRequest { leads })
        .send()
        .await
        .map_err(|e| format!("Failed to reach backend at {}: {}", url, e))?;
    let parsed: MigrateResponse = handle_response(response).await?;
    Ok(parsed.imported)
}

// --- Phone numbers (manual CRUD, independent of the AI phone-lookup pipeline) ---

#[derive(Serialize)]
struct PhoneRequest<'a> {
    phone_number: &'a str,
}

pub async fn add_phone(base_url: &str, token: &str, lead_id: &str, phone_number: &str) -> Result<LeadRecord, String> {
    let client = reqwest::Client::new();
    let url = format!("{}/leads/{}/phones", base_url, lead_id);
    let response = client
        .post(&url)
        .header("Authorization", format!("Bearer {}", token))
        .json(&PhoneRequest { phone_number })
        .send()
        .await
        .map_err(|e| format!("Failed to reach backend at {}: {}", url, e))?;
    handle_response(response).await
}

pub async fn update_phone(
    base_url: &str,
    token: &str,
    lead_id: &str,
    phone_id: &str,
    phone_number: &str,
) -> Result<LeadRecord, String> {
    let client = reqwest::Client::new();
    let url = format!("{}/leads/{}/phones/{}", base_url, lead_id, phone_id);
    let response = client
        .patch(&url)
        .header("Authorization", format!("Bearer {}", token))
        .json(&PhoneRequest { phone_number })
        .send()
        .await
        .map_err(|e| format!("Failed to reach backend at {}: {}", url, e))?;
    handle_response(response).await
}

pub async fn delete_phone(base_url: &str, token: &str, lead_id: &str, phone_id: &str) -> Result<LeadRecord, String> {
    let client = reqwest::Client::new();
    let url = format!("{}/leads/{}/phones/{}", base_url, lead_id, phone_id);
    let response = client
        .delete(&url)
        .header("Authorization", format!("Bearer {}", token))
        .send()
        .await
        .map_err(|e| format!("Failed to reach backend at {}: {}", url, e))?;
    handle_response(response).await
}

// --- Email addresses (manual CRUD, fully independent of phones) ---

#[derive(Serialize)]
struct EmailRequest<'a> {
    email: &'a str,
}

pub async fn add_email(base_url: &str, token: &str, lead_id: &str, email: &str) -> Result<LeadRecord, String> {
    let client = reqwest::Client::new();
    let url = format!("{}/leads/{}/emails", base_url, lead_id);
    let response = client
        .post(&url)
        .header("Authorization", format!("Bearer {}", token))
        .json(&EmailRequest { email })
        .send()
        .await
        .map_err(|e| format!("Failed to reach backend at {}: {}", url, e))?;
    handle_response(response).await
}

pub async fn update_email(
    base_url: &str,
    token: &str,
    lead_id: &str,
    email_id: &str,
    email: &str,
) -> Result<LeadRecord, String> {
    let client = reqwest::Client::new();
    let url = format!("{}/leads/{}/emails/{}", base_url, lead_id, email_id);
    let response = client
        .patch(&url)
        .header("Authorization", format!("Bearer {}", token))
        .json(&EmailRequest { email })
        .send()
        .await
        .map_err(|e| format!("Failed to reach backend at {}: {}", url, e))?;
    handle_response(response).await
}

pub async fn delete_email(base_url: &str, token: &str, lead_id: &str, email_id: &str) -> Result<LeadRecord, String> {
    let client = reqwest::Client::new();
    let url = format!("{}/leads/{}/emails/{}", base_url, lead_id, email_id);
    let response = client
        .delete(&url)
        .header("Authorization", format!("Bearer {}", token))
        .send()
        .await
        .map_err(|e| format!("Failed to reach backend at {}: {}", url, e))?;
    handle_response(response).await
}

// --- Independent AI email scraper — manual trigger only ---

pub async fn scrape_email(base_url: &str, token: &str, lead_id: &str) -> Result<LeadRecord, String> {
    let client = reqwest::Client::new();
    let url = format!("{}/leads/{}/scrape-email", base_url, lead_id);
    let response = client
        .post(&url)
        .header("Authorization", format!("Bearer {}", token))
        .send()
        .await
        .map_err(|e| format!("Failed to reach backend at {}: {}", url, e))?;
    handle_response(response).await
}

// --- Cold call lists (private per-user lead lists; admins reach all of them) ---

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LeadList {
    pub id: String,
    pub name: String,
    pub owner_user_id: String,
    pub owner_name: Option<String>,
    pub created_at: String,
    pub lead_count: usize,
}

#[derive(Serialize)]
struct CreateLeadListRequest<'a> {
    name: &'a str,
}

pub async fn create_lead_list(base_url: &str, token: &str, name: &str) -> Result<LeadList, String> {
    let client = reqwest::Client::new();
    let url = format!("{}/lead-lists", base_url);
    let response = client
        .post(&url)
        .header("Authorization", format!("Bearer {}", token))
        .json(&CreateLeadListRequest { name })
        .send()
        .await
        .map_err(|e| format!("Failed to reach backend at {}: {}", url, e))?;
    handle_response(response).await
}

#[derive(Deserialize)]
struct LeadListsResponse {
    lists: Vec<LeadList>,
}

pub async fn list_lead_lists(base_url: &str, token: &str) -> Result<Vec<LeadList>, String> {
    let client = reqwest::Client::new();
    let url = format!("{}/lead-lists", base_url);
    let response = client
        .get(&url)
        .header("Authorization", format!("Bearer {}", token))
        .send()
        .await
        .map_err(|e| format!("Failed to reach backend at {}: {}", url, e))?;
    let parsed: LeadListsResponse = handle_response(response).await?;
    Ok(parsed.lists)
}

pub async fn get_list_leads(base_url: &str, token: &str, list_id: &str) -> Result<Vec<LeadRecord>, String> {
    let client = reqwest::Client::new();
    let url = format!("{}/lead-lists/{}/leads", base_url, list_id);
    let response = client
        .get(&url)
        .header("Authorization", format!("Bearer {}", token))
        .send()
        .await
        .map_err(|e| format!("Failed to reach backend at {}: {}", url, e))?;
    let parsed: LeadListResponse = handle_response(response).await?;
    Ok(parsed.leads)
}

#[derive(Serialize)]
struct ImportLeadsRequest {
    leads: Vec<serde_json::Value>,
}

#[derive(Deserialize)]
struct ImportLeadsResponse {
    imported: usize,
}

pub async fn import_leads_to_list(
    base_url: &str,
    token: &str,
    list_id: &str,
    leads: Vec<serde_json::Value>,
) -> Result<usize, String> {
    let client = reqwest::Client::new();
    let url = format!("{}/lead-lists/{}/import-csv", base_url, list_id);
    let response = client
        .post(&url)
        .header("Authorization", format!("Bearer {}", token))
        .json(&ImportLeadsRequest { leads })
        .send()
        .await
        .map_err(|e| format!("Failed to reach backend at {}: {}", url, e))?;
    let parsed: ImportLeadsResponse = handle_response(response).await?;
    Ok(parsed.imported)
}

// --- AI Sales Intelligence — manual trigger only, full version history kept ---

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ScoreBreakdown {
    pub company_maturity: i64,
    pub hiring_intensity: i64,
    pub growth_signals: i64,
    pub buying_intent: i64,
    pub accessibility_fit: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PainPoints {
    pub operational: Vec<String>,
    pub sales_revenue: Vec<String>,
    pub recruitment_scaling: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ObjectionResponse {
    pub category: String,
    pub objection: String,
    pub response: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LeadIntelligence {
    pub executive_summary: String,
    pub sales_summary: String,
    pub pain_points: PainPoints,
    pub buying_signals: Vec<String>,
    pub conversation_starters: Vec<String>,
    pub discovery_questions: Vec<String>,
    pub objection_handling: Vec<ObjectionResponse>,
    pub pitch_angle: String,
    pub call_brief: String,
    pub score_breakdown: ScoreBreakdown,
    pub lead_score: i64,
    pub lead_temperature: String,
    pub confidence_note: String,
    pub generated_at: String,
    pub updated_at: String,
    pub version_count: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LeadIntelligenceVersion {
    pub id: String,
    pub executive_summary: String,
    pub sales_summary: String,
    pub pain_points: PainPoints,
    pub buying_signals: Vec<String>,
    pub conversation_starters: Vec<String>,
    pub discovery_questions: Vec<String>,
    pub objection_handling: Vec<ObjectionResponse>,
    pub pitch_angle: String,
    pub call_brief: String,
    pub score_breakdown: ScoreBreakdown,
    pub lead_score: i64,
    pub lead_temperature: String,
    pub confidence_note: String,
    pub created_at: String,
}

pub async fn generate_intelligence(base_url: &str, token: &str, lead_id: &str) -> Result<LeadRecord, String> {
    let client = reqwest::Client::new();
    let url = format!("{}/leads/{}/generate-intelligence", base_url, lead_id);
    let response = client
        .post(&url)
        .header("Authorization", format!("Bearer {}", token))
        .send()
        .await
        .map_err(|e| format!("Failed to reach backend at {}: {}", url, e))?;
    // Special-cased here (rather than in the generic handle_response) since
    // this is the only endpoint where a 409 has a specific, user-facing
    // meaning — "someone already clicked Generate, hang on" — distinct from
    // a generic failure.
    if response.status() == reqwest::StatusCode::CONFLICT {
        return Err("Intelligence generation already in progress for this lead.".to_string());
    }
    handle_response(response).await
}

#[derive(Deserialize)]
struct LeadIntelligenceHistoryResponse {
    versions: Vec<LeadIntelligenceVersion>,
}

pub async fn get_intelligence_history(
    base_url: &str,
    token: &str,
    lead_id: &str,
) -> Result<Vec<LeadIntelligenceVersion>, String> {
    let client = reqwest::Client::new();
    let url = format!("{}/leads/{}/intelligence-history", base_url, lead_id);
    let response = client
        .get(&url)
        .header("Authorization", format!("Bearer {}", token))
        .send()
        .await
        .map_err(|e| format!("Failed to reach backend at {}: {}", url, e))?;
    let parsed: LeadIntelligenceHistoryResponse = handle_response(response).await?;
    Ok(parsed.versions)
}

// --- Lead chat — read-only Q&A about a single lead, pre-existing backend
// endpoint (`/lead-chat`) that had no caller until now. No backend changes. ---

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatTurn {
    pub role: String,
    pub content: String,
}

#[derive(Serialize)]
struct LeadChatRequest<'a> {
    context: &'a str,
    message: &'a str,
    history: Vec<ChatTurn>,
}

#[derive(Deserialize)]
struct LeadChatResponse {
    reply: String,
}

pub async fn chat_about_lead(
    base_url: &str,
    token: &str,
    context: &str,
    message: &str,
    history: Vec<ChatTurn>,
) -> Result<String, String> {
    let client = reqwest::Client::new();
    let url = format!("{}/lead-chat", base_url);
    let response = client
        .post(&url)
        .header("Authorization", format!("Bearer {}", token))
        .json(&LeadChatRequest { context, message, history })
        .send()
        .await
        .map_err(|e| format!("Failed to reach backend at {}: {}", url, e))?;
    let parsed: LeadChatResponse = handle_response(response).await?;
    Ok(parsed.reply)
}

// --- Calendar events — private per-owner, same admin-override pattern as lead lists ---

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CalendarEventRecord {
    pub id: String,
    pub owner_user_id: String,
    pub title: String,
    pub date: String,
    pub time: String,
    #[serde(rename = "type")]
    pub event_type: String,
    pub lead_id: Option<String>,
    pub description: String,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Deserialize)]
struct CalendarEventsResponse {
    events: Vec<CalendarEventRecord>,
}

pub async fn list_calendar_events(base_url: &str, token: &str) -> Result<Vec<CalendarEventRecord>, String> {
    let client = reqwest::Client::new();
    let url = format!("{}/calendar-events", base_url);
    let response = client
        .get(&url)
        .header("Authorization", format!("Bearer {}", token))
        .send()
        .await
        .map_err(|e| format!("Failed to reach backend at {}: {}", url, e))?;
    let parsed: CalendarEventsResponse = handle_response(response).await?;
    Ok(parsed.events)
}

#[derive(Serialize)]
struct CreateCalendarEventRequest<'a> {
    title: &'a str,
    date: &'a str,
    time: &'a str,
    #[serde(rename = "type")]
    event_type: &'a str,
    lead_id: Option<&'a str>,
}

pub async fn create_calendar_event(
    base_url: &str,
    token: &str,
    title: &str,
    date: &str,
    time: &str,
    event_type: &str,
    lead_id: Option<&str>,
) -> Result<CalendarEventRecord, String> {
    let client = reqwest::Client::new();
    let url = format!("{}/calendar-events", base_url);
    let response = client
        .post(&url)
        .header("Authorization", format!("Bearer {}", token))
        .json(&CreateCalendarEventRequest { title, date, time, event_type, lead_id })
        .send()
        .await
        .map_err(|e| format!("Failed to reach backend at {}: {}", url, e))?;
    handle_response(response).await
}

#[derive(Serialize)]
struct UpdateCalendarEventRequest<'a> {
    title: Option<&'a str>,
    date: Option<&'a str>,
    time: Option<&'a str>,
    #[serde(rename = "type")]
    event_type: Option<&'a str>,
    lead_id: Option<&'a str>,
}

pub async fn update_calendar_event(
    base_url: &str,
    token: &str,
    id: &str,
    title: Option<&str>,
    date: Option<&str>,
    time: Option<&str>,
    event_type: Option<&str>,
    lead_id: Option<&str>,
) -> Result<CalendarEventRecord, String> {
    let client = reqwest::Client::new();
    let url = format!("{}/calendar-events/{}", base_url, id);
    let response = client
        .patch(&url)
        .header("Authorization", format!("Bearer {}", token))
        .json(&UpdateCalendarEventRequest { title, date, time, event_type, lead_id })
        .send()
        .await
        .map_err(|e| format!("Failed to reach backend at {}: {}", url, e))?;
    handle_response(response).await
}

pub async fn delete_calendar_event(base_url: &str, token: &str, id: &str) -> Result<(), String> {
    let client = reqwest::Client::new();
    let url = format!("{}/calendar-events/{}", base_url, id);
    let response = client
        .delete(&url)
        .header("Authorization", format!("Bearer {}", token))
        .send()
        .await
        .map_err(|e| format!("Failed to reach backend at {}: {}", url, e))?;
    let _: serde_json::Value = handle_response(response).await?;
    Ok(())
}

// --- Call logs (shared per-lead history, no owner restriction) ---

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CallLogRecord {
    pub id: String,
    pub lead_id: String,
    pub calendar_event_id: Option<String>,
    pub outcome: String,
    pub notes: String,
    pub duration_seconds: Option<i64>,
    pub created_by: String,
    pub created_at: String,
}

#[derive(Deserialize)]
struct CallLogsResponse {
    call_logs: Vec<CallLogRecord>,
}

pub async fn list_call_logs(base_url: &str, token: &str, lead_id: &str) -> Result<Vec<CallLogRecord>, String> {
    let client = reqwest::Client::new();
    let url = format!("{}/call-logs/lead/{}", base_url, lead_id);
    let response = client
        .get(&url)
        .header("Authorization", format!("Bearer {}", token))
        .send()
        .await
        .map_err(|e| format!("Failed to reach backend at {}: {}", url, e))?;
    let parsed: CallLogsResponse = handle_response(response).await?;
    Ok(parsed.call_logs)
}

#[derive(Serialize)]
struct CreateCallLogRequest<'a> {
    lead_id: &'a str,
    calendar_event_id: Option<&'a str>,
    outcome: &'a str,
    notes: &'a str,
    duration_seconds: Option<i64>,
}

pub async fn create_call_log(
    base_url: &str,
    token: &str,
    lead_id: &str,
    calendar_event_id: Option<&str>,
    outcome: &str,
    notes: &str,
    duration_seconds: Option<i64>,
) -> Result<CallLogRecord, String> {
    let client = reqwest::Client::new();
    let url = format!("{}/call-logs", base_url);
    let response = client
        .post(&url)
        .header("Authorization", format!("Bearer {}", token))
        .json(&CreateCallLogRequest { lead_id, calendar_event_id, outcome, notes, duration_seconds })
        .send()
        .await
        .map_err(|e| format!("Failed to reach backend at {}: {}", url, e))?;
    handle_response(response).await
}

// --- AI Email Writer: brand voice ---

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct BrandVoice {
    pub company_name: String,
    pub company_description: String,
    pub industry: String,
    pub target_audience: String,
    pub core_services: String,
    pub unique_selling_points: String,
    pub preferred_writing_style: String,
    pub preferred_cta_style: String,
    pub preferred_email_length: String,
    pub website: String,
    pub booking_link: String,
    pub signature: String,
}

pub async fn get_brand_voice(base_url: &str, token: &str) -> Result<BrandVoice, String> {
    let client = reqwest::Client::new();
    let url = format!("{}/brand-voice", base_url);
    let response = client
        .get(&url)
        .header("Authorization", format!("Bearer {}", token))
        .send()
        .await
        .map_err(|e| format!("Failed to reach backend at {}: {}", url, e))?;
    handle_response(response).await
}

#[derive(Serialize)]
struct UpdateBrandVoiceRequest<'a> {
    company_name: &'a str,
    company_description: &'a str,
    industry: &'a str,
    target_audience: &'a str,
    core_services: &'a str,
    unique_selling_points: &'a str,
    preferred_writing_style: &'a str,
    preferred_cta_style: &'a str,
    preferred_email_length: &'a str,
    website: &'a str,
    booking_link: &'a str,
    signature: &'a str,
}

pub async fn update_brand_voice(base_url: &str, token: &str, brand_voice: &BrandVoice) -> Result<BrandVoice, String> {
    let client = reqwest::Client::new();
    let url = format!("{}/brand-voice", base_url);
    let response = client
        .put(&url)
        .header("Authorization", format!("Bearer {}", token))
        .json(&UpdateBrandVoiceRequest {
            company_name: &brand_voice.company_name,
            company_description: &brand_voice.company_description,
            industry: &brand_voice.industry,
            target_audience: &brand_voice.target_audience,
            core_services: &brand_voice.core_services,
            unique_selling_points: &brand_voice.unique_selling_points,
            preferred_writing_style: &brand_voice.preferred_writing_style,
            preferred_cta_style: &brand_voice.preferred_cta_style,
            preferred_email_length: &brand_voice.preferred_email_length,
            website: &brand_voice.website,
            booking_link: &brand_voice.booking_link,
            signature: &brand_voice.signature,
        })
        .send()
        .await
        .map_err(|e| format!("Failed to reach backend at {}: {}", url, e))?;
    handle_response(response).await
}

// --- AI Email Writer: templates (private per creator) ---

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EmailTemplate {
    pub id: String,
    pub owner_user_id: String,
    pub owner_name: Option<String>,
    pub name: String,
    pub subject: String,
    pub body: String,
    pub tone: String,
    pub length: String,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Deserialize)]
struct EmailTemplatesResponse {
    templates: Vec<EmailTemplate>,
}

#[derive(Serialize)]
struct CreateEmailTemplateRequest<'a> {
    name: &'a str,
    subject: &'a str,
    body: &'a str,
    tone: &'a str,
    length: &'a str,
}

pub async fn create_email_template(
    base_url: &str,
    token: &str,
    name: &str,
    subject: &str,
    body: &str,
    tone: &str,
    length: &str,
) -> Result<EmailTemplate, String> {
    let client = reqwest::Client::new();
    let url = format!("{}/email-templates", base_url);
    let response = client
        .post(&url)
        .header("Authorization", format!("Bearer {}", token))
        .json(&CreateEmailTemplateRequest { name, subject, body, tone, length })
        .send()
        .await
        .map_err(|e| format!("Failed to reach backend at {}: {}", url, e))?;
    handle_response(response).await
}

pub async fn list_email_templates(base_url: &str, token: &str) -> Result<Vec<EmailTemplate>, String> {
    let client = reqwest::Client::new();
    let url = format!("{}/email-templates", base_url);
    let response = client
        .get(&url)
        .header("Authorization", format!("Bearer {}", token))
        .send()
        .await
        .map_err(|e| format!("Failed to reach backend at {}: {}", url, e))?;
    let parsed: EmailTemplatesResponse = handle_response(response).await?;
    Ok(parsed.templates)
}

#[derive(Serialize)]
struct UpdateEmailTemplateRequest<'a> {
    name: Option<&'a str>,
    subject: Option<&'a str>,
    body: Option<&'a str>,
    tone: Option<&'a str>,
    length: Option<&'a str>,
}

#[allow(clippy::too_many_arguments)]
pub async fn update_email_template(
    base_url: &str,
    token: &str,
    id: &str,
    name: Option<&str>,
    subject: Option<&str>,
    body: Option<&str>,
    tone: Option<&str>,
    length: Option<&str>,
) -> Result<EmailTemplate, String> {
    let client = reqwest::Client::new();
    let url = format!("{}/email-templates/{}", base_url, id);
    let response = client
        .patch(&url)
        .header("Authorization", format!("Bearer {}", token))
        .json(&UpdateEmailTemplateRequest { name, subject, body, tone, length })
        .send()
        .await
        .map_err(|e| format!("Failed to reach backend at {}: {}", url, e))?;
    handle_response(response).await
}

pub async fn delete_email_template(base_url: &str, token: &str, id: &str) -> Result<(), String> {
    let client = reqwest::Client::new();
    let url = format!("{}/email-templates/{}", base_url, id);
    let response = client
        .delete(&url)
        .header("Authorization", format!("Bearer {}", token))
        .send()
        .await
        .map_err(|e| format!("Failed to reach backend at {}: {}", url, e))?;
    let _: serde_json::Value = handle_response(response).await?;
    Ok(())
}

#[derive(Serialize)]
struct ApplyEmailTemplateRequest<'a> {
    lead_id: &'a str,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AppliedEmailTemplate {
    pub subject: String,
    pub body: String,
}

pub async fn apply_email_template(
    base_url: &str,
    token: &str,
    template_id: &str,
    lead_id: &str,
) -> Result<AppliedEmailTemplate, String> {
    let client = reqwest::Client::new();
    let url = format!("{}/email-templates/{}/apply", base_url, template_id);
    let response = client
        .post(&url)
        .header("Authorization", format!("Bearer {}", token))
        .json(&ApplyEmailTemplateRequest { lead_id })
        .send()
        .await
        .map_err(|e| format!("Failed to reach backend at {}: {}", url, e))?;
    handle_response(response).await
}

// --- AI Email Writer: drafts (lead-scoped, follows the lead's own access rules) ---

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EmailDraft {
    pub id: String,
    pub lead_id: String,
    pub owner_user_id: String,
    pub subject: String,
    pub body: String,
    pub tone: String,
    pub length: String,
    pub status: String,
    pub sent_via: Option<String>,
    pub sent_at: Option<String>,
    pub estimated_open_rate: Option<f64>,
    pub estimated_reply_rate: Option<f64>,
    pub estimated_readability_score: Option<f64>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Deserialize)]
struct EmailDraftsResponse {
    drafts: Vec<EmailDraft>,
}

#[derive(Serialize)]
struct GenerateEmailRequest<'a> {
    instruction: &'a str,
    preset: &'a str,
    length: &'a str,
}

pub async fn generate_email_draft(
    base_url: &str,
    token: &str,
    lead_id: &str,
    instruction: &str,
    preset: &str,
    length: &str,
) -> Result<EmailDraft, String> {
    let client = reqwest::Client::new();
    let url = format!("{}/leads/{}/email-drafts/generate", base_url, lead_id);
    let response = client
        .post(&url)
        .header("Authorization", format!("Bearer {}", token))
        .json(&GenerateEmailRequest { instruction, preset, length })
        .send()
        .await
        .map_err(|e| format!("Failed to reach backend at {}: {}", url, e))?;
    handle_response(response).await
}

#[derive(Serialize)]
struct RefineEmailRequest<'a> {
    instruction: &'a str,
}

pub async fn refine_email_draft(base_url: &str, token: &str, draft_id: &str, instruction: &str) -> Result<EmailDraft, String> {
    let client = reqwest::Client::new();
    let url = format!("{}/email-drafts/{}/refine", base_url, draft_id);
    let response = client
        .post(&url)
        .header("Authorization", format!("Bearer {}", token))
        .json(&RefineEmailRequest { instruction })
        .send()
        .await
        .map_err(|e| format!("Failed to reach backend at {}: {}", url, e))?;
    handle_response(response).await
}

#[derive(Serialize)]
struct UpdateEmailDraftRequest<'a> {
    subject: Option<&'a str>,
    body: Option<&'a str>,
}

pub async fn update_email_draft(
    base_url: &str,
    token: &str,
    id: &str,
    subject: Option<&str>,
    body: Option<&str>,
) -> Result<EmailDraft, String> {
    let client = reqwest::Client::new();
    let url = format!("{}/email-drafts/{}", base_url, id);
    let response = client
        .patch(&url)
        .header("Authorization", format!("Bearer {}", token))
        .json(&UpdateEmailDraftRequest { subject, body })
        .send()
        .await
        .map_err(|e| format!("Failed to reach backend at {}: {}", url, e))?;
    handle_response(response).await
}

pub async fn list_email_drafts(base_url: &str, token: &str, lead_id: &str) -> Result<Vec<EmailDraft>, String> {
    let client = reqwest::Client::new();
    let url = format!("{}/leads/{}/email-drafts", base_url, lead_id);
    let response = client
        .get(&url)
        .header("Authorization", format!("Bearer {}", token))
        .send()
        .await
        .map_err(|e| format!("Failed to reach backend at {}: {}", url, e))?;
    let parsed: EmailDraftsResponse = handle_response(response).await?;
    Ok(parsed.drafts)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PendingEmailDraft {
    pub id: String,
    pub lead_id: String,
    pub owner_user_id: String,
    pub subject: String,
    pub body: String,
    pub tone: String,
    pub length: String,
    pub status: String,
    pub sent_via: Option<String>,
    pub sent_at: Option<String>,
    pub estimated_open_rate: Option<f64>,
    pub estimated_reply_rate: Option<f64>,
    pub estimated_readability_score: Option<f64>,
    pub created_at: String,
    pub updated_at: String,
    pub lead_company: String,
}

#[derive(Deserialize)]
struct PendingEmailDraftsResponse {
    drafts: Vec<PendingEmailDraft>,
}

pub async fn list_pending_email_drafts(base_url: &str, token: &str) -> Result<Vec<PendingEmailDraft>, String> {
    let client = reqwest::Client::new();
    let url = format!("{}/email-drafts/pending", base_url);
    let response = client
        .get(&url)
        .header("Authorization", format!("Bearer {}", token))
        .send()
        .await
        .map_err(|e| format!("Failed to reach backend at {}: {}", url, e))?;
    let parsed: PendingEmailDraftsResponse = handle_response(response).await?;
    Ok(parsed.drafts)
}

pub async fn delete_email_draft(base_url: &str, token: &str, id: &str) -> Result<(), String> {
    let client = reqwest::Client::new();
    let url = format!("{}/email-drafts/{}", base_url, id);
    let response = client
        .delete(&url)
        .header("Authorization", format!("Bearer {}", token))
        .send()
        .await
        .map_err(|e| format!("Failed to reach backend at {}: {}", url, e))?;
    let _: serde_json::Value = handle_response(response).await?;
    Ok(())
}

// --- AI Email Writer: personalisation, CTA suggestions, activity timeline ---

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PersonalisationOption {
    pub hook: String,
    pub pain_point_observation: String,
    pub growth_observation: String,
    pub opportunity_statement: String,
}

#[derive(Serialize)]
struct PersonalisationRequest {
    count: i64,
}

#[derive(Deserialize)]
struct PersonalisationResponse {
    options: Vec<PersonalisationOption>,
}

pub async fn generate_email_personalisation(
    base_url: &str,
    token: &str,
    lead_id: &str,
    count: i64,
) -> Result<Vec<PersonalisationOption>, String> {
    let client = reqwest::Client::new();
    let url = format!("{}/leads/{}/email-drafts/personalisation", base_url, lead_id);
    let response = client
        .post(&url)
        .header("Authorization", format!("Bearer {}", token))
        .json(&PersonalisationRequest { count })
        .send()
        .await
        .map_err(|e| format!("Failed to reach backend at {}: {}", url, e))?;
    let parsed: PersonalisationResponse = handle_response(response).await?;
    Ok(parsed.options)
}

#[derive(Serialize)]
struct CtaSuggestionsRequest<'a> {
    goal: &'a str,
}

#[derive(Deserialize)]
struct CtaSuggestionsResponse {
    ctas: Vec<String>,
}

pub async fn get_email_cta_suggestions(base_url: &str, token: &str, lead_id: &str, goal: &str) -> Result<Vec<String>, String> {
    let client = reqwest::Client::new();
    let url = format!("{}/leads/{}/email-drafts/cta-suggestions", base_url, lead_id);
    let response = client
        .post(&url)
        .header("Authorization", format!("Bearer {}", token))
        .json(&CtaSuggestionsRequest { goal })
        .send()
        .await
        .map_err(|e| format!("Failed to reach backend at {}: {}", url, e))?;
    let parsed: CtaSuggestionsResponse = handle_response(response).await?;
    Ok(parsed.ctas)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TimelineEntry {
    pub timestamp: String,
    #[serde(rename = "type")]
    pub entry_type: String,
    pub summary: String,
}

#[derive(Deserialize)]
struct TimelineResponse {
    entries: Vec<TimelineEntry>,
}

pub async fn get_lead_timeline(base_url: &str, token: &str, lead_id: &str) -> Result<Vec<TimelineEntry>, String> {
    let client = reqwest::Client::new();
    let url = format!("{}/leads/{}/timeline", base_url, lead_id);
    let response = client
        .get(&url)
        .header("Authorization", format!("Bearer {}", token))
        .send()
        .await
        .map_err(|e| format!("Failed to reach backend at {}: {}", url, e))?;
    let parsed: TimelineResponse = handle_response(response).await?;
    Ok(parsed.entries)
}

// --- AI Email Writer: OAuth email accounts (real sending — Gmail/Microsoft) ---

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EmailOAuthAccount {
    pub provider: String,
    pub email_address: String,
}

#[derive(Deserialize)]
struct ConnectUrlResponse {
    url: String,
}

pub async fn get_email_oauth_connect_url(base_url: &str, token: &str, provider: &str) -> Result<String, String> {
    let client = reqwest::Client::new();
    let url = format!("{}/email-oauth/{}/connect", base_url, provider);
    let response = client
        .get(&url)
        .header("Authorization", format!("Bearer {}", token))
        .send()
        .await
        .map_err(|e| format!("Failed to reach backend at {}: {}", url, e))?;
    let parsed: ConnectUrlResponse = handle_response(response).await?;
    Ok(parsed.url)
}

#[derive(Deserialize)]
struct EmailOAuthAccountsResponse {
    accounts: Vec<EmailOAuthAccount>,
}

pub async fn list_email_oauth_accounts(base_url: &str, token: &str) -> Result<Vec<EmailOAuthAccount>, String> {
    let client = reqwest::Client::new();
    let url = format!("{}/email-oauth/accounts", base_url);
    let response = client
        .get(&url)
        .header("Authorization", format!("Bearer {}", token))
        .send()
        .await
        .map_err(|e| format!("Failed to reach backend at {}: {}", url, e))?;
    let parsed: EmailOAuthAccountsResponse = handle_response(response).await?;
    Ok(parsed.accounts)
}

pub async fn disconnect_email_oauth_account(base_url: &str, token: &str, provider: &str) -> Result<(), String> {
    let client = reqwest::Client::new();
    let url = format!("{}/email-oauth/{}", base_url, provider);
    let response = client
        .delete(&url)
        .header("Authorization", format!("Bearer {}", token))
        .send()
        .await
        .map_err(|e| format!("Failed to reach backend at {}: {}", url, e))?;
    let _: serde_json::Value = handle_response(response).await?;
    Ok(())
}

#[derive(Serialize)]
struct SendEmailDraftRequest<'a> {
    provider: &'a str,
}

pub async fn send_email_draft(base_url: &str, token: &str, draft_id: &str, provider: &str) -> Result<EmailDraft, String> {
    let client = reqwest::Client::new();
    let url = format!("{}/email-drafts/{}/send", base_url, draft_id);
    let response = client
        .post(&url)
        .header("Authorization", format!("Bearer {}", token))
        .json(&SendEmailDraftRequest { provider })
        .send()
        .await
        .map_err(|e| format!("Failed to reach backend at {}: {}", url, e))?;
    handle_response(response).await
}

// --- Sales Sequences (multi-channel automation: email + call/follow-up/reminder tasks) ---

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SequenceRecord {
    pub id: String,
    pub name: String,
    pub owner_user_id: String,
    pub status: String,
    pub created_at: String,
    pub updated_at: String,
    pub step_count: i64,
    pub enrollment_count: i64,
}

#[derive(Deserialize)]
struct SequencesResponse {
    sequences: Vec<SequenceRecord>,
}

pub async fn list_sequences(base_url: &str, token: &str) -> Result<Vec<SequenceRecord>, String> {
    let client = reqwest::Client::new();
    let url = format!("{}/sequences", base_url);
    let response = client
        .get(&url)
        .header("Authorization", format!("Bearer {}", token))
        .send()
        .await
        .map_err(|e| format!("Failed to reach backend at {}: {}", url, e))?;
    let parsed: SequencesResponse = handle_response(response).await?;
    Ok(parsed.sequences)
}

#[derive(Serialize)]
struct CreateSequenceRequest<'a> {
    name: &'a str,
}

pub async fn create_sequence(base_url: &str, token: &str, name: &str) -> Result<SequenceRecord, String> {
    let client = reqwest::Client::new();
    let url = format!("{}/sequences", base_url);
    let response = client
        .post(&url)
        .header("Authorization", format!("Bearer {}", token))
        .json(&CreateSequenceRequest { name })
        .send()
        .await
        .map_err(|e| format!("Failed to reach backend at {}: {}", url, e))?;
    handle_response(response).await
}

#[derive(Serialize)]
struct UpdateSequenceRequest<'a> {
    name: Option<&'a str>,
    status: Option<&'a str>,
}

pub async fn update_sequence(
    base_url: &str,
    token: &str,
    id: &str,
    name: Option<&str>,
    status: Option<&str>,
) -> Result<SequenceRecord, String> {
    let client = reqwest::Client::new();
    let url = format!("{}/sequences/{}", base_url, id);
    let response = client
        .patch(&url)
        .header("Authorization", format!("Bearer {}", token))
        .json(&UpdateSequenceRequest { name, status })
        .send()
        .await
        .map_err(|e| format!("Failed to reach backend at {}: {}", url, e))?;
    handle_response(response).await
}

pub async fn delete_sequence(base_url: &str, token: &str, id: &str) -> Result<(), String> {
    let client = reqwest::Client::new();
    let url = format!("{}/sequences/{}", base_url, id);
    let response = client
        .delete(&url)
        .header("Authorization", format!("Bearer {}", token))
        .send()
        .await
        .map_err(|e| format!("Failed to reach backend at {}: {}", url, e))?;
    let _: serde_json::Value = handle_response(response).await?;
    Ok(())
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SequenceStepRecord {
    pub id: String,
    pub sequence_id: String,
    pub step_order: i64,
    pub delay_days: i64,
    pub step_type: String,
    pub subject_template: String,
    pub body_template: String,
    pub created_at: String,
}

#[derive(Deserialize)]
struct SequenceStepsResponse {
    steps: Vec<SequenceStepRecord>,
}

pub async fn list_sequence_steps(base_url: &str, token: &str, sequence_id: &str) -> Result<Vec<SequenceStepRecord>, String> {
    let client = reqwest::Client::new();
    let url = format!("{}/sequences/{}/steps", base_url, sequence_id);
    let response = client
        .get(&url)
        .header("Authorization", format!("Bearer {}", token))
        .send()
        .await
        .map_err(|e| format!("Failed to reach backend at {}: {}", url, e))?;
    let parsed: SequenceStepsResponse = handle_response(response).await?;
    Ok(parsed.steps)
}

#[derive(Serialize)]
struct AddSequenceStepRequest<'a> {
    delay_days: i64,
    step_type: &'a str,
    subject_template: &'a str,
    body_template: &'a str,
}

pub async fn add_sequence_step(
    base_url: &str,
    token: &str,
    sequence_id: &str,
    delay_days: i64,
    step_type: &str,
    subject_template: &str,
    body_template: &str,
) -> Result<SequenceStepRecord, String> {
    let client = reqwest::Client::new();
    let url = format!("{}/sequences/{}/steps", base_url, sequence_id);
    let response = client
        .post(&url)
        .header("Authorization", format!("Bearer {}", token))
        .json(&AddSequenceStepRequest { delay_days, step_type, subject_template, body_template })
        .send()
        .await
        .map_err(|e| format!("Failed to reach backend at {}: {}", url, e))?;
    handle_response(response).await
}

pub async fn delete_sequence_step(base_url: &str, token: &str, sequence_id: &str, step_id: &str) -> Result<(), String> {
    let client = reqwest::Client::new();
    let url = format!("{}/sequences/{}/steps/{}", base_url, sequence_id, step_id);
    let response = client
        .delete(&url)
        .header("Authorization", format!("Bearer {}", token))
        .send()
        .await
        .map_err(|e| format!("Failed to reach backend at {}: {}", url, e))?;
    let _: serde_json::Value = handle_response(response).await?;
    Ok(())
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SequenceEnrollmentRecord {
    pub id: String,
    pub sequence_id: String,
    pub lead_id: String,
    pub lead_company: String,
    pub current_step: i64,
    pub status: String,
    pub last_error: Option<String>,
    pub enrolled_at: String,
    pub next_run_at: Option<String>,
    pub created_by: String,
}

#[derive(Deserialize)]
struct SequenceEnrollmentsResponse {
    enrollments: Vec<SequenceEnrollmentRecord>,
}

pub async fn list_sequence_enrollments(
    base_url: &str,
    token: &str,
    sequence_id: &str,
) -> Result<Vec<SequenceEnrollmentRecord>, String> {
    let client = reqwest::Client::new();
    let url = format!("{}/sequences/{}/enrollments", base_url, sequence_id);
    let response = client
        .get(&url)
        .header("Authorization", format!("Bearer {}", token))
        .send()
        .await
        .map_err(|e| format!("Failed to reach backend at {}: {}", url, e))?;
    let parsed: SequenceEnrollmentsResponse = handle_response(response).await?;
    Ok(parsed.enrollments)
}

#[derive(Serialize)]
struct EnrollLeadRequest<'a> {
    lead_id: &'a str,
}

pub async fn enroll_lead_in_sequence(
    base_url: &str,
    token: &str,
    sequence_id: &str,
    lead_id: &str,
) -> Result<SequenceEnrollmentRecord, String> {
    let client = reqwest::Client::new();
    let url = format!("{}/sequences/{}/enrollments", base_url, sequence_id);
    let response = client
        .post(&url)
        .header("Authorization", format!("Bearer {}", token))
        .json(&EnrollLeadRequest { lead_id })
        .send()
        .await
        .map_err(|e| format!("Failed to reach backend at {}: {}", url, e))?;
    handle_response(response).await
}

pub async fn stop_sequence_enrollment(
    base_url: &str,
    token: &str,
    sequence_id: &str,
    enrollment_id: &str,
) -> Result<(), String> {
    let client = reqwest::Client::new();
    let url = format!("{}/sequences/{}/enrollments/{}/stop", base_url, sequence_id, enrollment_id);
    let response = client
        .post(&url)
        .header("Authorization", format!("Bearer {}", token))
        .send()
        .await
        .map_err(|e| format!("Failed to reach backend at {}: {}", url, e))?;
    let _: serde_json::Value = handle_response(response).await?;
    Ok(())
}

// --- AI Prospecting (Companies House lead sourcing) ---

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProspectingStatus {
    pub configured: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProspectingCriteria {
    pub name: String,
    pub sic_codes: Vec<String>,
    pub locations: Vec<String>,
    pub location: String,
    pub company_type: String,
    pub incorporated_from: String,
    pub incorporated_to: String,
    pub max_results: i64,
    pub min_ch_score: i64,
    pub run_ai_enrichment: bool,
    pub charge_types: Vec<String>,
    pub active_charges_only: bool,
    pub include_satisfied: bool,
    pub new_charges_only: bool,
    pub charge_registered_from: String,
    pub charge_registered_to: String,
    pub min_charges: i64,
    pub max_charges: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProspectingRunRecord {
    pub id: String,
    pub name: String,
    pub status: String,
    pub criteria: String,
    pub found: i64,
    pub created: i64,
    pub skipped: i64,
    pub error: Option<String>,
    pub started_at: String,
    pub completed_at: Option<String>,
    pub list_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StartProspectingResponse {
    pub run_id: String,
    pub message: String,
}

pub async fn get_prospecting_status(base_url: &str, token: &str) -> Result<ProspectingStatus, String> {
    let client = reqwest::Client::new();
    let url = format!("{}/ai-prospecting/status", base_url);
    let response = client
        .get(&url)
        .header("Authorization", format!("Bearer {}", token))
        .send()
        .await
        .map_err(|e| format!("Failed to reach backend at {}: {}", url, e))?;
    handle_response(response).await
}

pub async fn start_prospecting_run(
    base_url: &str,
    token: &str,
    criteria: &ProspectingCriteria,
) -> Result<StartProspectingResponse, String> {
    let client = reqwest::Client::new();
    let url = format!("{}/ai-prospecting/run", base_url);
    let response = client
        .post(&url)
        .header("Authorization", format!("Bearer {}", token))
        .json(criteria)
        .send()
        .await
        .map_err(|e| format!("Failed to reach backend at {}: {}", url, e))?;
    handle_response(response).await
}

pub async fn get_prospecting_run(base_url: &str, token: &str, run_id: &str) -> Result<ProspectingRunRecord, String> {
    let client = reqwest::Client::new();
    let url = format!("{}/ai-prospecting/runs/{}", base_url, run_id);
    let response = client
        .get(&url)
        .header("Authorization", format!("Bearer {}", token))
        .send()
        .await
        .map_err(|e| format!("Failed to reach backend at {}: {}", url, e))?;
    handle_response(response).await
}

pub async fn list_prospecting_runs(base_url: &str, token: &str) -> Result<Vec<ProspectingRunRecord>, String> {
    let client = reqwest::Client::new();
    let url = format!("{}/ai-prospecting/runs", base_url);
    let response = client
        .get(&url)
        .header("Authorization", format!("Bearer {}", token))
        .send()
        .await
        .map_err(|e| format!("Failed to reach backend at {}: {}", url, e))?;
    handle_response(response).await
}

// --- Activity Feed (DataGardener) ---

#[derive(Serialize, Deserialize, Clone)]
pub struct ActivityEvent {
    pub id: String,
    pub company_number: String,
    pub company_name: String,
    pub lead_id: Option<String>,
    pub event_type: String,
    pub description: String,
    pub event_data: Option<String>,
    pub occurred_at: String,
    pub detected_at: String,
}

#[derive(Serialize, Deserialize, Clone)]
pub struct ActivitySummary {
    pub count: i64,
    pub latest_detected_at: Option<String>,
    pub has_recent_24h: bool,
}

#[derive(Deserialize)]
struct ActivityEventsWrapper {
    events: Vec<ActivityEvent>,
}

#[derive(Deserialize)]
struct BatchSummaryWrapper {
    summaries: std::collections::HashMap<String, ActivitySummary>,
}

pub async fn list_lead_activity(base_url: &str, token: &str, lead_id: &str) -> Result<Vec<ActivityEvent>, String> {
    let client = reqwest::Client::new();
    let url = format!("{}/activity/lead/{}", base_url, lead_id);
    let response = client
        .get(&url)
        .header("Authorization", format!("Bearer {}", token))
        .send()
        .await
        .map_err(|e| format!("Failed to reach backend at {}: {}", url, e))?;
    let wrapper: ActivityEventsWrapper = handle_response(response).await?;
    Ok(wrapper.events)
}

pub async fn get_lead_activity_summary(base_url: &str, token: &str, lead_id: &str) -> Result<ActivitySummary, String> {
    let client = reqwest::Client::new();
    let url = format!("{}/activity/lead/{}/summary", base_url, lead_id);
    let response = client
        .get(&url)
        .header("Authorization", format!("Bearer {}", token))
        .send()
        .await
        .map_err(|e| format!("Failed to reach backend at {}: {}", url, e))?;
    handle_response(response).await
}

pub async fn trigger_lead_refresh(base_url: &str, token: &str, lead_id: &str) -> Result<(), String> {
    let client = reqwest::Client::new();
    let url = format!("{}/activity/lead/{}/refresh", base_url, lead_id);
    let response = client
        .post(&url)
        .header("Authorization", format!("Bearer {}", token))
        .header("Content-Length", "0")
        .send()
        .await
        .map_err(|e| format!("Failed to reach backend at {}: {}", url, e))?;
    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        return Err(format!("Backend returned {}: {}", status, body));
    }
    Ok(())
}

pub async fn get_global_activity_feed(
    base_url: &str,
    token: &str,
    event_types: Option<&str>,
    since: Option<&str>,
    company_name: Option<&str>,
) -> Result<Vec<ActivityEvent>, String> {
    let client = reqwest::Client::new();
    let url = format!("{}/activity/feed", base_url);
    let mut params: Vec<(&str, &str)> = vec![];
    if let Some(et) = event_types {
        params.push(("event_types", et));
    }
    if let Some(s) = since {
        params.push(("since", s));
    }
    if let Some(cn) = company_name {
        params.push(("company_name", cn));
    }
    let response = client
        .get(&url)
        .header("Authorization", format!("Bearer {}", token))
        .query(&params)
        .send()
        .await
        .map_err(|e| format!("Failed to reach backend at {}: {}", url, e))?;
    let wrapper: ActivityEventsWrapper = handle_response(response).await?;
    Ok(wrapper.events)
}

pub async fn get_batch_activity_summaries(
    base_url: &str,
    token: &str,
    lead_ids: &[String],
) -> Result<std::collections::HashMap<String, ActivitySummary>, String> {
    if lead_ids.is_empty() {
        return Ok(std::collections::HashMap::new());
    }
    let client = reqwest::Client::new();
    let ids_param = lead_ids.join(",");
    let url = format!("{}/activity/batch-summary", base_url);
    let response = client
        .get(&url)
        .header("Authorization", format!("Bearer {}", token))
        .query(&[("lead_ids", ids_param.as_str())])
        .send()
        .await
        .map_err(|e| format!("Failed to reach backend at {}: {}", url, e))?;
    let wrapper: BatchSummaryWrapper = handle_response(response).await?;
    Ok(wrapper.summaries)
}

pub async fn get_activity_status(base_url: &str, token: &str) -> Result<serde_json::Value, String> {
    let client = reqwest::Client::new();
    let url = format!("{}/activity/status", base_url);
    let response = client
        .get(&url)
        .header("Authorization", format!("Bearer {}", token))
        .send()
        .await
        .map_err(|e| format!("Failed to reach backend at {}: {}", url, e))?;
    handle_response(response).await
}
