use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use tauri::Manager;

use crate::auth_client::UserInfo;
use crate::backend_client::default_base_url;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StoredSession {
    pub token: String,
    pub user: UserInfo,
}

fn app_state_dir(app_handle: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app_handle
        .path()
        .app_data_dir()
        .map_err(|e| format!("Could not resolve app data dir: {}", e))?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("Could not create app data dir: {}", e))?;
    Ok(dir)
}

fn session_path(app_handle: &tauri::AppHandle) -> Result<PathBuf, String> {
    Ok(app_state_dir(app_handle)?.join("session.json"))
}

pub fn save_session(app_handle: &tauri::AppHandle, session: &StoredSession) -> Result<(), String> {
    let path = session_path(app_handle)?;
    let json = serde_json::to_string(session).map_err(|e| format!("Could not serialize session: {}", e))?;
    std::fs::write(&path, json).map_err(|e| format!("Could not write session file: {}", e))
}

pub fn load_session(app_handle: &tauri::AppHandle) -> Option<StoredSession> {
    let path = session_path(app_handle).ok()?;
    let contents = std::fs::read_to_string(path).ok()?;
    serde_json::from_str(&contents).ok()
}

pub fn clear_session(app_handle: &tauri::AppHandle) -> Result<(), String> {
    let path = session_path(app_handle)?;
    if path.exists() {
        std::fs::remove_file(&path).map_err(|e| format!("Could not remove session file: {}", e))?;
    }
    Ok(())
}

fn backend_url_path(app_handle: &tauri::AppHandle) -> Result<PathBuf, String> {
    Ok(app_state_dir(app_handle)?.join("backend_url.txt"))
}

pub fn save_backend_url(app_handle: &tauri::AppHandle, url: &str) -> Result<(), String> {
    let path = backend_url_path(app_handle)?;
    std::fs::write(&path, url).map_err(|e| format!("Could not write backend url override: {}", e))
}

/// Resolves the backend base URL: a per-install runtime override if one has
/// been set (via the `set_backend_base_url` command), otherwise the
/// compiled-in default. This is what makes the backend address configurable
/// without a rebuild — relevant since hosting/deployment isn't fixed yet.
pub fn resolve_base_url(app_handle: &tauri::AppHandle) -> String {
    if let Ok(path) = backend_url_path(app_handle) {
        if let Ok(contents) = std::fs::read_to_string(path) {
            let trimmed = contents.trim();
            if !trimmed.is_empty() {
                return trimmed.to_string();
            }
        }
    }
    default_base_url().to_string()
}
