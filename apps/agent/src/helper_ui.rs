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
    use windows::Win32::Graphics::Gdi::{CreateSolidBrush, GetMonitorInfoW, GetSysColorBrush, MonitorFromPoint, SetBkMode, SetTextColor, COLOR_WINDOW, MONITORINFO, TRANSPARENT};
    use windows::Win32::Foundation::COLORREF;
    use windows::Win32::UI::Shell::{NIF_ICON, NIF_MESSAGE, NIF_TIP, NIM_ADD, NIM_DELETE, NIM_MODIFY, NOTIFYICONDATAW, Shell_NotifyIconW};
    use windows::Win32::UI::WindowsAndMessaging::*;
    use windows::core::PCWSTR;

    // ── Window placement ────────────────────────────────────────────────

    /// Work area of the monitor that currently contains the mouse pointer,
    /// falling back to the primary monitor when the pointer cannot be read.
    /// Returns (x, y, width, height).
    fn focused_monitor_work_area() -> (i32, i32, i32, i32) {
        unsafe {
            let mut point = POINT::default();
            GetCursorPos(&mut point).ok();
            let monitor = MonitorFromPoint(point, windows::Win32::Graphics::Gdi::MONITOR_DEFAULTTONEAREST);
            let mut info = MONITORINFO {
                cbSize: std::mem::size_of::<MONITORINFO>() as u32,
                ..Default::default()
            };
            if GetMonitorInfoW(monitor, &mut info).as_bool() {
                let area = info.rcWork;
                return (area.left, area.top, area.right - area.left, area.bottom - area.top);
            }
            // Fallback: primary screen metrics.
            let w = GetSystemMetrics(SM_CXSCREEN);
            let h = GetSystemMetrics(SM_CYSCREEN);
            (0, 0, w, h)
        }
    }

    /// Center a window of the given size inside the monitor under the cursor,
    /// so it never straddles the bezel between two monitors.
    fn center_on_focused_monitor(w: i32, h: i32) -> (i32, i32) {
        let (mx, my, mw, mh) = focused_monitor_work_area();
        (mx + (mw - w) / 2, my + (mh - h) / 2)
    }

    // ── Consent window ──────────────────────────────────────────────────

    const IDC_ALLOW: i32 = 3001;
    const IDC_LIMITED: i32 = 3002;
    const IDC_DENY: i32 = 3003;
    const IDC_CONSENT_BRAND: i32 = 3004;

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
            WM_CTLCOLORSTATIC => {
                let hdc = windows::Win32::Graphics::Gdi::HDC(wparam.0 as isize);
                SetBkMode(hdc, TRANSPARENT);
                if GetDlgItem(hwnd, IDC_CONSENT_BRAND) == HWND(lparam.0) {
                    SetTextColor(hdc, COLORREF(BRAND_RGB));
                } else {
                    SetTextColor(hdc, COLORREF(0x00A0A0A0));
                }
                LRESULT(GetSysColorBrush(COLOR_WINDOW).0 as isize)
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
            let (x, y) = center_on_focused_monitor(w, h);

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
                hwnd, HMENU(IDC_CONSENT_BRAND as isize), None, None,
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
    const IDC_FILES: i32 = 4007;
    const IDC_CHAT_LOG: i32 = 4004;
    const IDC_STATUS: i32 = 4005;
    const IDC_BRAND: i32 = 4006;
    const BRAND_RGB: u32 = 0x003DA3E8; // ReyDesk amber: #E8A33D in Windows COLORREF order
    const TIMER_POLL_INBOX: usize = 1;

    const IDM_TRAY_OPEN: i32 = 4101;
    const IDM_TRAY_DISCONNECT: i32 = 4102;
    const IDM_TRAY_EXIT: i32 = 4103;
    const WM_TRAY_CALLBACK: u32 = WM_APP + 1;
    const TRAY_ID: u32 = 0x5245; // "RE"

    struct SessionWindow {
        session_id: String,
        last_message_count: usize,
        chat_dir: std::path::PathBuf,
    }

    static SESSION_STATE: AtomicPtr<SessionWindow> = AtomicPtr::new(std::ptr::null_mut());

    /// Sender used to stop the agent when the end user closes the session
    /// window (Disconnect / Exit / X). The Rust/async agent half is started
    /// by run_helper_native, which also owns the receiver.
    static SESSION_SHUTDOWN: AtomicPtr<tokio::sync::mpsc::UnboundedSender<()>> = AtomicPtr::new(std::ptr::null_mut());

    pub fn set_session_shutdown(sender: tokio::sync::mpsc::UnboundedSender<()>) {
        let ptr = Box::into_raw(Box::new(sender));
        let old = SESSION_SHUTDOWN.swap(ptr, std::sync::atomic::Ordering::SeqCst);
        if !old.is_null() {
            // SAFETY: only swapped here; the box was allocated here.
            unsafe {
                drop(Box::from_raw(old));
            }
        }
    }

    fn trigger_session_shutdown() {
        let ptr = SESSION_SHUTDOWN.load(std::sync::atomic::Ordering::SeqCst);
        if !ptr.is_null() {
            // SAFETY: the box is only freed by set_session_shutdown, which is
            // never called again after the window is running.
            unsafe {
                let _ = (*ptr).send(());
            }
        }
    }

    static SESSION_WINDOW_HWND: AtomicPtr<std::ffi::c_void> = AtomicPtr::new(std::ptr::null_mut());

    /// Ask the session window to close (used when the technician ends the
    /// session and the agent is winding down).
    pub fn close_session_window() {
        let ptr = SESSION_WINDOW_HWND.load(std::sync::atomic::Ordering::SeqCst);
        if !ptr.is_null() {
            // SAFETY: the HWND is only stored while the window is alive; the
            // destroy path clears it before the window is freed.
            unsafe {
                let _ = PostMessageW(HWND(ptr as isize), WM_CLOSE, WPARAM(0), LPARAM(0));
            }
        }
    }

    fn build_tray_data(hwnd: HWND, tooltip: &str) -> NOTIFYICONDATAW {
        let mut data = NOTIFYICONDATAW::default();
        data.cbSize = std::mem::size_of::<NOTIFYICONDATAW>() as u32;
        data.hWnd = hwnd;
        data.uID = TRAY_ID;
        data.uFlags = NIF_ICON | NIF_MESSAGE | NIF_TIP;
        data.uCallbackMessage = WM_TRAY_CALLBACK;
        // SAFETY: LoadIconW is safe to call with a null instance handle.
        data.hIcon = unsafe { LoadIconW(None, IDI_APPLICATION).unwrap_or_default() };
        for (slot, unit) in data.szTip.iter_mut().zip(tooltip.encode_utf16().chain(std::iter::once(0))) {
            *slot = unit;
        }
        data
    }

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
            WM_TRAY_CALLBACK => {
                let action = (lparam.0 as u32) & 0xFFFF;
                match action {
                    WM_LBUTTONDBLCLK | WM_LBUTTONUP => {
                        ShowWindow(hwnd, SW_SHOW).ok();
                        SetForegroundWindow(hwnd);
                    }
                    WM_RBUTTONUP | WM_CONTEXTMENU => {
                        let menu = CreatePopupMenu().unwrap_or_default();
                        let state = SESSION_STATE.load(Ordering::SeqCst);
                        let status_text = if !state.is_null() && (*state).last_message_count > 0 {
                            "Session active — messages received".to_owned()
                        } else {
                            "Session active — waiting for technician".to_owned()
                        };
                        AppendMenuW(menu, MF_GRAYED | MF_STRING, 0, PCWSTR(tray_wide(&status_text).as_ptr()));
                        AppendMenuW(menu, MF_SEPARATOR, 0, PCWSTR::null());
                        AppendMenuW(menu, MF_STRING, IDM_TRAY_OPEN as usize, PCWSTR(tray_wide("Open session window").as_ptr()));
                        AppendMenuW(menu, MF_STRING, IDM_TRAY_DISCONNECT as usize, PCWSTR(tray_wide("Disconnect").as_ptr()));
                        AppendMenuW(menu, MF_STRING, IDM_TRAY_EXIT as usize, PCWSTR(tray_wide("Exit").as_ptr()));
                        let mut point = POINT::default();
                        GetCursorPos(&mut point).ok();
                        SetForegroundWindow(hwnd);
                        let selected = TrackPopupMenu(menu, TPM_RIGHTBUTTON | TPM_RETURNCMD, point.x, point.y, 0, hwnd, None);
                        DestroyMenu(menu);
                        if selected.0 != 0 {
                            PostMessageW(hwnd, WM_COMMAND, WPARAM(selected.0 as usize), LPARAM(0));
                        }
                    }
                    _ => {}
                }
                LRESULT(0)
            }
            WM_SIZE => {
                // Minimize to the tray instead of the taskbar.
                if wparam.0 == 1 /* SIZE_MINIMIZED */ {
                    ShowWindow(hwnd, SW_HIDE).ok();
                }
                LRESULT(0)
            }
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
                            // Keep the tray tooltip in sync with activity.
                            let tooltip = format!("ReyDesk support — {} message{}", count, if count == 1 { "" } else { "s" });
                            Shell_NotifyIconW(NIM_MODIFY, &build_tray_data(hwnd, &tooltip));
                        }
                    }
                }
                LRESULT(0)
            }
            WM_COMMAND => {
                let id = (wparam.0 & 0xFFFF) as i32;
                match id {
                    IDM_TRAY_OPEN => {
                        ShowWindow(hwnd, SW_SHOW).ok();
                        SetForegroundWindow(hwnd);
                        LRESULT(0)
                    }
                    IDM_TRAY_DISCONNECT | IDM_TRAY_EXIT => {
                        DestroyWindow(hwnd).ok();
                        LRESULT(0)
                    }
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
                    IDC_FILES => {
                        // Reveal the folder where technician-sent files are saved.
                        let root = file_root();
                        let _ = std::process::Command::new("explorer.exe")
                            .arg(&root)
                            .creation_flags(0x08000000) // CREATE_NO_WINDOW
                            .spawn();
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
                SESSION_WINDOW_HWND.store(std::ptr::null_mut(), Ordering::SeqCst);
                Shell_NotifyIconW(NIM_DELETE, &build_tray_data(hwnd, ""));
                let state = SESSION_STATE.load(Ordering::SeqCst);
                if !state.is_null() {
                    let _ = Box::from_raw(state);
                    SESSION_STATE.store(std::ptr::null_mut(), Ordering::SeqCst);
                }
                KillTimer(hwnd, TIMER_POLL_INBOX).ok();
                // Closing the window (X, Disconnect or Exit) ends the session:
                // the agent task observes the shutdown signal and closes the
                // relay, then the helper exits.
                trigger_session_shutdown();
                PostQuitMessage(0);
                LRESULT(0)
            }
            WM_CTLCOLORSTATIC => {
                let hdc = windows::Win32::Graphics::Gdi::HDC(wparam.0 as isize);
                SetBkMode(hdc, TRANSPARENT);
                if GetDlgItem(hwnd, IDC_BRAND) == HWND(lparam.0) {
                    SetTextColor(hdc, COLORREF(BRAND_RGB));
                } else {
                    SetTextColor(hdc, COLORREF(0x00A0A0A0));
                }
                let brush = CreateSolidBrush(COLORREF(0x001D2329));
                LRESULT(brush.0 as isize)
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

            let w = 420i32;
            let h = 420i32;
            let (x, y) = center_on_focused_monitor(w, h);

            let title = tray_wide("ReyDesk Support Session");
            let hwnd = CreateWindowExW(
                WINDOW_EX_STYLE::default(),
                PCWSTR(class_name.as_ptr()),
                PCWSTR(title.as_ptr()),
                WS_OVERLAPPED | WS_CAPTION | WS_SYSMENU | WS_MINIMIZEBOX | WS_VISIBLE,
                x, y, w, h,
                None, None, None, None,
            );
            if hwnd.0 == 0 {
                return Err(anyhow!("failed to create session window"));
            }
            SESSION_WINDOW_HWND.store(hwnd.0 as *mut std::ffi::c_void, Ordering::SeqCst);

            // System tray entry with connection status, open/disconnect/exit.
            Shell_NotifyIconW(NIM_ADD, &build_tray_data(hwnd, "ReyDesk support — session active"));

            let static_class = tray_wide("STATIC");
            let button_class = tray_wide("BUTTON");
            let edit_class = tray_wide("EDIT");

            // Status label
            CreateWindowExW(
                WINDOW_EX_STYLE::default(),
                PCWSTR(static_class.as_ptr()),
                PCWSTR(tray_wide("ReyDesk  ·  Connected securely").as_ptr()),
                WS_CHILD | WS_VISIBLE,
                20, 12, 380, 20,
                hwnd, HMENU(IDC_BRAND as isize), None, None,
            );
            CreateWindowExW(
                WINDOW_EX_STYLE::default(),
                PCWSTR(static_class.as_ptr()),
                PCWSTR(tray_wide("Session chat").as_ptr()),
                WS_CHILD | WS_VISIBLE,
                20, 30, 380, 16,
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
                20, 40, 380, 248,
                hwnd, HMENU(IDC_CHAT_LOG as isize), None, None,
            );

            // Message input
            CreateWindowExW(
                WINDOW_EX_STYLE::default(),
                PCWSTR(edit_class.as_ptr()),
                PCWSTR::null(),
                WS_CHILD | WS_VISIBLE | WS_TABSTOP,
                20, 300, 280, 28,
                hwnd, HMENU(IDC_MSG_INPUT as isize), None, None,
            );

            // Send button
            CreateWindowExW(
                WINDOW_EX_STYLE::default(),
                PCWSTR(button_class.as_ptr()),
                PCWSTR(tray_wide("Send").as_ptr()),
                WS_CHILD | WS_VISIBLE | WS_TABSTOP,
                308, 300, 92, 28,
                hwnd, HMENU(IDC_MSG_SEND as isize), None, None,
            );

            // Received-files button
            CreateWindowExW(
                WINDOW_EX_STYLE::default(),
                PCWSTR(button_class.as_ptr()),
                PCWSTR(tray_wide("Files").as_ptr()),
                WS_CHILD | WS_VISIBLE | WS_TABSTOP,
                20, 350, 108, 30,
                hwnd, HMENU(IDC_FILES as isize), None, None,
            );

            // Disconnect button
            CreateWindowExW(
                WINDOW_EX_STYLE::default(),
                PCWSTR(button_class.as_ptr()),
                PCWSTR(tray_wide("Disconnect").as_ptr()),
                WS_CHILD | WS_VISIBLE | WS_TABSTOP,
                140, 350, 140, 30,
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
