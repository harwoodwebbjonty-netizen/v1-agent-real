use std::fs::OpenOptions;
use std::path::PathBuf;

use chrono::Utc;
use tauri::Manager;

use crate::backend_client::LookupResult;

const LOG_FILE_NAME: &str = "phone_lookups.csv";
const FIELDS: [&str; 6] = [
    "timestamp",
    "company",
    "phone_number",
    "source_url",
    "status",
    "notes",
];

fn log_path(app_handle: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app_handle
        .path()
        .app_data_dir()
        .map_err(|e| format!("Could not resolve app data dir: {}", e))?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("Could not create app data dir: {}", e))?;
    Ok(dir.join(LOG_FILE_NAME))
}

pub fn append_result(app_handle: &tauri::AppHandle, result: &LookupResult) -> Result<(), String> {
    let path = log_path(app_handle)?;
    let is_new = !path.exists();

    let file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .map_err(|e| format!("Could not open log file {:?}: {}", path, e))?;

    let mut writer = csv::WriterBuilder::new()
        .has_headers(false)
        .from_writer(file);

    if is_new {
        writer
            .write_record(FIELDS)
            .map_err(|e| format!("Could not write CSV header: {}", e))?;
    }

    writer
        .write_record(&[
            Utc::now().to_rfc3339(),
            result.company.clone(),
            result.phone_number.clone(),
            result.source_url.clone(),
            result.status.clone(),
            result.notes.clone(),
        ])
        .map_err(|e| format!("Could not write CSV row: {}", e))?;

    writer.flush().map_err(|e| format!("Could not flush CSV writer: {}", e))
}

pub fn read_all(app_handle: &tauri::AppHandle) -> Result<Vec<LookupResult>, String> {
    let path = log_path(app_handle)?;
    if !path.exists() {
        return Ok(Vec::new());
    }

    let mut reader = csv::Reader::from_path(&path)
        .map_err(|e| format!("Could not read log file {:?}: {}", path, e))?;

    let mut results = Vec::new();
    for record in reader.records() {
        let record = record.map_err(|e| format!("Could not parse CSV row: {}", e))?;
        // record[0] is the timestamp column, not part of LookupResult
        results.push(LookupResult {
            company: record.get(1).unwrap_or_default().to_string(),
            phone_number: record.get(2).unwrap_or_default().to_string(),
            source_url: record.get(3).unwrap_or_default().to_string(),
            status: record.get(4).unwrap_or_default().to_string(),
            notes: record.get(5).unwrap_or_default().to_string(),
        });
    }
    Ok(results)
}

pub fn export_to(app_handle: &tauri::AppHandle, dest_path: &str) -> Result<(), String> {
    let source = log_path(app_handle)?;
    std::fs::copy(&source, dest_path)
        .map(|_| ())
        .map_err(|e| format!("Could not export log to {}: {}", dest_path, e))
}
