#![cfg_attr(target_os = "windows", windows_subsystem = "windows")]

mod helper_ui;

use anyhow::{anyhow, Context, Result};
use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use bytes::Bytes;
use clap::{Parser, Subcommand};
use ed25519_dalek::{Signature, Verifier, VerifyingKey};
use futures_util::{stream::SplitSink, SinkExt, StreamExt};
use openh264::encoder::Encoder;
use openh264::formats::{RgbSliceU8, YUVBuffer};
use reqwest::Client;
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use sha2::{Digest, Sha256};
#[cfg(not(target_os = "windows"))]
use std::io::{self, IsTerminal, Write};
#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Mutex as StdMutex,
};
use std::{
    collections::{HashMap, HashSet},
    fs,
    path::{Component, Path, PathBuf},
    process::Stdio,
    sync::Arc,
    thread,
    time::{Duration, Instant},
};
#[cfg(target_os = "windows")]
use std::{ffi::OsString, process::Command as ProcessCommand};
use sysinfo::{Disks, Pid, System};
use tokio::time::{interval, MissedTickBehavior};
use tokio::{
    io::{AsyncBufReadExt, AsyncRead, AsyncReadExt, AsyncWriteExt, BufReader},
    net::{TcpListener, TcpStream},
    process::{Child, Command as TokioCommand},
    sync::{mpsc, watch, Mutex},
};
use tokio_tungstenite::{connect_async, tungstenite::Message, MaybeTlsStream, WebSocketStream};
use webrtc::{
    api::{media_engine::MediaEngine, APIBuilder},
    data_channel::{data_channel_message::DataChannelMessage, RTCDataChannel},
    ice_transport::{
        ice_candidate::RTCIceCandidateInit, ice_credential_type::RTCIceCredentialType,
        ice_server::RTCIceServer,
    },
    media::Sample,
    peer_connection::{
        configuration::RTCConfiguration, sdp::session_description::RTCSessionDescription,
    },
    rtp_transceiver::rtp_codec::RTCRtpCodecCapability,
    track::track_local::track_local_static_sample::TrackLocalStaticSample,
};
#[cfg(target_os = "windows")]
use windows::Win32::{
    Graphics::Gdi::{GetSysColorBrush, COLOR_WINDOW},
    UI::WindowsAndMessaging::{
        DestroyWindow, GetDlgItem, GetWindowLongPtrW, GetWindowTextW, LoadCursorW,
        SetForegroundWindow, SetWindowLongPtrW, SetWindowTextW, ShowWindow, CW_USEDEFAULT, ES_CENTER,
        GWLP_USERDATA, HMENU, IDC_ARROW, SW_HIDE, SW_SHOW, WINDOW_STYLE, WM_CLOSE, WM_COMMAND, WM_DESTROY, WM_RBUTTONUP, WM_LBUTTONDBLCLK,
        WS_CAPTION, WS_CHILD, WS_MINIMIZEBOX, WS_OVERLAPPED, WS_SYSMENU, WS_THICKFRAME, WS_TABSTOP, WS_VISIBLE,
    },
};
#[cfg(target_os = "windows")]
use windows::{
    core::PCWSTR,
    Win32::{
        Foundation::{
            CloseHandle, GetLastError, ERROR_ALREADY_EXISTS, HANDLE, HGLOBAL, HWND, LPARAM,
            LRESULT, POINT, WPARAM,
        },
        System::{
            DataExchange::{
                CloseClipboard, EmptyClipboard, GetClipboardData, OpenClipboard, SetClipboardData,
            },
            Memory::{GlobalAlloc, GlobalLock, GlobalUnlock, GMEM_MOVEABLE, GMEM_ZEROINIT},
            Threading::CreateMutexW,
        },
        UI::{
            HiDpi::{SetProcessDpiAwarenessContext, DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2},
            Input::KeyboardAndMouse::*,
            Shell::{
                Shell_NotifyIconW, NIF_ICON, NIF_MESSAGE, NIF_TIP, NIM_ADD, NIM_DELETE, NIM_MODIFY,
                NOTIFYICONDATAW,
            },
            WindowsAndMessaging::{
                CreateWindowExW, DefWindowProcW, DispatchMessageW, GetCursorPos, GetMessageW,
                GetSystemMetrics, LoadIconW, MessageBoxW, PostQuitMessage, RegisterClassW,
                TranslateMessage, IDI_APPLICATION, IDYES, MB_ICONQUESTION, MB_SYSTEMMODAL,
                MB_YESNO, MSG, SM_CXVIRTUALSCREEN, SM_CYVIRTUALSCREEN, SM_XVIRTUALSCREEN,
                SM_YVIRTUALSCREEN, WINDOW_EX_STYLE, WM_APP, WNDCLASSW, TPM_RETURNCMD, CreatePopupMenu, AppendMenuW, TrackPopupMenu, MF_SEPARATOR, MF_STRING,
            },
        },
    },
};
#[cfg(target_os = "windows")]
use windows_service::{
    define_windows_service,
    service::{
        ServiceControl, ServiceControlAccept, ServiceExitCode, ServiceState, ServiceStatus,
        ServiceType,
    },
    service_control_handler::{self, ServiceControlHandlerResult},
    service_dispatcher,
};
#[cfg(target_os = "windows")]
use winreg::{enums::HKEY_LOCAL_MACHINE, RegKey};
use xcap::Monitor;

const SERVICE_NAME: &str = "ReyDeskAgent";

/// Base64 ed25519 public key baked at build time (`REYDESK_UPDATE_PUBLIC_KEY`, with the legacy name accepted).
/// When set, update artifacts must carry a signature over `<version>:<sha256>`.
/// When unset (development builds), signature verification is skipped but the
/// SHA-256 check is always enforced.
const UPDATE_PUBLIC_KEY: Option<&str> = match option_env!("REYDESK_UPDATE_PUBLIC_KEY") {
    Some(value) => Some(value),
    None => option_env!("DESKOS_UPDATE_PUBLIC_KEY"),
};

#[derive(Parser, Debug)]
#[command(name = "deskos-agent", about = "ReyDesk endpoint agent")]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand, Debug)]
enum Command {
    /// Enroll this endpoint with a 12-digit human code or an opaque fleet token.
    Enroll {
        #[arg(long, default_value = "http://localhost:4000")]
        api_url: String,
        #[arg(long, default_value = "ws://localhost:4100/ws")]
        relay_url: String,
        #[arg(long)]
        enrol_token: String,
        #[arg(long)]
        name: Option<String>,
        #[arg(long)]
        hostname: Option<String>,
        #[arg(long, default_value = "deskos-agent-dev")]
        agent_version: String,
        #[arg(long, default_value = "deskos-agent.json")]
        config: PathBuf,
    },
    /// Redeem a technician's support code without installing anything, then run as a portable endpoint.
    Helper {
        /// Optional override; defaults to the deployment-baked or registered endpoint.
        #[arg(long, default_value = "")]
        api_url: String,
        /// Optional override; defaults to the deployment-baked or registered endpoint.
        #[arg(long, default_value = "")]
        relay_url: String,
        /// The 12-digit support code from the technician. Omit it to open a code-entry window instead.
        code: Option<String>,
        #[arg(long)]
        name: Option<String>,
        #[arg(long, default_value = "deskos-helper.json")]
        config: PathBuf,
    },
    /// Run the heartbeat, inventory, metrics, and session polling loop.
    Run {
        #[arg(long, default_value = "deskos-agent.json")]
        config: PathBuf,
        #[arg(long)]
        interval_sec: Option<u64>,
        /// Prompt for attended consent in an interactive user session; never enabled by the service.
        #[arg(long)]
        interactive_consent: bool,
    },
    /// Run the hidden logged-in-user consent helper alongside the Windows service.
    ConsentUi {
        #[arg(long, default_value = "deskos-agent.json")]
        config: PathBuf,
    },
    /// Run the logged-in-user tray status and consent helper.
    TrayUi {
        #[arg(long, default_value = "deskos-agent.json")]
        config: PathBuf,
    },
    /// Explicitly grant or deny an attended-session consent request.
    Consent {
        #[arg(long, default_value = "deskos-agent.json")]
        config: PathBuf,
        #[arg(long)]
        session_id: String,
        #[arg(long, action = clap::ArgAction::Set)]
        granted: bool,
    },
    /// End a remote session from the endpoint as a local kill switch.
    End {
        #[arg(long, default_value = "deskos-agent.json")]
        config: PathBuf,
        #[arg(long)]
        session_id: String,
    },
    /// Capture the primary display to an image for endpoint diagnostics.
    Capture {
        #[arg(long, default_value = "deskos-screen.png")]
        output: PathBuf,
    },
    /// Report a remote-session state transition from an agent integration.
    State {
        #[arg(long, default_value = "deskos-agent.json")]
        config: PathBuf,
        #[arg(long)]
        session_id: String,
        #[arg(long)]
        state: String,
    },
    /// Check the configured update channel and print the latest offered version.
    CheckUpdate {
        #[arg(long, default_value = "deskos-agent.json")]
        config: PathBuf,
        /// The current agent version to compare against (defaults to the binary's version).
        #[arg(long, default_value = env!("CARGO_PKG_VERSION"))]
        version: String,
    },
    /// Verify a downloaded artifact against its manifest SHA-256 and ed25519 signature.
    VerifyUpdate {
        /// Path to the downloaded artifact.
        file: PathBuf,
        /// Lowercase hex SHA-256 from the update manifest.
        #[arg(long)]
        sha256: String,
        /// Version string that was signed (from the update manifest).
        #[arg(long)]
        version: String,
        /// Base64 ed25519 signature over `<version>:<sha256>`.
        #[arg(long, default_value = "")]
        signature: String,
    },
    /// Open a browser-based enrollment wizard for customer or technician-assisted setup.
    EnrollUi {
        /// Optional hidden override used by development and deployment tooling; normal users only enter the code.
        #[arg(long, hide = true, default_value = "")]
        api_url: String,
        /// Optional hidden override used by development and deployment tooling; normal users only enter the code.
        #[arg(long, hide = true, default_value = "")]
        relay_url: String,
        #[arg(long, default_value = "deskos-agent.json")]
        config: PathBuf,
    },
    /// Run the agent under the native Windows Service Control Manager.
    Service {
        #[arg(long, default_value = "deskos-agent.json")]
        config: PathBuf,
    },
    /// Register this binary as an automatic Windows service.
    InstallService {
        #[arg(long, default_value = "deskos-agent.json")]
        config: PathBuf,
    },
    /// Remove the ReyDesk Windows service registration.
    UninstallService,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
struct AgentConfig {
    api_url: String,
    #[serde(default = "default_relay_url")]
    relay_url: String,
    device_id: String,
    device_token: String,
    name: String,
    hostname: String,
    agent_version: String,
    #[serde(default = "default_device_type")]
    device_type: String,
    #[serde(default = "default_interval")]
    heartbeat_interval_sec: u64,
}

fn default_interval() -> u64 {
    30
}

fn default_device_type() -> String {
    "workstation".to_owned()
}

fn default_relay_url() -> String {
    "ws://localhost:4100/ws".to_owned()
}

/// Compile-time deployment defaults so a portable helper can be built with the
/// API/relay endpoints baked in, letting the endpoint user enter only the code.
const BAKED_API_URL: &str = match option_env!("REYDESK_API_URL") {
    Some(url) => url,
    None => match option_env!("DESKOS_API_URL") {
        Some(url) => url,
        None => "",
    },
};
const BAKED_RELAY_URL: &str = match option_env!("REYDESK_RELAY_URL") {
    Some(url) => url,
    None => match option_env!("DESKOS_RELAY_URL") {
        Some(url) => url,
        None => "",
    },
};

#[derive(Debug, Deserialize)]
struct ProtectedConfig {
    format: String,
    payload: String,
}

const PROTECTED_CONFIG_FORMAT: &str = "deskos-agent.dpapi.v1";

type RelayWriter = SplitSink<WebSocketStream<MaybeTlsStream<TcpStream>>, Message>;
type SharedRelayWriter = Arc<Mutex<RelayWriter>>;
type TrayStatus = Arc<StdMutex<String>>;

#[cfg(target_os = "windows")]
const TRAY_STATUS: usize = 4101;
#[cfg(target_os = "windows")]
const TRAY_DISCONNECT: usize = 4102;
#[cfg(target_os = "windows")]
const TRAY_EXIT: usize = 4103;
#[cfg(target_os = "windows")]
const TRAY_OPEN_CHAT: usize = 4104;
#[cfg(target_os = "windows")]
const TRAY_WM_MESSAGE: u32 = WM_APP + 1;

#[derive(Debug, Deserialize)]
struct BrowserIceCandidate {
    candidate: String,
    #[serde(rename = "sdpMid")]
    sdp_mid: Option<String>,
    #[serde(rename = "sdpMLineIndex")]
    sdp_mline_index: Option<u16>,
    #[serde(rename = "usernameFragment")]
    username_fragment: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct EnrollRequest {
    token: String,
    name: String,
    hostname: String,
    os: String,
    os_version: String,
    arch: String,
    ip: String,
    agent_version: String,
    #[serde(default = "default_device_type")]
    device_type: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct EnrollResponse {
    device: EnrolledDevice,
    device_token: String,
    heartbeat_interval_sec: u64,
}

#[derive(Debug, Deserialize)]
struct EnrolledDevice {
    id: String,
    name: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ClaimRequest {
    name: String,
    hostname: String,
    os: String,
    os_version: String,
    arch: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ClaimResponse {
    device: EnrolledDevice,
    device_token: String,
    session: ClaimedSession,
    relay_url: String,
}

#[derive(Debug, Deserialize)]
struct ClaimedSession {
    id: String,
    state: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct InventoryRequest {
    hostname: String,
    os: String,
    os_version: String,
    arch: String,
    ip: String,
    agent_version: String,
    device_type: String,
    power_source: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    battery_pct: Option<f32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    battery_health_pct: Option<f32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    uptime_seconds: Option<u64>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct MetricsRequest {
    cpu_pct: f32,
    mem_pct: f32,
    disk_pct: f32,
    disk_free_bytes: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    network_latency_ms: Option<f32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    battery_pct: Option<f32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    battery_health_pct: Option<f32>,
    uptime_seconds: u64,
    process_count: usize,
    service_states: HashMap<String, String>,
    reason: String,
}

#[derive(Debug, Deserialize)]
struct SessionListResponse {
    sessions: Vec<AgentSession>,
}

#[derive(Clone, Debug, Deserialize)]
struct AgentSession {
    id: String,
    #[serde(rename = "type")]
    session_type: String,
    state: String,
    permissions: Vec<String>,
    reason: String,
}

#[derive(Debug, Deserialize)]
struct SessionResponse {
    session: AgentSession,
    #[serde(rename = "joinToken", default)]
    join_token: Option<String>,
}

#[derive(Debug, Deserialize)]
struct PendingActionsResponse {
    actions: Vec<PendingAction>,
}

#[derive(Clone, Debug, Deserialize)]
struct PendingAction {
    id: String,
    action: String,
    #[serde(default)]
    payload: serde_json::Value,
}

#[derive(Debug, Deserialize)]
struct AgentScriptResponse {
    script: AgentScript,
}

#[derive(Clone, Debug, Deserialize)]
struct AgentScript {
    id: String,
    name: String,
    body: String,
}

#[derive(Debug, Deserialize)]
struct IceConfigResponse {
    #[serde(rename = "iceServers", default)]
    ice_servers: Vec<IceServerEntry>,
}

#[derive(Clone, Debug, Deserialize)]
struct IceServerEntry {
    urls: IceUrls,
    #[serde(default)]
    username: String,
    #[serde(default)]
    credential: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(untagged)]
enum IceUrls {
    One(String),
    Many(Vec<String>),
}

impl IceServerEntry {
    fn urls(&self) -> Vec<String> {
        match &self.urls {
            IceUrls::One(url) => vec![url.clone()],
            IceUrls::Many(urls) => urls.clone(),
        }
    }

    fn into_rtc(self) -> RTCIceServer {
        RTCIceServer {
            urls: self.urls(),
            username: self.username,
            credential: self.credential,
            credential_type: RTCIceCredentialType::Password,
        }
    }
}

#[derive(Debug, Deserialize)]
struct UpdateCheckResponse {
    #[serde(default)]
    update: Option<UpdateOffer>,
    status: String,
}

#[derive(Debug, Deserialize)]
struct UpdateOffer {
    version: String,
    #[serde(rename = "minVersion", default)]
    min_version: String,
    url: String,
    sha256: String,
    #[serde(default)]
    signature: String,
    #[serde(rename = "rolloutPercent", default)]
    rollout_percent: u32,
}

#[derive(Debug, Serialize)]
struct ControlAudit {
    outcome: String,
    action: String,
    reason: String,
}

#[derive(Clone)]
struct AgentClient {
    http: Client,
    api_url: String,
    device_token: String,
}

impl AgentClient {
    fn new(config: &AgentConfig) -> Self {
        Self {
            http: Client::new(),
            api_url: config.api_url.trim_end_matches('/').to_owned(),
            device_token: config.device_token.clone(),
        }
    }

    async fn post_json<T: DeserializeOwned>(&self, path: &str, body: impl Serialize) -> Result<T> {
        let response = self
            .http
            .post(format!("{}{}", self.api_url, path))
            .bearer_auth(&self.device_token)
            .json(&body)
            .send()
            .await
            .with_context(|| format!("request failed: POST {path}"))?
            .error_for_status()
            .with_context(|| format!("API rejected: POST {path}"))?;
        response.json().await.context("invalid API response")
    }

    async fn get_json<T: DeserializeOwned>(&self, path: &str) -> Result<T> {
        let response = self
            .http
            .get(format!("{}{}", self.api_url, path))
            .bearer_auth(&self.device_token)
            .send()
            .await
            .with_context(|| format!("request failed: GET {path}"))?
            .error_for_status()
            .with_context(|| format!("API rejected: GET {path}"))?;
        response.json().await.context("invalid API response")
    }

    async fn post_no_content(&self, path: &str, body: impl Serialize) -> Result<()> {
        self.http
            .post(format!("{}{}", self.api_url, path))
            .bearer_auth(&self.device_token)
            .json(&body)
            .send()
            .await
            .with_context(|| format!("request failed: POST {path}"))?
            .error_for_status()
            .with_context(|| format!("API rejected: POST {path}"))?;
        Ok(())
    }

    async fn heartbeat(&self) -> Result<f32> {
        let started = Instant::now();
        let _: serde_json::Value = self
            .post_json("/api/v1/agent/heartbeat", serde_json::json!({}))
            .await?;
        Ok(started.elapsed().as_secs_f32() * 1_000.0)
    }

    async fn inventory(&self, body: &InventoryRequest) -> Result<()> {
        let _: serde_json::Value = self
            .http
            .put(format!("{}/api/v1/agent/inventory", self.api_url))
            .bearer_auth(&self.device_token)
            .json(body)
            .send()
            .await
            .context("inventory request failed")?
            .error_for_status()
            .context("inventory update rejected")?
            .json()
            .await
            .context("invalid inventory response")?;
        Ok(())
    }

    async fn metrics(&self, body: &MetricsRequest) -> Result<()> {
        let _: serde_json::Value = self.post_json("/api/v1/agent/metrics", body).await?;
        Ok(())
    }

    async fn sessions(&self) -> Result<Vec<AgentSession>> {
        Ok(self
            .get_json::<SessionListResponse>("/api/v1/agent/sessions")
            .await?
            .sessions)
    }

    async fn pending_actions(&self) -> Result<Vec<PendingAction>> {
        Ok(self
            .get_json::<PendingActionsResponse>("/api/v1/agent/actions/pending")
            .await?
            .actions)
    }

    async fn get_script(&self, script_id: &str) -> Result<AgentScript> {
        Ok(self
            .get_json::<AgentScriptResponse>(&format!("/api/v1/agent/scripts/{script_id}"))
            .await?
            .script)
    }

    async fn report_action_result(&self, action_id: &str, status: &str, result: serde_json::Value) -> Result<()> {
        let _: serde_json::Value = self
            .post_json(
                &format!("/api/v1/agent/actions/{action_id}/result"),
                serde_json::json!({ "status": status, "result": result }),
            )
            .await?;
        Ok(())
    }

    async fn ice_config(&self, session_id: &str) -> Result<Vec<RTCIceServer>> {
        let response: IceConfigResponse = self
            .get_json(&format!("/api/v1/agent/sessions/{session_id}/ice"))
            .await?;
        Ok(response
            .ice_servers
            .into_iter()
            .map(IceServerEntry::into_rtc)
            .collect())
    }

    async fn check_update(&self, version: &str) -> Result<UpdateCheckResponse> {
        self.get_json(&format!("/api/v1/agent/update?version={version}"))
            .await
    }

    async fn report_update(
        &self,
        from_version: &str,
        to_version: &str,
        outcome: &str,
        reason: Option<&str>,
    ) -> Result<()> {
        let mut body = serde_json::json!({
            "fromVersion": from_version,
            "toVersion": to_version,
            "outcome": outcome,
        });
        if let Some(reason) = reason {
            body["reason"] = serde_json::json!(reason);
        }
        self.post_no_content("/api/v1/agent/update/telemetry", body)
            .await
    }

    async fn consent(
        &self,
        session_id: &str,
        granted: bool,
        permissions: Option<Vec<String>>,
    ) -> Result<SessionResponse> {
        let mut body = serde_json::json!({ "granted": granted });
        if let Some(permissions) = permissions {
            body["permissions"] = serde_json::json!(permissions);
        }
        self.post_json(
            &format!("/api/v1/agent/sessions/{session_id}/consent"),
            body,
        )
        .await
    }

    async fn state(&self, session_id: &str, state: &str) -> Result<serde_json::Value> {
        self.post_json(
            &format!("/api/v1/agent/sessions/{session_id}/state"),
            serde_json::json!({ "state": state }),
        )
        .await
    }

    async fn reconnect(&self, session_id: &str) -> Result<SessionResponse> {
        self.post_json(
            &format!("/api/v1/agent/sessions/{session_id}/reconnect"),
            serde_json::json!({}),
        )
        .await
    }

    async fn end_session(&self, session_id: &str) -> Result<SessionResponse> {
        self.post_json(
            &format!("/api/v1/agent/sessions/{session_id}/end"),
            serde_json::json!({}),
        )
        .await
    }

    async fn audit_control(&self, session_id: &str, audit: &ControlAudit) -> Result<()> {
        let _: serde_json::Value = self
            .post_json(
                &format!("/api/v1/agent/sessions/{session_id}/events"),
                audit,
            )
            .await?;
        Ok(())
    }

    async fn diagnostic(
        &self,
        session_id: &str,
        event: &str,
        reason: Option<String>,
    ) -> Result<()> {
        let _: serde_json::Value = self
            .post_json(
                &format!("/api/v1/agent/sessions/{session_id}/diagnostics"),
                serde_json::json!({ "event": event, "reason": reason }),
            )
            .await?;
        Ok(())
    }

    async fn send_chat(&self, session_id: &str, body: &str) -> Result<()> {
        let _: serde_json::Value = self
            .post_json(
                &format!("/api/v1/agent/sessions/{session_id}/messages"),
                serde_json::json!({ "body": body }),
            )
            .await?;
        Ok(())
    }
}

fn hostname() -> String {
    std::env::var("COMPUTERNAME")
        .or_else(|_| std::env::var("HOSTNAME"))
        .ok()
        .filter(|value| !value.is_empty())
        .or_else(System::host_name)
        .unwrap_or_else(|| "unknown-host".to_owned())
}
#[cfg(target_os = "windows")]
fn protect_config(contents: &[u8]) -> Result<Vec<u8>> {
    windows_dpapi::encrypt_data(contents, windows_dpapi::Scope::Machine, None)
        .context("protect agent config with Windows DPAPI")
}

#[cfg(target_os = "windows")]
fn unprotect_config(contents: &[u8]) -> Result<Vec<u8>> {
    windows_dpapi::decrypt_data(contents, windows_dpapi::Scope::Machine, None)
        .context("unprotect agent config with Windows DPAPI")
}

fn save_config(path: &Path, config: &AgentConfig) -> Result<()> {
    if let Some(parent) = path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
    {
        fs::create_dir_all(parent)
            .with_context(|| format!("create config directory {}", parent.display()))?;
    }
    let plaintext = serde_json::to_vec_pretty(config).context("serialize agent config")?;
    let contents = {
        #[cfg(target_os = "windows")]
        {
            let protected = protect_config(&plaintext)?;
            serde_json::to_vec_pretty(&serde_json::json!({
                "format": PROTECTED_CONFIG_FORMAT,
                "payload": BASE64.encode(protected),
            }))?
        }
        #[cfg(not(target_os = "windows"))]
        {
            plaintext
        }
    };
    fs::write(path, contents).with_context(|| format!("write agent config {}", path.display()))?;
    Ok(())
}

fn load_config(path: &Path) -> Result<AgentConfig> {
    let contents =
        fs::read(path).with_context(|| format!("read agent config {}", path.display()))?;
    #[cfg(target_os = "windows")]
    {
        if let Ok(envelope) = serde_json::from_slice::<ProtectedConfig>(&contents) {
            if envelope.format == PROTECTED_CONFIG_FORMAT {
                let protected = BASE64
                    .decode(envelope.payload)
                    .context("decode protected agent config")?;
                let plaintext = unprotect_config(&protected)?;
                return serde_json::from_slice(&plaintext)
                    .context("parse unprotected agent config");
            }
        }
        let config = serde_json::from_slice(&contents).context("parse legacy agent config")?;
        save_config(path, &config).context("migrate agent config to Windows DPAPI")?;
        return Ok(config);
    }
    #[cfg(not(target_os = "windows"))]
    {
        serde_json::from_slice(&contents).context("parse agent config")
    }
}

#[cfg(target_os = "windows")]
fn battery_percentage() -> Option<f32> {
    use windows::Win32::System::Power::{GetSystemPowerStatus, SYSTEM_POWER_STATUS};
    let mut status = SYSTEM_POWER_STATUS::default();
    let ok = unsafe { GetSystemPowerStatus(&mut status).is_ok() };
    if !ok || status.BatteryLifePercent == 255 {
        return None;
    }
    Some(status.BatteryLifePercent as f32)
}

#[cfg(target_os = "linux")]
fn battery_percentage() -> Option<f32> {
    let entries = fs::read_dir("/sys/class/power_supply").ok()?;
    for entry in entries.flatten() {
        if !entry.file_name().to_string_lossy().starts_with("BAT") {
            continue;
        }
        let value = fs::read_to_string(entry.path().join("capacity")).ok()?;
        if let Ok(percent) = value.trim().parse::<f32>() {
            return (0.0..=100.0).contains(&percent).then_some(percent);
        }
    }
    None
}

#[cfg(target_os = "macos")]
fn battery_percentage() -> Option<f32> {
    let output = std::process::Command::new("pmset")
        .args(["-g", "batt"])
        .output()
        .ok()?;
    let text = String::from_utf8_lossy(&output.stdout);
    let percent_end = text.find('%')?;
    let digits = text[..percent_end]
        .chars()
        .rev()
        .take_while(|character| character.is_ascii_digit())
        .collect::<String>()
        .chars()
        .rev()
        .collect::<String>();
    digits.parse::<f32>().ok().filter(|percent| *percent <= 100.0)
}

#[cfg(not(any(target_os = "windows", target_os = "linux", target_os = "macos")))]
fn battery_percentage() -> Option<f32> {
    None
}

#[cfg(target_os = "windows")]
fn power_source() -> String {
    use windows::Win32::System::Power::{GetSystemPowerStatus, SYSTEM_POWER_STATUS};
    let mut status = SYSTEM_POWER_STATUS::default();
    if unsafe { GetSystemPowerStatus(&mut status).is_ok() } {
        return match status.ACLineStatus {
            0 => "battery".to_owned(),
            1 => "ac".to_owned(),
            _ => "unknown".to_owned(),
        };
    }
    "unknown".to_owned()
}

#[cfg(not(target_os = "windows"))]
fn power_source() -> String {
    if battery_percentage().is_some() {
        "battery".to_owned()
    } else {
        "unknown".to_owned()
    }
}

#[cfg(target_os = "windows")]
fn battery_health_percentage() -> Option<f32> {
    let output = std::process::Command::new("powershell.exe")
        .args(["-NoProfile", "-NonInteractive", "-Command", "$b=Get-CimInstance Win32_Battery -ErrorAction SilentlyContinue | Select-Object -First 1; if ($b -and $b.DesignCapacity -gt 0) {[math]::Round(($b.FullChargeCapacity / $b.DesignCapacity) * 100, 2)}"])
        .creation_flags(0x08000000) // CREATE_NO_WINDOW — runs on every heartbeat
        .output()
        .ok()?;
    String::from_utf8_lossy(&output.stdout).trim().parse::<f32>().ok().filter(|value| (0.0..=100.0).contains(value))
}

#[cfg(target_os = "linux")]
fn battery_health_percentage() -> Option<f32> {
    let entries = fs::read_dir("/sys/class/power_supply").ok()?;
    for entry in entries.flatten() {
        if !entry.file_name().to_string_lossy().starts_with("BAT") { continue; }
        let design = fs::read_to_string(entry.path().join("energy_full_design")).ok()
            .or_else(|| fs::read_to_string(entry.path().join("charge_full_design")).ok())?.trim().parse::<f32>().ok()?;
        let full = fs::read_to_string(entry.path().join("energy_full")).ok()
            .or_else(|| fs::read_to_string(entry.path().join("charge_full")).ok())?.trim().parse::<f32>().ok()?;
        if design > 0.0 { return Some((full / design * 100.0).clamp(0.0, 100.0)); }
    }
    None
}

#[cfg(target_os = "macos")]
fn battery_health_percentage() -> Option<f32> {
    let output = std::process::Command::new("ioreg").args(["-rn", "AppleSmartBattery"]).output().ok()?;
    let text = String::from_utf8_lossy(&output.stdout);
    let design = text.lines().find_map(|line| line.split('=').nth(1)?.trim().parse::<f32>().ok().filter(|_| line.contains("DesignCapacity")))?;
    let full = text.lines().find_map(|line| line.split('=').nth(1)?.trim().parse::<f32>().ok().filter(|_| line.contains("AppleRawMaxCapacity") || line.contains("FullChargeCapacity")))?;
    (design > 0.0).then_some((full / design * 100.0).clamp(0.0, 100.0))
}

#[cfg(not(any(target_os = "windows", target_os = "linux", target_os = "macos")))]
fn battery_health_percentage() -> Option<f32> { None }

#[cfg(target_os = "windows")]
fn service_states() -> HashMap<String, String> {
    let mut states = HashMap::new();
    let output = match std::process::Command::new("sc.exe").args(["query", "state=", "all"])
        .creation_flags(0x08000000) // CREATE_NO_WINDOW — service probe runs on heartbeats
        .output() { Ok(output) => output, Err(_) => return states };
    let mut name: Option<String> = None;
    for line in String::from_utf8_lossy(&output.stdout).lines() {
        let trimmed = line.trim();
        if let Some(value) = trimmed.strip_prefix("SERVICE_NAME:") { name = Some(value.trim().to_owned()); }
        else if trimmed.starts_with("STATE") {
            if let Some(service) = name.take() {
                let state = if trimmed.contains("RUNNING") { "running" } else if trimmed.contains("PAUSED") { "paused" } else if trimmed.contains("STOPPED") { "stopped" } else { "unknown" };
                states.insert(service, state.to_owned());
                if states.len() >= 200 { break; }
            }
        }
    }
    states
}

#[cfg(not(target_os = "windows"))]
fn service_states() -> HashMap<String, String> { HashMap::new() }

fn inventory(config: &AgentConfig) -> InventoryRequest {
    InventoryRequest {
        hostname: config.hostname.clone(),
        os: std::env::consts::OS.to_owned(),
        os_version: System::long_os_version()
            .or_else(System::os_version)
            .unwrap_or_default(),
        arch: std::env::consts::ARCH.to_owned(),
        ip: String::new(),
        agent_version: config.agent_version.clone(),
        device_type: config.device_type.clone(),
        power_source: power_source(),
        battery_pct: battery_percentage(),
        battery_health_pct: battery_health_percentage(),
        uptime_seconds: Some(System::uptime()),
    }
}

fn metrics(system: &mut System, disks: &mut Disks, network_latency_ms: Option<f32>) -> MetricsRequest {
    system.refresh_cpu();
    system.refresh_memory();
    system.refresh_processes();
    disks.refresh();
    let total_disk = disks
        .list()
        .iter()
        .map(|disk| disk.total_space())
        .sum::<u64>();
    let available_disk = disks
        .list()
        .iter()
        .map(|disk| disk.available_space())
        .sum::<u64>();
    MetricsRequest {
        cpu_pct: system.global_cpu_info().cpu_usage(),
        mem_pct: if system.total_memory() == 0 {
            0.0
        } else {
            (system.used_memory() as f32 / system.total_memory() as f32) * 100.0
        },
        disk_pct: if total_disk == 0 {
            0.0
        } else {
            ((total_disk - available_disk) as f32 / total_disk as f32) * 100.0
        },
        disk_free_bytes: available_disk,
        network_latency_ms,
        battery_pct: battery_percentage(),
        battery_health_pct: battery_health_percentage(),
        uptime_seconds: System::uptime(),
        process_count: system.processes().len(),
        service_states: service_states(),
        reason: "periodic".to_owned(),
    }
}

async fn enroll(
    api_url: String,
    relay_url: String,
    enrol_token: String,
    name: Option<String>,
    provided_hostname: Option<String>,
    agent_version: String,
    config_path: PathBuf,
) -> Result<()> {
    validate_endpoints(&api_url, &relay_url)?;
    let hostname = provided_hostname.unwrap_or_else(hostname);
    let device_name = name.unwrap_or_else(|| hostname.clone());
    let request = EnrollRequest {
        token: enrol_token,
        name: device_name.clone(),
        hostname: hostname.clone(),
        os: std::env::consts::OS.to_owned(),
        os_version: System::long_os_version()
            .or_else(System::os_version)
            .unwrap_or_default(),
        arch: std::env::consts::ARCH.to_owned(),
        ip: String::new(),
        agent_version: agent_version.clone(),
        device_type: default_device_type(),
    };
    let response = Client::new()
        .post(format!(
            "{}/api/v1/agent/enrol",
            api_url.trim_end_matches('/')
        ))
        .json(&request)
        .send()
        .await
        .context("enrollment request failed")?
        .error_for_status()
        .context("enrollment rejected")?
        .json::<EnrollResponse>()
        .await
        .context("invalid enrollment response")?;
    let config = AgentConfig {
        api_url,
        relay_url,
        device_id: response.device.id,
        device_token: response.device_token,
        name: response.device.name,
        hostname,
        agent_version,
        device_type: default_device_type(),
        heartbeat_interval_sec: response.heartbeat_interval_sec,
    };
    save_config(&config_path, &config)?;
    println!("Enrolled {} ({})", config.name, config.device_id);
    println!("Saved agent credentials to {}", config_path.display());
    println!("Heartbeat interval: {}s", config.heartbeat_interval_sec);
    Ok(())
}

async fn claim_code(
    api_url: &str,
    code: &str,
    name: &str,
    hostname: &str,
    claim_token: Option<&str>,
    fingerprint: Option<&str>,
) -> Result<ClaimResponse> {
    let body = ClaimRequest {
        name: name.to_owned(),
        hostname: hostname.to_owned(),
        os: std::env::consts::OS.to_owned(),
        os_version: System::long_os_version()
            .or_else(System::os_version)
            .unwrap_or_default(),
        arch: std::env::consts::ARCH.to_owned(),
    };
    let mut request = Client::new()
        .post(format!(
            "{}/api/connect/{code}/claim",
            api_url.trim_end_matches('/')
        ))
        .json(&body);
    if let Some(claim_token) = claim_token {
        request = request.query(&[("claimToken", claim_token)]);
    }
    if let Some(fingerprint) = fingerprint {
        request = request.header("x-deskos-claim-fingerprint", fingerprint);
    }
    let response = request
        .send()
        .await
        .context("support-code claim request failed")?;
    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        let detail = serde_json::from_str::<serde_json::Value>(&body)
            .ok()
            .and_then(|value| value.get("error").and_then(|error| error.get("message")).and_then(serde_json::Value::as_str).map(str::to_owned))
            .filter(|message| !message.is_empty())
            .unwrap_or_else(|| format!("HTTP {status}"));
        return Err(anyhow!("support code was rejected: {detail}"));
    }
    response.json::<ClaimResponse>().await.context("invalid claim response")
}

fn parse_support_input(raw: &str) -> Result<(String, Option<String>)> {
    let value = raw.trim();
    if let Some(connect_start) = value.find("/connect/") {
        let after = &value[connect_start + "/connect/".len()..];
        let (code, query) = after.split_once('?').unwrap_or((after, ""));
        if code.len() != 12 || !code.chars().all(|character| character.is_ascii_digit()) {
            return Err(anyhow!("the secure link does not contain a valid 12-digit technician code"));
        }
        let token = query
            .split('&')
            .find_map(|part| part.strip_prefix("claimToken="))
            .filter(|token| (token.starts_with("reydesk_link_") || token.starts_with("deskos_link_")) && token.len() <= 200)
            .map(str::to_owned)
            .ok_or_else(|| anyhow!("the secure link is missing its one-time claim token"))?;
        return Ok((code.to_owned(), Some(token)));
    }
    if value.len() == 12 && value.chars().all(|character| character.is_ascii_digit()) {
        return Ok((value.to_owned(), None));
    }
    Err(anyhow!("enter the 12-digit technician code or paste the complete secure ReyDesk link"))
}

fn new_claim_fingerprint() -> String {
    let mut bytes = [0u8; 32];
    if getrandom::getrandom(&mut bytes).is_ok() {
        return format!("deskos_fp_{}", hex::encode(bytes));
    }
    let fallback = format!(
        "{}:{}:{}:{}",
        hostname(),
        std::process::id(),
        std::env::consts::OS,
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|duration| duration.as_nanos())
            .unwrap_or_default(),
    );
    format!("deskos_fp_{}", hex::encode(Sha256::digest(fallback.as_bytes())))
}

async fn claim_and_save(
    api_url: String,
    relay_url: String,
    code: String,
    claim_token: Option<String>,
    fingerprint: Option<String>,
    name: Option<String>,
    config_path: PathBuf,
) -> Result<(ClaimedSession, AgentConfig)> {
    let (api_url, fallback_relay) = helper_endpoint_defaults(api_url, relay_url);
    validate_endpoints(&api_url, &fallback_relay)?;
    let hostname = hostname();
    let device_name = name.unwrap_or_else(|| hostname.clone());
    let claimed = claim_code(
        &api_url,
        &code,
        &device_name,
        &hostname,
        claim_token.as_deref(),
        fingerprint.as_deref(),
    )
    .await?;
    validate_endpoint(&claimed.relay_url, true)?;
    let config = AgentConfig {
        api_url,
        relay_url: claimed.relay_url,
        device_id: claimed.device.id,
        device_token: claimed.device_token,
        name: claimed.device.name,
        hostname,
        agent_version: "deskos-helper".to_owned(),
        device_type: default_device_type(),
        heartbeat_interval_sec: 30,
    };
    save_config(&config_path, &config)?;
    Ok((claimed.session, config))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AgentJoinResponse {
    session_id: String,
    join_token: String,
    relay_url: String,
    permissions: Vec<String>,
    #[serde(default)]
    ice_servers: Vec<IceServerEntry>,
}

/// Attach to a session that was already claimed (browser companion flow) using
/// the support code as the bearer credential. Returns a fresh relay ticket.
async fn agent_join(api_url: &str, code: &str) -> Result<AgentJoinResponse> {
    let response = Client::new()
        .post(format!(
            "{}/api/connect/{code}/agent-join",
            api_url.trim_end_matches('/')
        ))
        .json(&serde_json::json!({}))
        .send()
        .await
        .context("attach-to-session request failed")?
        .error_for_status()
        .context("the support session is no longer available")?;
    response
        .json::<AgentJoinResponse>()
        .await
        .context("invalid attach response")
}

/// Streaming-engine mode: the browser companion owns consent and chat, so the
/// helper only connects the relay, streams the screen, and relays chat. No
/// device identity is required — the join ticket is issued by the API.
async fn run_streamer(
    api_url: String,
    code: String,
    mut shutdown: Option<mpsc::UnboundedReceiver<()>>,
) -> Result<()> {
    let mut backoff_seconds = 2_u64;
    let mut attempt = 0_u32;
    loop {
        let joined = agent_join(&api_url, &code).await?;
        validate_endpoint(&joined.relay_url, true)?;
        let config = AgentConfig {
            api_url: api_url.clone(),
            relay_url: joined.relay_url.clone(),
            device_id: joined.session_id.clone(),
            device_token: String::new(),
            name: "Streaming helper".to_owned(),
            hostname: hostname(),
            agent_version: "deskos-helper".to_owned(),
            device_type: default_device_type(),
            heartbeat_interval_sec: 30,
        };
        let client = Arc::new(AgentClient::new(&config));
        let ice_servers = joined.ice_servers.clone().into_iter().map(IceServerEntry::into_rtc).collect::<Vec<_>>();
        let should_reconnect = match run_relay_connection(
            &config,
            &joined.session_id,
            &joined.join_token,
            &joined.permissions,
            client,
            Some(ice_servers),
        )
        .await
        {
            Ok(value) => value,
            Err(error) => {
                eprintln!("streamer relay: {error:#}");
                true
            }
        };
        if !should_reconnect {
            return Ok(());
        }
        attempt += 1;
        if attempt >= 5 {
            return Err(anyhow!("the support session ended or could not be reached"));
        }
        println!("Streamer disconnected; retrying in {backoff_seconds}s (attempt {attempt})");
        tokio::select! {
            _ = tokio::time::sleep(Duration::from_secs(backoff_seconds)) => {}
            _ = async {
                match shutdown.as_mut() {
                    Some(receiver) => {
                        let _ = receiver.recv().await;
                    }
                    None => std::future::pending::<()>().await,
                }
            } => {
                return Ok(());
            }
        }
        backoff_seconds = (backoff_seconds.saturating_mul(2)).min(30);
    }
}

async fn run_helper(
    api_url: String,
    relay_url: String,
    code: String,
    name: Option<String>,
    config_path: PathBuf,
) -> Result<()> {
    let (code, claim_token) = parse_support_input(&code)?;
    let fingerprint = claim_token.as_ref().map(|_| new_claim_fingerprint());
    let (session, config) = match claim_and_save(
        api_url.clone(),
        relay_url,
        code.clone(),
        claim_token,
        fingerprint,
        name,
        config_path.clone(),
    )
    .await
    {
        Ok(value) => value,
        Err(claim_error) => {
            // The code may already be claimed by the browser companion page;
            // attach as the streaming engine instead of failing.
            match agent_join(&api_url, &code).await {
                Ok(_joined) => {
                    println!("Attaching to an already-claimed support session; streaming screen only.");
                    run_streamer(api_url.clone(), code.clone(), None).await?;
                    return Ok(());
                }
                Err(_) => return Err(claim_error),
            }
        }
    };
    println!(
        "Support session {} ({}) — saved helper credentials to {}",
        session.id,
        session.state,
        config_path.display()
    );
    println!(
        "A consent prompt will appear when your technician requests access. Keep this window open; close it to end the helper."
    );
    let result = run_agent(config_path, None, true, None).await;
    let _ = AgentClient::new(&config).end_session(&session.id).await;
    result
}

async fn helper_ui(
    api_url: String,
    relay_url: String,
    name: Option<String>,
    config_path: PathBuf,
) -> Result<()> {
    #[cfg(target_os = "windows")]
    {
        let (api_url, _fallback_relay) = helper_endpoint_defaults(api_url, relay_url);
        return run_helper_native(api_url, name, config_path).await;
    }
    #[cfg(not(target_os = "windows"))]
    {
        helper_ui_browser(api_url, relay_url, name, config_path).await
    }
}

#[cfg(target_os = "windows")]
const IDC_HELPER_CODE: i32 = 1001;
#[cfg(target_os = "windows")]
const IDC_HELPER_CONNECT: i32 = 1002;
#[cfg(target_os = "windows")]
const IDC_HELPER_BRAND: i32 = 1003;
#[cfg(target_os = "windows")]
const HELPER_TRAY_MESSAGE: u32 = WM_APP + 3;
#[cfg(target_os = "windows")]
const HELPER_TRAY_ID: u32 = 0x5248;
#[cfg(target_os = "windows")]
const WM_HELPER_HIDE: u32 = WM_APP + 2;

#[cfg(target_os = "windows")]
enum HelperEvent {
    SubmitCode(String),
    Closed,
}

#[cfg(target_os = "windows")]
struct HelperWindowState {
    submit: tokio::sync::mpsc::UnboundedSender<HelperEvent>,
    shutdown: tokio::sync::mpsc::UnboundedSender<()>,
    status: Arc<StdMutex<String>>,
    hwnd: std::sync::atomic::AtomicPtr<std::ffi::c_void>,
}

#[cfg(target_os = "windows")]
unsafe extern "system" fn helper_window_proc(
    hwnd: HWND,
    message: u32,
    wparam: WPARAM,
    lparam: LPARAM,
) -> LRESULT {
    if message == HELPER_TRAY_MESSAGE {
        let action = (lparam.0 as u32) & 0xFFFF;
        if action == WM_RBUTTONUP || action == WM_LBUTTONDBLCLK {
            if action == WM_LBUTTONDBLCLK {
                let _ = ShowWindow(hwnd, SW_SHOW);
                SetForegroundWindow(hwnd);
            } else {
                let Ok(menu) = CreatePopupMenu() else { return LRESULT(0) };
                let _ = AppendMenuW(menu, MF_STRING, TRAY_STATUS, PCWSTR(tray_wide("Connection status").as_ptr()));
                let _ = AppendMenuW(menu, MF_STRING, TRAY_DISCONNECT, PCWSTR(tray_wide("Disconnect").as_ptr()));
                let _ = AppendMenuW(menu, MF_SEPARATOR, 0, PCWSTR::null());
                let _ = AppendMenuW(menu, MF_STRING, TRAY_EXIT, PCWSTR(tray_wide("Exit ReyDesk helper").as_ptr()));
                let mut point = POINT::default();
                let _ = GetCursorPos(&mut point);
                SetForegroundWindow(hwnd);
                let selected = TrackPopupMenu(menu, TPM_RETURNCMD, point.x, point.y, 0, hwnd, None).0 as u32;
                let _ = windows::Win32::UI::WindowsAndMessaging::DestroyMenu(menu);
                match selected as usize {
                    TRAY_STATUS => {
                        let _ = MessageBoxW(hwnd, PCWSTR(tray_wide("The helper is ready for a technician code or an active support session.").as_ptr()), PCWSTR(tray_wide("ReyDesk connection status").as_ptr()), MB_SYSTEMMODAL);
                    }
                    TRAY_DISCONNECT | TRAY_EXIT => {
                        let _ = DestroyWindow(hwnd);
                    }
                    _ => {}
                }
            }
        }
        return LRESULT(0);
    }
    if message == WM_COMMAND {
        let control_id = (wparam.0 & 0xFFFF) as i32;
        if control_id == IDC_HELPER_CONNECT {
            let state = GetWindowLongPtrW(hwnd, GWLP_USERDATA) as *const HelperWindowState;
            if !state.is_null() {
                let edit = GetDlgItem(hwnd, IDC_HELPER_CODE);
                let mut buffer = [0u16; 512];
                let len = GetWindowTextW(edit, &mut buffer);
                let code = String::from_utf16_lossy(&buffer[..len as usize]);
                if let Ok(mut status) = (*state).status.lock() {
                    *status = "Connecting…".to_owned();
                }
                let _ = (*state).submit.send(HelperEvent::SubmitCode(code));
            }
        }
        return LRESULT(0);
    }
    if message == WM_HELPER_HIDE {
        let mut tray = NOTIFYICONDATAW {
            cbSize: std::mem::size_of::<NOTIFYICONDATAW>() as u32,
            hWnd: hwnd,
            uID: HELPER_TRAY_ID,
            ..Default::default()
        };
        let _ = Shell_NotifyIconW(NIM_DELETE, &mut tray);
        let _ = ShowWindow(hwnd, SW_HIDE);
        return LRESULT(0);
    }
    if message == windows::Win32::UI::WindowsAndMessaging::WM_SIZE {
        if wparam.0 == 1 {
            let _ = ShowWindow(hwnd, SW_HIDE);
        }
        return LRESULT(0);
    }
    if message == windows::Win32::UI::WindowsAndMessaging::WM_CTLCOLORSTATIC {
        let hdc = windows::Win32::Graphics::Gdi::HDC(wparam.0 as isize);
        windows::Win32::Graphics::Gdi::SetBkMode(hdc, windows::Win32::Graphics::Gdi::TRANSPARENT);
        if GetDlgItem(hwnd, IDC_HELPER_BRAND) == HWND(lparam.0) {
            windows::Win32::Graphics::Gdi::SetTextColor(hdc, windows::Win32::Foundation::COLORREF(0x003DA3E8));
        }
        return LRESULT(GetSysColorBrush(COLOR_WINDOW).0 as isize);
    }
    if message == WM_CLOSE {
        let _ = DestroyWindow(hwnd);
        return LRESULT(0);
    }
    if message == WM_DESTROY {
        let mut tray = NOTIFYICONDATAW {
            cbSize: std::mem::size_of::<NOTIFYICONDATAW>() as u32,
            hWnd: hwnd,
            uID: HELPER_TRAY_ID,
            ..Default::default()
        };
        let _ = Shell_NotifyIconW(NIM_DELETE, &mut tray);
        let state = GetWindowLongPtrW(hwnd, GWLP_USERDATA) as *const HelperWindowState;
        if !state.is_null() {
            let _ = (*state).submit.send(HelperEvent::Closed);
            let _ = (*state).shutdown.send(());
        }
        PostQuitMessage(0);
        return LRESULT(0);
    }
    DefWindowProcW(hwnd, message, wparam, lparam)
}

#[cfg(target_os = "windows")]
fn run_helper_window(
    submit: tokio::sync::mpsc::UnboundedSender<HelperEvent>,
    shutdown: tokio::sync::mpsc::UnboundedSender<()>,
    status: Arc<StdMutex<String>>,
    hwnd_out: Option<Arc<std::sync::atomic::AtomicPtr<std::ffi::c_void>>>,
) -> Result<()> {
    let class_name = tray_wide("ReyDeskHelperWindow");
    let cursor = unsafe { LoadCursorW(None, IDC_ARROW) }.unwrap_or_default();
    let class = WNDCLASSW {
        lpfnWndProc: Some(helper_window_proc),
        lpszClassName: PCWSTR(class_name.as_ptr()),
        hCursor: cursor,
        hbrBackground: unsafe { GetSysColorBrush(COLOR_WINDOW) },
        ..Default::default()
    };
    unsafe { RegisterClassW(&class) };

    let hwnd_holder = hwnd_out.unwrap_or_else(|| std::sync::Arc::new(std::sync::atomic::AtomicPtr::new(std::ptr::null_mut())));
    let hwnd_holder_for_state = hwnd_holder.clone();
    let state = Box::into_raw(Box::new(HelperWindowState {
        submit,
        shutdown,
        status: status.clone(),
        hwnd: std::sync::atomic::AtomicPtr::new(std::ptr::null_mut()),
    }));

    let title = tray_wide("ReyDesk support");
    let hwnd = unsafe {
        CreateWindowExW(
            WINDOW_EX_STYLE::default(),
            PCWSTR(class_name.as_ptr()),
            PCWSTR(title.as_ptr()),
            WS_OVERLAPPED | WS_CAPTION | WS_SYSMENU | WS_MINIMIZEBOX | WS_THICKFRAME,
            CW_USEDEFAULT,
            CW_USEDEFAULT,
            430,
            245,
            None,
            None,
            None,
            None,
        )
    };
    if hwnd.0 == 0 {
        let _ = unsafe { Box::from_raw(state) };
        return Err(anyhow!("create ReyDesk helper window failed"));
    }
    unsafe { SetWindowLongPtrW(hwnd, GWLP_USERDATA, state as isize) };

    let edit_class = tray_wide("EDIT");
    let button_class = tray_wide("BUTTON");
    let static_class = tray_wide("STATIC");
    unsafe {
        CreateWindowExW(
            WINDOW_EX_STYLE::default(),
            PCWSTR(static_class.as_ptr()),
            PCWSTR(tray_wide("ReyDesk").as_ptr()),
            WS_CHILD | WS_VISIBLE,
            28,
            16,
            360,
            24,
            hwnd,
            HMENU(IDC_HELPER_BRAND as isize),
            None,
            None,
        );
        CreateWindowExW(
            WINDOW_EX_STYLE::default(),
            PCWSTR(static_class.as_ptr()),
            PCWSTR(tray_wide("Connect securely with a technician").as_ptr()),
            WS_CHILD | WS_VISIBLE,
            28,
            44,
            360,
            22,
            hwnd,
            None,
            None,
            None,
        );
        CreateWindowExW(
            WINDOW_EX_STYLE::default(),
            PCWSTR(edit_class.as_ptr()),
            PCWSTR::null(),
            WS_CHILD | WS_VISIBLE | WS_TABSTOP | WINDOW_STYLE(ES_CENTER as u32),
            28,
            72,
            374,
            34,
            hwnd,
            HMENU(IDC_HELPER_CODE as isize),
            None,
            None,
        );
        CreateWindowExW(
            WINDOW_EX_STYLE::default(),
            PCWSTR(button_class.as_ptr()),
            PCWSTR(tray_wide("Start secure support").as_ptr()),
            WS_CHILD | WS_VISIBLE | WS_TABSTOP,
            28,
            118,
            374,
            36,
            hwnd,
            HMENU(IDC_HELPER_CONNECT as isize),
            None,
            None,
        );
        let status_hwnd = CreateWindowExW(
            WINDOW_EX_STYLE::default(),
            PCWSTR(static_class.as_ptr()),
            PCWSTR(tray_wide("Enter your technician's 12-digit code to begin.").as_ptr()),
            WS_CHILD | WS_VISIBLE,
            28,
            174,
            374,
            22,
            hwnd,
            None,
            None,
            None,
        );
        let mut tray = NOTIFYICONDATAW {
            cbSize: std::mem::size_of::<NOTIFYICONDATAW>() as u32,
            hWnd: hwnd,
            uID: HELPER_TRAY_ID,
            uFlags: NIF_ICON | NIF_MESSAGE | NIF_TIP,
            uCallbackMessage: HELPER_TRAY_MESSAGE,
            hIcon: LoadIconW(None, IDI_APPLICATION).unwrap_or_default(),
            ..Default::default()
        };
        let tip = tray_wide("ReyDesk support helper");
        let tip_len = tip.len().saturating_sub(1).min(tray.szTip.len().saturating_sub(1));
        tray.szTip[..tip_len].copy_from_slice(&tip[..tip_len]);
        let _ = Shell_NotifyIconW(NIM_ADD, &mut tray);
        ShowWindow(hwnd, SW_SHOW);
        // Store HWND so the async task can close this window after claim
        hwnd_holder_for_state.store(hwnd.0 as *mut _, std::sync::atomic::Ordering::SeqCst);
        (*state).hwnd.store(hwnd.0 as *mut _, std::sync::atomic::Ordering::SeqCst);

        let status_thread = status;
        thread::spawn(move || {
            let mut previous = String::new();
            loop {
                let current = status_thread
                    .lock()
                    .map(|value| value.clone())
                    .unwrap_or_default();
                if current != previous {
                    let wide = tray_wide(&current);
                    let _ = SetWindowTextW(status_hwnd, PCWSTR(wide.as_ptr()));
                    previous = current;
                }
                thread::sleep(Duration::from_millis(200));
            }
        });

        let mut message = MSG::default();
        loop {
            let result = GetMessageW(&mut message, None, 0, 0);
            if result.0 <= 0 {
                break;
            }
            TranslateMessage(&message);
            DispatchMessageW(&message);
        }
        let _ = Shell_NotifyIconW(NIM_DELETE, &mut tray);
        let _ = Box::from_raw(state);
    }
    Ok(())
}

#[cfg(target_os = "windows")]
async fn run_helper_native(
    api_url: String,
    name: Option<String>,
    config_path: PathBuf,
) -> Result<()> {
    let (submit, mut receiver) = tokio::sync::mpsc::unbounded_channel::<HelperEvent>();
    let (shutdown_tx, _shutdown_rx) = tokio::sync::mpsc::unbounded_channel::<()>();
    let status = Arc::new(StdMutex::new("Enter your technician's 12-digit code to begin.".to_owned()));
    let hwnd_holder: Arc<std::sync::atomic::AtomicPtr<std::ffi::c_void>> = Arc::new(std::sync::atomic::AtomicPtr::new(std::ptr::null_mut()));

    let window_submit = submit.clone();
    let window_status = status.clone();
    let hwnd_clone = hwnd_holder.clone();
    let window = tokio::task::spawn_blocking(move || {
        run_helper_window(window_submit, shutdown_tx, window_status, Some(hwnd_clone))
    });
    drop(submit);

    while let Some(event) = receiver.recv().await {
        match event {
            HelperEvent::Closed => break,
            HelperEvent::SubmitCode(raw) => {
                let parsed = parse_support_input(&raw);
                let (code, claim_token) = match parsed {
                    Ok(value) => value,
                    Err(error) => {
                        if let Ok(mut current) = status.lock() {
                            *current = error.to_string();
                        }
                        continue;
                    }
                };
                let fingerprint = claim_token.as_ref().map(|_| new_claim_fingerprint());
                match claim_and_save(
                    api_url.clone(),
                    String::new(),
                    code.clone(),
                    claim_token,
                    fingerprint,
                    name.clone(),
                    config_path.clone(),
                )
                .await
                {
                    Ok((session, config)) => {
                        // Close the code-entry window. Its WM_DESTROY sends a
                        // shutdown signal on the *code window* channel; the agent
                        // below uses its own channel so this close cannot kill it.
                        let ptr = hwnd_holder.load(std::sync::atomic::Ordering::SeqCst);
                        if !ptr.is_null() {
                            unsafe {
                                let _ = windows::Win32::UI::WindowsAndMessaging::PostMessageW(
                                    HWND(ptr as isize),
                                    WM_HELPER_HIDE, WPARAM(0), LPARAM(0),
                                );
                            }
                        }
                        // The entry window stays hidden while the native
                        // session/consent UI runs. Awaiting it here would block
                        // the agent and prevent the consent window from opening.

                        // The session window (Disconnect / Exit / X) is the only
                        // thing that stops the agent.
                        let (agent_shutdown_tx, agent_shutdown_rx) = tokio::sync::mpsc::unbounded_channel::<()>();
                        helper_ui::windows_ui::set_session_shutdown(agent_shutdown_tx);

                        // Open the session management window on a background thread
                        let session_id = session.id.clone();
                        let session_window = tokio::task::spawn_blocking(move || {
                            if let Err(error) = helper_ui::windows_ui::run_session_window(&session_id) {
                                eprintln!("[session-window] {error:#}");
                            }
                        });

                        // Run the agent (consent, relay, chat, telemetry) until
                        // the technician ends the session or the user closes the
                        // session window.
                        let agent_task = tokio::spawn(run_agent(config_path.clone(), None, true, Some(agent_shutdown_rx)));
                        tokio::select! {
                            agent_result = agent_task => {
                                // Technician ended the session; close the UI window.
                                helper_ui::windows_ui::close_session_window();
                                agent_result.context("agent task failed")??;
                                let _ = AgentClient::new(&config).end_session(&session.id).await;
                                let ptr = hwnd_holder.load(std::sync::atomic::Ordering::SeqCst);
                                if !ptr.is_null() {
                                    let _ = unsafe { windows::Win32::UI::WindowsAndMessaging::PostMessageW(HWND(ptr as isize), WM_CLOSE, WPARAM(0), LPARAM(0)) };
                                }
                                let _ = window.await;
                                return Ok(());
                            }
                            _ = session_window => {
                                // User closed the window; the shutdown signal has
                                // already told the agent to stop. End the session
                                // server-side as a final cleanup.
                                let _ = AgentClient::new(&config).end_session(&session.id).await;
                                let ptr = hwnd_holder.load(std::sync::atomic::Ordering::SeqCst);
                                if !ptr.is_null() {
                                    let _ = unsafe { windows::Win32::UI::WindowsAndMessaging::PostMessageW(HWND(ptr as isize), WM_CLOSE, WPARAM(0), LPARAM(0)) };
                                }
                                let _ = window.await;
                                return Ok(());
                            }
                        }
                    }
                    Err(error) => {
                        // The code may already be claimed by the browser companion
                        // page — attach as the streaming engine instead of failing.
                        match agent_join(&api_url, &code).await {
                            Ok(joined) => {
                                if let Ok(mut current) = status.lock() {
                                    *current = "Connecting to your support session…".to_owned();
                                }
                                let ptr = hwnd_holder.load(std::sync::atomic::Ordering::SeqCst);
                                if !ptr.is_null() {
                                    unsafe {
                                        let _ = unsafe { windows::Win32::UI::WindowsAndMessaging::PostMessageW(
                                            HWND(ptr as isize),
                                            WM_HELPER_HIDE, WPARAM(0), LPARAM(0),
                                        ) };
                                    }
                                }
                                // Keep the hidden entry window's message loop
                                // alive while the streamer session runs.
                                let (agent_shutdown_tx, agent_shutdown_rx) = tokio::sync::mpsc::unbounded_channel::<()>();
                                helper_ui::windows_ui::set_session_shutdown(agent_shutdown_tx);

                                let stream_session_id = joined.session_id.clone();
                                let session_window = tokio::task::spawn_blocking(move || {
                                    if let Err(error) = helper_ui::windows_ui::run_session_window(&stream_session_id) {
                                        eprintln!("[session-window] {error:#}");
                                    }
                                });
                                let agent_task = tokio::spawn(run_streamer(api_url.clone(), code.clone(), Some(agent_shutdown_rx)));
                                tokio::select! {
                                    agent_result = agent_task => {
                                        helper_ui::windows_ui::close_session_window();
                                            agent_result.context("streamer task failed")??;
                                        let ptr = hwnd_holder.load(std::sync::atomic::Ordering::SeqCst);
                                        if !ptr.is_null() {
                                            let _ = unsafe { windows::Win32::UI::WindowsAndMessaging::PostMessageW(HWND(ptr as isize), WM_CLOSE, WPARAM(0), LPARAM(0)) };
                                        }
                                        let _ = window.await;
                                        return Ok(());
                                    }
                                    _ = session_window => {
                                        let ptr = hwnd_holder.load(std::sync::atomic::Ordering::SeqCst);
                                        if !ptr.is_null() {
                                            let _ = unsafe { windows::Win32::UI::WindowsAndMessaging::PostMessageW(HWND(ptr as isize), WM_CLOSE, WPARAM(0), LPARAM(0)) };
                                        }
                                        let _ = window.await;
                                        return Ok(());
                                    }
                                }
                            }
                            Err(_) => {
                                if let Ok(mut current) = status.lock() {
                                    *current = format!("Connection failed: {error}");
                                }
                            }
                        }
                    }
                }
            }
        }
    }
    let _ = window.await;
    Ok(())
}

#[cfg(not(target_os = "windows"))]
fn helper_html(message: Option<&str>) -> String {
    let notice = message
        .map(|message| format!("<div class=notice>{}</div>", html_escape(message)))
        .unwrap_or_default();
    format!(
        r#"<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>ReyDesk support</title>
<style>body{{font-family:Segoe UI,sans-serif;background:#f4f7fb;color:#182230;margin:0;padding:32px}}main{{max-width:560px;margin:auto;background:white;border:1px solid #d9e2ef;border-radius:14px;padding:28px;box-shadow:0 8px 28px #12263b18}}h1{{margin-top:0}}label{{display:block;margin:16px 0 6px;font-weight:600}}input{{box-sizing:border-box;width:100%;padding:11px;border:1px solid #b9c7d8;border-radius:8px;font:inherit}}button{{margin-top:24px;padding:11px 18px;background:#1769e0;color:#fff;border:0;border-radius:8px;font-weight:600;cursor:pointer}}.muted{{color:#64748b;font-size:.94rem}}.notice{{background:#eef6ff;border:1px solid #b9dcff;border-radius:8px;padding:12px;margin-bottom:18px}}</style></head>
<body><main><h1>ReyDesk support</h1><p class=muted>Enter the 12-digit technician code or paste the complete secure link your technician gave you. No installation or login is needed.</p>{notice}
<form method=post action=/connect><label for=code>12-digit technician code or secure link</label><input id=code name=code placeholder="123456789012 or https://…" autocomplete=one-time-code autofocus required><button type=submit>Start secure support</button></form></main></body></html>"#,
        notice = notice,
    )
}

#[cfg(not(target_os = "windows"))]
async fn helper_ui_browser(
    api_url: String,
    relay_url: String,
    name: Option<String>,
    config_path: PathBuf,
) -> Result<()> {
    let (api_url, _fallback_relay) = helper_endpoint_defaults(api_url, relay_url);
    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .context("bind local helper UI")?;
    let address = listener.local_addr().context("read helper UI address")?;
    let url = format!("http://{address}/");
    println!("Opening ReyDesk helper UI at {url}");
    open_enrollment_browser(&url)?;

    loop {
        let (mut stream, _) = listener
            .accept()
            .await
            .context("accept helper UI request")?;
        let mut buffer = vec![0_u8; 64 * 1024];
        let bytes = stream
            .read(&mut buffer)
            .await
            .context("read helper UI request")?;
        let request = String::from_utf8_lossy(&buffer[..bytes]);
        if request.starts_with("GET ") {
            http_response(stream, "200 OK", helper_html(None)).await?;
            continue;
        }
        if !request.starts_with("POST /connect ") {
            http_response(
                stream,
                "404 Not Found",
                helper_html(Some("Unknown request.")),
            )
            .await?;
            continue;
        }
        let Some(body) = request.split_once("\r\n\r\n").map(|(_, body)| body) else {
            http_response(
                stream,
                "400 Bad Request",
                helper_html(Some("Invalid form submission.")),
            )
            .await?;
            continue;
        };
        let fields = parse_form(body.trim());
        let code = fields
            .get("code")
            .map(|value| {
                value
                    .chars()
                    .filter(|character| !character.is_whitespace())
                    .collect::<String>()
            })
            .unwrap_or_default();
        if code.trim().is_empty() {
            http_response(
                stream,
                "400 Bad Request",
                helper_html(Some("Support code is required.")),
            )
            .await?;
            continue;
        }
        let parsed = parse_support_input(&code)
            .map_err(|error| anyhow!("support input rejected: {error}"));
        let (code, claim_token) = match parsed {
            Ok(value) => value,
            Err(error) => {
                http_response(stream, "400 Bad Request", helper_html(Some(&error.to_string()))).await?;
                continue;
            }
        };
        let fingerprint = claim_token.as_ref().map(|_| new_claim_fingerprint());
        match claim_and_save(
            api_url.clone(),
            String::new(),
            code,
            claim_token,
            fingerprint,
            name.clone(),
            config_path.clone(),
        )
        .await
        {
            Ok((session, config)) => {
                let page = format(
                    "<!doctype html><meta charset=utf-8><title>ReyDesk connected</title><h1>Support session {}</h1><p>You can close this window. A consent prompt will appear when your technician requests access.</p>",
                    html_escape(&session.state)
                );
                http_response(stream, "200 OK", page).await?;
                println!(
                    "Support session {} ({}) — keep this window open; close it to end the helper.",
                    session.id, session.state
                );
                let result = run_agent(config_path, None, true, None).await;
                let _ = AgentClient::new(&config).end_session(&session.id).await;
                result?;
                return Ok(());
            }
            Err(error) => {
                http_response(
                    stream,
                    "400 Bad Request",
                    helper_html(Some(&format!("Connection failed: {error}"))),
                )
                .await?;
            }
        }
    }
}

fn show_consent_prompt(message: &str) -> Result<bool> {
    #[cfg(target_os = "windows")]
    {
        let prompt = message
            .encode_utf16()
            .chain(std::iter::once(0))
            .collect::<Vec<_>>();
        let title = "ReyDesk remote-support consent"
            .encode_utf16()
            .chain(std::iter::once(0))
            .collect::<Vec<_>>();
        let result = unsafe {
            MessageBoxW(
                None,
                PCWSTR(prompt.as_ptr()),
                PCWSTR(title.as_ptr()),
                MB_YESNO | MB_ICONQUESTION | MB_SYSTEMMODAL,
            )
        };
        return Ok(result == IDYES);
    }

    #[cfg(not(target_os = "windows"))]
    {
        if !io::stdin().is_terminal() {
            return Ok(false);
        }
        print!("{message}\n\nAllow? [y/N]: ");
        io::stdout().flush().context("flush consent prompt")?;
        let mut answer = String::new();
        io::stdin()
            .read_line(&mut answer)
            .context("read consent response")?;
        Ok(matches!(
            answer.trim().to_ascii_lowercase().as_str(),
            "y" | "yes"
        ))
    }
}

fn is_elevated_permission(permission: &str) -> bool {
    matches!(permission, "elevation" | "terminal" | "system_manage")
}

fn session_consent_prompt(session: &AgentSession) -> Result<bool> {
    let permissions: Vec<&str> = session
        .permissions
        .iter()
        .filter(|permission| !is_elevated_permission(permission.as_str()))
        .map(String::as_str)
        .collect();
    let permissions = if permissions.is_empty() {
        "view_screen".to_owned()
    } else {
        permissions.join(", ")
    };
    let message = format!(
        "ReyDesk is requesting remote support for this endpoint.\n\nReason: {}\nRequested permissions: {}\n\nAllow this session?",
        if session.reason.is_empty() { "Not provided" } else { &session.reason },
        permissions,
    );
    show_consent_prompt(&message)
}

fn session_elevation_prompt(session: &AgentSession) -> Result<bool> {
    let capabilities: Vec<&str> = session
        .permissions
        .iter()
        .filter(|permission| matches!(permission.as_str(), "terminal" | "system_manage"))
        .map(|permission| match permission.as_str() {
            "terminal" => "terminal access",
            "system_manage" => "process/service management",
            _ => permission.as_str(),
        })
        .collect();
    let capabilities = capabilities.join(", ");
    let message = format!(
        "ReyDesk is requesting ELEVATED access to this endpoint.\n\nElevated capabilities: {}\n\nThis grants full system privileges for the session. If you decline, the session will continue with screen sharing only.\n\nAllow elevated access?",
        capabilities,
    );
    show_consent_prompt(&message)
}

#[derive(Clone)]
enum ConsentDecision {
    Denied,
    Granted,
    GrantedWithoutElevation(Vec<String>),
}

fn decide_consent(session: &AgentSession) -> Result<ConsentDecision> {
    #[cfg(target_os = "windows")]
    {
        return helper_ui::windows_ui::show_consent_window(session);
    }
    #[cfg(not(target_os = "windows"))]
    {
        if !session_consent_prompt(session)? {
            return Ok(ConsentDecision::Denied);
        }
        let wants_elevation = session
            .permissions
            .iter()
            .any(|permission| permission == "elevation");
        if !wants_elevation {
            return Ok(ConsentDecision::Granted);
        }
        if session_elevation_prompt(session)? {
            return Ok(ConsentDecision::Granted);
        }
        let reduced = session
            .permissions
            .iter()
            .filter(|permission| !is_elevated_permission(permission.as_str()))
            .cloned()
            .collect();
        Ok(ConsentDecision::GrantedWithoutElevation(reduced))
    }
}

/// The mailbox is a per-session set of JSON files shared between the Windows
/// service (which owns the relay connection) and the logged-in-user tray helper
/// (which owns the visible chat UI). Incoming technician messages land in
/// `<session_id>.inbox.<stamp>.json`; endpoint replies land in
/// `<session_id>.outbox.<stamp>.json` and are drained by the service, which
/// persists them via the API and relays them to the technician in real time.
fn chat_mailbox_dir() -> PathBuf {
    #[cfg(target_os = "windows")]
    {
        let program_data = std::env::var("ProgramData")
            .ok()
            .filter(|value| !value.trim().is_empty())
            .unwrap_or_else(|| "C:\\ProgramData".to_owned());
        return PathBuf::from(program_data).join("ReyDesk").join("chat");
    }
    #[cfg(not(target_os = "windows"))]
    {
        std::env::temp_dir().join("deskos-chat")
    }
}

fn mailbox_stamp() -> u128 {
    static SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or(0);
    let seq = SEQ.fetch_add(1, Ordering::Relaxed) as u128;
    nanos ^ (seq << 1)
}

fn write_mailbox_message(
    dir: &Path,
    session_id: &str,
    kind: &str,
    value: &serde_json::Value,
) -> Result<()> {
    fs::create_dir_all(dir)
        .with_context(|| format!("create chat mailbox directory {}", dir.display()))?;
    let path = dir.join(format!("{session_id}.{kind}.{}.json", mailbox_stamp()));
    fs::write(
        &path,
        serde_json::to_vec(value).context("serialize chat mailbox message")?,
    )
    .with_context(|| format!("write chat mailbox message {}", path.display()))?;
    Ok(())
}

fn read_mailbox_messages(
    dir: &Path,
    session_id: &str,
    kind: &str,
) -> Vec<(PathBuf, serde_json::Value)> {
    let Ok(entries) = fs::read_dir(dir) else {
        return Vec::new();
    };
    let prefix = format!("{session_id}.{kind}.");
    let mut messages = Vec::new();
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        if !name.starts_with(&prefix) || !name.ends_with(".json") {
            continue;
        }
        let contents = match fs::read(entry.path()) {
            Ok(contents) => contents,
            Err(_) => continue,
        };
        match serde_json::from_slice::<serde_json::Value>(&contents) {
            Ok(value) => messages.push((entry.path(), value)),
            Err(_) => {
                // Drop corrupt files so they don't stall the mailbox forever.
                let _ = fs::remove_file(entry.path());
            }
        }
    }
    messages.sort_by_key(|(path, _)| {
        path.file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_default()
    });
    messages
}

fn remove_mailbox_message(path: &Path) {
    let _ = fs::remove_file(path);
}

fn clear_chat_mailbox(dir: &Path, session_id: &str) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    let prefix = format!("{session_id}.");
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        if name.starts_with(&prefix) {
            let _ = fs::remove_file(entry.path());
        }
    }
}

/// Cancels the outbox drain task when the relay connection tears down, so a
/// reconnect starts a fresh drain on the new socket.
struct RelayDrainGuard(watch::Sender<bool>);

impl Drop for RelayDrainGuard {
    fn drop(&mut self) {
        let _ = self.0.send(true);
    }
}

async fn drain_chat_outbox(
    session_id: String,
    writer: SharedRelayWriter,
    client: Arc<AgentClient>,
    mut cancel: watch::Receiver<bool>,
) {
    let dir = chat_mailbox_dir();
    let mut ticker = interval(Duration::from_millis(750));
    ticker.set_missed_tick_behavior(MissedTickBehavior::Delay);
    loop {
        tokio::select! {
            _ = ticker.tick() => {}
            _ = cancel.changed() => break,
        }
        for (path, value) in read_mailbox_messages(&dir, &session_id, "outbox") {
            let Some(body) = value.get("body").and_then(serde_json::Value::as_str) else {
                remove_mailbox_message(&path);
                continue;
            };
            let body = body.trim();
            if body.is_empty() {
                remove_mailbox_message(&path);
                continue;
            }
            // Persist durably first so a dropped relay never loses the reply.
            // Persistence is best-effort: in streamer mode there is no device
            // identity, so the relay must still deliver even when persist fails.
            if let Err(error) = client.send_chat(&session_id, body).await {
                eprintln!("[chat] persist reply: {error:#}");
            }
            if let Err(error) =
                send_relay(&writer, serde_json::json!({ "type": "chat", "body": body })).await
            {
                eprintln!("[chat] relay reply: {error:#}");
                continue;
            }
            remove_mailbox_message(&path);
        }
    }
}

async fn spawn_relay_task(
    config: AgentConfig,
    response: SessionResponse,
    client: AgentClient,
    relay_tasks: Arc<Mutex<HashSet<String>>>,
) {
    let Some(ticket) = response.join_token else {
        return;
    };
    let session_id = response.session.id.clone();
    let mut tasks = relay_tasks.lock().await;
    if !tasks.insert(session_id.clone()) {
        return;
    }
    drop(tasks);
    let permissions = response.session.permissions;
    tokio::spawn(async move {
        if let Err(error) = connect_relay(
            &config,
            &session_id,
            &ticket,
            &permissions,
            Arc::new(client),
        )
        .await
        {
            eprintln!("session {session_id}: {error:#}");
        }
        relay_tasks.lock().await.remove(&session_id);
    });
}

#[cfg(target_os = "windows")]
#[derive(Debug)]
struct FleetBootstrap {
    api_url: String,
    relay_url: String,
    token: String,
}

#[cfg(target_os = "windows")]
fn load_fleet_bootstrap() -> Option<FleetBootstrap> {
    let hklm = RegKey::predef(HKEY_LOCAL_MACHINE);
    let key = hklm.open_subkey("Software\\DeskOS\\Enrollment").ok()?;
    let token: String = key.get_value("Token").ok()?;
    if token.trim().is_empty() {
        return None;
    }
    let api_url: String = key
        .get_value("ApiUrl")
        .unwrap_or_else(|_| "http://localhost:4000".to_owned());
    let relay_url: String = key
        .get_value("RelayUrl")
        .unwrap_or_else(|_| "ws://localhost:4100/ws".to_owned());
    Some(FleetBootstrap {
        api_url,
        relay_url,
        token,
    })
}

#[cfg(target_os = "windows")]
fn clear_fleet_bootstrap() {
    let hklm = RegKey::predef(HKEY_LOCAL_MACHINE);
    if let Ok(key) =
        hklm.open_subkey_with_flags("Software\\DeskOS\\Enrollment", winreg::enums::KEY_WRITE)
    {
        let _ = key.delete_value("Token");
        let _ = key.delete_value("ApiUrl");
        let _ = key.delete_value("RelayUrl");
    }
}

fn enrollment_endpoints(api_url: String, relay_url: String) -> (String, String) {
    #[cfg(target_os = "windows")]
    {
        let hklm = RegKey::predef(HKEY_LOCAL_MACHINE);
        if let Ok(key) = hklm.open_subkey("Software\\DeskOS\\Enrollment") {
            let configured_api: Option<String> = key
                .get_value("ApiUrl")
                .ok()
                .filter(|value: &String| !value.trim().is_empty());
            let configured_relay: Option<String> = key
                .get_value("RelayUrl")
                .ok()
                .filter(|value: &String| !value.trim().is_empty());
            return (
                if api_url.trim().is_empty() {
                    configured_api.unwrap_or_else(|| "http://localhost:4000".to_owned())
                } else {
                    api_url
                },
                if relay_url.trim().is_empty() {
                    configured_relay.unwrap_or_else(|| "ws://localhost:4100/ws".to_owned())
                } else {
                    relay_url
                },
            );
        }
    }
    (
        if api_url.trim().is_empty() {
            "http://localhost:4000".to_owned()
        } else {
            api_url
        },
        if relay_url.trim().is_empty() {
            "ws://localhost:4100/ws".to_owned()
        } else {
            relay_url
        },
    )
}

/// Resolve the portable helper's endpoints: explicit flag → build-time baked
/// default → fleet registry → localhost. This lets a deployment ship a helper
/// whose users only ever enter the 10–12 digit support code.
fn helper_endpoint_defaults(api_url: String, relay_url: String) -> (String, String) {
    let (registry_api, registry_relay) = enrollment_endpoints(String::new(), String::new());
    (
        if !api_url.trim().is_empty() {
            api_url
        } else if !BAKED_API_URL.is_empty() {
            BAKED_API_URL.to_owned()
        } else {
            registry_api
        },
        if !relay_url.trim().is_empty() {
            relay_url
        } else if !BAKED_RELAY_URL.is_empty() {
            BAKED_RELAY_URL.to_owned()
        } else {
            registry_relay
        },
    )
}

fn endpoint_is_local(url: &reqwest::Url) -> bool {
    matches!(url.host_str(), Some("localhost" | "127.0.0.1" | "[::1]" | "::1"))
}

fn validate_endpoint(raw: &str, relay: bool) -> Result<()> {
    let parsed = reqwest::Url::parse(raw).with_context(|| format!("invalid {} endpoint", if relay { "relay" } else { "API" }))?;
    let secure_scheme = if relay { parsed.scheme() == "wss" } else { parsed.scheme() == "https" };
    if !secure_scheme && !endpoint_is_local(&parsed) {
        return Err(anyhow!(
            "refusing insecure {} endpoint {}; use {} outside localhost",
            if relay { "relay" } else { "API" },
            raw,
            if relay { "wss://" } else { "https://" },
        ));
    }
    Ok(())
}

fn validate_endpoints(api_url: &str, relay_url: &str) -> Result<()> {
    validate_endpoint(api_url, false)?;
    validate_endpoint(relay_url, true)
}

fn html_escape(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&#39;")
}

fn decode_form_component(value: &str) -> String {
    let mut bytes = Vec::with_capacity(value.len());
    let mut chars = value.as_bytes().iter().copied();
    while let Some(byte) = chars.next() {
        match byte {
            b'+' => bytes.push(b' '),
            b'%' => {
                let high = chars.next().and_then(|value| (value as char).to_digit(16));
                let low = chars.next().and_then(|value| (value as char).to_digit(16));
                if let (Some(high), Some(low)) = (high, low) {
                    bytes.push(((high << 4) | low) as u8);
                }
            }
            _ => bytes.push(byte),
        }
    }
    String::from_utf8_lossy(&bytes).into_owned()
}

fn parse_form(body: &str) -> std::collections::HashMap<String, String> {
    body.split('&')
        .filter_map(|pair| {
            let (key, value) = pair.split_once('=')?;
            Some((key.to_owned(), decode_form_component(value)))
        })
        .collect()
}

fn enrollment_html(message: Option<&str>) -> String {
    let notice = message
        .map(|message| format!("<div class=notice>{}</div>", html_escape(message)))
        .unwrap_or_default();
    format!(
        r#"<!doctype html><html><head><meta charset="utf-8"><title>ReyDesk enrollment</title>
<style>body{{font-family:Segoe UI,sans-serif;background:#f4f7fb;color:#182230;margin:0;padding:32px}}main{{max-width:560px;margin:auto;background:white;border:1px solid #d9e2ef;border-radius:14px;padding:28px;box-shadow:0 8px 28px #12263b18}}h1{{margin-top:0}}label{{display:block;margin:16px 0 6px;font-weight:600}}input{{box-sizing:border-box;width:100%;padding:11px;border:1px solid #b9c7d8;border-radius:8px;font:inherit}}button{{margin-top:24px;padding:11px 18px;background:#1769e0;color:#fff;border:0;border-radius:8px;font-weight:600;cursor:pointer}}.muted{{color:#64748b;font-size:.94rem}}.notice{{background:#eef6ff;border:1px solid #b9dcff;border-radius:8px;padding:12px;margin-bottom:18px}}</style></head>
<body><main><h1>Connect this device to ReyDesk</h1><p class=muted>Enter the one-time enrollment code provided by your IT technician. The ReyDesk connection settings are already configured for this installer.</p>{notice}
<form method=post action=/enroll><label for=token>Enrollment code (12 digits)</label><input id=token name=token inputmode=numeric pattern="[0-9]{{12}}" maxlength=12 placeholder="123456789012" autocomplete=one-time-code autofocus required><button type=submit>Enroll this device</button></form></main></body></html>"#,
        notice = notice,
    )
}

async fn http_response(
    mut stream: tokio::net::TcpStream,
    status: &str,
    body: String,
) -> Result<()> {
    let response = format!(
        "HTTP/1.1 {status}\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
        body.len(),
        body,
    );
    stream
        .write_all(response.as_bytes())
        .await
        .context("write enrollment UI response")?;
    Ok(())
}

async fn http_json_response(
    mut stream: tokio::net::TcpStream,
    status: &str,
    body: String,
) -> Result<()> {
    let response = format!(
        "HTTP/1.1 {status}\r\nContent-Type: application/json; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
        body.len(),
        body,
    );
    stream
        .write_all(response.as_bytes())
        .await
        .context("write JSON response")?;
    Ok(())
}

fn parse_query(query: &str) -> std::collections::HashMap<String, String> {
    query
        .split('&')
        .filter(|pair| !pair.is_empty())
        .filter_map(|pair| {
            let (key, value) = pair.split_once('=')?;
            Some((key.to_owned(), decode_form_component(value)))
        })
        .collect()
}

fn request_body(request: &str) -> &str {
    match request.find("\r\n\r\n") {
        Some(position) => &request[position + 4..],
        None => "",
    }
}

fn list_inbox_messages(session_id: &str) -> Vec<serde_json::Value> {
    read_mailbox_messages(&chat_mailbox_dir(), session_id, "inbox")
        .into_iter()
        .map(|(_, value)| value)
        .collect()
}

fn chat_page_html(session_id: &str) -> String {
    const PAGE: &str = r#"<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>ReyDesk support chat</title>
<style>:root{font-family:Segoe UI,system-ui,sans-serif;color:#172033;background:#f4f7fb}*{box-sizing:border-box}body{margin:0;min-height:100vh;padding:28px 18px;background:radial-gradient(circle at top right,#e7f1ff 0,#f4f7fb 42%,#eef3f8 100%)}main{max-width:720px;margin:auto;background:#fff;border:1px solid #d9e2ef;border-radius:18px;box-shadow:0 16px 42px #17324d18;overflow:hidden}.header{padding:24px 26px 20px;border-bottom:1px solid #e5ebf2;display:flex;align-items:flex-start;justify-content:space-between;gap:18px}.eyebrow{color:#1769e0;font-size:.72rem;font-weight:700;letter-spacing:.1em;text-transform:uppercase}.title{margin:5px 0 4px;font-size:1.35rem;line-height:1.2}.subtitle{margin:0;color:#64748b;font-size:.9rem}.badge{flex:0 0 auto;display:inline-flex;align-items:center;gap:7px;padding:7px 10px;border-radius:999px;background:#eefaf2;color:#197044;font-size:.78rem;font-weight:600}.badge:before{content:"";width:7px;height:7px;border-radius:50%;background:#2ca66f}.content{padding:20px 26px 24px}.privacy{margin:0 0 14px;color:#64748b;font-size:.78rem}.privacy strong{color:#334155}#log{display:flex;flex-direction:column;gap:10px;background:#f8fafc;border:1px solid #d9e2ef;border-radius:12px;padding:14px;min-height:230px;max-height:430px;overflow:auto}#log .row{padding:10px 12px;border-radius:11px;white-space:pre-wrap;word-break:break-word;line-height:1.45;box-shadow:0 1px 1px #17324d0b}#log .tech{align-self:flex-start;max-width:86%;background:#eef6ff;border:1px solid #b9dcff}#log .agent{align-self:flex-end;max-width:86%;background:#eefaf2;border:1px solid #bfe6cf}#log .muted{align-self:center;color:#64748b;font-size:.86rem}.who{font-size:.72rem;color:#64748b;display:block;margin-bottom:3px;font-weight:600}.composer{margin-top:14px}.composer-label{display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;color:#334155;font-size:.82rem;font-weight:600}.counter{color:#94a3b8;font-weight:400}textarea{display:block;box-sizing:border-box;width:100%;min-height:84px;padding:12px 13px;border:1px solid #b9c7d8;border-radius:10px;font:inherit;line-height:1.45;resize:vertical;color:#172033;background:#fff}textarea:focus{outline:2px solid #8fc4ff;outline-offset:1px;border-color:#1769e0}.composer-foot{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-top:9px}.hint{color:#94a3b8;font-size:.75rem}button{padding:10px 18px;background:#1769e0;color:#fff;border:0;border-radius:9px;font-weight:600;cursor:pointer;box-shadow:0 3px 8px #1769e033}button:hover{background:#1258be}button:disabled{opacity:.55;cursor:not-allowed;box-shadow:none}#status{min-height:1.2em;margin-top:10px;color:#1769e0;font-size:.82rem}@media(max-width:560px){body{padding:0}.header{padding:20px}.content{padding:16px 20px 20px}.badge{font-size:0;padding:9px}.badge:before{margin:0}.title{font-size:1.2rem}}</style></head>
<body><main><header class="header"><div><div class="eyebrow">ReyDesk assisted support</div><h1 class="title">Chat with your technician</h1><p style="color:#64748b">Ask questions, share updates, and confirm when you are ready.</p></div><span class="badge">Secure session</span></header><section class="content"><p class="privacy"><strong>This conversation is private to your support session.</strong> Keep this window open while the technician is helping you.</p><div id="log">Loading&hellip;</div><form class="composer" id="reply"><textarea id="body" placeholder="Type your reply&hellip;"></textarea><button type="submit">Send reply</button></form><div id="status"></div></section></main>
<script>const SESSION="__SESSION__";function esc(s){var d=document.createElement("div");d.textContent=s;return d.innerHTML}async function load(){try{var res=await fetch("/chat/messages?session="+encodeURIComponent(SESSION));var msgs=await res.json();var log=document.getElementById("log");log.innerHTML=msgs.length===0?'<span class="muted">No messages yet.</span>':msgs.map(function(m){return '<div class="row '+(m.from==="technician"?"tech":"agent")+'"><span class="who">'+(m.from==="technician"?"Technician":"You")+'</span>'+esc(m.body)+'</div>'}).join("")}catch(e){}}document.getElementById("reply").addEventListener("submit",async function(ev){ev.preventDefault();var body=document.getElementById("body").value.trim();if(!body)return;var status=document.getElementById("status");status.textContent="Sending&hellip;";try{var res=await fetch("/chat/reply",{method:"POST",headers:{"Content-Type":"application/x-www-form-urlencoded"},body:"session="+encodeURIComponent(SESSION)+"&body="+encodeURIComponent(body)});if(res.ok){document.getElementById("body").value="";status.textContent="Sent.";load()}else{status.textContent="Could not send your reply."}}catch(e){status.textContent="Could not send your reply."}});setInterval(load,2000);load();</script></body></html>"#;
    PAGE.replace("__SESSION__", &html_escape(session_id))
}

async fn handle_chat_request(mut stream: tokio::net::TcpStream) -> Result<()> {
    let mut buffer = [0_u8; 64 * 1024];
    let read = stream
        .read(&mut buffer)
        .await
        .context("read chat UI request")?;
    if read == 0 {
        return Ok(());
    }
    let request = String::from_utf8_lossy(&buffer[..read]).into_owned();
    let mut lines = request.lines();
    let request_line = lines.next().unwrap_or_default();
    let mut parts = request_line.split_whitespace();
    let method = parts.next().unwrap_or_default();
    let target = parts.next().unwrap_or_default();
    let (path, query) = match target.split_once('?') {
        Some((path, query)) => (path, query),
        None => (target, ""),
    };
    let params = parse_query(query);
    let session_id = params
        .get("session")
        .map(String::as_str)
        .unwrap_or_default();

    match (method, path) {
        ("GET", "/chat") => http_response(stream, "200 OK", chat_page_html(session_id)).await,
        ("GET", "/chat/messages") => {
            let messages = list_inbox_messages(session_id);
            let body = serde_json::to_string(&messages).unwrap_or_else(|_| "[]".to_owned());
            http_json_response(stream, "200 OK", body).await
        }
        ("POST", "/chat/reply") => {
            let form = parse_form(request_body(&request));
            let reply_session = form
                .get("session")
                .map(String::as_str)
                .unwrap_or(session_id);
            let body = form
                .get("body")
                .map(String::as_str)
                .unwrap_or_default()
                .trim()
                .to_owned();
            if reply_session.is_empty() || body.is_empty() {
                http_response(
                    stream,
                    "400 Bad Request",
                    "A session and a non-empty reply are required.".to_owned(),
                )
                .await
            } else {
                if let Err(error) = write_mailbox_message(
                    &chat_mailbox_dir(),
                    reply_session,
                    "outbox",
                    &serde_json::json!({ "body": body, "ts": mailbox_stamp() }),
                ) {
                    eprintln!("[chat] write outbox: {error:#}");
                }
                let redirect = format!(
                    "<!doctype html><meta charset=utf-8><meta http-equiv=refresh content=\"0;url=/chat?session={}\"><title>Sent</title>",
                    html_escape(reply_session)
                );
                http_response(stream, "200 OK", redirect).await
            }
        }
        _ => http_response(stream, "404 Not Found", "Not found".to_owned()).await,
    }
}

async fn serve_chat_ui(listener: tokio::net::TcpListener) -> Result<()> {
    loop {
        let (stream, _) = listener
            .accept()
            .await
            .context("accept chat UI connection")?;
        tokio::spawn(async move {
            if let Err(error) = handle_chat_request(stream).await {
                eprintln!("[chat] request: {error:#}");
            }
        });
    }
}

fn open_enrollment_browser(url: &str) -> Result<()> {
    #[cfg(target_os = "windows")]
    {
        ProcessCommand::new("cmd.exe")
            .args(["/C", "start", "", url])
            .creation_flags(0x08000000) // CREATE_NO_WINDOW — no console flash
            .spawn()
            .context("open enrollment browser")?;
        return Ok(());
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg(url)
            .spawn()
            .context("open enrollment browser")?;
        return Ok(());
    }
    #[cfg(target_os = "linux")]
    {
        std::process::Command::new("xdg-open")
            .arg(url)
            .spawn()
            .context("open enrollment browser")?;
        return Ok(());
    }
    #[allow(unreachable_code)]
    Err(anyhow!(
        "automatic browser opening is unsupported on this platform"
    ))
}

async fn enroll_ui(api_url: String, relay_url: String, config_path: PathBuf) -> Result<()> {
    let (api_url, relay_url) = enrollment_endpoints(api_url, relay_url);
    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .context("bind local enrollment UI")?;
    let address = listener
        .local_addr()
        .context("read enrollment UI address")?;
    let url = format!("http://{address}/");
    println!("Opening ReyDesk enrollment UI at {url}");
    open_enrollment_browser(&url)?;

    loop {
        let (mut stream, _) = listener
            .accept()
            .await
            .context("accept enrollment UI request")?;
        let mut buffer = vec![0_u8; 64 * 1024];
        let bytes = stream
            .read(&mut buffer)
            .await
            .context("read enrollment UI request")?;
        let request = String::from_utf8_lossy(&buffer[..bytes]);
        if request.starts_with("GET ") {
            http_response(stream, "200 OK", enrollment_html(None)).await?;
            continue;
        }
        if !request.starts_with("POST /enroll ") {
            http_response(
                stream,
                "404 Not Found",
                enrollment_html(Some("Unknown enrollment request.")),
            )
            .await?;
            continue;
        }
        let Some(body) = request.split_once("\r\n\r\n").map(|(_, body)| body) else {
            http_response(
                stream,
                "400 Bad Request",
                enrollment_html(Some("Invalid form submission.")),
            )
            .await?;
            continue;
        };
        let fields = parse_form(body.trim());
        let token = fields
            .get("token")
            .map(|value| {
                value
                    .chars()
                    .filter(|character| !character.is_whitespace())
                    .collect::<String>()
            })
            .unwrap_or_default();
        if token.trim().is_empty() {
            http_response(
                stream,
                "400 Bad Request",
                enrollment_html(Some("Enrollment code is required.")),
            )
            .await?;
            continue;
        }
        match enroll(
            api_url.clone(),
            relay_url.clone(),
            token,
            None,
            None,
            "deskos-agent-gui".to_owned(),
            config_path.clone(),
        )
        .await
        {
            Ok(()) => {
                #[cfg(target_os = "windows")]
                {
                    let _ = ProcessCommand::new("sc.exe")
                        .args(["start", SERVICE_NAME])
                        .creation_flags(0x08000000) // CREATE_NO_WINDOW
                        .status();
                    if let Err(error) = launch_consent_helper(&config_path) {
                        eprintln!("consent helper: {error:#}");
                    }
                }
                http_response(stream, "200 OK", "<!doctype html><meta charset=utf-8><title>ReyDesk enrolled</title><h1>Device enrolled</h1><p>You can close this window. ReyDesk is now starting the endpoint agent and its user-session consent helper.</p>".to_owned()).await?;
                return Ok(());
            }
            Err(error) => {
                http_response(
                    stream,
                    "400 Bad Request",
                    enrollment_html(Some(&format!("Enrollment failed: {error}"))),
                )
                .await?;
            }
        }
    }
}

fn set_tray_status(status: &TrayStatus, value: &str) {
    if let Ok(mut current) = status.lock() {
        *current = value.to_owned();
    }
}

async fn run_consent_ui(config_path: PathBuf, tray_status: TrayStatus) -> Result<()> {
    let config = load_config(&config_path)?;
    let client = AgentClient::new(&config);
    let relay_tasks: Arc<Mutex<HashSet<String>>> = Arc::new(Mutex::new(HashSet::new()));
    let mut prompted_sessions = HashSet::new();
    let mut opened_chat = HashSet::new();
    let mut seen_inbox = HashSet::new();
    let mut chat_window_url: Option<String> = None;

    // Serve a lightweight browser chat surface in the logged-in user session so
    // the endpoint user can read technician messages and reply without a native
    // window. The service relays chat into/out of the shared mailbox.
    let chat_listener = TcpListener::bind("127.0.0.1:0")
        .await
        .context("bind chat UI listener")?;
    let chat_address = chat_listener.local_addr().context("read chat UI address")?;
    tokio::spawn(serve_chat_ui(chat_listener));

    let mut ticker = interval(Duration::from_secs(2));
    ticker.set_missed_tick_behavior(MissedTickBehavior::Delay);

    loop {
        match client.sessions().await {
            Ok(sessions) => {
                let has_pending_consent = sessions.iter().any(|session| {
                    matches!(session.state.as_str(), "requested" | "consent_pending")
                });
                set_tray_status(
                    &tray_status,
                    if has_pending_consent {
                        "ReyDesk: consent pending"
                    } else {
                        "ReyDesk: online"
                    },
                );
                for session in sessions.iter().filter(|session| {
                    matches!(
                        session.state.as_str(),
                        "connecting" | "active" | "reconnecting"
                    )
                }) {
                    let session_id = session.id.as_str();
                    let messages = read_mailbox_messages(&chat_mailbox_dir(), session_id, "inbox");
                    let has_new = messages.iter().any(|(path, _)| !seen_inbox.contains(path));
                    for (path, _) in &messages {
                        seen_inbox.insert(path.clone());
                    }

                    // Open the endpoint-user chat as soon as assistance starts,
                    // rather than waiting for the technician to send the first
                    // message. This makes the communication channel discoverable
                    // and lets the user explain the issue immediately.
                    let first_open = opened_chat.insert(session_id.to_owned());
                    if first_open || has_new {
                        set_tray_status(
                            &tray_status,
                            if first_open {
                                "ReyDesk: session chat ready"
                            } else {
                                "ReyDesk: new message"
                            },
                        );
                    }
                    if first_open {
                        let url = format!("http://{chat_address}/chat?session={session_id}");
                        chat_window_url = Some(url.clone());
                        if let Err(error) = open_enrollment_browser(&url) {
                            eprintln!("[chat] open chat UI: {error:#}");
                        }
                    }
                    if has_new && !first_open {
                        if let Some(url) = chat_window_url.as_deref() {
                            if let Err(error) = open_enrollment_browser(url) {
                                eprintln!("[chat] focus chat UI: {error:#}");
                            }
                        }
                    }
                }
                for session in sessions {
                    if matches!(session.state.as_str(), "requested" | "consent_pending")
                        && prompted_sessions.insert(session.id.clone())
                    {
                        let prompt_session = session.clone();
                        let prompt_config = config.clone();
                        let prompt_client = client.clone();
                        let prompt_relay_tasks = relay_tasks.clone();
                        tokio::spawn(async move {
                            let session_id = prompt_session.id.clone();
                            let decision = tokio::task::spawn_blocking(move || {
                                decide_consent(&prompt_session)
                            })
                            .await;
                            match decision {
                                Ok(Ok(ConsentDecision::Denied)) => {
                                    let _ = prompt_client.consent(&session_id, false, None).await;
                                }
                                Ok(Ok(ConsentDecision::Granted)) => {
                                    match prompt_client.consent(&session_id, true, None).await {
                                        Ok(response) => {
                                            spawn_relay_task(
                                                prompt_config,
                                                response,
                                                prompt_client,
                                                prompt_relay_tasks,
                                            )
                                            .await;
                                        }
                                        Err(_) => {}
                                    }
                                }
                                Ok(Ok(ConsentDecision::GrantedWithoutElevation(permissions))) => {
                                    match prompt_client
                                        .consent(&session_id, true, Some(permissions))
                                        .await
                                    {
                                        Ok(response) => {
                                            spawn_relay_task(
                                                prompt_config,
                                                response,
                                                prompt_client,
                                                prompt_relay_tasks,
                                            )
                                            .await;
                                        }
                                        Err(_) => {}
                                    }
                                }
                                Ok(Err(_)) | Err(_) => {}
                            }
                        });
                    }
                }
            }
            Err(_) => set_tray_status(&tray_status, "ReyDesk: offline"),
        }

        tokio::select! {
            _ = ticker.tick() => {},
            _ = tokio::signal::ctrl_c() => break,
        }
    }
    Ok(())
}

#[cfg(target_os = "windows")]
unsafe extern "system" fn tray_window_proc(
    hwnd: HWND,
    message: u32,
    wparam: WPARAM,
    lparam: LPARAM,
) -> LRESULT {
    if message == TRAY_WM_MESSAGE && (lparam.0 as u32 == WM_RBUTTONUP || lparam.0 as u32 == WM_LBUTTONDBLCLK) {
        let Ok(menu) = CreatePopupMenu() else { return LRESULT(0); };
        let status = tray_wide("Connection status");
        let disconnect = tray_wide("Disconnect active sessions");
        let chat = tray_wide("Open support chat");
        let exit = tray_wide("Exit ReyDesk helper");
        let _ = AppendMenuW(menu, MF_STRING, TRAY_STATUS, PCWSTR(status.as_ptr()));
        let _ = AppendMenuW(menu, MF_STRING, TRAY_DISCONNECT, PCWSTR(disconnect.as_ptr()));
        let _ = AppendMenuW(menu, MF_STRING, TRAY_OPEN_CHAT, PCWSTR(chat.as_ptr()));
        let _ = AppendMenuW(menu, MF_SEPARATOR, 0, PCWSTR::null());
        let _ = AppendMenuW(menu, MF_STRING, TRAY_EXIT, PCWSTR(exit.as_ptr()));
        let mut point = POINT::default();
        let _ = GetCursorPos(&mut point);
        let selected = TrackPopupMenu(menu, TPM_RETURNCMD, point.x, point.y, 0, hwnd, None).0 as u32;
        let _ = windows::Win32::UI::WindowsAndMessaging::DestroyMenu(menu);
        if selected == TRAY_EXIT as u32 {
            PostQuitMessage(0);
        } else if selected == TRAY_STATUS as u32 {
            let title = tray_wide("ReyDesk connection status");
            let body = tray_wide("Open the ReyDesk session console to view active connections and permissions.");
            MessageBoxW(hwnd, PCWSTR(body.as_ptr()), PCWSTR(title.as_ptr()), MB_SYSTEMMODAL);
        } else if selected == TRAY_DISCONNECT as u32 {
            let title = tray_wide("Disconnect");
            let body = tray_wide("To safely end a session, use the End support button in the consent window or technician console.");
            MessageBoxW(hwnd, PCWSTR(body.as_ptr()), PCWSTR(title.as_ptr()), MB_SYSTEMMODAL);
        }
        return LRESULT(0);
    }
    if message == windows::Win32::UI::WindowsAndMessaging::WM_DESTROY {
        PostQuitMessage(0);
    }
    DefWindowProcW(hwnd, message, wparam, lparam)
}

#[cfg(target_os = "windows")]
fn tray_wide(value: &str) -> Vec<u16> {
    value.encode_utf16().chain(std::iter::once(0)).collect()
}

#[cfg(target_os = "windows")]
fn acquire_tray_instance() -> Result<Option<windows::Win32::Foundation::HANDLE>> {
    let name = tray_wide("Global\\DeskOSTrayHelper");
    let handle = unsafe { CreateMutexW(None, true, PCWSTR(name.as_ptr())) }
        .context("create ReyDesk tray helper mutex")?;
    let already_exists = unsafe { GetLastError() }
        .err()
        .is_some_and(|error| error.code().0 as u32 == ERROR_ALREADY_EXISTS.0);
    if already_exists {
        unsafe {
            CloseHandle(handle).ok();
        }
        return Ok(None);
    }
    Ok(Some(handle))
}

#[cfg(target_os = "windows")]
fn enable_dpi_awareness() {
    unsafe {
        let _ = SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
    }
}

#[cfg(target_os = "windows")]
fn tray_data(
    hwnd: HWND,
    icon: windows::Win32::UI::WindowsAndMessaging::HICON,
    tooltip: &str,
) -> NOTIFYICONDATAW {
    let mut data = NOTIFYICONDATAW {
        cbSize: std::mem::size_of::<NOTIFYICONDATAW>() as u32,
        hWnd: hwnd,
        uID: 1,
        uFlags: NIF_ICON | NIF_MESSAGE | NIF_TIP,
        uCallbackMessage: TRAY_WM_MESSAGE,
        hIcon: icon,
        ..Default::default()
    };
    let wide = tray_wide(tooltip);
    let copy_len = wide
        .len()
        .saturating_sub(1)
        .min(data.szTip.len().saturating_sub(1));
    data.szTip[..copy_len].copy_from_slice(&wide[..copy_len]);
    data
}

#[cfg(target_os = "windows")]
fn run_tray_message_loop(status: TrayStatus) -> Result<()> {
    let class_name = tray_wide("DeskOSTrayStatusWindow");
    let class = WNDCLASSW {
        lpfnWndProc: Some(tray_window_proc),
        lpszClassName: PCWSTR(class_name.as_ptr()),
        ..Default::default()
    };
    unsafe {
        RegisterClassW(&class);
    }
    let hwnd = unsafe {
        CreateWindowExW(
            WINDOW_EX_STYLE::default(),
            PCWSTR(class_name.as_ptr()),
            PCWSTR(class_name.as_ptr()),
            WS_OVERLAPPED,
            0,
            0,
            0,
            0,
            None,
            None,
            None,
            None,
        )
    };
    if hwnd.0 == 0 {
        return Err(anyhow!("create ReyDesk tray window failed"));
    }
    let icon = unsafe { LoadIconW(None, IDI_APPLICATION) }.unwrap_or_default();
    let mut data = tray_data(hwnd, icon, "ReyDesk: starting");
    if !unsafe { Shell_NotifyIconW(NIM_ADD, &mut data) }.as_bool() {
        return Err(anyhow!("add ReyDesk tray icon failed"));
    }

    let update_status = status.clone();
    let update_hwnd = hwnd;
    thread::spawn(move || {
        let mut previous = String::new();
        loop {
            let current = update_status
                .lock()
                .map(|value| value.clone())
                .unwrap_or_else(|_| "ReyDesk: unavailable".to_owned());
            if current != previous {
                let mut update = tray_data(update_hwnd, icon, &current);
                let _ = unsafe { Shell_NotifyIconW(NIM_MODIFY, &mut update) };
                previous = current;
            }
            thread::sleep(Duration::from_millis(500));
        }
    });

    let mut message = MSG::default();
    loop {
        let result = unsafe { GetMessageW(&mut message, None, 0, 0) };
        if result.0 <= 0 {
            break;
        }
        unsafe {
            TranslateMessage(&message);
            DispatchMessageW(&message);
        }
    }
    let _ = unsafe { Shell_NotifyIconW(NIM_DELETE, &mut data) };
    Ok(())
}

async fn run_tray_ui(config_path: PathBuf) -> Result<()> {
    #[cfg(target_os = "windows")]
    let Some(_tray_instance) = acquire_tray_instance()?
    else {
        return Ok(());
    };

    let status = Arc::new(StdMutex::new("ReyDesk: starting".to_owned()));
    #[cfg(target_os = "windows")]
    {
        let tray_status = status.clone();
        let tray = tokio::task::spawn_blocking(move || run_tray_message_loop(tray_status));
        tokio::select! {
            result = tray => {
                return result.context("tray UI thread failed")?;
            }
            result = run_consent_ui(config_path, status) => return result,
        }
    }
    #[cfg(not(target_os = "windows"))]
    {
        run_consent_ui(config_path, status).await
    }
}

#[cfg(target_os = "windows")]
fn launch_consent_helper(config_path: &Path) -> Result<()> {
    let executable = std::env::current_exe().context("locate agent executable")?;
    ProcessCommand::new(executable)
        .args(["tray-ui", "--config"])
        .arg(config_path)
        .creation_flags(0x08000000)
        .spawn()
        .context("launch logged-in-user tray helper")?;
    Ok(())
}

/// Executes a queued device action (dispatched by a technician or an AI
/// worker). Runs in its own task so a slow script never blocks heartbeats.
async fn run_device_action(client: AgentClient, config: AgentConfig, action: PendingAction) {
    let action_id = action.id.clone();
    let action_kind = action.action.clone();
    let result = match action.action.as_str() {
        "run_script" => run_script_action(&client, &action).await,
        "restart" => restart_action().await,
        "collect_inventory" => collect_inventory_action(&client, &config).await,
        other => Err(anyhow!("unknown device action: {other}")),
    };
    match result {
        Ok(payload) => {
            if let Err(error) = client
                .report_action_result(&action_id, "succeeded", payload)
                .await
            {
                eprintln!("[action] report {action_kind}: {error:#}");
            }
        }
        Err(error) => {
            eprintln!("[action] {action_kind} failed: {error:#}");
            if let Err(report_error) = client
                .report_action_result(
                    &action_id,
                    "failed",
                    serde_json::json!({ "error": format!("{error:#}") }),
                )
                .await
            {
                eprintln!("[action] report {action_kind}: {report_error:#}");
            }
        }
    }
}

async fn run_script_action(client: &AgentClient, action: &PendingAction) -> Result<serde_json::Value> {
    let script_id = action
        .payload
        .get("scriptId")
        .and_then(serde_json::Value::as_str)
        .ok_or_else(|| anyhow!("run_script action missing scriptId"))?;
    let script = client.get_script(script_id).await?;
    let mut command = {
        #[cfg(target_os = "windows")]
        {
            let mut command = TokioCommand::new("powershell.exe");
            command.args(["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", "-"]);
            #[cfg(target_os = "windows")]
            command.creation_flags(0x08000000);
            command
        }
        #[cfg(not(target_os = "windows"))]
        {
            let mut command = TokioCommand::new("sh");
            command.arg("-s");
            command
        }
    };
    command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = command.spawn().context("spawn script process")?;
    if let Some(stdin) = child.stdin.as_mut() {
        stdin
            .write_all(script.body.as_bytes())
            .await
            .context("write script to stdin")?;
    }
    let output = child.wait_with_output().await.context("wait for script")?;
    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();
    if !output.status.success() {
        return Err(anyhow!(
            "script {} exited with {}: {}",
            script.name,
            output.status,
            stderr.trim().chars().take(1500).collect::<String>()
        ));
    }
    Ok(serde_json::json!({
        "scriptId": script_id,
        "scriptName": script.name,
        "exitCode": output.status.code(),
        "stdout": stdout.chars().take(20000).collect::<String>(),
        "stderr": stderr.chars().take(20000).collect::<String>(),
    }))
}

async fn restart_action() -> Result<serde_json::Value> {
    #[cfg(target_os = "windows")]
    {
        let _ = std::process::Command::new("shutdown.exe")
            .args(["/r", "/t", "1"])
            .spawn();
    }
    #[cfg(target_os = "macos")]
    {
        let _ = std::process::Command::new("osascript")
            .args(["-e", "tell app \"System Events\" to restart"])
            .spawn();
    }
    #[cfg(target_os = "linux")]
    {
        let _ = std::process::Command::new("systemctl").arg("reboot").spawn();
    }
    Ok(serde_json::json!({ "rebootTriggered": true }))
}

async fn collect_inventory_action(client: &AgentClient, config: &AgentConfig) -> Result<serde_json::Value> {
    let mut system = System::new_all();
    let mut disks = Disks::new_with_refreshed_list();
    client.inventory(&inventory(config)).await?;
    let metrics_body = metrics(&mut system, &mut disks, None);
    client.metrics(&metrics_body).await?;
    Ok(serde_json::json!({
        "collected": true,
        "cpuPct": metrics_body.cpu_pct,
        "memPct": metrics_body.mem_pct,
        "diskPct": metrics_body.disk_pct,
    }))
}

async fn run_agent(
    config_path: PathBuf,
    interval_override: Option<u64>,
    interactive_consent: bool,
    mut shutdown: Option<mpsc::UnboundedReceiver<()>>,
) -> Result<()> {
    let config = match load_config(&config_path) {
        Ok(config) => config,
        Err(config_error) => {
            #[cfg(target_os = "windows")]
            {
                if let Some(bootstrap) = load_fleet_bootstrap() {
                    enroll(
                        bootstrap.api_url,
                        bootstrap.relay_url,
                        bootstrap.token,
                        None,
                        None,
                        "deskos-agent-fleet".to_owned(),
                        config_path.clone(),
                    )
                    .await
                    .context("fleet bootstrap enrollment")?;
                    clear_fleet_bootstrap();
                    load_config(&config_path).context("load fleet-enrolled agent config")?
                } else {
                    return Err(config_error);
                }
            }
            #[cfg(not(target_os = "windows"))]
            {
                return Err(config_error);
            }
        }
    };
    validate_endpoints(&config.api_url, &config.relay_url)?;
    let client = AgentClient::new(&config);
    let heartbeat_seconds = interval_override.unwrap_or(config.heartbeat_interval_sec.max(5));
    let mut system = System::new_all();
    let mut disks = Disks::new_with_refreshed_list();
    let mut ticker = interval(Duration::from_secs(heartbeat_seconds));
    ticker.set_missed_tick_behavior(MissedTickBehavior::Delay);
    let relay_tasks: Arc<Mutex<HashSet<String>>> = Arc::new(Mutex::new(HashSet::new()));
    let mut prompted_sessions = HashSet::new();
    let mut update_check_ticks: u64 = 0;
    let mut last_reported_update: Option<String> = None;

    println!(
        "ReyDesk agent running for {} ({})",
        config.name, config.device_id
    );
    loop {
        if let Err(error) = client.inventory(&inventory(&config)).await {
            eprintln!("inventory: {error:#}");
        }
        let network_latency_ms = match client.heartbeat().await {
            Ok(latency_ms) => Some(latency_ms),
            Err(error) => {
                eprintln!("heartbeat: {error:#}");
                None
            }
        };
        if let Err(error) = client.metrics(&metrics(&mut system, &mut disks, network_latency_ms)).await {
            eprintln!("metrics: {error:#}");
        }
        // Check the update channel on a slower cadence than heartbeats so the
        // endpoint reports availability without hammering the API.
        update_check_ticks += 1;
        if update_check_ticks % 20 == 0 {
            let version = env!("CARGO_PKG_VERSION").to_owned();
            match client.check_update(&version).await {
                Ok(response) => {
                    if response.status == "available" {
                        let target = response.update.as_ref().map(|offer| offer.version.clone());
                        println!(
                            "[update] {} available",
                            target.as_deref().unwrap_or("unknown")
                        );
                        if let Some(target) = target {
                            if last_reported_update.as_deref() != Some(target.as_str()) {
                                if let Err(error) = client
                                    .report_update(&version, &target, "checked", None)
                                    .await
                                {
                                    eprintln!("[update] report: {error:#}");
                                }
                                last_reported_update = Some(target);
                            }
                        }
                    }
                }
                Err(error) => eprintln!("[update] check failed: {error:#}"),
            }
        }
        match client.sessions().await {
            Ok(sessions) => {
                for session in sessions {
                    println!(
                        "Session {}: {} {} — {} [{}]",
                        session.id,
                        session.session_type,
                        session.state,
                        session.reason,
                        session.permissions.join(", "),
                    );
                    if session.state == "active"
                        && session
                            .permissions
                            .iter()
                            .any(|permission| permission == "reboot_reconnect")
                    {
                        let config = config.clone();
                        let client = client.clone();
                        let relay_tasks = relay_tasks.clone();
                        let session_id = session.id.clone();
                        let already_running = relay_tasks.lock().await.contains(&session_id);
                        if !already_running {
                            match client.reconnect(&session_id).await {
                                Ok(response) => {
                                    spawn_relay_task(config, response, client, relay_tasks).await;
                                }
                                Err(error) => eprintln!("startup session {session_id}: {error:#}"),
                            }
                        }
                    } else if interactive_consent
                        && matches!(session.state.as_str(), "requested" | "consent_pending")
                        && prompted_sessions.insert(session.id.clone())
                    {
                        // Windows MessageBoxW is synchronous. Keep it off the agent
                        // polling task so a user who takes time to answer cannot make
                        // the device appear offline by blocking heartbeats.
                        let prompt_session = session.clone();
                        let prompt_config = config.clone();
                        let prompt_client = client.clone();
                        let prompt_relay_tasks = relay_tasks.clone();
                        tokio::spawn(async move {
                            let session_id = prompt_session.id.clone();
                            let decision = tokio::task::spawn_blocking(move || {
                                decide_consent(&prompt_session)
                            })
                            .await;
                            match decision {
                                Ok(Ok(ConsentDecision::Denied)) => {
                                    match prompt_client.consent(&session_id, false, None).await {
                                        Ok(response) => println!(
                                            "Session {} denied by endpoint user",
                                            response.session.id
                                        ),
                                        Err(error) => eprintln!("consent {session_id}: {error:#}"),
                                    }
                                }
                                Ok(Ok(ConsentDecision::Granted)) => {
                                    match prompt_client.consent(&session_id, true, None).await {
                                        Ok(response) => {
                                            spawn_relay_task(
                                                prompt_config,
                                                response,
                                                prompt_client,
                                                prompt_relay_tasks,
                                            )
                                            .await;
                                        }
                                        Err(error) => eprintln!("consent {session_id}: {error:#}"),
                                    }
                                }
                                Ok(Ok(ConsentDecision::GrantedWithoutElevation(permissions))) => {
                                    match prompt_client
                                        .consent(&session_id, true, Some(permissions))
                                        .await
                                    {
                                        Ok(response) => {
                                            spawn_relay_task(
                                                prompt_config,
                                                response,
                                                prompt_client,
                                                prompt_relay_tasks,
                                            )
                                            .await;
                                        }
                                        Err(error) => eprintln!("consent {session_id}: {error:#}"),
                                    }
                                }
                                Ok(Err(error)) => {
                                    eprintln!("consent prompt {session_id}: {error:#}")
                                }
                                Err(error) => {
                                    eprintln!("consent prompt task {session_id}: {error}")
                                }
                            }
                        });
                    }
                }
            }
            Err(error) => eprintln!("sessions: {error:#}"),
        }
        // Poll for queued device actions (technician or AI-worker dispatched)
        // and run them off the heartbeat task so long scripts never make the
        // device look offline.
        match client.pending_actions().await {
            Ok(actions) => {
                for action in actions {
                    let client = client.clone();
                    let config = config.clone();
                    tokio::spawn(async move {
                        run_device_action(client, config, action).await;
                    });
                }
            }
            Err(error) => eprintln!("actions: {error:#}"),
        }
        tokio::select! {
            _ = ticker.tick() => {},
            _ = tokio::signal::ctrl_c(), if shutdown.is_none() => {
                println!("Stopping ReyDesk agent");
                break;
            }
            _ = async {
                match shutdown.as_mut() {
                    Some(receiver) => {
                        let _ = receiver.recv().await;
                    }
                    None => std::future::pending::<()>().await,
                }
            } => {
                println!("Windows service stop requested");
                break;
            }
        }
    }
    Ok(())
}

async fn send_relay(writer: &SharedRelayWriter, payload: serde_json::Value) -> Result<()> {
    writer
        .lock()
        .await
        .send(Message::Text(payload.to_string()))
        .await
        .context("send relay message")?;
    Ok(())
}

#[cfg(target_os = "windows")]
fn send_native_input(input: INPUT) -> Result<()> {
    let sent = unsafe { SendInput(&[input], std::mem::size_of::<INPUT>() as i32) };
    if sent != 1 {
        return Err(anyhow!(
            "Windows SendInput injected {sent} events instead of one"
        ));
    }
    Ok(())
}

#[cfg(target_os = "windows")]
fn send_key(key: &str, key_up: bool) -> Result<()> {
    let flags = if key_up {
        KEYEVENTF_KEYUP
    } else {
        KEYBD_EVENT_FLAGS(0)
    };
    let named = match key {
        "Enter" => Some(VK_RETURN),
        "Backspace" => Some(VK_BACK),
        "Tab" => Some(VK_TAB),
        "Escape" => Some(VK_ESCAPE),
        "Space" => Some(VK_SPACE),
        "ArrowLeft" => Some(VK_LEFT),
        "ArrowRight" => Some(VK_RIGHT),
        "ArrowUp" => Some(VK_UP),
        "ArrowDown" => Some(VK_DOWN),
        "Delete" => Some(VK_DELETE),
        "Home" => Some(VK_HOME),
        "End" => Some(VK_END),
        "PageUp" => Some(VK_PRIOR),
        "PageDown" => Some(VK_NEXT),
        "Shift" => Some(VK_SHIFT),
        "Control" => Some(VK_CONTROL),
        "Alt" => Some(VK_MENU),
        "Meta" => Some(VK_LWIN),
        "CapsLock" => Some(VK_CAPITAL),
        _ => None,
    };
    if let Some(vk) = named {
        return send_native_input(INPUT {
            r#type: INPUT_KEYBOARD,
            Anonymous: INPUT_0 {
                ki: KEYBDINPUT {
                    wVk: vk,
                    wScan: 0,
                    dwFlags: flags,
                    time: 0,
                    dwExtraInfo: 0,
                },
            },
        });
    }
    let mut chars = key.chars();
    let Some(character) = chars.next() else {
        return Err(anyhow!("empty key value"));
    };
    if chars.next().is_some() {
        return Err(anyhow!("unsupported key value: {key}"));
    }
    send_native_input(INPUT {
        r#type: INPUT_KEYBOARD,
        Anonymous: INPUT_0 {
            ki: KEYBDINPUT {
                wVk: VIRTUAL_KEY(0),
                wScan: character as u16,
                dwFlags: KEYEVENTF_UNICODE | flags,
                time: 0,
                dwExtraInfo: 0,
            },
        },
    })
}

#[cfg(target_os = "windows")]
fn cursor_position() -> Option<(f64, f64)> {
    let mut point = POINT::default();
    unsafe { GetCursorPos(&mut point).ok()? };
    let (origin_x, origin_y, width, height) = unsafe {
        (
            GetSystemMetrics(SM_XVIRTUALSCREEN) as f64,
            GetSystemMetrics(SM_YVIRTUALSCREEN) as f64,
            GetSystemMetrics(SM_CXVIRTUALSCREEN).max(1) as f64,
            GetSystemMetrics(SM_CYVIRTUALSCREEN).max(1) as f64,
        )
    };
    Some((
        ((point.x as f64 - origin_x) / (width - 1.0)).clamp(0.0, 1.0),
        ((point.y as f64 - origin_y) / (height - 1.0)).clamp(0.0, 1.0),
    ))
}

#[cfg(not(target_os = "windows"))]
fn cursor_position() -> Option<(f64, f64)> {
    None
}

#[cfg(target_os = "windows")]
fn send_pointer(value: &serde_json::Value) -> Result<()> {
    let x = value
        .get("x")
        .and_then(serde_json::Value::as_f64)
        .ok_or_else(|| anyhow!("missing pointer x"))?;
    let y = value
        .get("y")
        .and_then(serde_json::Value::as_f64)
        .ok_or_else(|| anyhow!("missing pointer y"))?;
    send_native_input(INPUT {
        r#type: INPUT_MOUSE,
        Anonymous: INPUT_0 {
            mi: MOUSEINPUT {
                dx: (x.clamp(0.0, 1.0) * 65_535.0).round() as i32,
                dy: (y.clamp(0.0, 1.0) * 65_535.0).round() as i32,
                mouseData: 0,
                dwFlags: MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_MOVE | MOUSEEVENTF_VIRTUALDESK,
                time: 0,
                dwExtraInfo: 0,
            },
        },
    })?;
    Ok(())
}

#[cfg(target_os = "windows")]
fn send_mouse_button(button: &str, down: bool) -> Result<()> {
    let flags = match (button, down) {
        ("right", true) => MOUSEEVENTF_RIGHTDOWN,
        ("right", false) => MOUSEEVENTF_RIGHTUP,
        ("middle", true) => MOUSEEVENTF_MIDDLEDOWN,
        ("middle", false) => MOUSEEVENTF_MIDDLEUP,
        (_, true) => MOUSEEVENTF_LEFTDOWN,
        (_, false) => MOUSEEVENTF_LEFTUP,
    };
    send_native_input(INPUT {
        r#type: INPUT_MOUSE,
        Anonymous: INPUT_0 {
            mi: MOUSEINPUT {
                dx: 0,
                dy: 0,
                mouseData: 0,
                dwFlags: flags,
                time: 0,
                dwExtraInfo: 0,
            },
        },
    })
}

#[cfg(target_os = "windows")]
fn send_wheel(value: &serde_json::Value) -> Result<()> {
    let delta = value
        .get("deltaY")
        .and_then(serde_json::Value::as_f64)
        .ok_or_else(|| anyhow!("missing wheel deltaY"))?;
    let ticks = (-delta.clamp(-10_000.0, 10_000.0) / 3.0).round() as i32;
    if ticks == 0 {
        return Ok(());
    }
    send_native_input(INPUT {
        r#type: INPUT_MOUSE,
        Anonymous: INPUT_0 {
            mi: MOUSEINPUT {
                dx: 0,
                dy: 0,
                mouseData: ticks as u32,
                dwFlags: MOUSEEVENTF_WHEEL,
                time: 0,
                dwExtraInfo: 0,
            },
        },
    })
}

#[cfg(target_os = "windows")]
fn apply_input(value: &serde_json::Value, action: &str) -> Result<()> {
    match action {
        "pointermove" => send_pointer(value),
        "pointerdown" => {
            send_pointer(value)?;
            send_mouse_button(
                value
                    .get("button")
                    .and_then(serde_json::Value::as_str)
                    .unwrap_or("left"),
                true,
            )
        }
        "pointerup" => send_mouse_button(
            value
                .get("button")
                .and_then(serde_json::Value::as_str)
                .unwrap_or("left"),
            false,
        ),
        "click" => {
            send_pointer(value)?;
            let button = value
                .get("button")
                .and_then(serde_json::Value::as_str)
                .unwrap_or("left");
            send_mouse_button(button, true)?;
            send_mouse_button(button, false)
        }
        "wheel" => {
            send_pointer(value)?;
            send_wheel(value)
        }
        "keydown" => send_key(
            value
                .get("key")
                .and_then(serde_json::Value::as_str)
                .unwrap_or_default(),
            false,
        ),
        "keyup" => send_key(
            value
                .get("key")
                .and_then(serde_json::Value::as_str)
                .unwrap_or_default(),
            true,
        ),
        _ => Err(anyhow!("unsupported input action: {action}")),
    }
}

#[cfg(target_os = "macos")]
fn mac_input_coordinates(value: &serde_json::Value) -> Result<(f64, f64)> {
    let x = value.get("x").and_then(serde_json::Value::as_f64).ok_or_else(|| anyhow!("missing pointer x"))?.clamp(0.0, 1.0);
    let y = value.get("y").and_then(serde_json::Value::as_f64).ok_or_else(|| anyhow!("missing pointer y"))?.clamp(0.0, 1.0);
    let screens = Monitor::all().context("enumerate macOS displays")?;
    let left = screens.iter().filter_map(|screen| screen.x().ok()).min().unwrap_or(0) as f64;
    let top = screens.iter().filter_map(|screen| screen.y().ok()).min().unwrap_or(0) as f64;
    let right = screens.iter().filter_map(|screen| screen.x().ok().zip(screen.width().ok()).map(|(position, width)| position + width as i32)).max().unwrap_or(1) as f64;
    let bottom = screens.iter().filter_map(|screen| screen.y().ok().zip(screen.height().ok()).map(|(position, height)| position + height as i32)).max().unwrap_or(1) as f64;
    Ok((left + x * (right - left).max(1.0), top + y * (bottom - top).max(1.0)))
}

#[cfg(target_os = "macos")]
fn mac_keycode(key: &str) -> Option<u16> {
    match key {
        "Enter" => Some(36), "Tab" => Some(48), "Space" => Some(49), "Backspace" | "Delete" => Some(51),
        "Escape" => Some(53), "ArrowLeft" => Some(123), "ArrowRight" => Some(124), "ArrowDown" => Some(125), "ArrowUp" => Some(126),
        "a" | "A" => Some(0), "s" | "S" => Some(1), "d" | "D" => Some(2), "f" | "F" => Some(3), "h" | "H" => Some(4), "g" | "G" => Some(5),
        "z" | "Z" => Some(6), "x" | "X" => Some(7), "c" | "C" => Some(8), "v" | "V" => Some(9), "b" | "B" => Some(11),
        "q" | "Q" => Some(12), "w" | "W" => Some(13), "e" | "E" => Some(14), "r" | "R" => Some(15), "y" | "Y" => Some(16), "t" | "T" => Some(17),
        "1" => Some(18), "2" => Some(19), "3" => Some(20), "4" => Some(21), "6" => Some(22), "5" => Some(23), "=" => Some(24), "9" => Some(25), "7" => Some(26), "-" => Some(27), "8" => Some(28), "0" => Some(29),
        "]" => Some(30), "o" | "O" => Some(31), "u" | "U" => Some(32), "[" => Some(33), "i" | "I" => Some(34), "p" | "P" => Some(35), "l" | "L" => Some(37), "j" | "J" => Some(38), "'" => Some(39), "k" | "K" => Some(40), ";" => Some(41), "\\" => Some(42), "," => Some(43), "/" => Some(44), "n" | "N" => Some(45), "m" | "M" => Some(46), "." => Some(47), "`" => Some(50),
        _ => None,
    }
}

#[cfg(target_os = "macos")]
fn run_macos_input_script(script: &str) -> Result<()> {
    let output = std::process::Command::new("osascript").args(["-l", "JavaScript", "-e", script]).output().context("invoke macOS input service")?;
    if !output.status.success() { return Err(anyhow!("macOS input was rejected: {}", String::from_utf8_lossy(&output.stderr).trim())); }
    Ok(())
}

#[cfg(target_os = "macos")]
fn apply_input(value: &serde_json::Value, action: &str) -> Result<()> {
    use core_graphics::event::{CGEvent, CGEventSource, CGEventSourceStateID, CGEventType, CGMouseButton};
    let source = CGEventSource::new(CGEventSourceStateID::HIDSystemState).context("create macOS input source")?;
    match action {
        "pointermove" | "pointerdown" | "pointerup" | "click" => {
            let (x, y) = mac_input_coordinates(value)?;
            let button = match value.get("button").and_then(serde_json::Value::as_str).unwrap_or("left") { "right" => CGMouseButton::Right, "middle" => CGMouseButton::Center, _ => CGMouseButton::Left };
            let event_type = match action { "pointerdown" => CGEventType::LeftMouseDown, "pointerup" => CGEventType::LeftMouseUp, _ => CGEventType::MouseMoved };
            let event = CGEvent::new_mouse_event(source, event_type, core_graphics::geometry::CGPoint::new(x, y), button).context("create macOS mouse event")?;
            event.post(core_graphics::event::CGEventTapLocation::HID);
            if action == "click" {
                let down = CGEvent::new_mouse_event(source.clone(), CGEventType::LeftMouseDown, core_graphics::geometry::CGPoint::new(x, y), button).context("create macOS click down")?;
                down.post(core_graphics::event::CGEventTapLocation::HID);
                let up = CGEvent::new_mouse_event(source, CGEventType::LeftMouseUp, core_graphics::geometry::CGPoint::new(x, y), button).context("create macOS click up")?;
                up.post(core_graphics::event::CGEventTapLocation::HID);
            }
            Ok(())
        }
        "wheel" => {
            let delta = value.get("deltaY").and_then(serde_json::Value::as_f64).unwrap_or(0.0).clamp(-10_000.0, 10_000.0) as i32;
            let event = CGEvent::new_scroll_event(source, core_graphics::event::CGScrollEventUnit::PIXEL, 1, -delta).context("create macOS scroll event")?;
            event.post(core_graphics::event::CGEventTapLocation::HID);
            Ok(())
        }
        "keydown" | "keyup" => {
            let key = value.get("key").and_then(serde_json::Value::as_str).unwrap_or("");
            let keycode = mac_keycode(key).ok_or_else(|| anyhow!("unsupported macOS key: {key}"))?;
            let event = CGEvent::new_keyboard_event(source, keycode, action == "keydown").context("create macOS key event")?;
            event.post(core_graphics::event::CGEventTapLocation::HID);
            Ok(())
        }
        _ => Err(anyhow!("unsupported macOS input action: {action}")),
    }
}

#[cfg(all(not(target_os = "windows"), not(target_os = "macos")))]
fn apply_input(_value: &serde_json::Value, _action: &str) -> Result<()> {
    Err(anyhow!("native input is not implemented for this operating system"))
}

#[cfg(target_os = "windows")]
fn read_clipboard_text() -> Result<String> {
    const CF_UNICODETEXT_FORMAT: u32 = 13;
    unsafe {
        OpenClipboard(None).context("open Windows clipboard")?;
        let result = (|| {
            let handle =
                GetClipboardData(CF_UNICODETEXT_FORMAT).context("read Unicode clipboard data")?;
            let memory = HGLOBAL(handle.0 as *mut std::ffi::c_void);
            let pointer = GlobalLock(memory);
            if pointer.is_null() {
                return Err(anyhow!("lock Windows clipboard data"));
            }
            let mut length = 0_usize;
            let units = pointer.cast::<u16>();
            while *units.add(length) != 0 {
                length += 1;
                if length > 1_000_000 {
                    return Err(anyhow!("clipboard text exceeds the 1 MB limit"));
                }
            }
            let text = String::from_utf16(std::slice::from_raw_parts(units, length))
                .context("decode Unicode clipboard data")?;
            let _ = GlobalUnlock(memory);
            Ok(text)
        })();
        let _ = CloseClipboard();
        result
    }
}

#[cfg(target_os = "windows")]
fn write_clipboard_text(text: &str) -> Result<()> {
    const CF_UNICODETEXT_FORMAT: u32 = 13;
    let utf16 = text
        .encode_utf16()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    if utf16.len() > 1_000_000 {
        return Err(anyhow!("clipboard text exceeds the 1 MB limit"));
    }
    unsafe {
        OpenClipboard(None).context("open Windows clipboard")?;
        let result = (|| {
            EmptyClipboard().context("clear Windows clipboard")?;
            let memory = GlobalAlloc(
                GMEM_MOVEABLE | GMEM_ZEROINIT,
                utf16.len() * std::mem::size_of::<u16>(),
            )
            .context("allocate Windows clipboard memory")?;
            if memory.is_invalid() {
                return Err(anyhow!("allocate Windows clipboard memory"));
            }
            let pointer = GlobalLock(memory);
            if pointer.is_null() {
                return Err(anyhow!("lock Windows clipboard memory"));
            }
            std::ptr::copy_nonoverlapping(
                utf16.as_ptr().cast::<u8>(),
                pointer.cast::<u8>(),
                utf16.len() * std::mem::size_of::<u16>(),
            );
            let _ = GlobalUnlock(memory);
            SetClipboardData(CF_UNICODETEXT_FORMAT, HANDLE(memory.0 as isize))
                .context("publish Windows clipboard data")?;
            Ok(())
        })();
        let _ = CloseClipboard();
        result
    }
}

#[cfg(target_os = "macos")]
fn read_clipboard_text() -> Result<String> {
    let output = std::process::Command::new("pbpaste").output().context("read macOS clipboard")?;
    if !output.status.success() { return Err(anyhow!("macOS clipboard read was rejected")); }
    String::from_utf8(output.stdout).context("decode macOS clipboard")
}

#[cfg(target_os = "macos")]
fn write_clipboard_text(text: &str) -> Result<()> {
    let mut child = std::process::Command::new("pbcopy").stdin(std::process::Stdio::piped()).spawn().context("open macOS clipboard")?;
    if let Some(stdin) = child.stdin.as_mut() { std::io::Write::write_all(stdin, text.as_bytes()).context("write macOS clipboard")?; }
    child.wait().context("finish macOS clipboard write")?.success().then_some(()).ok_or_else(|| anyhow!("macOS clipboard write was rejected"))
}

#[cfg(all(not(target_os = "windows"), not(target_os = "macos")))]
fn read_clipboard_text() -> Result<String> { Err(anyhow!("clipboard integration is not implemented for this operating system")) }

#[cfg(all(not(target_os = "windows"), not(target_os = "macos")))]
fn write_clipboard_text(_text: &str) -> Result<()> { Err(anyhow!("clipboard integration is not implemented for this operating system")) }

fn rejected_control_audit(action: impl Into<String>, reason: &str) -> ControlAudit {
    ControlAudit {
        outcome: "rejected".to_owned(),
        action: action.into(),
        reason: reason.to_owned(),
    }
}

fn handle_control_message(
    message: &DataChannelMessage,
    can_control: bool,
    _monitors: &[Monitor],
    _selected_monitor: &Arc<StdMutex<Option<usize>>>,
) -> ControlAudit {
    let Ok(text) = std::str::from_utf8(&message.data) else {
        eprintln!("Rejected non-UTF-8 control message");
        return rejected_control_audit("unknown", "invalid_encoding");
    };
    let Ok(value) = serde_json::from_str::<serde_json::Value>(text) else {
        eprintln!("Rejected malformed control message");
        return rejected_control_audit("unknown", "malformed_message");
    };
    let raw_action = value
        .get("action")
        .and_then(serde_json::Value::as_str)
        .unwrap_or("unknown");
    let action = match raw_action {
        "pointermove" | "pointerdown" | "pointerup" | "click" | "wheel" | "keydown" | "keyup" => {
            raw_action.to_owned()
        }
        _ => "unknown".to_owned(),
    };
    if value.get("type").and_then(serde_json::Value::as_str) != Some("input") {
        eprintln!("Rejected unsupported control message");
        return rejected_control_audit(action, "unsupported_message");
    }
    if !can_control {
        eprintln!("Rejected input: session was not granted control_input");
        return rejected_control_audit(action, "control_not_granted");
    }
    let valid = match action.as_str() {
        "pointermove" | "pointerdown" | "pointerup" | "click" | "wheel" => {
            let coordinates_valid = value
                .get("x")
                .and_then(serde_json::Value::as_f64)
                .is_some_and(|coordinate| (0.0..=1.0).contains(&coordinate))
                && value
                    .get("y")
                    .and_then(serde_json::Value::as_f64)
                    .is_some_and(|coordinate| (0.0..=1.0).contains(&coordinate));
            let button_valid = !matches!(action.as_str(), "pointermove" | "wheel")
                && value
                    .get("button")
                    .and_then(serde_json::Value::as_str)
                    .is_some_and(|button| matches!(button, "left" | "middle" | "right"));
            let wheel_valid = action != "wheel"
                || value
                    .get("deltaY")
                    .and_then(serde_json::Value::as_f64)
                    .is_some_and(|delta| delta.is_finite() && delta.abs() <= 10_000.0);
            coordinates_valid
                && (action == "pointermove" || action == "wheel" || button_valid)
                && wheel_valid
        }
        "keydown" | "keyup" => value
            .get("key")
            .and_then(serde_json::Value::as_str)
            .is_some_and(|key| !key.is_empty() && key.len() <= 64),
        _ => false,
    };
    if !valid {
        eprintln!("Rejected invalid input payload");
        return rejected_control_audit(action, "invalid_payload");
    }
    // The console always sends normalized coordinates for the full virtual
    // desktop (it maps the selected display's frame into virtual bounds before
    // sending). The Windows input backend injects with
    // MOUSEEVENTF_ABSOLUTE|MOUSEEVENTF_VIRTUALDESK, which expects exactly that
    // virtual-desktop fraction, so the payload passes through unchanged.
    // Remapping here used to double-map the fraction, which offset every click
    // when the endpoint had more than one display or the selected display was
    // not at the virtual origin.
    match apply_input(&value, &action) {
        Ok(()) => {
            println!("Applied validated input action: {action}");
            ControlAudit {
                outcome: "accepted".to_owned(),
                action,
                reason: "applied".to_owned(),
            }
        }
        Err(error) => {
            eprintln!("Input action rejected by native backend: {error:#}");
            rejected_control_audit(action, "native_backend_rejected")
        }
    }
}

/// Present monitor names the way humans expect them. Windows reports device
/// paths such as `\\.\DISPLAY1` or `\\?\DISPLAY2`; macOS reports friendly
/// names like "Color LCD". Strip the path and keep the readable label.
fn friendly_monitor_name(monitor: &Monitor, index: usize) -> String {
    let raw = monitor.name().unwrap_or_default();
    let name = raw.trim();
    if name.is_empty() {
        return format!("Display {}", index + 1);
    }
    let stripped = name.trim_start_matches("\\\\.\\").trim_start_matches("\\\\?\\");
    if stripped != name {
        if let Some(digits) = stripped.strip_prefix("DISPLAY") {
            if !digits.is_empty() && digits.chars().all(|character| character.is_ascii_digit()) {
                return format!("Display {digits}");
            }
        }
        return format!("Display {}", index + 1);
    }
    if name.contains('\\') || name.contains('/') || name.len() > 32 {
        return format!("Display {}", index + 1);
    }
    name.to_owned()
}

fn monitor_catalog(monitors: &[Monitor]) -> Vec<serde_json::Value> {
    monitors
        .iter()
        .enumerate()
        .map(|(index, monitor)| {
            serde_json::json!({
                "id": index,
                "name": friendly_monitor_name(monitor, index),
                "x": monitor.x().unwrap_or(0),
                "y": monitor.y().unwrap_or(0),
                "width": monitor.width().unwrap_or(0),
                "height": monitor.height().unwrap_or(0),
                "primary": monitor.is_primary().unwrap_or(false),
            })
        })
        .collect()
}

fn handle_session_control_message(
    message: &DataChannelMessage,
    can_monitor: bool,
    can_clipboard: bool,
    monitors: &[Monitor],
    selected_monitor: &Arc<StdMutex<Option<usize>>>,
) -> Option<serde_json::Value> {
    let text = std::str::from_utf8(&message.data).ok()?;
    let value = serde_json::from_str::<serde_json::Value>(text).ok()?;
    if value.get("type").and_then(serde_json::Value::as_str) != Some("control") {
        return None;
    }
    let action = value.get("action").and_then(serde_json::Value::as_str)?;
    let request_id = value
        .get("requestId")
        .cloned()
        .unwrap_or(serde_json::Value::Null);
    match action {
        "monitor_list" if can_monitor => Some(serde_json::json!({
            "type": "monitor",
            "action": "list",
            "monitors": monitor_catalog(monitors),
            "selectedMonitorId": selected_monitor.lock().ok().and_then(|selected| *selected),
        })),
        "monitor_select" if can_monitor => {
            let monitor_id = value
                .get("monitorId")
                .and_then(serde_json::Value::as_u64)
                .map(|id| id as usize);
            let valid = monitor_id.is_some_and(|id| id < monitors.len());
            if valid {
                if let Ok(mut selected) = selected_monitor.lock() {
                    *selected = monitor_id;
                }
                Some(serde_json::json!({
                    "type": "monitor",
                    "action": "selected",
                    "monitorId": monitor_id,
                    "monitors": monitor_catalog(monitors),
                }))
            } else {
                Some(serde_json::json!({
                    "type": "monitor",
                    "action": "error",
                    "reason": "the requested display is not available",
                }))
            }
        }
        "monitor_all" if can_monitor => {
            if let Ok(mut selected) = selected_monitor.lock() {
                *selected = None;
            }
            Some(serde_json::json!({
                "type": "monitor",
                "action": "selected",
                "monitorId": serde_json::Value::Null,
                "monitors": monitor_catalog(monitors),
            }))
        }
        "monitor_list" | "monitor_select" | "monitor_all" => Some(serde_json::json!({
            "type": "monitor",
            "action": "error",
            "reason": "display control permission was not granted",
        })),
        "presence" => Some(serde_json::json!({
            "type": "presence",
            "status": "endpoint_ready",
        })),
        "clipboard_get" if can_clipboard => Some(match read_clipboard_text() {
            Ok(text) => serde_json::json!({
                "type": "control",
                "action": "clipboard_result",
                "requestId": request_id,
                "text": text,
            }),
            Err(error) => serde_json::json!({
                "type": "control",
                "action": "clipboard_error",
                "requestId": request_id,
                "reason": error.to_string().chars().take(160).collect::<String>(),
            }),
        }),
        "clipboard_set" if can_clipboard => {
            let Some(text) = value.get("text").and_then(serde_json::Value::as_str) else {
                return Some(serde_json::json!({
                    "type": "control",
                    "action": "clipboard_error",
                    "requestId": request_id,
                    "reason": "clipboard text is required",
                }));
            };
            Some(match write_clipboard_text(text) {
                Ok(()) => serde_json::json!({
                    "type": "control",
                    "action": "clipboard_ack",
                    "requestId": request_id,
                }),
                Err(error) => serde_json::json!({
                    "type": "control",
                    "action": "clipboard_error",
                    "requestId": request_id,
                    "reason": error.to_string().chars().take(160).collect::<String>(),
                }),
            })
        }
        "clipboard_get" | "clipboard_set" => Some(serde_json::json!({
            "type": "control",
            "action": "clipboard_error",
            "requestId": request_id,
            "reason": "clipboard permission was not granted",
        })),
        _ => None,
    }
}

fn spawn_terminal_reader<R>(reader: R, channel: Arc<RTCDataChannel>, stream: &'static str)
where
    R: AsyncRead + Unpin + Send + 'static,
{
    tokio::spawn(async move {
        let mut reader = BufReader::new(reader);
        let mut line = String::new();
        loop {
            match reader.read_line(&mut line).await {
                Ok(0) | Err(_) => break,
                Ok(_) => {
                    let text = std::mem::take(&mut line);
                    if channel
                        .send_text(
                            serde_json::json!({
                                "type": "terminal",
                                "action": "output",
                                "stream": stream,
                                "text": text,
                            })
                            .to_string(),
                        )
                        .await
                        .is_err()
                    {
                        break;
                    }
                }
            }
        }
    });
}

async fn start_terminal(
    state: Arc<Mutex<Option<Child>>>,
    channel: Arc<RTCDataChannel>,
) -> Result<()> {
    let mut command = {
        #[cfg(target_os = "windows")]
        {
            // Interactive stdin mode: each newline-terminated command executes
            // immediately. `-Command -` would instead buffer all input until EOF,
            // which silently swallows every command sent over the channel.
            let mut command = TokioCommand::new("powershell.exe");
            command.args(["-NoLogo", "-NoProfile", "-NonInteractive"]);
            #[cfg(target_os = "windows")]
            command.creation_flags(0x08000000);
            command
        }
        #[cfg(not(target_os = "windows"))]
        {
            let mut command = TokioCommand::new("sh");
            command.arg("-s");
            command
        }
    };
    command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = command.spawn().context("start audited terminal process")?;
    let stdout = child.stdout.take().context("open terminal stdout")?;
    let stderr = child.stderr.take().context("open terminal stderr")?;
    {
        let mut current = state.lock().await;
        if current.is_some() {
            return Err(anyhow!("a terminal session is already running"));
        }
        *current = Some(child);
    }
    spawn_terminal_reader(stdout, channel.clone(), "stdout");
    spawn_terminal_reader(stderr, channel, "stderr");
    Ok(())
}

async fn write_terminal_input(state: Arc<Mutex<Option<Child>>>, text: &str) -> Result<()> {
    let mut current = state.lock().await;
    let child = current
        .as_mut()
        .ok_or_else(|| anyhow!("terminal session is not running"))?;
    let stdin = child
        .stdin
        .as_mut()
        .ok_or_else(|| anyhow!("terminal input is unavailable"))?;
    let mut input = text.to_owned();
    if !input.ends_with('\n') {
        input.push_str("\r\n");
    }
    stdin
        .write_all(input.as_bytes())
        .await
        .context("write terminal input")?;
    stdin.flush().await.context("flush terminal input")?;
    Ok(())
}

async fn stop_terminal(state: Arc<Mutex<Option<Child>>>) -> Result<()> {
    let mut child = state.lock().await.take();
    if let Some(child) = child.as_mut() {
        let _ = child.kill().await;
    }
    Ok(())
}

struct UploadState {
    target: PathBuf,
    temporary: PathBuf,
    file: fs::File,
    bytes: usize,
}

type UploadTransfers = Arc<Mutex<HashMap<String, UploadState>>>;

fn file_root() -> PathBuf {
    if let Ok(configured) = std::env::var("DESKOS_FILE_ROOT") {
        if !configured.trim().is_empty() {
            return PathBuf::from(configured);
        }
    }
    #[cfg(target_os = "windows")]
    {
        if let Ok(profile) = std::env::var("USERPROFILE") {
            return PathBuf::from(profile).join("Downloads").join("ReyDesk");
        }
        PathBuf::from(r"C:\Users\Public\Downloads\ReyDesk")
    }
    #[cfg(not(target_os = "windows"))]
    {
        PathBuf::from("/tmp/deskos-files")
    }
}

fn safe_file_path(relative: &str) -> Result<PathBuf> {
    let root = file_root();
    fs::create_dir_all(&root).context("create ReyDesk file root")?;
    let normalized = relative.replace('\\', "/");
    let path = Path::new(&normalized);
    if path.is_absolute() || normalized.len() > 512 {
        return Err(anyhow!("absolute or oversized file paths are not allowed"));
    }
    for component in path.components() {
        match component {
            Component::CurDir | Component::Normal(_) => {}
            Component::ParentDir | Component::RootDir | Component::Prefix(_) => {
                return Err(anyhow!("path traversal is not allowed"));
            }
        }
    }
    let denied = [
        "windows",
        "system32",
        "programdata",
        "appdata",
        ".ssh",
        ".git",
    ];
    if path.components().any(|component| {
        let value = component.as_os_str().to_string_lossy().to_ascii_lowercase();
        denied.iter().any(|name| value == *name)
    }) {
        return Err(anyhow!("sensitive directory is not accessible"));
    }
    let candidate = root.join(path);
    let parent = candidate.parent().unwrap_or(&root);
    let canonical_parent = fs::canonicalize(parent).context("resolve file parent")?;
    let canonical_root = fs::canonicalize(&root).context("resolve file root")?;
    if !canonical_parent.starts_with(&canonical_root) {
        return Err(anyhow!("file path escapes the managed root"));
    }
    if candidate.exists() {
        let canonical = fs::canonicalize(&candidate).context("resolve file path")?;
        if !canonical.starts_with(&canonical_root) {
            return Err(anyhow!("file path escapes the managed root"));
        }
    }
    Ok(candidate)
}

fn file_list(relative: &str) -> Result<Vec<serde_json::Value>> {
    let directory = safe_file_path(relative)?;
    if !directory.is_dir() {
        return Err(anyhow!("requested path is not a directory"));
    }
    let mut entries = Vec::new();
    for entry in fs::read_dir(directory).context("read managed directory")? {
        let entry = entry.context("read managed directory entry")?;
        let metadata = entry.metadata().context("read managed file metadata")?;
        let name = entry.file_name().to_string_lossy().into_owned();
        if name.starts_with('.') || name.eq_ignore_ascii_case("desktop.ini") {
            continue;
        }
        entries.push(serde_json::json!({
            "name": name,
            "directory": metadata.is_dir(),
            "size": if metadata.is_file() { metadata.len() } else { 0 },
        }));
    }
    entries.sort_by(|left, right| {
        let left_directory = left
            .get("directory")
            .and_then(serde_json::Value::as_bool)
            .unwrap_or(false);
        let right_directory = right
            .get("directory")
            .and_then(serde_json::Value::as_bool)
            .unwrap_or(false);
        right_directory.cmp(&left_directory).then_with(|| {
            left.get("name")
                .and_then(serde_json::Value::as_str)
                .unwrap_or("")
                .cmp(
                    right
                        .get("name")
                        .and_then(serde_json::Value::as_str)
                        .unwrap_or(""),
                )
        })
    });
    Ok(entries)
}

fn sanitized_transfer_id(value: &str) -> String {
    let sanitized = value
        .chars()
        .filter(|character| character.is_ascii_alphanumeric() || *character == '-')
        .take(48)
        .collect::<String>();
    if sanitized.is_empty() {
        "transfer".to_owned()
    } else {
        sanitized
    }
}

fn list_processes() -> Result<Vec<serde_json::Value>> {
    let mut system = System::new_all();
    system.refresh_all();
    Ok(system
        .processes()
        .values()
        .take(200)
        .map(|process| {
            serde_json::json!({
                "pid": process.pid().as_u32(),
                "name": process.name(),
                "cpu": process.cpu_usage(),
                "memory": process.memory(),
                "user": process.user_id().map(|user| user.to_string()),
            })
        })
        .collect())
}

fn terminate_process(pid: u32) -> Result<()> {
    if pid <= 4 {
        return Err(anyhow!("system process termination is not allowed"));
    }
    let mut system = System::new_all();
    system.refresh_all();
    let process = system
        .process(Pid::from_u32(pid))
        .ok_or_else(|| anyhow!("process {pid} was not found"))?;
    if !process.kill() {
        return Err(anyhow!("process {pid} refused termination"));
    }
    Ok(())
}

#[cfg(target_os = "windows")]
fn list_services() -> Result<Vec<serde_json::Value>> {
    let output = ProcessCommand::new("sc.exe")
        .args(["query", "type=", "service", "state=", "all"])
        .creation_flags(0x08000000) // CREATE_NO_WINDOW
        .output()
        .context("query Windows services")?;
    if !output.status.success() {
        return Err(anyhow!("Windows service query failed"));
    }
    let text = String::from_utf8_lossy(&output.stdout);
    let mut services = Vec::new();
    for line in text.lines() {
        let trimmed = line.trim();
        if let Some(name) = trimmed.strip_prefix("SERVICE_NAME:") {
            let name = name.trim();
            if !name.is_empty() {
                services.push(serde_json::json!({ "name": name }));
            }
        }
    }
    services.sort_by(|left, right| {
        left.get("name")
            .and_then(serde_json::Value::as_str)
            .unwrap_or("")
            .cmp(
                right
                    .get("name")
                    .and_then(serde_json::Value::as_str)
                    .unwrap_or(""),
            )
    });
    Ok(services.into_iter().take(200).collect())
}

#[cfg(not(target_os = "windows"))]
fn list_services() -> Result<Vec<serde_json::Value>> {
    Err(anyhow!(
        "service management is only implemented for Windows endpoints"
    ))
}

#[cfg(target_os = "windows")]
fn change_service(action: &str, name: &str) -> Result<()> {
    if name.is_empty()
        || name.len() > 128
        || !name.chars().all(|character| {
            character.is_ascii_alphanumeric() || matches!(character, '-' | '_' | '.')
        })
    {
        return Err(anyhow!("invalid service name"));
    }
    let denied = ["DeskOSAgent", "RpcSs", "WinDefend", "EventLog", "PlugPlay"];
    if denied
        .iter()
        .any(|blocked| blocked.eq_ignore_ascii_case(name))
    {
        return Err(anyhow!("protected service cannot be changed"));
    }
    let output = ProcessCommand::new("sc.exe")
        .args([action, name])
        .creation_flags(0x08000000) // CREATE_NO_WINDOW
        .output()
        .with_context(|| format!("{action} Windows service"))?;
    if !output.status.success() {
        return Err(anyhow!(
            "service command failed: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    Ok(())
}

#[cfg(not(target_os = "windows"))]
fn change_service(_action: &str, _name: &str) -> Result<()> {
    Err(anyhow!(
        "service management is only implemented for Windows endpoints"
    ))
}

fn handle_system_request(value: &serde_json::Value, can_system: bool) -> serde_json::Value {
    let action = value
        .get("action")
        .and_then(serde_json::Value::as_str)
        .unwrap_or("unknown");
    if !can_system {
        return serde_json::json!({ "type": "sysdata", "action": "error", "reason": "system management permission was not granted" });
    }
    let result = match action {
        "process_list" => list_processes().map(|processes| serde_json::json!({ "type": "sysdata", "action": "process_result", "processes": processes })),
        "process_terminate" => value.get("pid").and_then(serde_json::Value::as_u64).map(|pid| terminate_process(pid as u32).map(|_| serde_json::json!({ "type": "sysdata", "action": "action_ack" }))).unwrap_or_else(|| Err(anyhow!("valid process id is required"))),
        "service_list" => list_services().map(|services| serde_json::json!({ "type": "sysdata", "action": "service_result", "services": services })),
        "service_start" | "service_stop" => value.get("name").and_then(serde_json::Value::as_str).map(|name| change_service(if action == "service_start" { "start" } else { "stop" }, name).map(|_| serde_json::json!({ "type": "sysdata", "action": "action_ack" }))).unwrap_or_else(|| Err(anyhow!("valid service name is required"))),
        _ => Err(anyhow!("unsupported system action")),
    };
    result.unwrap_or_else(|error| serde_json::json!({ "type": "sysdata", "action": "error", "reason": error.to_string().chars().take(160).collect::<String>() }))
}

async fn accept_webrtc_offer(
    writer: SharedRelayWriter,
    offer_sdp: String,
    can_control: bool,
    can_clipboard: bool,
    can_terminal: bool,
    can_file_transfer: bool,
    can_system_manage: bool,
    can_monitor: bool,
    client: Arc<AgentClient>,
    session_id: String,
    ice_servers_override: Option<Vec<RTCIceServer>>,
) -> Result<Arc<webrtc::peer_connection::RTCPeerConnection>> {
    let mut media_engine = MediaEngine::default();
    media_engine
        .register_default_codecs()
        .context("register default WebRTC codecs")?;
    let ice_servers = match ice_servers_override {
        Some(servers) => servers,
        None => match client.ice_config(&session_id).await {
            Ok(servers) => servers,
            Err(error) => {
                eprintln!("[ice] ICE server lookup failed ({error:#}); host-candidate-only media");
                Vec::new()
            }
        },
    };
    let api = APIBuilder::new().with_media_engine(media_engine).build();
    let peer = Arc::new(
        api.new_peer_connection(RTCConfiguration {
            ice_servers,
            ..Default::default()
        })
        .await
        .context("create WebRTC peer connection")?,
    );
    let video_track = Arc::new(TrackLocalStaticSample::new(
        RTCRtpCodecCapability {
            mime_type: "video/H264".to_owned(),
            clock_rate: 90_000,
            channels: 0,
            sdp_fmtp_line: "level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f"
                .to_owned(),
            rtcp_feedback: vec![],
        },
        "screen".to_owned(),
        "deskos-agent".to_owned(),
    ));
    peer.add_track(video_track.clone())
        .await
        .context("add screen video track")?;

    let candidate_writer = writer.clone();
    peer.on_ice_candidate(Box::new(move |candidate| {
        let candidate_writer = candidate_writer.clone();
        Box::pin(async move {
            if let Some(candidate) = candidate {
                if let Ok(candidate) = candidate.to_json() {
                    let _ = send_relay(
                        &candidate_writer,
                        serde_json::json!({
                            "type": "ice",
                            "candidate": {
                                "candidate": candidate.candidate,
                                "sdpMid": candidate.sdp_mid,
                                "sdpMLineIndex": candidate.sdp_mline_index,
                                "usernameFragment": candidate.username_fragment,
                            }
                        }),
                    )
                    .await;
                }
            }
        })
    }));

    let data_client = client.clone();
    let data_session_id = session_id.clone();
    // Start on the endpoint's primary display so the first frame the
    // technician sees is the primary screen. "All displays" remains available
    // through the console switcher (monitor_all clears the selection).
    let initial_monitor_selection = Monitor::all().ok().and_then(|monitors| {
        monitors
            .iter()
            .position(|monitor| monitor.is_primary().unwrap_or(false))
            .or_else(|| (!monitors.is_empty()).then_some(0))
    });
    let monitor_selection = Arc::new(StdMutex::new(initial_monitor_selection));
    let terminal_state = Arc::new(Mutex::new(None::<Child>));
    let file_transfers: UploadTransfers = Arc::new(Mutex::new(HashMap::new()));
    let publisher_monitor_selection = monitor_selection.clone();
    peer.on_data_channel(Box::new(move |channel: Arc<RTCDataChannel>| {
        let can_control = can_control;
        let can_clipboard = can_clipboard;
        let can_terminal = can_terminal;
        let can_file_transfer = can_file_transfer;
        let can_system_manage = can_system_manage;
        let can_monitor = can_monitor;
        let monitor_selection = monitor_selection.clone();
        let terminal_state = terminal_state.clone();
        let file_transfers = file_transfers.clone();
        let client = data_client.clone();
        let session_id = data_session_id.clone();
        Box::pin(async move {
            let label = channel.label().to_owned();
            let is_control_channel = label == "control";
            let opened = channel.clone();
            let cursor_channel = channel.clone();
            let monitor_selection_open = monitor_selection.clone();
            channel.on_open(Box::new(move || {
                let opened = opened.clone();
                let cursor_channel = cursor_channel.clone();
                Box::pin(async move {
                    if !is_control_channel {
                        return;
                    }
                    let _ = opened.send_text("ReyDesk agent control channel ready").await;
                    // Publish the monitor catalogue immediately (not waiting for
                    // a console request) so the technician console can adopt the
                    // primary display and map coordinates before the user ever
                    // interacts with the remote screen. Serialized before the
                    // await because xcap Monitor is not Send across await points.
                    let catalogue_json = {
                        let monitors_for_open = Monitor::all().unwrap_or_default();
                        let selected_for_open = monitor_selection_open
                            .lock()
                            .ok()
                            .and_then(|selection| *selection);
                        serde_json::json!({
                            "type": "monitor",
                            "action": "list",
                            "monitors": monitor_catalog(&monitors_for_open),
                            "selectedMonitorId": selected_for_open,
                        })
                        .to_string()
                    };
                    let _ = opened.send_text(catalogue_json).await;
                    tokio::spawn(async move {
                        loop {
                            let Some((x, y)) = cursor_position() else {
                                tokio::time::sleep(Duration::from_millis(100)).await;
                                continue;
                            };
                            let payload = serde_json::json!({
                                "type": "cursor",
                                "x": x,
                                "y": y,
                                "visible": true,
                                "embedded": true,
                            });
                            if cursor_channel.send_text(payload.to_string()).await.is_err() {
                                break;
                            }
                            tokio::time::sleep(Duration::from_millis(100)).await;
                        }
                    });
                })
            }));
            let response_channel = channel.clone();
            channel.on_message(Box::new(move |message: DataChannelMessage| {
                println!("Received {} bytes on {label} channel", message.data.len());
                if is_control_channel {
                    let request_action = serde_json::from_slice::<serde_json::Value>(&message.data)
                        .ok()
                        .and_then(|value| {
                            value
                                .get("action")
                                .and_then(serde_json::Value::as_str)
                                .map(str::to_owned)
                        });
                    let monitors = Monitor::all().unwrap_or_default();
                    if let Some(response) = handle_session_control_message(
                        &message,
                        can_monitor,
                        can_clipboard,
                        &monitors,
                        &monitor_selection,
                    )
                    {
                        let response_action = response
                            .get("action")
                            .and_then(serde_json::Value::as_str)
                            .unwrap_or_default()
                            .to_owned();
                        let response_reason = response
                            .get("reason")
                            .and_then(serde_json::Value::as_str)
                            .map(str::to_owned);
                        let response_channel = response_channel.clone();
                        let client = client.clone();
                        let session_id = session_id.clone();
                        tokio::spawn(async move {
                            let _ = response_channel.send_text(response.to_string()).await;
                            if let Some(action) = request_action.filter(|action| {
                                matches!(action.as_str(), "clipboard_get" | "clipboard_set")
                            }) {
                                let audit = ControlAudit {
                                    outcome: if response_action == "clipboard_error" {
                                        "rejected".to_owned()
                                    } else {
                                        "accepted".to_owned()
                                    },
                                    action,
                                    reason: response_reason
                                        .unwrap_or_else(|| "applied".to_owned())
                                        .chars()
                                        .take(120)
                                        .collect(),
                                };
                                if let Err(error) = client.audit_control(&session_id, &audit).await
                                {
                                    eprintln!("clipboard audit: {error:#}");
                                }
                            }
                        });
                    }
                } else if label == "terminal" {
                    let terminal_state = terminal_state.clone();
                    let terminal_channel = response_channel.clone();
                    let client = client.clone();
                    let session_id = session_id.clone();
                    tokio::spawn(async move {
                        let value = serde_json::from_slice::<serde_json::Value>(&message.data).ok();
                        let action = value
                            .as_ref()
                            .and_then(|value| value.get("action"))
                            .and_then(serde_json::Value::as_str)
                            .unwrap_or("unknown");
                        let (outcome, reason, response) = if !can_terminal {
                            (
                                "rejected",
                                "terminal permission was not granted".to_owned(),
                                serde_json::json!({ "type": "terminal", "action": "error", "reason": "terminal permission was not granted" }),
                            )
                        } else {
                            match action {
                                "start" => match start_terminal(terminal_state.clone(), terminal_channel.clone()).await {
                                    Ok(()) => ("accepted", "started".to_owned(), serde_json::json!({ "type": "terminal", "action": "ready" })),
                                    Err(error) => ("rejected", error.to_string(), serde_json::json!({ "type": "terminal", "action": "error", "reason": error.to_string() })),
                                },
                                "input" => {
                                    let text = value
                                        .as_ref()
                                        .and_then(|value| value.get("text"))
                                        .and_then(serde_json::Value::as_str)
                                        .unwrap_or_default();
                                    match write_terminal_input(terminal_state.clone(), text).await {
                                        Ok(()) => ("accepted", "applied".to_owned(), serde_json::json!({ "type": "terminal", "action": "input_ack" })),
                                        Err(error) => ("rejected", error.to_string(), serde_json::json!({ "type": "terminal", "action": "error", "reason": error.to_string() })),
                                    }
                                }
                                "close" => match stop_terminal(terminal_state.clone()).await {
                                    Ok(()) => ("accepted", "closed".to_owned(), serde_json::json!({ "type": "terminal", "action": "closed" })),
                                    Err(error) => ("rejected", error.to_string(), serde_json::json!({ "type": "terminal", "action": "error", "reason": error.to_string() })),
                                },
                                _ => ("rejected", "unsupported terminal action".to_owned(), serde_json::json!({ "type": "terminal", "action": "error", "reason": "unsupported terminal action" })),
                            }
                        };
                        let _ = terminal_channel.send_text(response.to_string()).await;
                        let audit_action = match action {
                            "start" => "terminal_start",
                            "input" => "terminal_input",
                            "close" => "terminal_close",
                            _ => "unknown",
                        };
                        let audit = ControlAudit {
                            outcome: outcome.to_owned(),
                            action: audit_action.to_owned(),
                            reason: reason.chars().take(120).collect(),
                        };
                        if let Err(error) = client.audit_control(&session_id, &audit).await {
                            eprintln!("terminal audit: {error:#}");
                        }
                    });
                } else if label == "files" {
                    let file_transfers = file_transfers.clone();
                    let file_channel = response_channel.clone();
                    let client = client.clone();
                    let session_id = session_id.clone();
                    tokio::spawn(async move {
                        let value = serde_json::from_slice::<serde_json::Value>(&message.data).ok();
                        let action = value
                            .as_ref()
                            .and_then(|value| value.get("action"))
                            .and_then(serde_json::Value::as_str)
                            .unwrap_or("unknown");
                        let mut outcome = "accepted".to_owned();
                        let mut reason = "applied".to_owned();
                        let mut response = serde_json::json!({ "type": "files", "action": "error", "reason": "unsupported file action" });
                        if !can_file_transfer {
                            outcome = "rejected".to_owned();
                            reason = "file transfer permission was not granted".to_owned();
                            response = serde_json::json!({ "type": "files", "action": "error", "reason": reason });
                        } else {
                            match action {
                                "list" => {
                                    let path = value.as_ref().and_then(|value| value.get("path")).and_then(serde_json::Value::as_str).unwrap_or("");
                                    match file_list(path) {
                                        Ok(entries) => response = serde_json::json!({ "type": "files", "action": "list_result", "path": path, "root": file_root().to_string_lossy(), "entries": entries }),
                                        Err(error) => { outcome = "rejected".to_owned(); reason = error.to_string(); response = serde_json::json!({ "type": "files", "action": "error", "reason": reason }); }
                                    }
                                }
                                "download" => {
                                    let path = value.as_ref().and_then(|value| value.get("path")).and_then(serde_json::Value::as_str).unwrap_or("");
                                    match safe_file_path(path).and_then(|path| {
                                        let metadata = fs::metadata(&path).context("read download metadata")?;
                                        if !metadata.is_file() { return Err(anyhow!("download target is not a file")); }
                                        if metadata.len() > 16 * 1024 * 1024 { return Err(anyhow!("file exceeds the 16 MB transfer limit")); }
                                        Ok((path, metadata.len()))
                                    }) {
                                        Ok((path_buf, size)) => match fs::read(&path_buf) {
                                            Ok(bytes) => {
                                                let name = path_buf.file_name().map(|name| name.to_string_lossy().into_owned()).unwrap_or_else(|| "download".to_owned());
                                                let _ = file_channel.send_text(serde_json::json!({ "type": "files", "action": "download_start", "name": name, "size": size }).to_string()).await;
                                                for (index, chunk) in bytes.chunks(24 * 1024).enumerate() {
                                                    let payload = serde_json::json!({ "type": "files", "action": "download_chunk", "index": index, "data": BASE64.encode(chunk) });
                                                    if file_channel.send_text(payload.to_string()).await.is_err() { break; }
                                                }
                                                response = serde_json::json!({ "type": "files", "action": "download_end" });
                                            }
                                            Err(error) => { outcome = "rejected".to_owned(); reason = error.to_string(); response = serde_json::json!({ "type": "files", "action": "error", "reason": reason }); }
                                        },
                                        Err(error) => { outcome = "rejected".to_owned(); reason = error.to_string(); response = serde_json::json!({ "type": "files", "action": "error", "reason": reason }); }
                                    }
                                }
                                "upload_start" => {
                                    let transfer_id = value.as_ref().and_then(|value| value.get("transferId")).and_then(serde_json::Value::as_str).unwrap_or("transfer");
                                    let path = value.as_ref().and_then(|value| value.get("path")).and_then(serde_json::Value::as_str).unwrap_or("");
                                    match safe_file_path(path).and_then(|target| {
                                        if target.exists() && target.is_dir() { return Err(anyhow!("upload target is a directory")); }
                                        let temporary = target.with_file_name(format!(".deskos-upload-{}.part", sanitized_transfer_id(transfer_id)));
                                        let file = fs::OpenOptions::new().create(true).write(true).truncate(true).open(&temporary).context("create upload staging file")?;
                                        Ok(UploadState { target, temporary, file, bytes: 0 })
                                    }) {
                                        Ok(upload) => { file_transfers.lock().await.insert(transfer_id.to_owned(), upload); response = serde_json::json!({ "type": "files", "action": "upload_ack", "phase": "start", "transferId": transfer_id }); }
                                        Err(error) => { outcome = "rejected".to_owned(); reason = error.to_string(); response = serde_json::json!({ "type": "files", "action": "error", "reason": reason }); }
                                    }
                                }
                                "upload_chunk" => {
                                    let transfer_id = value.as_ref().and_then(|value| value.get("transferId")).and_then(serde_json::Value::as_str).unwrap_or("");
                                    let encoded = value.as_ref().and_then(|value| value.get("data")).and_then(serde_json::Value::as_str).unwrap_or("");
                                    match BASE64.decode(encoded).context("decode upload chunk") {
                                        Ok(bytes) if bytes.len() <= 24 * 1024 => {
                                            let mut transfers = file_transfers.lock().await;
                                            match transfers.get_mut(transfer_id) {
                                                Some(upload) if upload.bytes + bytes.len() <= 16 * 1024 * 1024 => {
                                                    if let Err(error) = std::io::Write::write_all(&mut upload.file, &bytes) { outcome = "rejected".to_owned(); reason = error.to_string(); response = serde_json::json!({ "type": "files", "action": "error", "reason": reason }); } else { upload.bytes += bytes.len(); response = serde_json::json!({ "type": "files", "action": "upload_ack", "phase": "chunk", "transferId": transfer_id }); }
                                                }
                                                None => { outcome = "rejected".to_owned(); reason = "unknown upload transfer".to_owned(); response = serde_json::json!({ "type": "files", "action": "error", "reason": reason }); }
                                                Some(_) => { outcome = "rejected".to_owned(); reason = "upload exceeds the 16 MB transfer limit".to_owned(); response = serde_json::json!({ "type": "files", "action": "error", "reason": reason }); }
                                            }
                                        }
                                        Ok(_) => { outcome = "rejected".to_owned(); reason = "upload chunk exceeds the 24 KB limit".to_owned(); response = serde_json::json!({ "type": "files", "action": "error", "reason": reason }); }
                                        Err(error) => { outcome = "rejected".to_owned(); reason = error.to_string(); response = serde_json::json!({ "type": "files", "action": "error", "reason": reason }); }
                                    }
                                }
                                "upload_complete" => {
                                    let transfer_id = value.as_ref().and_then(|value| value.get("transferId")).and_then(serde_json::Value::as_str).unwrap_or("");
                                    match file_transfers.lock().await.remove(transfer_id) {
                                Some(mut upload) => {
                                    let _ = std::io::Write::flush(&mut upload.file);
                                    match fs::rename(&upload.temporary, &upload.target) {
                                        Ok(()) => {
                                            // Tell the end user a file just arrived: the
                                            // session window (and browser chat UI) picks
                                            // this up from the shared mailbox instantly.
                                            let name = upload.target.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| "file".to_owned());
                                            let saved = upload.target.display().to_string();
                                            let _ = write_mailbox_message(
                                                &chat_mailbox_dir(),
                                                &session_id,
                                                "inbox",
                                                &serde_json::json!({ "body": format!("ReyDesk: Technician sent a file \"{name}\" — saved to {saved}. Press Files to open the folder.") }),
                                            );
                                            response = serde_json::json!({ "type": "files", "action": "upload_complete", "transferId": transfer_id });
                                        }
                                        Err(error) => { outcome = "rejected".to_owned(); reason = error.to_string(); response = serde_json::json!({ "type": "files", "action": "error", "reason": reason }); }
                                    }
                                }
                                        None => { outcome = "rejected".to_owned(); reason = "unknown upload transfer".to_owned(); response = serde_json::json!({ "type": "files", "action": "error", "reason": reason }); }
                                    }
                                }
                                _ => { outcome = "rejected".to_owned(); reason = "unsupported file action".to_owned(); }
                            }
                        }
                        let _ = file_channel.send_text(response.to_string()).await;
                        let audit_action = match action { "list" => "file_list", "download" => "file_download", "upload_start" | "upload_chunk" | "upload_complete" => "file_upload", _ => "unknown" };
                        let audit = ControlAudit { outcome, action: audit_action.to_owned(), reason: reason.chars().take(120).collect() };
                        if let Err(error) = client.audit_control(&session_id, &audit).await { eprintln!("file audit: {error:#}"); }
                    });
                } else if label == "sysdata" {
                    let system_channel = response_channel.clone();
                    let client = client.clone();
                    let session_id = session_id.clone();
                    tokio::spawn(async move {
                        let value = serde_json::from_slice::<serde_json::Value>(&message.data).unwrap_or(serde_json::Value::Null);
                        let action = value.get("action").and_then(serde_json::Value::as_str).unwrap_or("unknown").to_owned();
                        let response = tokio::task::spawn_blocking(move || handle_system_request(&value, can_system_manage)).await.unwrap_or_else(|error| serde_json::json!({ "type": "sysdata", "action": "error", "reason": error.to_string() }));
                        let accepted = response.get("action").and_then(serde_json::Value::as_str) != Some("error");
                        let _ = system_channel.send_text(response.to_string()).await;
                        let audit_action = match action.as_str() { "process_list" => "process_list", "process_terminate" => "process_terminate", "service_list" => "service_list", "service_start" => "service_start", "service_stop" => "service_stop", _ => "unknown" };
                        let reason = response.get("reason").and_then(serde_json::Value::as_str).unwrap_or("applied").chars().take(120).collect();
                        let audit = ControlAudit { outcome: if accepted { "accepted".to_owned() } else { "rejected".to_owned() }, action: audit_action.to_owned(), reason };
                        if let Err(error) = client.audit_control(&session_id, &audit).await { eprintln!("system audit: {error:#}"); }
                    });
                } else {
                    let monitors = Monitor::all().unwrap_or_default();
                    let audit = handle_control_message(
                        &message,
                        can_control,
                        &monitors,
                        &monitor_selection,
                    );
                    // Pointer motion is deliberately not written to the audit log: it is
                    // high-frequency telemetry, contains no useful operator intent, and
                    // would add avoidable API/database latency. Button, wheel, and
                    // keyboard actions remain auditable.
                    if audit.action != "pointermove" {
                        let client = client.clone();
                        let session_id = session_id.clone();
                        tokio::spawn(async move {
                            if let Err(error) = client.audit_control(&session_id, &audit).await {
                                eprintln!("control audit: {error:#}");
                            }
                        });
                    }
                }
                Box::pin(async {})
            }));
        })
    }));

    peer.set_remote_description(
        RTCSessionDescription::offer(offer_sdp).context("parse browser SDP offer")?,
    )
    .await
    .context("set browser SDP offer")?;
    let answer = peer
        .create_answer(None)
        .await
        .context("create WebRTC SDP answer")?;
    peer.set_local_description(answer)
        .await
        .context("set local WebRTC description")?;
    let local = peer
        .local_description()
        .await
        .context("read local WebRTC description")?;
    send_relay(
        &writer,
        serde_json::json!({
            "type": "sdp",
            "description": { "type": "answer", "sdp": local.sdp }
        }),
    )
    .await?;
    let _ = client
        .diagnostic(&session_id, "webrtc.answer_sent", None)
        .await;
    let _ = client
        .diagnostic(&session_id, "screen.publisher_started", None)
        .await;
    start_screen_publisher(video_track, client, session_id, publisher_monitor_selection);
    println!("Sent WebRTC SDP answer; publishing screen frames");
    Ok(peer)
}

async fn run_relay_connection(
    config: &AgentConfig,
    session_id: &str,
    join_token: &str,
    permissions: &[String],
    client: Arc<AgentClient>,
    ice_servers_override: Option<Vec<RTCIceServer>>,
) -> Result<bool> {
    let (socket, _) = connect_async(&config.relay_url)
        .await
        .with_context(|| format!("connect to relay {}", config.relay_url))?;
    let (writer, mut reader) = socket.split();
    let writer = Arc::new(Mutex::new(writer));
    send_relay(
        &writer,
        serde_json::json!({
            "type": "join",
            "sessionId": session_id,
            "joinToken": join_token,
        }),
    )
    .await?;
    let (drain_cancel, drain_receiver) = watch::channel(false);
    let _drain_guard = RelayDrainGuard(drain_cancel);
    {
        let writer = writer.clone();
        let client = client.clone();
        let session_id = session_id.to_owned();
        tokio::spawn(drain_chat_outbox(
            session_id,
            writer,
            client,
            drain_receiver,
        ));
    }
    println!("Agent joined relay for session {session_id}; waiting for technician signaling");
    let mut peer: Option<Arc<webrtc::peer_connection::RTCPeerConnection>> = None;
    let mut pending_ice: Vec<RTCIceCandidateInit> = Vec::new();

    loop {
        match reader.next().await {
            Some(Ok(Message::Text(text))) => {
                let value: serde_json::Value =
                    serde_json::from_str(&text).context("parse relay message")?;
                match value.get("type").and_then(serde_json::Value::as_str) {
                    Some("joined") => {
                        println!("Relay room joined");
                        let _ = client.diagnostic(session_id, "relay.joined", None).await;
                        if let Err(error) = client.state(session_id, "active").await {
                            eprintln!("report active session state: {error:#}");
                        }
                    }
                    Some("peer_joined") => {
                        println!("Technician connected to relay");
                        let _ = client
                            .diagnostic(session_id, "relay.peer_joined", None)
                            .await;
                    }
                    Some("sdp") => {
                        let description = value
                            .get("description")
                            .context("missing SDP description")?;
                        if description.get("type").and_then(serde_json::Value::as_str)
                            == Some("offer")
                        {
                            // Only answer the first offer. The browser companion
                            // page can join the same relay room for chat, which
                            // makes the technician re-offer; answering twice would
                            // create a second (orphaned) media peer.
                            if peer.is_some() {
                                println!("Ignoring additional WebRTC offer (peer already negotiated)");
                                continue;
                            }
                            let sdp = description
                                .get("sdp")
                                .and_then(serde_json::Value::as_str)
                                .context("missing SDP offer")?;
                            let _ = client
                                .diagnostic(session_id, "webrtc.offer_received", None)
                                .await;
                            let new_peer = match accept_webrtc_offer(
                                writer.clone(),
                                sdp.to_owned(),
                                permissions
                                    .iter()
                                    .any(|permission| permission == "control_input"),
                                permissions
                                    .iter()
                                    .any(|permission| permission == "clipboard"),
                                permissions
                                    .iter()
                                    .any(|permission| permission == "terminal")
                                    && permissions
                                        .iter()
                                        .any(|permission| permission == "elevation"),
                                permissions
                                    .iter()
                                    .any(|permission| permission == "file_transfer"),
                                permissions
                                    .iter()
                                    .any(|permission| permission == "system_manage")
                                    && permissions
                                        .iter()
                                        .any(|permission| permission == "elevation"),
                                permissions
                                    .iter()
                                    .any(|permission| permission == "view_screen"),
                                client.clone(),
                                session_id.to_owned(),
                                ice_servers_override.clone(),
                            )
                            .await
                            {
                                Ok(peer) => peer,
                                Err(error) => {
                                    let reason = error.to_string().chars().take(240).collect();
                                    let _ = client
                                        .diagnostic(session_id, "webrtc.error", Some(reason))
                                        .await;
                                    return Err(error);
                                }
                            };
                            for candidate in pending_ice.drain(..) {
                                new_peer
                                    .add_ice_candidate(candidate)
                                    .await
                                    .context("add queued browser ICE candidate")?;
                            }
                            peer = Some(new_peer);
                        }
                    }
                    Some("ice") => {
                        if let Some(candidate) = value.get("candidate") {
                            let candidate: BrowserIceCandidate =
                                serde_json::from_value(candidate.clone())
                                    .context("parse browser ICE candidate")?;
                            let candidate = RTCIceCandidateInit {
                                candidate: candidate.candidate,
                                sdp_mid: candidate.sdp_mid,
                                sdp_mline_index: candidate.sdp_mline_index,
                                username_fragment: candidate.username_fragment,
                            };
                            if let Some(peer) = &peer {
                                peer.add_ice_candidate(candidate)
                                    .await
                                    .context("add browser ICE candidate")?;
                            } else {
                                pending_ice.push(candidate);
                            }
                        }
                    }
                    Some("chat") => {
                        let body = value
                            .get("body")
                            .and_then(serde_json::Value::as_str)
                            .unwrap_or_default();
                        let from = value
                            .get("from")
                            .and_then(serde_json::Value::as_str)
                            .unwrap_or("technician");
                        println!("[chat] {from}: {body}");
                        if let Err(error) = write_mailbox_message(
                            &chat_mailbox_dir(),
                            session_id,
                            "inbox",
                            &serde_json::json!({ "from": from, "body": body, "ts": mailbox_stamp() }),
                        ) {
                            eprintln!("[chat] write inbox: {error:#}");
                        }
                    }
                    Some("peer_left") => println!("Technician left the relay room"),
                    Some("session_end") => {
                        println!("Technician ended the remote session");
                        clear_chat_mailbox(&chat_mailbox_dir(), session_id);
                        if let Some(peer) = peer.take() {
                            peer.close().await.context("close ended WebRTC peer")?;
                        }
                        return Ok(false);
                    }
                    Some("error") => eprintln!(
                        "Relay error: {}",
                        value.get("code").unwrap_or(&serde_json::Value::Null)
                    ),
                    _ => {}
                }
            }
            Some(Ok(Message::Ping(payload))) => {
                writer
                    .lock()
                    .await
                    .send(Message::Pong(payload))
                    .await
                    .context("reply to relay ping")?;
            }
            Some(Ok(Message::Close(_))) | None => {
                println!("Relay connection closed");
                let _ = client
                    .diagnostic(session_id, "relay.disconnected", None)
                    .await;
                break;
            }
            Some(Ok(_)) => {}
            Some(Err(error)) => {
                let reason = error.to_string().chars().take(240).collect();
                let _ = client
                    .diagnostic(session_id, "relay.error", Some(reason))
                    .await;
                return Err(error).context("relay connection failed");
            }
        }
    }
    if let Some(peer) = peer {
        peer.close().await.context("close WebRTC peer")?;
    }
    Ok(true)
}

async fn connect_relay(
    config: &AgentConfig,
    session_id: &str,
    join_token: &str,
    permissions: &[String],
    client: Arc<AgentClient>,
) -> Result<()> {
    let mut current_token = join_token.to_owned();
    let mut current_permissions = permissions.to_owned();
    let mut backoff_seconds = 1_u64;

    loop {
        let should_reconnect = match run_relay_connection(
            config,
            session_id,
            &current_token,
            &current_permissions,
            client.clone(),
            None,
        )
        .await
        {
            Ok(should_reconnect) => should_reconnect,
            Err(error) => {
                eprintln!("relay session: {error:#}");
                let reason = error.to_string().chars().take(240).collect();
                let _ = client
                    .diagnostic(session_id, "relay.error", Some(reason))
                    .await;
                true
            }
        };
        if !should_reconnect {
            return Ok(());
        }

        println!("Relay session disconnected; requesting a fresh ticket in {backoff_seconds}s");
        tokio::select! {
            _ = tokio::signal::ctrl_c() => {
                println!("Leaving remote session");
                return Ok(());
            }
            _ = tokio::time::sleep(Duration::from_secs(backoff_seconds)) => {}
        }

        let response = client
            .reconnect(session_id)
            .await
            .context("request relay reconnect ticket")?;
        current_token = response
            .join_token
            .context("reconnect response did not include a broker ticket")?;
        current_permissions = response.session.permissions;
        backoff_seconds = (backoff_seconds.saturating_mul(2)).min(30);
    }
}

async fn consent(config_path: PathBuf, session_id: String, granted: bool) -> Result<()> {
    let config = load_config(&config_path)?;
    let client = Arc::new(AgentClient::new(&config));
    let response = client.consent(&session_id, granted, None).await?;
    println!(
        "Session {} is now {}",
        response.session.id, response.session.state
    );
    if let Some(token) = response.join_token {
        println!("Agent broker ticket issued (expires shortly)");
        connect_relay(
            &config,
            &response.session.id,
            &token,
            &response.session.permissions,
            client,
        )
        .await?;
    }
    Ok(())
}

fn capture_desktop_rgb(
    monitors: &[Monitor],
    selected_monitor: Option<usize>,
) -> Result<(Vec<u8>, usize, usize)> {
    if monitors.is_empty() {
        return Err(anyhow!("no display found"));
    }
    // Capture every requested display independently so that a single failing
    // output (a sleeping second monitor, a headless/off output that is still
    // enumerated, or a display the capture API temporarily rejects) does not
    // take down the whole stream. Frames keep flowing from the displays that
    // did capture, and the encoder adapts to the resulting bounds.
    let mut captured: Vec<(i32, i32, xcap::image::RgbaImage)> = Vec::new();
    let mut first_error: Option<anyhow::Error> = None;
    for (index, monitor) in monitors.iter().enumerate() {
        if selected_monitor.is_some_and(|selected| selected != index) {
            continue;
        }
        let offset_x = monitor.x().unwrap_or(0);
        let offset_y = monitor.y().unwrap_or(0);
        match monitor.capture_image() {
            Ok(image) => captured.push((offset_x, offset_y, image)),
            Err(error) => {
                if first_error.is_none() {
                    first_error = Some(anyhow!(
                        "display {} ({}) could not be captured: {error:#}",
                        index + 1,
                        monitor
                            .name()
                            .unwrap_or_else(|_| "unnamed".to_owned()),
                    ));
                    eprintln!("screen capture: {}", first_error.as_ref().unwrap());
                }
            }
        }
    }
    if captured.is_empty() {
        match first_error {
            Some(error) => return Err(error),
            None => return Err(anyhow!("no display could be captured")),
        }
    }
    let left = captured
        .iter()
        .map(|(x, _, _)| *x)
        .min()
        .unwrap_or_default();
    let top = captured
        .iter()
        .map(|(_, y, _)| *y)
        .min()
        .unwrap_or_default();
    let right = captured
        .iter()
        .map(|(x, _, image)| *x + image.width() as i32)
        .max()
        .unwrap_or(left + 1);
    let bottom = captured
        .iter()
        .map(|(_, y, image)| *y + image.height() as i32)
        .max()
        .unwrap_or(top + 1);
    let width = (right - left).max(1) as usize;
    let height = (bottom - top).max(1) as usize;
    let mut rgb = vec![0_u8; width * height * 3];

    for (screen_x, screen_y, image) in captured {
        let offset_x = (screen_x - left).max(0) as usize;
        let offset_y = (screen_y - top).max(0) as usize;
        for (row, pixels) in image
            .as_raw()
            .chunks_exact(image.width() as usize * 4)
            .enumerate()
        {
            let destination = (offset_y + row) * width * 3 + offset_x * 3;
            for (column, pixel) in pixels.chunks_exact(4).enumerate() {
                let index = destination + column * 3;
                if index + 2 < rgb.len() {
                    rgb[index..index + 3].copy_from_slice(&pixel[..3]);
                }
            }
        }
    }

    #[cfg(target_os = "windows")]
    if let Some((cursor_x, cursor_y)) = cursor_coordinates() {
        draw_cursor(&mut rgb, width, height, cursor_x - left, cursor_y - top);
    }
    Ok((rgb, width, height))
}

#[cfg(target_os = "windows")]
fn cursor_coordinates() -> Option<(i32, i32)> {
    let mut point = POINT::default();
    unsafe { GetCursorPos(&mut point).ok()? };
    Some((point.x, point.y))
}

#[cfg(target_os = "windows")]
fn draw_cursor(rgb: &mut [u8], width: usize, height: usize, x: i32, y: i32) {
    for row in 0..20_i32 {
        let max_column = if row < 14 { row / 2 + 2 } else { 9 };
        for column in 0..max_column {
            let px = x + column;
            let py = y + row;
            if px < 0 || py < 0 || px >= width as i32 || py >= height as i32 {
                continue;
            }
            let border = column == 0 || row == 0 || column == max_column - 1 || row > 13;
            let index = (py as usize * width + px as usize) * 3;
            let color = if border { [0, 0, 0] } else { [255, 255, 255] };
            rgb[index..index + 3].copy_from_slice(&color);
        }
    }
}

fn start_screen_publisher(
    track: Arc<TrackLocalStaticSample>,
    client: Arc<AgentClient>,
    session_id: String,
    selected_monitor: Arc<StdMutex<Option<usize>>>,
) {
    let (sender, mut receiver) = tokio::sync::mpsc::channel::<Vec<u8>>(1);
    let runtime_handle = tokio::runtime::Handle::current();
    let frame_reported = Arc::new(AtomicBool::new(false));
    let capture_error_reported = Arc::new(AtomicBool::new(false));
    thread::spawn(move || {
        let screens = match Monitor::all() {
            Ok(screens) if !screens.is_empty() => screens,
            Ok(_) => {
                eprintln!("screen capture: no display found");
                return;
            }
            Err(error) => {
                eprintln!("screen capture: {error:#}");
                return;
            }
        };
        let mut encoder = match Encoder::new() {
            Ok(encoder) => encoder,
            Err(error) => {
                eprintln!("screen encoder: {error}");
                let reason = error.to_string().chars().take(240).collect();
                let diagnostic_client = client.clone();
                let diagnostic_session = session_id.clone();
                runtime_handle.spawn(async move {
                    let _ = diagnostic_client
                        .diagnostic(&diagnostic_session, "screen.capture_error", Some(reason))
                        .await;
                });
                return;
            }
        };
        let mut encoder_dimensions: Option<(usize, usize)> = None;
        let mut monitor_staleness_reported = false;
        loop {
            let mut selected = selected_monitor.lock().ok().and_then(|selection| *selection);
            // If the requested display no longer exists (monitor unplugged,
            // display configuration changed), fall back to all displays so the
            // stream does not stall on a stale selection.
            if selected.is_some_and(|selected| selected >= screens.len()) {
                if let Ok(mut selection) = selected_monitor.lock() {
                    *selection = None;
                }
                if !monitor_staleness_reported {
                    eprintln!(
                        "screen capture: selected display {} is no longer available; showing all displays",
                        selected.unwrap_or(0) + 1
                    );
                    monitor_staleness_reported = true;
                }
                selected = None;
            }
            // Capture first, then size the encoder to the actual frame: when a
            // display fails (off/sleeping second monitor) the composite shrinks,
            // and encoding must follow the real bounds, not stale monitor metadata.
            let captured = match capture_desktop_rgb(&screens, selected) {
                Ok(captured) => captured,
                Err(error) => {
                    eprintln!("screen capture: {error:#}");
                    if !capture_error_reported.swap(true, Ordering::Relaxed) {
                        let reason = error.to_string().chars().take(240).collect();
                        let diagnostic_client = client.clone();
                        let diagnostic_session = session_id.clone();
                        runtime_handle.spawn(async move {
                            let _ = diagnostic_client
                                .diagnostic(
                                    &diagnostic_session,
                                    "screen.capture_error",
                                    Some(reason),
                                )
                                .await;
                        });
                    }
                    thread::sleep(Duration::from_millis(250));
                    continue;
                }
            };
            let (rgb, width, height) = captured;
            let dimensions = (width, height);
            if encoder_dimensions != Some(dimensions) {
                match Encoder::new() {
                    Ok(new_encoder) => {
                        encoder = new_encoder;
                        encoder_dimensions = Some(dimensions);
                    }
                    Err(error) => {
                        eprintln!("screen encoder reset: {error}");
                        thread::sleep(Duration::from_millis(250));
                        continue;
                    }
                }
            }
            let yuv = YUVBuffer::from_rgb_source(RgbSliceU8::new(&rgb, (width, height)));
            match encoder.encode(&yuv) {
                Ok(frame) => {
                    let frame = frame.to_vec();
                    if !frame_reported.swap(true, Ordering::Relaxed) {
                        let diagnostic_client = client.clone();
                        let diagnostic_session = session_id.clone();
                        let size = frame.len();
                        runtime_handle.spawn(async move {
                            let _ = diagnostic_client
                                .diagnostic(
                                    &diagnostic_session,
                                    "screen.frame_encoded",
                                    Some(format!("bytes={size}")),
                                )
                                .await;
                        });
                    }
                    match sender.try_send(frame) {
                        Ok(()) | Err(tokio::sync::mpsc::error::TrySendError::Full(_)) => {}
                        Err(tokio::sync::mpsc::error::TrySendError::Closed(_)) => break,
                    }
                }
                Err(error) => {
                    eprintln!("screen encoder: {error:#}");
                    if !capture_error_reported.swap(true, Ordering::Relaxed) {
                        let reason = error.to_string().chars().take(240).collect();
                        let diagnostic_client = client.clone();
                        let diagnostic_session = session_id.clone();
                        runtime_handle.spawn(async move {
                            let _ = diagnostic_client
                                .diagnostic(
                                    &diagnostic_session,
                                    "screen.capture_error",
                                    Some(reason),
                                )
                                .await;
                        });
                    }
                }
            }
            thread::sleep(Duration::from_millis(33));
        }
    });

    tokio::spawn(async move {
        while let Some(frame) = receiver.recv().await {
            let sample = Sample {
                data: Bytes::from(frame),
                duration: Duration::from_millis(33),
                ..Default::default()
            };
            if track.write_sample(&sample).await.is_err() {
                break;
            }
        }
    });
}

fn capture_screen(output: PathBuf) -> Result<()> {
    let screens = Monitor::all().context("enumerate displays")?;
    let screen = screens.first().context("no display found")?;
    let image = screen.capture_image().context("capture primary display")?;
    image
        .save(&output)
        .with_context(|| format!("write screenshot {}", output.display()))?;
    println!(
        "Captured primary display ({}x{}) to {}",
        image.width(),
        image.height(),
        output.display()
    );
    Ok(())
}

async fn report_state(config_path: PathBuf, session_id: String, state: String) -> Result<()> {
    let config = load_config(&config_path)?;
    AgentClient::new(&config).state(&session_id, &state).await?;
    println!("Reported session {session_id} as {state}");
    Ok(())
}

async fn end_session(config_path: PathBuf, session_id: String) -> Result<()> {
    let config = load_config(&config_path)?;
    let response = AgentClient::new(&config).end_session(&session_id).await?;
    println!(
        "Ended session {} from the endpoint ({})",
        response.session.id, response.session.state
    );
    Ok(())
}

async fn check_update(config_path: PathBuf, version: String) -> Result<()> {
    let config = load_config(&config_path)?;
    let client = AgentClient::new(&config);
    let response = client.check_update(&version).await?;
    println!("update status: {}", response.status);
    match &response.update {
        Some(offer) => println!(
            "update available: {} (min {}, sha256 {}, rollout {}%, {}): {}",
            offer.version,
            offer.min_version,
            offer.sha256,
            offer.rollout_percent,
            if offer.signature.is_empty() {
                "unsigned"
            } else {
                "signed"
            },
            offer.url,
        ),
        None => {}
    }
    if response.status == "available" {
        if let Some(offer) = &response.update {
            client
                .report_update(&version, &offer.version, "checked", None)
                .await?;
        }
    }
    Ok(())
}

/// Verify a downloaded artifact against its manifest: SHA-256 is always
/// enforced, and when a public key is available the base64 ed25519 signature
/// over `<version>:<sha256>` is verified too.
fn verify_update_artifact(
    bytes: &[u8],
    expected_sha256: &str,
    version: &str,
    signature_b64: &str,
    public_key_b64: Option<&str>,
) -> Result<()> {
    let actual = hex::encode(Sha256::digest(bytes));
    if !actual.eq_ignore_ascii_case(expected_sha256.trim()) {
        anyhow::bail!(
            "sha256 mismatch: expected {}, got {}",
            expected_sha256.trim(),
            actual
        );
    }
    if !signature_b64.is_empty() {
        let public_key_b64 = public_key_b64.ok_or_else(|| {
            anyhow!(
                "the update is signed but no REYDESK_UPDATE_PUBLIC_KEY (or legacy DESKOS_UPDATE_PUBLIC_KEY) was baked into this build"
            )
        })?;
        let public_key_bytes = BASE64
            .decode(public_key_b64)
            .context("decode baked public key")?;
        let public_key: [u8; 32] = public_key_bytes
            .try_into()
            .map_err(|_| anyhow!("baked public key is not 32 bytes"))?;
        let signature_bytes = BASE64.decode(signature_b64).context("decode signature")?;
        let signature = Signature::from_slice(&signature_bytes).context("parse signature")?;
        let message = format!("{version}:{}", expected_sha256.trim());
        VerifyingKey::from_bytes(&public_key)
            .context("parse public key")?
            .verify(message.as_bytes(), &signature)
            .context("ed25519 signature verification failed")?;
    }
    Ok(())
}

async fn verify_update(
    file: PathBuf,
    sha256: String,
    version: String,
    signature: String,
) -> Result<()> {
    let bytes = fs::read(&file).with_context(|| format!("read {}", file.display()))?;
    verify_update_artifact(&bytes, &sha256, &version, &signature, UPDATE_PUBLIC_KEY)?;
    println!(
        "{} verified (sha256 {}{})",
        file.display(),
        sha256.trim(),
        if signature.is_empty() {
            ""
        } else {
            ", signature valid"
        }
    );
    Ok(())
}

#[cfg(target_os = "windows")]
define_windows_service!(ffi_service_main, service_main);

#[cfg(target_os = "windows")]
fn service_main(arguments: Vec<OsString>) {
    let config = arguments
        .windows(2)
        .find(|pair| pair[0] == "--config")
        .map(|pair| PathBuf::from(&pair[1]))
        .unwrap_or_else(|| PathBuf::from("deskos-agent.json"));
    if let Err(error) = run_windows_service(config) {
        eprintln!("ReyDesk Windows service failed: {error:#}");
    }
}

#[cfg(target_os = "windows")]
fn run_windows_service(config: PathBuf) -> Result<()> {
    let (shutdown_tx, shutdown_rx) = mpsc::unbounded_channel();
    let status_handle =
        service_control_handler::register(SERVICE_NAME, move |event| match event {
            ServiceControl::Stop | ServiceControl::Shutdown => {
                let _ = shutdown_tx.send(());
                ServiceControlHandlerResult::NoError
            }
            _ => ServiceControlHandlerResult::NotImplemented,
        })?;
    status_handle.set_service_status(ServiceStatus {
        service_type: ServiceType::OWN_PROCESS,
        current_state: ServiceState::Running,
        controls_accepted: ServiceControlAccept::STOP | ServiceControlAccept::SHUTDOWN,
        exit_code: ServiceExitCode::Win32(0),
        checkpoint: 0,
        wait_hint: Duration::from_secs(5),
        process_id: None,
    })?;

    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .context("create Windows service runtime")?;
    let result = runtime.block_on(run_agent(config, None, false, Some(shutdown_rx)));
    status_handle.set_service_status(ServiceStatus {
        service_type: ServiceType::OWN_PROCESS,
        current_state: ServiceState::Stopped,
        controls_accepted: ServiceControlAccept::empty(),
        exit_code: ServiceExitCode::Win32(if result.is_ok() { 0 } else { 1 }),
        checkpoint: 0,
        wait_hint: Duration::from_secs(5),
        process_id: None,
    })?;
    result
}

fn run_service(config: PathBuf) -> Result<()> {
    #[cfg(target_os = "windows")]
    {
        let _ = config;
        service_dispatcher::start(SERVICE_NAME, ffi_service_main)
            .context("start Windows service dispatcher")?;
        return Ok(());
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = config;
        Err(anyhow!(
            "the native service command is only available on Windows"
        ))
    }
}

fn install_service(config: PathBuf) -> Result<()> {
    #[cfg(target_os = "windows")]
    {
        let executable = std::env::current_exe().context("locate agent executable")?;
        let config = fs::canonicalize(&config)
            .with_context(|| format!("locate agent config {}", config.display()))?;
        let bin_path = format!(
            "\\\"{}\\\" service --config \\\"{}\\\"",
            executable.display(),
            config.display()
        );
        let create = ProcessCommand::new("sc.exe")
            .arg("create")
            .arg(SERVICE_NAME)
            .arg("binPath=")
            .arg(&bin_path)
            .arg("start=")
            .arg("auto")
            .arg("DisplayName=")
            .arg("ReyDesk Endpoint Agent")
            .creation_flags(0x08000000) // CREATE_NO_WINDOW
            .status()
            .context("run sc.exe create")?;
        if !create.success() {
            return Err(anyhow!(
                "sc.exe could not create the {SERVICE_NAME} service"
            ));
        }
        let failure = ProcessCommand::new("sc.exe")
            .args([
                "failure",
                SERVICE_NAME,
                "reset=",
                "86400",
                "actions=",
                "restart/5000/restart/15000/restart/60000",
            ])
            .creation_flags(0x08000000) // CREATE_NO_WINDOW
            .status()
            .context("configure Windows service recovery")?;
        if !failure.success() {
            return Err(anyhow!("sc.exe could not configure service recovery"));
        }
        let start = ProcessCommand::new("sc.exe")
            .args(["start", SERVICE_NAME])
            .creation_flags(0x08000000) // CREATE_NO_WINDOW
            .status()
            .context("start ReyDesk service")?;
        if !start.success() {
            return Err(anyhow!("sc.exe could not start the {SERVICE_NAME} service"));
        }
        println!(
            "Installed and started {SERVICE_NAME} using {}",
            executable.display()
        );
        return Ok(());
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = config;
        Err(anyhow!(
            "the native service installer is only available on Windows"
        ))
    }
}

fn uninstall_service() -> Result<()> {
    #[cfg(target_os = "windows")]
    {
        let _ = ProcessCommand::new("sc.exe")
            .args(["stop", SERVICE_NAME])
            .creation_flags(0x08000000) // CREATE_NO_WINDOW
            .status();
        let delete = ProcessCommand::new("sc.exe")
            .args(["delete", SERVICE_NAME])
            .creation_flags(0x08000000) // CREATE_NO_WINDOW
            .status()
            .context("run sc.exe delete")?;
        if !delete.success() {
            return Err(anyhow!(
                "sc.exe could not remove the {SERVICE_NAME} service"
            ));
        }
        println!("Removed {SERVICE_NAME}");
        return Ok(());
    }
    #[cfg(not(target_os = "windows"))]
    {
        Err(anyhow!(
            "the native service uninstaller is only available on Windows"
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_ice_servers_into_rtc_configuration_entries() {
        let json = r#"{"iceServers":[{"urls":"stun:stun.l.google.com:19302"},{"urls":["turn:turn.example.com:3478","turns:turn.example.com:443"],"username":"1789000000:deskos","credential":"c2lnbmF0dXJl"}]}"#;
        let parsed: IceConfigResponse = serde_json::from_str(json).expect("ice config parses");
        assert_eq!(parsed.ice_servers.len(), 2);

        let stun = parsed.ice_servers[0].urls();
        assert_eq!(stun, vec!["stun:stun.l.google.com:19302".to_owned()]);

        let turn = parsed.ice_servers[1].urls();
        assert_eq!(
            turn,
            vec![
                "turn:turn.example.com:3478".to_owned(),
                "turns:turn.example.com:443".to_owned()
            ]
        );
        let rtc = parsed.ice_servers[1].clone().into_rtc();
        assert_eq!(rtc.username, "1789000000:deskos");
        assert_eq!(rtc.credential, "c2lnbmF0dXJl");
        assert_eq!(rtc.urls.len(), 2);
    }

    #[test]
    fn serializes_rich_health_telemetry_using_api_field_names() {
        let payload = MetricsRequest {
            cpu_pct: 12.5,
            mem_pct: 40.0,
            disk_pct: 60.0,
            disk_free_bytes: 987654321,
            network_latency_ms: Some(24.5),
            battery_pct: Some(73.0),
            battery_health_pct: Some(91.0),
            uptime_seconds: 86400,
            process_count: 142,
            service_states: HashMap::from([(String::from("Spooler"), String::from("running"))]),
            reason: "periodic".to_owned(),
        };
        let json = serde_json::to_value(payload).expect("telemetry serializes");
        assert_eq!(json["cpuPct"], 12.5);
        assert_eq!(json["diskFreeBytes"], 987654321u64);
        assert_eq!(json["networkLatencyMs"], 24.5);
        assert_eq!(json["batteryPct"], 73.0);
        assert_eq!(json["batteryHealthPct"], 91.0);
        assert_eq!(json["serviceStates"]["Spooler"], "running");
        assert_eq!(json["uptimeSeconds"], 86400u64);
        assert_eq!(json["processCount"], 142);
        assert_eq!(json["reason"], "periodic");
    }

    #[test]
    fn parses_update_check_response_into_an_offer() {
        let available = r#"{"update":{"version":"0.1.1","minVersion":"0.1.0","url":"https://dl.example/deskos-agent.exe","sha256":"abc123","signature":"sig","rolloutPercent":50},"status":"available"}"#;
        let parsed: UpdateCheckResponse = serde_json::from_str(available).expect("update parses");
        assert_eq!(parsed.status, "available");
        let offer = parsed.update.expect("offer present");
        assert_eq!(offer.version, "0.1.1");
        assert_eq!(offer.min_version, "0.1.0");
        assert_eq!(offer.sha256, "abc123");
        assert_eq!(offer.rollout_percent, 50);

        let deferred = r#"{"update":null,"status":"rollout_deferred"}"#;
        let parsed: UpdateCheckResponse = serde_json::from_str(deferred).expect("deferred parses");
        assert_eq!(parsed.status, "rollout_deferred");
        assert!(parsed.update.is_none());
    }

    #[test]
    fn verifies_artifact_sha256_and_ed25519_signature() {
        let bytes = b"deskos-agent-release-bytes";
        let version = "0.1.1";
        let sha256 = hex::encode(Sha256::digest(bytes));

        // SHA-256 alone (unsigned development artifact).
        verify_update_artifact(bytes, &sha256, version, "", None).expect("sha256 verifies");
        assert!(verify_update_artifact(bytes, &"0".repeat(64), version, "", None).is_err());

        // Deterministic keypair and a signature over `<version>:<sha256>`.
        use ed25519_dalek::Signer;
        let signing_key = ed25519_dalek::SigningKey::from_bytes(&[7u8; 32]);
        let signature = signing_key.sign(format!("{version}:{sha256}").as_bytes());
        let signature_b64 = BASE64.encode(signature.to_bytes());
        let public_key_b64 = BASE64.encode(signing_key.verifying_key().to_bytes());

        // A signed artifact needs a key; the dev build has none baked in.
        assert!(verify_update_artifact(bytes, &sha256, version, &signature_b64, None).is_err());

        // Correct key + signature verifies.
        verify_update_artifact(
            bytes,
            &sha256,
            version,
            &signature_b64,
            Some(&public_key_b64),
        )
        .expect("signed artifact verifies");

        // A wrong signature is rejected.
        let bad_sig = BASE64.encode([0u8; 64]);
        assert!(
            verify_update_artifact(bytes, &sha256, version, &bad_sig, Some(&public_key_b64))
                .is_err()
        );
    }

    #[test]
    fn control_audit_is_redacted_to_action_and_reason() {
        let audit = rejected_control_audit("keydown", "invalid_payload");
        let encoded = serde_json::to_string(&audit).expect("audit serializes");
        assert_eq!(audit.outcome, "rejected");
        assert_eq!(audit.action, "keydown");
        assert_eq!(audit.reason, "invalid_payload");
        assert!(!encoded.contains("coordinates"));
        assert!(!encoded.contains("key-value"));
    }

    #[test]
    fn parses_numeric_codes_and_secure_claim_links() {
        assert_eq!(parse_support_input("123456789012").unwrap(), ("123456789012".to_owned(), None));
        assert!(parse_support_input("1234567890").is_err());
        let parsed = parse_support_input("https://support.example/connect/123456789012?claimToken=deskos_link_secret").unwrap();
        assert_eq!(parsed.0, "123456789012");
        assert_eq!(parsed.1.as_deref(), Some("deskos_link_secret"));
        assert!(parse_support_input("1234").is_err());
        assert!(parse_support_input("https://support.example/connect/1234567890").is_err());
    }

    #[test]
    fn parses_support_code_claim_response() {
        let json = r#"{"device":{"id":"dev-1","name":"customer-laptop"},"deviceToken":"deskos_dev_abc123","session":{"id":"sess-1","state":"consent_pending"},"relayUrl":"ws://relay.example/ws"}"#;
        let parsed: ClaimResponse = serde_json::from_str(json).expect("claim response parses");
        assert_eq!(parsed.device.id, "dev-1");
        assert_eq!(parsed.device.name, "customer-laptop");
        assert_eq!(parsed.device_token, "deskos_dev_abc123");
        assert_eq!(parsed.session.id, "sess-1");
        assert_eq!(parsed.session.state, "consent_pending");
        assert_eq!(parsed.relay_url, "ws://relay.example/ws");
    }

    #[test]
    fn config_roundtrip_uses_the_expected_storage_format() {
        let path = std::env::temp_dir().join(format!(
            "deskos-agent-config-test-{}.json",
            std::process::id()
        ));
        let config = AgentConfig {
            api_url: "http://localhost:4000".to_owned(),
            relay_url: "ws://localhost:4100/ws".to_owned(),
            device_id: "device-test".to_owned(),
            device_token: "secret-device-token".to_owned(),
            name: "test-endpoint".to_owned(),
            hostname: "test-host".to_owned(),
            agent_version: "test".to_owned(),
            device_type: default_device_type(),
            heartbeat_interval_sec: 30,
        };
        save_config(&path, &config).expect("save config");
        let loaded = load_config(&path).expect("load config");
        assert_eq!(loaded.device_id, config.device_id);
        assert_eq!(loaded.device_token, config.device_token);
        #[cfg(target_os = "windows")]
        {
            let raw = fs::read(&path).expect("read protected config");
            let text = String::from_utf8_lossy(&raw);
            assert!(text.contains(PROTECTED_CONFIG_FORMAT));
            assert!(!text.contains("secret-device-token"));
        }
        let _ = fs::remove_file(&path);

        let legacy_path = std::env::temp_dir().join(format!(
            "deskos-agent-legacy-config-test-{}.json",
            std::process::id()
        ));
        let legacy = serde_json::to_vec(&config).expect("serialize legacy config");
        fs::write(&legacy_path, legacy).expect("write legacy config");
        let migrated = load_config(&legacy_path).expect("migrate legacy config");
        assert_eq!(migrated.device_token, config.device_token);
        #[cfg(target_os = "windows")]
        {
            let raw = fs::read(&legacy_path).expect("read migrated config");
            let text = String::from_utf8_lossy(&raw);
            assert!(text.contains(PROTECTED_CONFIG_FORMAT));
            assert!(!text.contains("secret-device-token"));
        }
        let _ = fs::remove_file(legacy_path);
    }

    #[test]
    fn enrollment_page_only_requests_the_one_time_code() {
        let page = enrollment_html(None);
        assert!(page.contains("Enrollment code (12 digits)"));
        assert!(page.contains("pattern=\"[0-9]{12}\""));
        assert!(!page.contains("ReyDesk API URL"));
        assert!(!page.contains("Relay URL"));
    }

    #[test]
    fn enrollment_form_decodes_urls_and_tokens() {
        let fields = parse_form("api_url=http%3A%2F%2Fdeskos%3A4000&relay_url=ws%3A%2F%2Fdeskos%3A4100%2Fws&token=deskos_demo%2Bcode");
        assert_eq!(
            fields.get("api_url"),
            Some(&"http://deskos:4000".to_owned())
        );
        assert_eq!(
            fields.get("relay_url"),
            Some(&"ws://deskos:4100/ws".to_owned())
        );
        assert_eq!(fields.get("token"), Some(&"deskos_demo+code".to_owned()));
    }

    #[test]
    fn support_helper_accepts_web_generated_code_lengths() {
        assert_eq!(parse_support_input("123456789012").unwrap().0, "123456789012");
        assert!(parse_support_input("12345678").is_err());
        assert!(parse_support_input("1234567890").is_err());
        assert!(parse_support_input("1234567").is_err());
        assert!(parse_support_input("1234567890123").is_err());
    }

    #[test]
    fn unsupported_action_is_recorded_as_unknown_by_the_api_contract() {
        let audit = rejected_control_audit("unknown", "unsupported_message");
        assert_eq!(audit.action, "unknown");
        assert_eq!(audit.reason, "unsupported_message");
    }

    #[test]
    fn chat_mailbox_roundtrips_messages() {
        let dir =
            std::env::temp_dir().join(format!("deskos-chat-mailbox-test-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        let session = "session-1";
        write_mailbox_message(
            &dir,
            session,
            "inbox",
            &serde_json::json!({ "from": "technician", "body": "hello", "ts": 1 }),
        )
        .expect("write inbox 1");
        write_mailbox_message(
            &dir,
            session,
            "inbox",
            &serde_json::json!({ "from": "technician", "body": "are you there?", "ts": 2 }),
        )
        .expect("write inbox 2");
        write_mailbox_message(
            &dir,
            session,
            "outbox",
            &serde_json::json!({ "body": "yes", "ts": 3 }),
        )
        .expect("write outbox");

        let inbox = read_mailbox_messages(&dir, session, "inbox");
        assert_eq!(inbox.len(), 2);
        assert_eq!(inbox[0].1["body"], "hello");
        assert_eq!(inbox[1].1["body"], "are you there?");

        let outbox = read_mailbox_messages(&dir, session, "outbox");
        assert_eq!(outbox.len(), 1);
        assert_eq!(outbox[0].1["body"], "yes");

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn chat_mailbox_drops_corrupt_and_clears_per_session() {
        let dir =
            std::env::temp_dir().join(format!("deskos-chat-clean-test-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        let session = "session-2";
        write_mailbox_message(&dir, session, "inbox", &serde_json::json!({ "body": "ok" }))
            .expect("write inbox");
        fs::write(dir.join(format!("{session}.inbox.9999.json")), b"not json")
            .expect("write corrupt file");
        write_mailbox_message(
            &dir,
            "other-session",
            "inbox",
            &serde_json::json!({ "body": "other" }),
        )
        .expect("write other session");

        let inbox = read_mailbox_messages(&dir, session, "inbox");
        assert_eq!(inbox.len(), 1);
        assert_eq!(inbox[0].1["body"], "ok");
        assert!(!dir.join(format!("{session}.inbox.9999.json")).exists());

        clear_chat_mailbox(&dir, session);
        assert!(read_mailbox_messages(&dir, session, "inbox").is_empty());
        assert_eq!(
            read_mailbox_messages(&dir, "other-session", "inbox").len(),
            1
        );

        let _ = fs::remove_dir_all(&dir);
    }
}

#[tokio::main]
async fn main() -> Result<()> {
    #[cfg(target_os = "windows")]
    enable_dpi_awareness();

    // The portable helper ships as this same binary. A bare double-click has no
    // subcommand, so default to the helper's code-entry window instead of letting
    // clap print a usage error and close the console immediately.
    if std::env::args_os().len() <= 1 {
        // Hide the console window so end users only see the GUI.
        #[cfg(target_os = "windows")]
        unsafe { windows::Win32::System::Console::FreeConsole().ok(); }
        return helper_ui(
            String::new(),
            String::new(),
            None,
            PathBuf::from("deskos-helper.json"),
        )
        .await;
    }

    match Cli::parse().command {
        Command::Enroll {
            api_url,
            relay_url,
            enrol_token,
            name,
            hostname,
            agent_version,
            config,
        } => {
            enroll(
                api_url,
                relay_url,
                enrol_token,
                name,
                hostname,
                agent_version,
                config,
            )
            .await
        }
        Command::Helper {
            api_url,
            relay_url,
            code,
            name,
            config,
        } => {
            // Hide the console window so end users only see the GUI.
            #[cfg(target_os = "windows")]
            unsafe { windows::Win32::System::Console::FreeConsole().ok(); }
            match code {
                Some(code) => run_helper(api_url, relay_url, code, name, config).await,
                None => helper_ui(api_url, relay_url, name, config).await,
            }
        },
        Command::Run {
            config,
            interval_sec,
            interactive_consent,
        } => run_agent(config, interval_sec, interactive_consent, None).await,
        Command::ConsentUi { config } => {
            run_consent_ui(config, Arc::new(StdMutex::new("ReyDesk: online".to_owned()))).await
        }
        Command::TrayUi { config } => run_tray_ui(config).await,
        Command::Consent {
            config,
            session_id,
            granted,
        } => consent(config, session_id, granted).await,
        Command::Capture { output } => capture_screen(output),
        Command::EnrollUi {
            api_url,
            relay_url,
            config,
        } => enroll_ui(api_url, relay_url, config).await,
        Command::End { config, session_id } => end_session(config, session_id).await,
        Command::State {
            config,
            session_id,
            state,
        } => report_state(config, session_id, state).await,
        Command::CheckUpdate { config, version } => check_update(config, version).await,
        Command::VerifyUpdate {
            file,
            sha256,
            version,
            signature,
        } => verify_update(file, sha256, version, signature).await,
        Command::Service { config } => run_service(config),
        Command::InstallService { config } => install_service(config),
        Command::UninstallService => uninstall_service(),
    }
}
