use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UserInfo {
    pub id: String,
    pub name: String,
    pub role: String,
    pub avatar: Option<String>,
    pub last_seen_at: Option<String>,
}

#[derive(Deserialize)]
struct LoginResponse {
    token: String,
    user: UserInfo,
}

async fn handle_response<T: serde::de::DeserializeOwned>(response: reqwest::Response) -> Result<T, String> {
    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        // Surface FastAPI's {"detail": "..."} as a plain human message when
        // present — the UI shows these errors verbatim.
        if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(&body) {
            if let Some(detail) = parsed.get("detail").and_then(|d| d.as_str()) {
                return Err(detail.to_string());
            }
        }
        return Err(format!("Backend returned {}: {}", status, body));
    }
    response
        .json::<T>()
        .await
        .map_err(|e| format!("Failed to parse backend response: {}", e))
}

#[derive(Serialize)]
struct IdentifyRequest<'a> {
    name: &'a str,
    password: &'a str,
    bootstrap_token: &'a str,
}

/// Name + password sign-in. A new name creates a member profile with that
/// password; an existing name must supply the matching password. The very first
/// account on a fresh deployment also needs the bootstrap admin token.
pub async fn identify(
    base_url: &str,
    name: &str,
    password: &str,
    bootstrap_token: &str,
) -> Result<(String, UserInfo), String> {
    let client = reqwest::Client::new();
    let url = format!("{}/auth/identify", base_url);
    let response = client
        .post(&url)
        .json(&IdentifyRequest { name, password, bootstrap_token })
        .send()
        .await
        .map_err(|e| format!("Failed to reach backend at {}: {}", url, e))?;
    let parsed: LoginResponse = handle_response(response).await?;
    Ok((parsed.token, parsed.user))
}

/// Real presence ping — called periodically while the app is open, not a
/// fabricated "online" flag. Failures are non-fatal (no network = no
/// update to last_seen_at, nothing else in the app depends on this).
pub async fn heartbeat(base_url: &str, token: &str) -> Result<(), String> {
    let client = reqwest::Client::new();
    let url = format!("{}/auth/heartbeat", base_url);
    let response = client
        .post(&url)
        .header("Authorization", format!("Bearer {}", token))
        .send()
        .await
        .map_err(|e| format!("Failed to reach backend at {}: {}", url, e))?;
    let _: serde_json::Value = handle_response(response).await?;
    Ok(())
}

pub async fn logout(base_url: &str, token: &str) -> Result<(), String> {
    let client = reqwest::Client::new();
    let url = format!("{}/auth/logout", base_url);
    let _ = client
        .post(&url)
        .header("Authorization", format!("Bearer {}", token))
        .send()
        .await;
    Ok(())
}

#[derive(Deserialize)]
struct UserListResponse {
    users: Vec<UserInfo>,
}

/// Full roster (ids/roles/last-seen) — now authenticated. Used post-sign-in by
/// team management, presence, and assignment dropdowns.
pub async fn list_team_members(base_url: &str, token: &str) -> Result<Vec<UserInfo>, String> {
    let client = reqwest::Client::new();
    let url = format!("{}/users", base_url);
    let response = client
        .get(&url)
        .header("Authorization", format!("Bearer {}", token))
        .send()
        .await
        .map_err(|e| format!("Failed to reach backend at {}: {}", url, e))?;
    let parsed: UserListResponse = handle_response(response).await?;
    Ok(parsed.users)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UserNameInfo {
    pub name: String,
    pub avatar: Option<String>,
}

#[derive(Deserialize)]
struct UserNamesResponse {
    users: Vec<UserNameInfo>,
}

/// Public, slim — names + avatars only, for the pre-auth login picker.
pub async fn list_user_names(base_url: &str) -> Result<Vec<UserNameInfo>, String> {
    let client = reqwest::Client::new();
    let url = format!("{}/users/names", base_url);
    let response = client
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("Failed to reach backend at {}: {}", url, e))?;
    let parsed: UserNamesResponse = handle_response(response).await?;
    Ok(parsed.users)
}

#[derive(Serialize)]
struct CreateUserRequest<'a> {
    name: &'a str,
    role: &'a str,
}

pub async fn create_team_member(base_url: &str, token: &str, name: &str, role: &str) -> Result<UserInfo, String> {
    let client = reqwest::Client::new();
    let url = format!("{}/users", base_url);
    let response = client
        .post(&url)
        .header("Authorization", format!("Bearer {}", token))
        .json(&CreateUserRequest { name, role })
        .send()
        .await
        .map_err(|e| format!("Failed to reach backend at {}: {}", url, e))?;
    handle_response(response).await
}

#[derive(Serialize)]
struct UpdateUserRequest<'a> {
    name: Option<&'a str>,
    role: Option<&'a str>,
}

pub async fn update_team_member(
    base_url: &str,
    token: &str,
    user_id: &str,
    name: Option<&str>,
    role: Option<&str>,
) -> Result<UserInfo, String> {
    let client = reqwest::Client::new();
    let url = format!("{}/users/{}", base_url, user_id);
    let response = client
        .patch(&url)
        .header("Authorization", format!("Bearer {}", token))
        .json(&UpdateUserRequest { name, role })
        .send()
        .await
        .map_err(|e| format!("Failed to reach backend at {}: {}", url, e))?;
    handle_response(response).await
}

#[derive(Serialize)]
struct SetPasswordRequest<'a> {
    password: &'a str,
}

/// Admin-issued password set/reset. Revokes the target user's other sessions.
pub async fn admin_set_user_password(
    base_url: &str,
    token: &str,
    user_id: &str,
    password: &str,
) -> Result<UserInfo, String> {
    let client = reqwest::Client::new();
    let url = format!("{}/users/{}/set-password", base_url, user_id);
    let response = client
        .post(&url)
        .header("Authorization", format!("Bearer {}", token))
        .json(&SetPasswordRequest { password })
        .send()
        .await
        .map_err(|e| format!("Failed to reach backend at {}: {}", url, e))?;
    handle_response(response).await
}

pub async fn delete_team_member(base_url: &str, token: &str, user_id: &str) -> Result<(), String> {
    let client = reqwest::Client::new();
    let url = format!("{}/users/{}", base_url, user_id);
    let response = client
        .delete(&url)
        .header("Authorization", format!("Bearer {}", token))
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

#[derive(Serialize)]
struct SetAvatarRequest<'a> {
    avatar: Option<&'a str>,
}

pub async fn set_avatar(base_url: &str, token: &str, user_id: &str, avatar: Option<&str>) -> Result<UserInfo, String> {
    let client = reqwest::Client::new();
    let url = format!("{}/users/{}/avatar", base_url, user_id);
    let response = client
        .patch(&url)
        .header("Authorization", format!("Bearer {}", token))
        .json(&SetAvatarRequest { avatar })
        .send()
        .await
        .map_err(|e| format!("Failed to reach backend at {}: {}", url, e))?;
    handle_response(response).await
}
