//! End-user session management UI for the ReyDesk helper.
//!
//! Provides two Windows-native windows:
//! 1. **Consent window** — branded three-button consent prompt
//! 2. **Session window** — chat panel, disconnect, and session controls

#[cfg(target_os = "windows")]
pub mod windows_ui {
    use super::super::*;
    use std::sync::atomic::{AtomicPtr, Ordering};
    use std::sync::Once;
    use windows::Win32::Graphics::Gdi::{GetSysColorBrush, COLOR_WINDOW};
    use windows::Win32::UI::WindowsAndMessaging::*;
    use windows::core::PCWSTR;

    // ── Consent window ──────────────────────────────────────────────────

    const IDC_ALLOW: i32 = 3001;
    const IDC_LIMITED: i32 = 3002;
    const IDC_DENY: i32 = 3003;

    static CONSENT_RESULT: AtomicPtr<ConsentDecision> = AtomicPtr::new(std::ptr::null_mut());

    unsafe extern "system" fn consent_proc(
        hwnd: HWND,
        msg: u32,
        wparam: WPARAM,
        lparam: LPARAM,
    ) -> LRESULT {
        match msg {
            WM_COMMAND => {
                let id = (wparam.0 & 0xFFFF) as i32;
                match id {
                    IDC_ALLOW => {
                        let ptr = CONSENT_RESULT.load(Ordering::SeqCst);
                        if !ptr.is_null() {
                            *ptr = ConsentDecision::Granted;
                        }
                        DestroyWindow(hwnd).ok();
                    }
                    IDC_LIMITED => {
                        let ptr = CONSENT_RESULT.load(Ordering::SeqCst);
                        if !ptr.is_null() {
                            *ptr = ConsentDecision::GrantedWithoutElevation(Vec::new());
                        }
                        DestroyWindow(hwnd).ok();
                    }
                    IDC_DENY => {
                        let ptr = CONSENT_RESULT.load(Ordering::SeqCst);
                        if !ptr.is_null() {
                            *ptr = ConsentDecision::Denied;
                        }
                        DestroyWindow(hwnd).ok();
                    }
                    _ => return DefWindowProcW(hwnd, msg, wparam, lparam),
                }
                LRESULT(0)
            }
            WM_CLOSE => {
                let ptr = CONSENT_RESULT.load(Ordering::SeqCst);
                if !ptr.is_null() {
                    (*ptr) = ConsentDecision::Denied;
                }
                DestroyWindow(hwnd).ok();
                LRESULT(0)
            }
            WM_DESTROY => {
                PostQuitMessage(0);
                LRESULT(0)
            }
            _ => DefWindowProcW(hwnd, msg, wparam, lparam),
        }
    }

    /// Show a branded consent window and return the user's decision.
    pub fn show_consent_window(session: &AgentSession) -> Result<ConsentDecision> {
        unsafe {
            let mut decision = ConsentDecision::Denied;
            let decision_ptr: *mut ConsentDecision = &mut decision;
            CONSENT_RESULT.store(decision_ptr, Ordering::SeqCst);

            let class_name = tray_wide("ReyDeskConsentV2");
            static REGISTER: Once = Once::new();
            REGISTER.call_once(|| {
                let cursor = LoadCursorW(None, IDC_ARROW).unwrap_or_default();
                let class = WNDCLASSW {
                    lpfnWndProc: Some(consent_proc),
                    lpszClassName: PCWSTR(class_name.as_ptr()),
                    hCursor: cursor,
                    hbrBackground: GetSysColorBrush(COLOR_WINDOW),
                    ..Default::default()
                };
                RegisterClassW(&class);
            });

            let w: i32 = 460;
            let h: i32 = 400;
            let screen_w = GetSystemMetrics(SM_CXVIRTUALSCREEN);
            let screen_h = GetSystemMetrics(SM_CYVIRTUALSCREEN);
            let x = (screen_w - w) / 2;
            let y = (screen_h - h) / 2;

            let title = tray_wide("ReyDesk Remote Support");
            let hwnd = CreateWindowExW(
                WINDOW_EX_STYLE::default(),
                PCWSTR(class_name.as_ptr()),
                PCWSTR(title.as_ptr()),
                WS_OVERLAPPED | WS_CAPTION | WS_SYSMENU | WS_VISIBLE,
                x, y, w, h,
                None, None, None, None,
            );
            if hwnd.0 == 0 {
                return Ok(ConsentDecision::Denied);
            }

            let static_class = tray_wide("STATIC");
            let button_class = tray_wide("BUTTON");

            // Branding header
            CreateWindowExW(
                WINDOW_EX_STYLE::default(),
                PCWSTR(static_class.as_ptr()),
                PCWSTR(tray_wide("ReyDesk").as_ptr()),
                WS_CHILD | WS_VISIBLE,
                28, 16, 200, 22,
                hwnd, None, None, None,
            );

            // Description
            CreateWindowExW(
                WINDOW_EX_STYLE::default(),
                PCWSTR(static_class.as_ptr()),
                PCWSTR(tray_wide("A technician is requesting remote access to your computer. Review the details below and decide whether to allow this session.").as_ptr()),
                WS_CHILD | WS_VISIBLE,
                28, 44, 400, 40,
                hwnd, None, None, None,
            );

            // Reason
            let reason_label = format!(
                "Reason: {}",
                if session.reason.is_empty() { "Not provided" } else { &session.reason }
            );
            CreateWindowExW(
                WINDOW_EX_STYLE::default(),
                PCWSTR(static_class.as_ptr()),
                PCWSTR(tray_wide(&reason_label).as_ptr()),
                WS_CHILD | WS_VISIBLE,
                28, 90, 400, 20,
                hwnd, None, None, None,
            );

            // Permissions header
            CreateWindowExW(
                WINDOW_EX_STYLE::default(),
                PCWSTR(static_class.as_ptr()),
                PCWSTR(tray_wide("Requested permissions:").as_ptr()),
                WS_CHILD | WS_VISIBLE,
                28, 118, 400, 20,
                hwnd, None, None, None,
            );

            // Permission list
            let mut y_offset = 142i32;
            let perm_names: Vec<(&str, &str)> = session.permissions.iter().map(|p| match p.as_str() {
                "view_screen" => ("view_screen", "View screen"),
                "control_input" => ("control_input", "Control keyboard & mouse"),
                "clipboard" => ("clipboard", "Clipboard access"),
                "terminal" => ("terminal", "Terminal access (elevated)"),
                "elevation" => ("elevation", "Elevation privileges"),
                "file_transfer" => ("file_transfer", "File transfer"),
                "system_manage" => ("system_manage", "Process/service management (elevated)"),
                other => (other, other),
            }).collect();

            for (key, label) in &perm_names {
                let icon = if is_elevated_permission(key) { "!" } else { "+" };
                let perm_text = format!("{icon}  {label}");
                CreateWindowExW(
                    WINDOW_EX_STYLE::default(),
                    PCWSTR(static_class.as_ptr()),
                    PCWSTR(tray_wide(&perm_text).as_ptr()),
                    WS_CHILD | WS_VISIBLE,
                    42, y_offset, 380, 18,
                    hwnd, None, None, None,
                );
                y_offset += 20;
            }

            // Buttons
            let btn_y = h - 80;
            let has_elevation = session.permissions.iter().any(|p| is_elevated_permission(p));

            CreateWindowExW(
                WINDOW_EX_STYLE::default(),
                PCWSTR(button_class.as_ptr()),
                PCWSTR(tray_wide("Allow").as_ptr()),
                WS_CHILD | WS_VISIBLE | WS_TABSTOP,
                28, btn_y, if has_elevation { 120 } else { 190 }, 34,
                hwnd, HMENU(IDC_ALLOW as isize), None, None,
            );

            if has_elevation {
                CreateWindowExW(
                    WINDOW_EX_STYLE::default(),
                    PCWSTR(button_class.as_ptr()),
                    PCWSTR(tray_wide("Allow (no elevated)").as_ptr()),
                    WS_CHILD | WS_VISIBLE | WS_TABSTOP,
                    158, btn_y, 150, 34,
                    hwnd, HMENU(IDC_LIMITED as isize), None, None,
                );
            }

            let deny_x = if has_elevation { 318 } else { 228 };
            let deny_w = if has_elevation { 114 } else { 190 };
            CreateWindowExW(
                WINDOW_EX_STYLE::default(),
                PCWSTR(button_class.as_ptr()),
                PCWSTR(tray_wide("Deny").as_ptr()),
                WS_CHILD | WS_VISIBLE | WS_TABSTOP,
                deny_x, btn_y, deny_w, 34,
                hwnd, HMENU(IDC_DENY as isize), None, None,
            );

            // Message loop
            let mut msg = MSG::default();
            loop {
                if GetMessageW(&mut msg, None, 0, 0).0 <= 0 { break; }
                TranslateMessage(&msg);
                DispatchMessageW(&msg);
            }

            CONSENT_RESULT.store(std::ptr::null_mut(), Ordering::SeqCst);

            match &decision {
                ConsentDecision::GrantedWithoutElevation(_) => {
                    let reduced: Vec<String> = session.permissions.iter()
                        .filter(|p| !is_elevated_permission(p.as_str()))
                        .cloned().collect();
                    Ok(ConsentDecision::GrantedWithoutElevation(reduced))
                }
                other => Ok(other.clone()),
            }
        }
    }

    // ── Session management window ───────────────────────────────────────

    const IDC_MSG_INPUT: i32 = 4001;
    const IDC_MSG_SEND: i32 = 4002;
    const IDC_DISCONNECT: i32 = 4003;
    const IDC_CHAT_LOG: i32 = 4004;
    const IDC_STATUS: i32 = 4005;
    const TIMER_POLL_INBOX: usize = 1;

    struct SessionWindow {
        session_id: String,
        last_message_count: usize,
        chat_dir: std::path::PathBuf,
    }

    static SESSION_STATE: AtomicPtr<SessionWindow> = AtomicPtr::new(std::ptr::null_mut());

    fn session_chat_dir() -> std::path::PathBuf {
        let program_data = std::env::var("ProgramData")
            .ok()
            .filter(|v| !v.trim().is_empty())
            .unwrap_or_else(|| "C:\\ProgramData".to_owned());
        std::path::PathBuf::from(program_data).join("ReyDesk").join("chat")
    }

    fn count_chat_files(dir: &std::path::Path, session_id: &str) -> usize {
        let mut count = 0;
        if let Ok(entries) = std::fs::read_dir(dir) {
            let prefix_inbox = format!("{session_id}.inbox.");
            let prefix_outbox = format!("{session_id}.outbox.");
            for entry in entries.flatten() {
                let name = entry.file_name().to_string_lossy().into_owned();
                if (name.starts_with(&prefix_inbox) || name.starts_with(&prefix_outbox)) && name.ends_with(".json") {
                    count += 1;
                }
            }
        }
        count
    }

    fn build_chat_text(dir: &std::path::Path, session_id: &str) -> String {
        let mut messages: Vec<(String, String)> = Vec::new();
        if let Ok(entries) = std::fs::read_dir(dir) {
            for entry in entries.flatten() {
                let name = entry.file_name().to_string_lossy().into_owned();
                let is_inbox = name.starts_with(&format!("{session_id}.inbox.")) && name.ends_with(".json");
                let is_outbox = name.starts_with(&format!("{session_id}.outbox.")) && name.ends_with(".json");
                if !is_inbox && !is_outbox { continue; }
                if let Ok(contents) = std::fs::read(entry.path()) {
                    if let Ok(value) = serde_json::from_slice::<serde_json::Value>(&contents) {
                        if let Some(body) = value.get("body").and_then(|b| b.as_str()) {
                            let sender = if is_inbox { "Technician" } else { "You" };
                            let stamp = name.split('.').nth(2).unwrap_or("0").to_owned();
                            messages.push((stamp, format!("{sender}: {body}")));
                        }
                    }
                }
            }
        }
        messages.sort_by_key(|(stamp, _)| stamp.clone());
        if messages.is_empty() {
            "No messages yet. The technician will appear here when connected.".to_owned()
        } else {
            messages.into_iter().map(|(_, text)| text).collect::<Vec<_>>().join("\r\n")
        }
    }

    unsafe extern "system" fn session_proc(
        hwnd: HWND,
        msg: u32,
        wparam: WPARAM,
        lparam: LPARAM,
    ) -> LRESULT {
        match msg {
            WM_TIMER => {
                if wparam.0 == TIMER_POLL_INBOX {
                    let state = SESSION_STATE.load(Ordering::SeqCst);
                    if !state.is_null() {
                        let count = count_chat_files(&(*state).chat_dir, &(*state).session_id);
                        if count != (*state).last_message_count {
                            (*state).last_message_count = count;
                            let log_hwnd = GetDlgItem(hwnd, IDC_CHAT_LOG);
                            if log_hwnd.0 != 0 {
                                let text = build_chat_text(&(*state).chat_dir, &(*state).session_id);
                                SetWindowTextW(log_hwnd, PCWSTR(tray_wide(&text).as_ptr()));
                            }
                        }
                    }
                }
                LRESULT(0)
            }
            WM_COMMAND => {
                let id = (wparam.0 & 0xFFFF) as i32;
                match id {
                    IDC_MSG_SEND => {
                        let state = SESSION_STATE.load(Ordering::SeqCst);
                        if !state.is_null() {
                            let input = GetDlgItem(hwnd, IDC_MSG_INPUT);
                            let mut buf = [0u16; 2048];
                            let len = GetWindowTextW(input, &mut buf);
                            let text = String::from_utf16_lossy(&buf[..len as usize]);
                            let trimmed = text.trim().to_owned();
                            if !trimmed.is_empty() {
                                let dir = &(*state).chat_dir;
                                let _ = std::fs::create_dir_all(dir);
                                let stamp = std::time::SystemTime::now()
                                    .duration_since(std::time::UNIX_EPOCH)
                                    .map(|d| d.as_nanos())
                                    .unwrap_or(0);
                                let path = dir.join(format!("{}.outbox.{}.json", (*state).session_id, stamp));
                                let _ = std::fs::write(&path, serde_json::json!({ "body": trimmed }).to_string());
                                SetWindowTextW(input, PCWSTR(tray_wide("").as_ptr()));
                                // Force immediate poll
                                let count = count_chat_files(&(*state).chat_dir, &(*state).session_id);
                                (*state).last_message_count = count;
                                let log_hwnd = GetDlgItem(hwnd, IDC_CHAT_LOG);
                                if log_hwnd.0 != 0 {
                                    let text = build_chat_text(&(*state).chat_dir, &(*state).session_id);
                                    SetWindowTextW(log_hwnd, PCWSTR(tray_wide(&text).as_ptr()));
                                }
                            }
                        }
                        LRESULT(0)
                    }
                    IDC_DISCONNECT => {
                        DestroyWindow(hwnd).ok();
                        LRESULT(0)
                    }
                    _ => return DefWindowProcW(hwnd, msg, wparam, lparam),
                }
            }
            WM_CLOSE => {
                DestroyWindow(hwnd).ok();
                LRESULT(0)
            }
            WM_DESTROY => {
                let state = SESSION_STATE.load(Ordering::SeqCst);
                if !state.is_null() {
                    let _ = Box::from_raw(state);
                    SESSION_STATE.store(std::ptr::null_mut(), Ordering::SeqCst);
                }
                KillTimer(hwnd, TIMER_POLL_INBOX).ok();
                PostQuitMessage(0);
                LRESULT(0)
            }
            _ => DefWindowProcW(hwnd, msg, wparam, lparam),
        }
    }

    /// Show the session management window. Returns when the user closes it.
    pub fn run_session_window(session_id: &str) -> Result<()> {
        unsafe {
            let chat_dir = session_chat_dir();
            let state = Box::into_raw(Box::new(SessionWindow {
                session_id: session_id.to_owned(),
                last_message_count: 0,
                chat_dir: chat_dir.clone(),
            }));
            SESSION_STATE.store(state, Ordering::SeqCst);

            let class_name = tray_wide("ReyDeskSessionV2");
            static REGISTER: Once = Once::new();
            REGISTER.call_once(|| {
                let cursor = LoadCursorW(None, IDC_ARROW).unwrap_or_default();
                let class = WNDCLASSW {
                    lpfnWndProc: Some(session_proc),
                    lpszClassName: PCWSTR(class_name.as_ptr()),
                    hCursor: cursor,
                    hbrBackground: GetSysColorBrush(COLOR_WINDOW),
                    ..Default::default()
                };
                RegisterClassW(&class);
            });

            let screen_w = GetSystemMetrics(SM_CXVIRTUALSCREEN);
            let screen_h = GetSystemMetrics(SM_CYVIRTUALSCREEN);
            let w = 480i32;
            let h = 520i32;
            let x = (screen_w - w) / 2;
            let y = (screen_h - h) / 2;

            let title = tray_wide("ReyDesk Support Session");
            let hwnd = CreateWindowExW(
                WINDOW_EX_STYLE::default(),
                PCWSTR(class_name.as_ptr()),
                PCWSTR(title.as_ptr()),
                WS_OVERLAPPED | WS_CAPTION | WS_SYSMENU | WS_VISIBLE,
                x, y, w, h,
                None, None, None, None,
            );
            if hwnd.0 == 0 {
                return Err(anyhow!("failed to create session window"));
            }

            let static_class = tray_wide("STATIC");
            let button_class = tray_wide("BUTTON");
            let edit_class = tray_wide("EDIT");

            // Status label
            CreateWindowExW(
                WINDOW_EX_STYLE::default(),
                PCWSTR(static_class.as_ptr()),
                PCWSTR(tray_wide("Connected — Secure session active").as_ptr()),
                WS_CHILD | WS_VISIBLE,
                20, 14, 440, 20,
                hwnd, HMENU(IDC_STATUS as isize), None, None,
            );

            // Chat log (read-only multiline edit)
            let style = WS_CHILD | WS_VISIBLE | WS_VSCROLL
                | WINDOW_STYLE(0x0004) // ES_MULTILINE
                | WINDOW_STYLE(0x0020) // ES_AUTOVSCROLL
                | WINDOW_STYLE(0x0800); // ES_READONLY
            CreateWindowExW(
                WINDOW_EX_STYLE::default(),
                PCWSTR(edit_class.as_ptr()),
                PCWSTR(tray_wide("No messages yet. The technician will appear here when connected.").as_ptr()),
                style,
                20, 40, 440, 330,
                hwnd, HMENU(IDC_CHAT_LOG as isize), None, None,
            );

            // Message input
            CreateWindowExW(
                WINDOW_EX_STYLE::default(),
                PCWSTR(edit_class.as_ptr()),
                PCWSTR::null(),
                WS_CHILD | WS_VISIBLE | WS_TABSTOP,
                20, 382, 330, 28,
                hwnd, HMENU(IDC_MSG_INPUT as isize), None, None,
            );

            // Send button
            CreateWindowExW(
                WINDOW_EX_STYLE::default(),
                PCWSTR(button_class.as_ptr()),
                PCWSTR(tray_wide("Send").as_ptr()),
                WS_CHILD | WS_VISIBLE | WS_TABSTOP,
                358, 382, 102, 28,
                hwnd, HMENU(IDC_MSG_SEND as isize), None, None,
            );

            // Disconnect button
            CreateWindowExW(
                WINDOW_EX_STYLE::default(),
                PCWSTR(button_class.as_ptr()),
                PCWSTR(tray_wide("Disconnect").as_ptr()),
                WS_CHILD | WS_VISIBLE | WS_TABSTOP,
                150, 440, 180, 34,
                hwnd, HMENU(IDC_DISCONNECT as isize), None, None,
            );

            // Start polling timer
            SetTimer(hwnd, TIMER_POLL_INBOX, 1000, None);

            // Message loop
            let mut msg = MSG::default();
            loop {
                if GetMessageW(&mut msg, None, 0, 0).0 <= 0 { break; }
                TranslateMessage(&msg);
                DispatchMessageW(&msg);
            }

            Ok(())
        }
    }
}
