//! Browser-session fallback. Credentials never cross the frontend IPC boundary.
use super::{cache_error, CommandError, YoutubeCookieJar};
use std::collections::HashSet;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons};

const MAX_COOKIE_BYTES: usize = super::YOUTUBE_COOKIE_CHUNK_SIZE * super::YOUTUBE_COOKIE_MAX_CHUNKS;
const MAX_PAGE_BYTES: usize = 8 * 1024 * 1024;
static IMPORT_ACTIVE: AtomicBool = AtomicBool::new(false);

struct ImportGuard;
impl Drop for ImportGuard {
    fn drop(&mut self) {
        IMPORT_ACTIVE.store(false, Ordering::Release);
    }
}

fn parse_import(raw: &str) -> Result<String, CommandError> {
    // Only a single request Cookie header, never a HAR, curl command or Netscape export.
    if raw.len() > MAX_COOKIE_BYTES + 16
        || raw.bytes().any(|b| !b.is_ascii() || b.is_ascii_control())
    {
        return Err(cache_error(
            "Copy only the single-line Cookie request header value.",
        ));
    }
    let raw = raw.trim();
    let raw = if raw
        .get(..7)
        .is_some_and(|s| s.eq_ignore_ascii_case("cookie:"))
    {
        raw[7..].trim()
    } else {
        raw
    };
    let mut names = HashSet::new();
    let mut pairs = Vec::new();
    let mut authenticated = false;
    for part in raw.split(';') {
        let (name, value) = part
            .trim()
            .split_once('=')
            .ok_or_else(|| cache_error("Clipboard does not contain a Cookie request header."))?;
        if name.is_empty()
            || !name
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"!#$%&'*+-.^_`|~".contains(&b))
            || !value.bytes().all(|b| {
                b == 0x21
                    || (0x23..=0x2b).contains(&b)
                    || (0x2d..=0x3a).contains(&b)
                    || (0x3c..=0x5b).contains(&b)
                    || (0x5d..=0x7e).contains(&b)
            })
            || [
                "domain", "path", "expires", "max-age", "samesite", "httponly", "secure",
            ]
            .contains(&name.to_ascii_lowercase().as_str())
            || !names.insert(name)
        {
            return Err(cache_error(
                "The Cookie header is malformed or contains duplicate names.",
            ));
        }
        authenticated |= matches!(name, "SAPISID" | "__Secure-1PAPISID" | "__Secure-3PAPISID")
            && !value.is_empty();
        pairs.push(format!("{name}={value}"));
    }
    if !authenticated {
        return Err(cache_error("No signed-in session found. Copy the header from a signed-in music.youtube.com request."));
    }
    let normalized = pairs.join("; ");
    if normalized.len() > MAX_COOKIE_BYTES {
        return Err(cache_error(
            "The browser session is too large for secure storage.",
        ));
    }
    Ok(normalized)
}

#[cfg(target_os = "windows")]
fn take_clipboard_session() -> Result<String, CommandError> {
    use windows::Win32::Foundation::HGLOBAL;
    use windows::Win32::System::DataExchange::{
        CloseClipboard, EmptyClipboard, GetClipboardData, OpenClipboard,
    };
    use windows::Win32::System::Memory::{GlobalLock, GlobalSize, GlobalUnlock};

    struct Clipboard;
    impl Drop for Clipboard {
        fn drop(&mut self) {
            unsafe {
                let _ = CloseClipboard();
            }
        }
    }
    struct Locked(HGLOBAL);
    impl Drop for Locked {
        fn drop(&mut self) {
            unsafe {
                let _ = GlobalUnlock(self.0);
            }
        }
    }
    // The OS owns this memory. Copy while locked, bound the allocation, and unlock
    // before EmptyClipboard. The clipboard stays open throughout, avoiding a race
    // that could clear unrelated content copied after the session.
    unsafe {
        OpenClipboard(None).map_err(|_| cache_error("Clipboard is busy. Try importing again."))?;
        let _clipboard = Clipboard;
        let handle = GetClipboardData(13) // CF_UNICODETEXT
            .map_err(|_| cache_error("Clipboard has no text. Copy the Cookie header first."))?;
        let global = HGLOBAL(handle.0);
        let size = GlobalSize(global);
        if size < 2 || size > 64 * 1024 || size % 2 != 0 {
            return Err(cache_error("Clipboard text is missing or too large."));
        }
        let pointer = GlobalLock(global);
        if pointer.is_null() {
            return Err(cache_error("Unable to read clipboard text."));
        }
        let locked = Locked(global);
        let units = std::slice::from_raw_parts(pointer.cast::<u16>(), size / 2);
        let end = units
            .iter()
            .position(|unit| *unit == 0)
            .ok_or_else(|| cache_error("Clipboard text is not terminated correctly."))?;
        let raw = String::from_utf16(&units[..end])
            .map_err(|_| cache_error("Clipboard text is invalid."))?;
        let session = parse_import(&raw)?;
        drop(locked);
        // Invalid/unrelated content is never cleared. History/cloud copies cannot
        // be erased here; the UI warns the user before copying credentials.
        EmptyClipboard()
            .map_err(|_| cache_error("Unable to clear the clipboard; import cancelled."))?;
        Ok(session)
    }
}

#[cfg(not(target_os = "windows"))]
fn take_clipboard_session() -> Result<String, CommandError> {
    Err(cache_error(
        "Browser-session import is currently available on Windows only.",
    ))
}

fn page_is_signed_in(html: &str) -> bool {
    // Parse JSON only; never execute downloaded JavaScript. Require the explicit
    // first-party config flag, not an occurrence of LOGGED_IN in arbitrary text.
    html.split("ytcfg.set(").skip(1).any(|tail| {
        let mut stream = serde_json::Deserializer::from_str(tail).into_iter::<serde_json::Value>();
        matches!(stream.next(), Some(Ok(value)) if value.get("LOGGED_IN").and_then(|v| v.as_bool()) == Some(true))
    })
}

async fn validate_session(cookie: &str) -> Result<(), CommandError> {
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(25))
        .build()
        .map_err(|_| cache_error("Unable to prepare session validation."))?;
    let mut response = client.get("https://music.youtube.com/")
        .header(reqwest::header::COOKIE, cookie)
        .header(reqwest::header::USER_AGENT, "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36")
        .send().await.map_err(|_| cache_error("YouTube Music session validation could not connect. Copy the header again and retry."))?;
    if !response.status().is_success() {
        return Err(cache_error(
            "YouTube Music did not accept the session validation request. No session was saved.",
        ));
    }
    let mut body = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| cache_error("Session validation response was interrupted."))?
    {
        if body.len() + chunk.len() > MAX_PAGE_BYTES {
            return Err(cache_error(
                "Session validation response exceeded the size limit.",
            ));
        }
        body.extend_from_slice(&chunk);
    }
    let html = std::str::from_utf8(&body)
        .map_err(|_| cache_error("Session validation response was invalid."))?;
    if !page_is_signed_in(html) {
        return Err(cache_error("YouTube Music did not confirm a signed-in session. No session was saved. Verify the browser is signed in, then copy a fresh Cookie request header."));
    }
    Ok(())
}

#[tauri::command]
pub(super) async fn import_browser_session(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    jar: tauri::State<'_, YoutubeCookieJar>,
) -> Result<bool, CommandError> {
    if window.label() != "main" {
        return Err(cache_error(
            "Session import is restricted to the main window.",
        ));
    }
    if IMPORT_ACTIVE.swap(true, Ordering::AcqRel) {
        return Err(cache_error(
            "A browser-session import is already in progress.",
        ));
    }
    let _import_guard = ImportGuard;
    if jar
        .0
        .lock()
        .map_err(|_| cache_error("Session storage is busy."))?
        .cookie
        .is_some()
    {
        return Err(cache_error(
            "Sign out of the existing app session before importing another.",
        ));
    }
    let approved = app.dialog()
        .message("Import the YouTube Music session from your clipboard? Use a disposable account only. The backend will read and clear the current clipboard, verify the session with YouTube Music, and save it in Windows Credential Manager. Clipboard history or synced copies must be cleared separately.")
        .title("Import browser session")
        .buttons(MessageDialogButtons::YesNo)
        .blocking_show();
    if !approved {
        return Err(cache_error("Browser-session import cancelled."));
    }
    let cookie = take_clipboard_session()?;
    eprintln!("[internal][tauri][info] browser_session_import validation started");
    validate_session(&cookie).await?;
    // Do not replace an already-connected session through this recovery flow.
    let mut state = jar
        .0
        .lock()
        .map_err(|_| cache_error("Session storage is busy."))?;
    if state.cookie.is_some() {
        return Err(cache_error(
            "Sign out of the existing app session before importing another.",
        ));
    }
    super::save_youtube_music_cookie(&app, &cookie)
        .map_err(|_| cache_error("Could not save the session in the system credential store."))?;
    state.cookie = Some(cookie);
    state.persisted_at = Some(Instant::now());
    eprintln!("[internal][tauri][info] browser_session_import saved verified session");
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn import_accepts_only_bounded_single_line_headers() {
        assert!(parse_import("Cookie: SAPISID=synthetic; PREF=test").is_ok());
        assert!(parse_import("__Secure-3PAPISID=synthetic").is_ok());
        for invalid in [
            "",
            "PREF=test",
            "SAPISID=",
            "SAPISID=synthetic\r\nHost: evil.test",
            "SAPISID=synthetic; SAPISID=duplicate",
            "SAPISID=synthetic; Domain=.youtube.com",
            "SAPISID=non ascii é",
            "curl https://music.youtube.com",
            "SAPISID=synthetic; invalid",
        ] {
            assert!(parse_import(invalid).is_err());
        }
        assert!(parse_import(&format!("SAPISID={}", "x".repeat(MAX_COOKIE_BYTES))).is_err());
    }
    #[test]
    fn validation_requires_explicit_signed_in_config() {
        assert!(page_is_signed_in(
            "<script>ytcfg.set({\"LOGGED_IN\":true});</script>"
        ));
        assert!(page_is_signed_in(
            "ytcfg.set({\"a\":1});ytcfg.set({\"LOGGED_IN\":true});"
        ));
        for html in [
            "",
            "\"LOGGED_IN\":true",
            "ytcfg.set({\"LOGGED_IN\":false});",
            "ytcfg.set({\"LOGGED_IN\":\"true\"});",
            "ytcfg.set({broken",
            "ytcfg.set({\"nested\":{\"LOGGED_IN\":true}});",
        ] {
            assert!(!page_is_signed_in(html));
        }
    }
}
