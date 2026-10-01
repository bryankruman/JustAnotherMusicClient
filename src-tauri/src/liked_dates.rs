//! Optional official YouTube API connection. Credentials never cross the IPC boundary.
use crate::{CommandError, KEYRING_SERVICE};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use rand::{rngs::OsRng, RngCore};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, HashSet},
    fs,
    path::PathBuf,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tauri::{Emitter, Manager};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_opener::OpenerExt;

const SCOPE: &str = "https://www.googleapis.com/auth/youtube.readonly";
const DAY: u64 = 86_400;
const RETRY_DELAY: u64 = 30 * 60;
const MAX_AGE: u64 = 29 * DAY;
const CACHE_FILE: &str = "liked-dates-v1.json";
static GENERATION: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
static LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

fn error(message: &str) -> CommandError {
    CommandError {
        message: message.into(),
    }
}
fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

#[derive(Serialize, Deserialize)]
struct Credentials {
    client_id: String,
    client_secret: String,
    refresh_token: String,
    channel_id: String,
    channel_title: String,
    playlist_id: String,
}

#[derive(Deserialize)]
struct ClientFile {
    installed: DesktopClient,
}
#[derive(Deserialize)]
struct DesktopClient {
    client_id: String,
    client_secret: String,
}
#[derive(Deserialize)]
struct TokenResponse {
    access_token: String,
    refresh_token: Option<String>,
}

#[derive(Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DateCache {
    channel_id: String,
    synced_at: u64,
    attempted_at: u64,
    dates: BTreeMap<String, String>,
    #[serde(default)]
    lookup_after: BTreeMap<String, u64>,
    #[serde(default)]
    publications: BTreeMap<String, PublicationDate>,
}

#[derive(Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PublicationDate {
    published_at: Option<String>,
    checked_at: u64,
    retry_after: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DateStatus {
    connected: bool,
    channel_title: Option<String>,
    synced_at: u64,
    dates: BTreeMap<String, String>,
    lookup_after: BTreeMap<String, u64>,
    publications: BTreeMap<String, PublicationDate>,
}

fn credential_entry() -> Result<keyring::Entry, CommandError> {
    keyring::Entry::new(KEYRING_SERVICE, "liked-dates-oauth-v1")
        .map_err(|_| error("The credential store is unavailable."))
}
fn credentials() -> Result<Option<Credentials>, CommandError> {
    match credential_entry()?.get_password() {
        Ok(value) => serde_json::from_str(&value)
            .map(Some)
            .map_err(|_| error("Reconnect liked dates in Settings.")),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(_) => Err(error(
            "Could not read the liked dates connection from the credential store.",
        )),
    }
}
fn cache_path(app: &tauri::AppHandle) -> Result<PathBuf, CommandError> {
    Ok(app
        .path()
        .app_data_dir()
        .map_err(|_| error("App data directory unavailable."))?
        .join(CACHE_FILE))
}
fn remove_cache(app: &tauri::AppHandle) -> Result<(), CommandError> {
    let path = cache_path(app)?;
    for file in [path.clone(), path.with_extension("json.tmp")] {
        match fs::remove_file(file) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(_) => return Err(error("Could not delete the liked dates cache.")),
        }
    }
    Ok(())
}
fn cache_is_current(cache: &DateCache, channel_id: &str, time: u64) -> bool {
    cache.channel_id == channel_id
        && cache.synced_at <= time
        && cache.synced_at != 0
        && time.saturating_sub(cache.synced_at) < MAX_AGE
}
fn expire_cached_dates(cache: &mut DateCache, time: u64) -> bool {
    let previous_count = cache.publications.len();
    // A successfully retrieved publication date is permanent, including entries
    // written by older versions with a seven-day retry timestamp.
    cache.publications.retain(|_, value| value.published_at.is_some()
        || value.checked_at == 0
        || (value.checked_at <= time && time - value.checked_at < MAX_AGE));
    let mut changed = cache.publications.len() != previous_count;
    if !cache_is_current(cache, &cache.channel_id, time) {
        changed |= cache.synced_at != 0 || !cache.dates.is_empty() || !cache.lookup_after.is_empty();
        cache.dates.clear();
        cache.lookup_after.clear();
        cache.synced_at = 0;
    }
    changed
}
fn load_cache(app: &tauri::AppHandle, channel_id: &str) -> Result<DateCache, CommandError> {
    let path = cache_path(app)?;
    let cache = fs::read(&path)
        .ok()
        .filter(|data| data.len() <= 4 * 1024 * 1024)
        .and_then(|data| serde_json::from_slice::<DateCache>(&data).ok());
    if let Some(mut cache) = cache {
        if cache.channel_id == channel_id && cache.synced_at <= now() {
            if expire_cached_dates(&mut cache, now()) { save_cache(app, &cache)?; }
            return Ok(cache);
        }
    }
    remove_cache(app)?;
    Ok(DateCache {
        channel_id: channel_id.into(),
        ..Default::default()
    })
}
fn save_cache(app: &tauri::AppHandle, cache: &DateCache) -> Result<(), CommandError> {
    write_cache(&cache_path(app)?, cache)
}
fn write_cache(path: &std::path::Path, cache: &DateCache) -> Result<(), CommandError> {
    fs::create_dir_all(path.parent().unwrap())
        .map_err(|_| error("Could not create the liked dates cache directory."))?;
    let data = serde_json::to_vec(cache).map_err(|_| error("Could not encode liked dates."))?;
    // Replace only after the complete file has been written. Credentials are never here.
    let temporary = path.with_extension("json.tmp");
    fs::write(&temporary, data).map_err(|_| error("Could not save liked dates."))?;
    fs::rename(&temporary, path).map_err(|_| {
        let _ = fs::remove_file(&temporary);
        error("Could not replace the liked dates cache.")
    })
}
fn status(auth: Option<&Credentials>, cache: DateCache) -> DateStatus {
    DateStatus {
        connected: auth.is_some(),
        channel_title: auth.map(|a| a.channel_title.clone()),
        synced_at: cache.synced_at,
        dates: cache.dates,
        lookup_after: cache.lookup_after,
        publications: cache.publications,
    }
}
fn refresh_due(cache: &DateCache, time: u64) -> bool {
    (cache.synced_at == 0 || time.saturating_sub(cache.synced_at) >= DAY)
        && (cache.attempted_at == 0 || time.saturating_sub(cache.attempted_at) >= RETRY_DELAY)
}
fn client() -> Result<reqwest::Client, CommandError> {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(30))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|_| error("Could not initialize the YouTube connection."))
}
async fn token(
    client: &reqwest::Client,
    params: &[(&str, &str)],
) -> Result<TokenResponse, CommandError> {
    let response = client
        .post("https://oauth2.googleapis.com/token")
        .form(params)
        .send()
        .await
        .map_err(|_| error("Could not reach Google. Check your connection and try again."))?;
    if !response.status().is_success() {
        return Err(error(
            "Google authorization failed. Reconnect liked dates in Settings.",
        ));
    }
    let text = response
        .text()
        .await
        .map_err(|_| error("Could not read Google's authorization response."))?;
    serde_json::from_str(&text)
        .map_err(|_| error("Google returned an invalid authorization response."))
}
async fn api(
    client: &reqwest::Client,
    access: &str,
    endpoint: &str,
    params: &[(&str, &str)],
) -> Result<serde_json::Value, CommandError> {
    let response = client
        .get(format!("https://www.googleapis.com/youtube/v3/{endpoint}"))
        .bearer_auth(access)
        .query(params)
        .send()
        .await
        .map_err(|_| error("Could not retrieve liked dates. Check your connection."))?;
    if !response.status().is_success() {
        return Err(error(match response.status().as_u16() {
            401 => "YouTube authorization expired. Reconnect liked dates in Settings.",
            403 => "YouTube denied the request. Check that YouTube Data API v3 is enabled and quota is available.",
            _ => "YouTube could not return liked dates. The previous cache has been kept.",
        }));
    }
    let text = response
        .text()
        .await
        .map_err(|_| error("Could not read YouTube's response."))?;
    serde_json::from_str(&text).map_err(|_| error("YouTube returned an invalid response."))
}

fn random_string() -> String {
    let mut bytes = [0u8; 32];
    OsRng.fill_bytes(&mut bytes);
    URL_SAFE_NO_PAD.encode(bytes)
}
fn callback_code(request_url: &str, expected_state: &str) -> Option<Result<String, CommandError>> {
    let url = url::Url::parse(&format!("http://127.0.0.1{request_url}")).ok()?;
    if url.path() != "/" {
        return None;
    }
    let params: BTreeMap<_, _> = url.query_pairs().into_owned().collect();
    if params.get("state").map(String::as_str) != Some(expected_state) {
        return None;
    }
    Some(
        params
            .get("code")
            .filter(|code| !code.is_empty())
            .cloned()
            .ok_or_else(|| error("Google sign-in was cancelled or permission was not granted.")),
    )
}

#[tauri::command]
pub async fn liked_dates_connect(app: tauri::AppHandle) -> Result<DateStatus, CommandError> {
    let _guard = LOCK.lock().await;
    let generation = GENERATION.load(std::sync::atomic::Ordering::SeqCst);
    let selected = app
        .dialog()
        .file()
        .add_filter("Google Desktop OAuth client", &["json"])
        .set_title("Choose your Google Desktop OAuth client JSON")
        .blocking_pick_file()
        .ok_or_else(|| error("Connection cancelled."))?;
    let path = selected
        .into_path()
        .map_err(|_| error("Could not open the selected client file."))?;
    if fs::metadata(&path)
        .map_err(|_| error("Could not read the client file."))?
        .len()
        > 64 * 1024
    {
        return Err(error("The selected client file is too large."));
    }
    let contents = fs::read(path).map_err(|_| error("Could not read the client file."))?;
    let config: ClientFile = serde_json::from_slice(&contents).map_err(|_| {
        error(
            "Choose the downloaded OAuth JSON for a Desktop app, not a web app or service account.",
        )
    })?;
    let config = config.installed;
    if !config.client_id.ends_with(".apps.googleusercontent.com") || config.client_secret.is_empty()
    {
        return Err(error(
            "The Google Desktop OAuth client configuration is incomplete.",
        ));
    }
    let server = tiny_http::Server::http("127.0.0.1:0")
        .map_err(|_| error("Could not start Google's local sign-in callback."))?;
    let redirect = format!("http://{}/", server.server_addr());
    let state = random_string();
    let verifier = random_string();
    let challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()));
    let mut auth_url = url::Url::parse("https://accounts.google.com/o/oauth2/v2/auth").unwrap();
    auth_url.query_pairs_mut().extend_pairs([
        ("client_id", config.client_id.as_str()),
        ("redirect_uri", redirect.as_str()),
        ("response_type", "code"),
        ("scope", SCOPE),
        ("state", state.as_str()),
        ("code_challenge", challenge.as_str()),
        ("code_challenge_method", "S256"),
        ("access_type", "offline"),
        ("prompt", "consent select_account"),
    ]);
    app.opener()
        .open_url(auth_url.as_str(), None::<&str>)
        .map_err(|_| error("Could not open the browser for Google sign-in."))?;
    let code = tauri::async_runtime::spawn_blocking(move || {
        let deadline = Instant::now() + Duration::from_secs(180);
        while Instant::now() < deadline {
            if generation != GENERATION.load(std::sync::atomic::Ordering::SeqCst) {
                return Err(error("Google sign-in cancelled."));
            }
            let request = server.recv_timeout(Duration::from_secs(1)).map_err(|_| error("Google sign-in callback failed."))?;
            let Some(request) = request else { continue; };
            if request.method() != &tiny_http::Method::Get {
                let _ = request.respond(tiny_http::Response::empty(405));
                continue;
            }
            if let Some(code) = callback_code(request.url(), &state) {
                let _ = request.respond(tiny_http::Response::from_string("Return to Just Another Music Client to finish connecting. You can close this tab."));
                return code;
            }
            let _ = request.respond(tiny_http::Response::empty(400));
        }
        Err(error("Google sign-in timed out. Try connecting again."))
    }).await.map_err(|_| error("Google sign-in was interrupted."))??;
    let client = client()?;
    let tokens = token(
        &client,
        &[
            ("client_id", &config.client_id),
            ("client_secret", &config.client_secret),
            ("code", &code),
            ("code_verifier", &verifier),
            ("redirect_uri", &redirect),
            ("grant_type", "authorization_code"),
        ],
    )
    .await?;
    let channels = api(
        &client,
        &tokens.access_token,
        "channels",
        &[("part", "snippet,contentDetails"), ("mine", "true")],
    )
    .await?;
    let channel = channels["items"]
        .as_array()
        .and_then(|items| items.first())
        .ok_or_else(|| error("No YouTube channel was found for this account."))?;
    let auth = Credentials {
        client_id: config.client_id,
        client_secret: config.client_secret,
        refresh_token: tokens.refresh_token.ok_or_else(|| {
            error("Google did not grant offline access. Reconnect and approve access.")
        })?,
        channel_id: channel["id"]
            .as_str()
            .ok_or_else(|| error("YouTube did not return an account ID."))?
            .into(),
        channel_title: channel["snippet"]["title"]
            .as_str()
            .unwrap_or("YouTube")
            .into(),
        playlist_id: channel["contentDetails"]["relatedPlaylists"]["likes"]
            .as_str()
            .ok_or_else(|| error("This account has no accessible liked playlist."))?
            .into(),
    };
    if generation != GENERATION.load(std::sync::atomic::Ordering::SeqCst) {
        return Err(error("Google sign-in cancelled."));
    }
    remove_cache(&app)?;
    credential_entry()?
        .set_password(
            &serde_json::to_string(&auth).map_err(|_| error("Could not save the connection."))?,
        )
        .map_err(|_| error("Could not save Google authorization in the credential store."))?;
    Ok(status(Some(&auth), DateCache::default()))
}

#[tauri::command]
pub async fn liked_dates_read(app: tauri::AppHandle) -> Result<DateStatus, CommandError> {
    let _guard = LOCK.lock().await;
    let auth = credentials()?;
    let cache = match &auth {
        Some(auth) => load_cache(&app, &auth.channel_id)?,
        None => {
            remove_cache(&app)?;
            DateCache::default()
        }
    };
    Ok(status(auth.as_ref(), cache))
}

fn collect_dates(
    response: &serde_json::Value,
    dates: &mut BTreeMap<String, String>,
) -> Result<Option<String>, CommandError> {
    let items = response["items"]
        .as_array()
        .ok_or_else(|| error("YouTube returned an invalid liked playlist page."))?;
    for item in items {
        let snippet = &item["snippet"];
        if let (Some(id), Some(date)) = (
            snippet["resourceId"]["videoId"].as_str(),
            snippet["publishedAt"].as_str(),
        ) {
            if id.len() == 11
                && id
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
                && chrono::DateTime::parse_from_rfc3339(date).is_ok()
            {
                dates.insert(id.into(), date.into());
            }
        }
    }
    Ok(response["nextPageToken"]
        .as_str()
        .filter(|v| !v.is_empty())
        .map(str::to_owned))
}

fn missing_date_ids(cache: &DateCache, ids: Vec<String>, time: u64) -> Vec<String> {
    let mut seen = HashSet::new();
    ids.into_iter()
        .filter(|id| {
            id.len() == 11
                && id
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
                && !cache.dates.contains_key(id)
                && cache.lookup_after.get(id).copied().unwrap_or(0) <= time
                && seen.insert(id.clone())
        })
        .take(200)
        .collect()
}

/// Ask for exact video IDs absent from the paginated LL response. A no-result
/// answer is cached too; opening the playlist again does not repeat the calls.
#[tauri::command]
pub async fn liked_dates_lookup(
    app: tauri::AppHandle,
    video_ids: Vec<String>,
) -> Result<DateStatus, CommandError> {
    let _guard = LOCK.lock().await;
    let Some(auth) = credentials()? else {
        return Ok(status(None, DateCache::default()));
    };
    let mut cache = load_cache(&app, &auth.channel_id)?;
    let ids = missing_date_ids(&cache, video_ids, now());
    if ids.is_empty() || cache.synced_at == 0 {
        return Ok(status(Some(&auth), cache));
    }
    let generation = GENERATION.load(std::sync::atomic::Ordering::SeqCst);
    // Persist before the token request as well, so authorization failures back off.
    for id in &ids {
        cache.lookup_after.insert(id.clone(), now() + RETRY_DELAY);
    }
    save_cache(&app, &cache)?;
    let client = client()?;
    let tokens = token(
        &client,
        &[
            ("client_id", &auth.client_id),
            ("client_secret", &auth.client_secret),
            ("refresh_token", &auth.refresh_token),
            ("grant_type", "refresh_token"),
        ],
    )
    .await?;
    let total = ids.len();
    for (index, id) in ids.into_iter().enumerate() {
        if generation != GENERATION.load(std::sync::atomic::Ordering::SeqCst) {
            return Err(error("Date lookup cancelled."));
        }
        let response = api(
            &client,
            &tokens.access_token,
            "playlistItems",
            &[
                ("part", "snippet"),
                ("playlistId", &auth.playlist_id),
                ("videoId", &id),
                ("maxResults", "50"),
                (
                    "fields",
                    "nextPageToken,items(snippet(publishedAt,resourceId/videoId))",
                ),
            ],
        )
        .await;
        let response = match response {
            Ok(response) => response,
            Err(error) => {
                save_cache(&app, &cache)?;
                return Err(error);
            }
        };
        let mut found = BTreeMap::new();
        collect_dates(&response, &mut found)?;
        if generation != GENERATION.load(std::sync::atomic::Ordering::SeqCst) {
            return Err(error("Date lookup cancelled."));
        }
        // Exact-ID matches only; never guess dates from titles or other uploads.
        if let Some(date) = found.remove(&id) {
            cache.dates.insert(id.clone(), date);
        }
        cache.lookup_after.insert(id, now() + DAY);
        // Avoid rewriting the entire 5,000-entry snapshot for every song.
        if (index + 1) % 20 == 0 || index + 1 == total {
            save_cache(&app, &cache)?;
        }
        if (index + 1) % 5 == 0 || index + 1 == total {
            let _ = app.emit_to(
                "main",
                "liked-dates-progress",
                serde_json::json!({
                    "checked": index + 1, "total": total,
                }),
            );
        }
    }
    Ok(status(Some(&auth), cache))
}

fn publication_ids(cache: &DateCache, ids: Vec<String>, time: u64) -> Vec<String> {
    let mut seen = HashSet::new();
    ids.into_iter().filter(|id| id.len() == 11
        && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
        && cache.publications.get(id).map_or(true, |date| date.published_at.is_none() && date.retry_after <= time)
        && seen.insert(id.clone())).take(500).collect()
}

fn collect_publications(response: &serde_json::Value, ids: &[String], time: u64)
    -> Result<BTreeMap<String, PublicationDate>, CommandError> {
    let items = response["items"].as_array().ok_or_else(|| error("YouTube returned invalid video dates."))?;
    let mut found = BTreeMap::new();
    for id in ids {
        let published = items.iter().find(|item| item["id"].as_str() == Some(id.as_str()))
            .and_then(|item| item["snippet"]["publishedAt"].as_str())
            .filter(|date| chrono::DateTime::parse_from_rfc3339(date).is_ok()).map(str::to_owned);
        // Successful dates never retry; the timestamp only schedules misses.
        let retry_after = if published.is_some() { 0 } else { time + DAY };
        found.insert(id.clone(), PublicationDate { published_at: published, checked_at: time, retry_after });
    }
    Ok(found)
}

/// Batch video publication metadata; estimates remain separate from exact likes.
#[tauri::command]
pub async fn liked_dates_publications(app: tauri::AppHandle, video_ids: Vec<String>) -> Result<DateStatus, CommandError> {
    let _guard = LOCK.lock().await;
    let Some(auth) = credentials()? else { return Ok(status(None, DateCache::default())); };
    let mut cache = load_cache(&app, &auth.channel_id)?;
    let ids = publication_ids(&cache, video_ids, now());
    if ids.is_empty() || cache.synced_at == 0 { return Ok(status(Some(&auth), cache)); }
    let generation = GENERATION.load(std::sync::atomic::Ordering::SeqCst);
    for id in &ids { cache.publications.entry(id.clone()).or_default().retry_after = now() + RETRY_DELAY; }
    save_cache(&app, &cache)?;
    let client = client()?;
    let tokens = token(&client, &[("client_id", &auth.client_id), ("client_secret", &auth.client_secret),
        ("refresh_token", &auth.refresh_token), ("grant_type", "refresh_token")]).await?;
    for (index, batch) in ids.chunks(50).enumerate() {
        if generation != GENERATION.load(std::sync::atomic::Ordering::SeqCst) { return Err(error("Date lookup cancelled.")); }
        let joined = batch.join(",");
        let response = api(&client, &tokens.access_token, "videos", &[("part", "snippet"),
            ("id", &joined), ("fields", "items(id,snippet/publishedAt)")]).await?;
        let found = collect_publications(&response, batch, now())?;
        if generation != GENERATION.load(std::sync::atomic::Ordering::SeqCst) { return Err(error("Date lookup cancelled.")); }
        cache.publications.extend(found);
        save_cache(&app, &cache)?;
        let _ = app.emit_to("main", "liked-dates-progress", serde_json::json!({
            "checked": ((index + 1) * 50).min(ids.len()), "total": ids.len(), "kind": "publications",
        }));
    }
    Ok(status(Some(&auth), cache))
}

#[tauri::command]
pub async fn liked_dates_sync(app: tauri::AppHandle) -> Result<DateStatus, CommandError> {
    let _guard = LOCK.lock().await;
    let Some(auth) = credentials()? else {
        return Ok(status(None, DateCache::default()));
    };
    let mut cache = load_cache(&app, &auth.channel_id)?;
    if !refresh_due(&cache, now()) {
        return Ok(status(Some(&auth), cache));
    }
    cache.attempted_at = now();
    save_cache(&app, &cache)?; // Backoff survives restart and failed network requests.
    let generation = GENERATION.load(std::sync::atomic::Ordering::SeqCst);
    let client = client()?;
    let tokens = token(
        &client,
        &[
            ("client_id", &auth.client_id),
            ("client_secret", &auth.client_secret),
            ("refresh_token", &auth.refresh_token),
            ("grant_type", "refresh_token"),
        ],
    )
    .await?;
    let mut dates = BTreeMap::new();
    let mut page = String::new();
    let mut seen = HashSet::new();
    // Full pagination also removes unlikes/re-likes made on other devices. Nothing
    // replaces the previous snapshot until every page has succeeded.
    for _ in 0..200 {
        if generation != GENERATION.load(std::sync::atomic::Ordering::SeqCst) {
            return Err(error("Date sync cancelled."));
        }
        let response = api(
            &client,
            &tokens.access_token,
            "playlistItems",
            &[
                ("part", "snippet"),
                ("playlistId", &auth.playlist_id),
                ("maxResults", "50"),
                (
                    "fields",
                    "nextPageToken,items(snippet(publishedAt,resourceId/videoId))",
                ),
                ("pageToken", &page),
            ],
        )
        .await?;
        if generation != GENERATION.load(std::sync::atomic::Ordering::SeqCst) {
            return Err(error("Date sync cancelled."));
        }
        match collect_dates(&response, &mut dates)? {
            Some(next) if seen.insert(next.clone()) => page = next,
            None => {
                cache.dates = dates;
                cache.lookup_after.clear();
                cache.synced_at = now();
                save_cache(&app, &cache)?;
                return Ok(status(Some(&auth), cache));
            }
            _ => break,
        }
    }
    Err(error(
        "YouTube pagination did not finish. The previous date cache has been kept.",
    ))
}

#[tauri::command]
pub async fn liked_dates_disconnect(app: tauri::AppHandle) -> Result<(), CommandError> {
    GENERATION.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    let _guard = LOCK.lock().await;
    remove_cache(&app)?;
    match credential_entry()?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(_) => Err(error(
            "Could not delete Google authorization from the credential store.",
        )),
    }
}

#[tauri::command]
pub async fn liked_dates_invalidate(
    app: tauri::AppHandle,
    video_id: String,
) -> Result<(), CommandError> {
    let _guard = LOCK.lock().await;
    if let Some(auth) = credentials()? {
        let mut cache = load_cache(&app, &auth.channel_id)?;
        cache.dates.remove(&video_id);
        cache.lookup_after.remove(&video_id);
        // Keep refresh timing: batches of likes should not cause a full scan each.
        save_cache(&app, &cache)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn publication_batches_cache_missing_and_valid_dates_separately_from_likes() {
        let ids = vec!["abcdefghijk".into(), "missing0000".into(), "invalid0000".into()];
        let response = serde_json::json!({"items":[
            {"id":"abcdefghijk","snippet":{"publishedAt":"2022-06-01T12:00:00Z"}},
            {"id":"invalid0000","snippet":{"publishedAt":"bad"}}
        ]});
        let result = collect_publications(&response, &ids, DAY).ok().unwrap();
        assert_eq!(result["abcdefghijk"].published_at.as_deref(), Some("2022-06-01T12:00:00Z"));
        assert_eq!(result["abcdefghijk"].retry_after, 0);
        assert!(result["missing0000"].published_at.is_none());
        assert!(result["invalid0000"].published_at.is_none());
        assert_eq!(result["missing0000"].retry_after, 2 * DAY);
        let mut cache = DateCache::default();
        cache.publications = result;
        assert!(publication_ids(&cache, ids.clone(), DAY + 1).is_empty());
        assert_eq!(publication_ids(&cache, ids, 2 * DAY).len(), 2);
        assert!(cache.dates.is_empty());
        assert!(collect_publications(&serde_json::json!({}), &[], DAY).is_err());
    }
    #[test]
    fn publication_dates_survive_snapshot_expiry_and_old_retry_timestamps() {
        let mut cache: DateCache = serde_json::from_value(serde_json::json!({
            "channelId":"a", "syncedAt":86400, "attemptedAt":86400,
            "dates":{"abcdefghijk":"2022-06-01T12:00:00Z"},
            "publications": {
                "abcdefghijk": {"publishedAt":"2022-05-01T12:00:00Z", "checkedAt":86400, "retryAfter":691200},
                "missing0000": {"publishedAt":null, "checkedAt":86400, "retryAfter":172800}
            }
        })).unwrap();
        assert!(publication_ids(&cache, vec!["abcdefghijk".into()], 3650 * DAY).is_empty());
        assert!(expire_cached_dates(&mut cache, 3650 * DAY));
        assert!(cache.dates.is_empty());
        assert_eq!(cache.synced_at, 0);
        assert_eq!(cache.publications.len(), 1);
        assert_eq!(cache.publications["abcdefghijk"].published_at.as_deref(), Some("2022-05-01T12:00:00Z"));
        assert!(!expire_cached_dates(&mut cache, 3651 * DAY));
        assert_eq!(publication_ids(&cache, vec!["abcdefghijk".into(), "missing0000".into()], 3651 * DAY), vec!["missing0000"]);
    }
    #[test]
    fn old_cache_migrates_without_losing_exact_dates() {
        let cache: DateCache = serde_json::from_value(serde_json::json!({
            "channelId":"a", "syncedAt":1, "attemptedAt":1,
            "dates":{"abcdefghijk":"2022-06-01T12:00:00Z"}
        })).unwrap();
        assert_eq!(cache.dates.len(), 1);
        assert!(cache.publications.is_empty());
    }
    #[test]
    fn missing_lookup_skips_known_invalid_duplicate_and_recently_checked_ids() {
        let mut cache = DateCache::default();
        cache
            .dates
            .insert("known000000".into(), "2026-09-23T16:40:17Z".into());
        cache.lookup_after.insert("missing0000".into(), 200);
        let ids = vec![
            "known000000",
            "missing0000",
            "new00000000",
            "new00000000",
            "bad/id00000",
            "short",
        ];
        assert_eq!(
            missing_date_ids(&cache, ids.iter().map(|id| id.to_string()).collect(), 100),
            vec!["new00000000"]
        );
        assert_eq!(
            missing_date_ids(&cache, vec!["missing0000".into()], 200),
            vec!["missing0000"]
        );
    }
    #[test]
    fn expired_or_other_account_dates_cannot_be_reused() {
        let cache = DateCache {
            channel_id: "account-a".into(),
            synced_at: DAY,
            ..Default::default()
        };
        assert!(cache_is_current(&cache, "account-a", DAY + MAX_AGE - 1));
        assert!(!cache_is_current(&cache, "account-a", DAY + MAX_AGE));
        assert!(!cache_is_current(&cache, "account-b", DAY));
        assert!(!cache_is_current(&cache, "account-a", DAY - 1));
    }
    #[test]
    fn disk_snapshot_replaces_existing_file_and_preserves_retry_time() {
        let directory = std::env::temp_dir().join(format!("jamc-date-test-{}", random_string()));
        let path = directory.join("dates.json");
        let mut cache = DateCache {
            channel_id: "account-a".into(),
            synced_at: DAY,
            attempted_at: DAY + 5,
            ..Default::default()
        };
        cache
            .dates
            .insert("abcdefghijk".into(), "2026-09-23T16:40:17Z".into());
        assert!(write_cache(&path, &cache).is_ok());
        cache.dates.clear();
        cache.attempted_at += 10;
        assert!(write_cache(&path, &cache).is_ok());
        let restored: DateCache = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        assert!(restored.dates.is_empty());
        assert_eq!(restored.attempted_at, DAY + 15);
        assert!(!path.with_extension("json.tmp").exists());
        fs::remove_file(path).unwrap();
        fs::remove_dir(directory).unwrap();
    }
    #[test]
    fn reads_added_date_not_video_upload_date() {
        let response = serde_json::json!({"items":[{"snippet":{"publishedAt":"2026-09-23T16:40:17Z","resourceId":{"videoId":"Gqr_IDRALKI"}},"contentDetails":{"videoPublishedAt":"2025-03-24T10:04:09Z"}}],"nextPageToken":"page2"});
        let mut dates = BTreeMap::new();
        assert_eq!(
            collect_dates(&response, &mut dates)
                .ok()
                .unwrap()
                .as_deref(),
            Some("page2")
        );
        assert_eq!(dates["Gqr_IDRALKI"], "2026-09-23T16:40:17Z");
    }
    #[test]
    fn missing_or_invalid_dates_stay_unknown() {
        let response = serde_json::json!({"items":[{"snippet":{"publishedAt":"invalid","resourceId":{"videoId":"Gqr_IDRALKI"}}},{"contentDetails":{"videoPublishedAt":"2025-03-24T10:04:09Z"}}]});
        let mut dates = BTreeMap::new();
        assert!(collect_dates(&response, &mut dates).ok().unwrap().is_none());
        assert!(dates.is_empty());
        assert!(collect_dates(&serde_json::json!({}), &mut dates).is_err());
    }
    #[test]
    fn fresh_cache_and_failed_attempts_do_not_refetch() {
        let mut cache = DateCache::default();
        assert!(refresh_due(&cache, 10 * DAY));
        cache.synced_at = 10 * DAY;
        assert!(!refresh_due(&cache, 10 * DAY + 1));
        assert!(refresh_due(&cache, 11 * DAY));
        cache.attempted_at = 11 * DAY;
        assert!(!refresh_due(&cache, 11 * DAY + RETRY_DELAY - 1));
        assert!(refresh_due(&cache, 11 * DAY + RETRY_DELAY));
    }
    #[test]
    fn callback_requires_matching_state_and_path() {
        assert!(callback_code("/?code=test&state=wrong", "expected").is_none());
        assert!(callback_code("/wrong?code=test&state=expected", "expected").is_none());
        assert!(
            callback_code("/?error=access_denied&state=expected", "expected")
                .unwrap()
                .is_err()
        );
        assert_eq!(
            callback_code("/?code=test&state=expected", "expected")
                .unwrap()
                .ok()
                .as_deref(),
            Some("test")
        );
    }
}
