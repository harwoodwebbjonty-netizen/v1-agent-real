use serde::{Deserialize, Serialize};

/// Base URL of the backend service. Not a secret — safe to compile into the
/// app. Override at build time with `BACKEND_BASE_URL=https://... cargo build`;
/// defaults to local dev.
const BACKEND_BASE_URL: &str = match option_env!("BACKEND_BASE_URL") {
    Some(url) => url,
    None => "http://localhost:8000",
};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LookupResult {
    pub company: String,
    pub phone_number: String,
    pub source_url: String,
    pub status: String,
    pub notes: String,
}

#[derive(Serialize)]
struct LookupRequest<'a> {
    company: &'a str,
}

pub async fn lookup_company_phone(company: &str) -> Result<LookupResult, String> {
    let client = reqwest::Client::new();
    let url = format!("{}/lookup-company-phone", BACKEND_BASE_URL);

    let response = client
        .post(&url)
        .json(&LookupRequest { company })
        .send()
        .await
        .map_err(|e| format!("Failed to reach backend at {}: {}", url, e))?;

    if response.status() == reqwest::StatusCode::TOO_MANY_REQUESTS {
        return Err("Rate limit exceeded. Try again shortly.".to_string());
    }

    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        return Err(format!("Backend returned {}: {}", status, body));
    }

    response
        .json::<LookupResult>()
        .await
        .map_err(|e| format!("Failed to parse backend response: {}", e))
}
