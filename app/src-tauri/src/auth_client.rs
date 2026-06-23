use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UserInfo {
    pub id: String,
    pub name: String,
    pub role: String,
    pub avatar: Option<String>,
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
}

/// No passwords — typing an existing name signs in as that person, typing a
/// new one creates a profile on the spot (small trusted team).
pub async fn identify(base_url: &str, name: &str) -> Result<(String, UserInfo), String> {
    let client = reqwest::Client::new();
    let url = format!("{}/auth/identify", base_url);
    let response = client
        .post(&url)
        .json(&IdentifyRequest { name })
        .send()
        .await
        .map_err(|e| format!("Failed to reach backend at {}: {}", url, e))?;
    let parsed: LoginResponse = handle_response(response).await?;
    Ok((parsed.token, parsed.user))
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

/// Public endpoint — no token needed (there's no password boundary, and the
/// identity picker needs to show known names before anyone is signed in).
pub async fn list_team_members(base_url: &str) -> Result<Vec<UserInfo>, String> {
    let client = reqwest::Client::new();
    let url = format!("{}/users", base_url);
    let response = client
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("Failed to reach backend at {}: {}", url, e))?;
    let parsed: UserListResponse = handle_response(response).await?;
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
