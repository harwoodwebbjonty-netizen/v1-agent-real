use std::fs::OpenOptions;
use std::path::{Path, PathBuf};

use chrono::Utc;
use serde::{Deserialize, Serialize};
use tauri::Manager;

const LOG_FILE_NAME: &str = "phone_lookups.csv";

/// Contact status is an ordered pipeline. Index in this array is the rank
/// used everywhere funnel/cumulative math or status sorting is needed —
/// defined once here rather than re-implemented per feature.
pub const CONTACT_STATUS_ORDER: [&str; 4] = ["New", "Contacted", "Replied", "Converted"];

const FIELDS: [&str; 10] = [
    "id",
    "timestamp",
    "company",
    "phone_number",
    "source_url",
    "status",
    "notes",
    "industry",
    "contact_status",
    "lead_notes",
];
// contact_history, notes_log, and enrichment are stored in extra columns
// appended after FIELDS (kept separate from FIELDS-for-defaults below since
// they're JSON, not plain string defaults).
const CONTACT_HISTORY_FIELD: &str = "contact_history";
const NOTES_LOG_FIELD: &str = "notes_log";
const ENRICHMENT_FIELD: &str = "enrichment";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ContactHistoryEntry {
    pub timestamp: String,
    pub event: String,
}

/// One entry in the per-lead notes log (distinct from the single-field
/// `lead_notes` scratchpad — this is an append-only timestamped thread).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NoteEntry {
    pub timestamp: String,
    pub text: String,
}

/// Output of the on-demand enrichment sidecar. Never written automatically —
/// only via the explicit `enrich_lead` command.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EnrichmentData {
    pub industry_suggestion: String,
    pub company_summary: String,
    pub call_prep_summary: String,
    pub confidence_note: String,
    pub enriched_at: String,
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
    pub contact_history: Vec<ContactHistoryEntry>,
    pub notes_log: Vec<NoteEntry>,
    pub enrichment: Option<EnrichmentData>,
}

fn log_path(app_handle: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app_handle
        .path()
        .app_data_dir()
        .map_err(|e| format!("Could not resolve app data dir: {}", e))?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("Could not create app data dir: {}", e))?;
    Ok(dir.join(LOG_FILE_NAME))
}

fn new_id() -> String {
    Utc::now()
        .timestamp_nanos_opt()
        .unwrap_or_else(|| Utc::now().timestamp())
        .to_string()
}

/// Reads every row by header name (tolerant of old-format files missing the
/// newer columns) and returns fully-populated LeadRecords with sensible
/// defaults for anything absent.
fn read_records(path: &Path) -> Result<Vec<LeadRecord>, String> {
    let mut reader = csv::Reader::from_path(path)
        .map_err(|e| format!("Could not read log file {:?}: {}", path, e))?;

    let headers = reader
        .headers()
        .map_err(|e| format!("Could not read CSV headers: {}", e))?
        .clone();
    let col = |name: &str| headers.iter().position(|h| h == name);

    let id_col = col("id");
    let timestamp_col = col("timestamp");
    let company_col = col("company");
    let phone_col = col("phone_number");
    let source_col = col("source_url");
    let status_col = col("status");
    let notes_col = col("notes");
    let industry_col = col("industry");
    let contact_status_col = col("contact_status");
    let lead_notes_col = col("lead_notes");
    let contact_history_col = col(CONTACT_HISTORY_FIELD);
    let notes_log_col = col(NOTES_LOG_FIELD);
    let enrichment_col = col(ENRICHMENT_FIELD);

    let get = |record: &csv::StringRecord, idx: Option<usize>| -> String {
        idx.and_then(|i| record.get(i)).unwrap_or_default().to_string()
    };

    let mut records = Vec::new();
    for result in reader.records() {
        let record = result.map_err(|e| format!("Could not parse CSV row: {}", e))?;

        let contact_history_raw = get(&record, contact_history_col);
        let contact_history: Vec<ContactHistoryEntry> = if contact_history_raw.is_empty() {
            Vec::new()
        } else {
            serde_json::from_str(&contact_history_raw).unwrap_or_default()
        };

        let notes_log_raw = get(&record, notes_log_col);
        let notes_log: Vec<NoteEntry> = if notes_log_raw.is_empty() {
            Vec::new()
        } else {
            serde_json::from_str(&notes_log_raw).unwrap_or_default()
        };

        let enrichment_raw = get(&record, enrichment_col);
        let enrichment: Option<EnrichmentData> = if enrichment_raw.is_empty() {
            None
        } else {
            serde_json::from_str(&enrichment_raw).unwrap_or(None)
        };

        let id = match id_col.and_then(|i| record.get(i)) {
            Some(v) if !v.is_empty() => v.to_string(),
            _ => new_id(),
        };
        let contact_status = match contact_status_col.and_then(|i| record.get(i)) {
            Some(v) if !v.is_empty() => v.to_string(),
            _ => CONTACT_STATUS_ORDER[0].to_string(),
        };

        records.push(LeadRecord {
            id,
            timestamp: get(&record, timestamp_col),
            company: get(&record, company_col),
            phone_number: get(&record, phone_col),
            source_url: get(&record, source_col),
            status: get(&record, status_col),
            notes: get(&record, notes_col),
            industry: get(&record, industry_col),
            contact_status,
            lead_notes: get(&record, lead_notes_col),
            contact_history,
            notes_log,
            enrichment,
        });
    }
    Ok(records)
}

fn write_records(path: &Path, records: &[LeadRecord]) -> Result<(), String> {
    let file = OpenOptions::new()
        .create(true)
        .write(true)
        .truncate(true)
        .open(path)
        .map_err(|e| format!("Could not open log file {:?}: {}", path, e))?;

    let mut writer = csv::WriterBuilder::new().has_headers(false).from_writer(file);

    let mut header_row: Vec<&str> = FIELDS.to_vec();
    header_row.push(CONTACT_HISTORY_FIELD);
    header_row.push(NOTES_LOG_FIELD);
    header_row.push(ENRICHMENT_FIELD);
    writer
        .write_record(&header_row)
        .map_err(|e| format!("Could not write CSV header: {}", e))?;

    for r in records {
        let history_json = serde_json::to_string(&r.contact_history).unwrap_or_else(|_| "[]".to_string());
        let notes_log_json = serde_json::to_string(&r.notes_log).unwrap_or_else(|_| "[]".to_string());
        let enrichment_json = match &r.enrichment {
            Some(data) => serde_json::to_string(data).unwrap_or_default(),
            None => String::new(),
        };
        writer
            .write_record(&[
                r.id.clone(),
                r.timestamp.clone(),
                r.company.clone(),
                r.phone_number.clone(),
                r.source_url.clone(),
                r.status.clone(),
                r.notes.clone(),
                r.industry.clone(),
                r.contact_status.clone(),
                r.lead_notes.clone(),
                history_json,
                notes_log_json,
                enrichment_json,
            ])
            .map_err(|e| format!("Could not write CSV row: {}", e))?;
    }

    writer.flush().map_err(|e| format!("Could not flush CSV writer: {}", e))
}

/// Reads the log, transparently upgrading old-format files to the current
/// schema by rewriting them in place. Idempotent: re-reading an
/// already-current-format file just reads it back unchanged (no-op rewrite
/// is skipped via the `needs_migration` check).
fn read_all_with_migration(path: &Path) -> Result<Vec<LeadRecord>, String> {
    if !path.exists() {
        return Ok(Vec::new());
    }

    let needs_migration = {
        let mut reader = csv::Reader::from_path(path)
            .map_err(|e| format!("Could not read log file {:?}: {}", path, e))?;
        let headers = reader
            .headers()
            .map_err(|e| format!("Could not read CSV headers: {}", e))?;
        !headers.iter().any(|h| h == "id")
    };

    let records = read_records(path)?;

    if needs_migration && !records.is_empty() {
        write_records(path, &records)?;
    }

    Ok(records)
}

pub fn read_all(app_handle: &tauri::AppHandle) -> Result<Vec<LeadRecord>, String> {
    let path = log_path(app_handle)?;
    read_all_with_migration(&path)
}

// Note: this module's write-side functions (update/add_note/set_enrichment/
// import/export/clear) were removed when leads moved to the backend-hosted
// SQLite store. The only thing that still touches this file at runtime is
// `read_all`, used exactly once by the `migrate_local_leads_to_team` command
// to import legacy local data into the shared workspace.

/// Parses an arbitrary user-supplied CSV (unknown column layout, picked via
/// the cold-call-list "Upload CSV" dialog) into JSON objects matching the
/// backend's `ImportLeadsRequest` shape. Unlike `read_records` above, which
/// only understands this app's own fixed internal log format, this is
/// header-driven and tolerant of missing optional columns.
pub fn parse_uploaded_csv(path: &str) -> Result<Vec<serde_json::Value>, String> {
    let mut reader = csv::Reader::from_path(path)
        .map_err(|e| format!("Could not read CSV file {:?}: {}", path, e))?;

    let headers = reader
        .headers()
        .map_err(|e| format!("Could not read CSV headers: {}", e))?
        .clone();

    let find_col = |names: &[&str]| -> Option<usize> {
        headers
            .iter()
            .position(|h| names.iter().any(|n| h.trim().eq_ignore_ascii_case(n)))
    };

    let company_col = find_col(&["company", "company_name", "name"])
        .ok_or_else(|| "That CSV needs a \"company\" column.".to_string())?;
    let phone_col = find_col(&["phone_number", "phone", "phone number"]);
    let source_col = find_col(&["source_url", "website", "url", "site"]);
    let notes_col = find_col(&["notes"]);

    let get = |record: &csv::StringRecord, idx: Option<usize>| -> String {
        idx.and_then(|i| record.get(i)).unwrap_or_default().trim().to_string()
    };

    let mut rows = Vec::new();
    for result in reader.records() {
        let record = result.map_err(|e| format!("Could not parse CSV row: {}", e))?;
        let company = get(&record, Some(company_col));
        if company.is_empty() {
            continue;
        }
        rows.push(serde_json::json!({
            "company": company,
            "phone_number": get(&record, phone_col),
            "source_url": get(&record, source_col),
            "notes": get(&record, notes_col),
        }));
    }
    Ok(rows)
}

