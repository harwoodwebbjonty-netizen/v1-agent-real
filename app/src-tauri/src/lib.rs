mod backend_client;
mod csv_log;

use backend_client::LookupResult;

#[tauri::command]
async fn lookup_company_phone(
    app_handle: tauri::AppHandle,
    company: String,
) -> Result<LookupResult, String> {
    let result = backend_client::lookup_company_phone(&company).await?;
    csv_log::append_result(&app_handle, &result)?;
    Ok(result)
}

#[tauri::command]
fn get_log_entries(app_handle: tauri::AppHandle) -> Result<Vec<LookupResult>, String> {
    csv_log::read_all(&app_handle)
}

#[tauri::command]
fn export_log_csv(app_handle: tauri::AppHandle, dest_path: String) -> Result<(), String> {
    csv_log::export_to(&app_handle, &dest_path)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  tauri::Builder::default()
    .plugin(tauri_plugin_dialog::init())
    .setup(|app| {
      if cfg!(debug_assertions) {
        app.handle().plugin(
          tauri_plugin_log::Builder::default()
            .level(log::LevelFilter::Info)
            .build(),
        )?;
      }
      Ok(())
    })
    .invoke_handler(tauri::generate_handler![
      lookup_company_phone,
      get_log_entries,
      export_log_csv
    ])
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}
