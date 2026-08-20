use chrono::Local;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::fs;
use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::{mpsc, Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::menu::{Menu, MenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Emitter, Manager, PhysicalPosition};

#[cfg(windows)]
use std::os::windows::process::CommandExt;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

#[derive(Debug, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct RawAccount {
    #[serde(rename = "type")]
    account_type: String,
    email: Option<String>,
    plan_type: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AccountReadResult {
    account: Option<RawAccount>,
    requires_openai_auth: bool,
}

#[derive(Debug, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct RawRateWindow {
    used_percent: f64,
    window_duration_mins: i64,
    resets_at: i64,
}

#[derive(Debug, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct RawRateLimitBucket {
    limit_id: String,
    limit_name: Option<String>,
    primary: Option<RawRateWindow>,
    secondary: Option<RawRateWindow>,
    plan_type: Option<String>,
    rate_limit_reached_type: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RateLimitsReadResult {
    rate_limits: Option<RawRateLimitBucket>,
    rate_limits_by_limit_id: Option<HashMap<String, RawRateLimitBucket>>,
}

#[derive(Debug, Deserialize, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct DailyUsageBucket {
    start_date: String,
    tokens: u64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawUsageSummary {
    lifetime_tokens: Option<u64>,
    peak_daily_tokens: Option<u64>,
    longest_running_turn_sec: Option<u64>,
    current_streak_days: Option<u64>,
    longest_streak_days: Option<u64>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct UsageReadResult {
    summary: Option<RawUsageSummary>,
    daily_usage_buckets: Option<Vec<DailyUsageBucket>>,
}

#[derive(Debug)]
struct RawProbe {
    account: AccountReadResult,
    rate_limits: RateLimitsReadResult,
    usage: UsageReadResult,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct AccountSnapshot {
    account_type: String,
    email: Option<String>,
    plan_type: Option<String>,
    requires_openai_auth: bool,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct WindowSnapshot {
    limit_id: String,
    limit_name: Option<String>,
    window_kind: String,
    used_percent: f64,
    remaining_percent: f64,
    window_duration_mins: i64,
    resets_at: i64,
    burn_rate_per_hour: Option<f64>,
    eta_exhausted_at: Option<i64>,
    risk: String,
    rate_limit_reached_type: Option<String>,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct TokenUsageSnapshot {
    lifetime_tokens: Option<u64>,
    peak_daily_tokens: Option<u64>,
    longest_running_turn_sec: Option<u64>,
    current_streak_days: Option<u64>,
    longest_streak_days: Option<u64>,
    today_tokens: Option<u64>,
    daily_usage_buckets: Vec<DailyUsageBucket>,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct UsageSnapshot {
    account: AccountSnapshot,
    windows: Vec<WindowSnapshot>,
    token_usage: TokenUsageSnapshot,
    sampled_at: i64,
    source: &'static str,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct CodexProfile {
    id: String,
    label: String,
    codex_home: Option<String>,
    is_default: bool,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ProfileUsageSnapshot {
    profile: CodexProfile,
    snapshot: Option<UsageSnapshot>,
    error: Option<String>,
}

#[derive(Default)]
struct MonitorState {
    latest: Mutex<HashMap<String, UsageSnapshot>>,
    last_error: Mutex<HashMap<String, String>>,
    pending_profiles: Mutex<HashMap<String, CodexProfile>>,
    login_processes: Mutex<HashMap<String, u32>>,
    probe_lock: Mutex<()>,
}

fn unix_now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64
}

fn app_data_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("無法取得應用程式資料目錄：{error}"))?;
    fs::create_dir_all(&data_dir).map_err(|error| format!("無法建立資料目錄：{error}"))?;
    Ok(data_dir)
}

fn default_profile() -> CodexProfile {
    CodexProfile {
        id: "default".to_string(),
        label: "主要帳號".to_string(),
        codex_home: None,
        is_default: true,
    }
}

fn custom_profiles_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app_data_dir(app)?.join("codex-profiles.json"))
}

fn load_custom_profiles(app: &AppHandle) -> Result<Vec<CodexProfile>, String> {
    let path = custom_profiles_path(app)?;
    if !path.exists() {
        return Ok(Vec::new());
    }

    let raw = fs::read_to_string(&path)
        .map_err(|error| format!("無法讀取 Codex 帳號設定：{error}"))?;
    serde_json::from_str(&raw).map_err(|error| format!("無法解析 Codex 帳號設定：{error}"))
}

fn save_custom_profiles(app: &AppHandle, profiles: &[CodexProfile]) -> Result<(), String> {
    let path = custom_profiles_path(app)?;
    let content = serde_json::to_string_pretty(profiles)
        .map_err(|error| format!("無法序列化 Codex 帳號設定：{error}"))?;
    fs::write(path, content).map_err(|error| format!("無法保存 Codex 帳號設定：{error}"))
}

fn load_profiles(app: &AppHandle) -> Result<Vec<CodexProfile>, String> {
    let mut profiles = vec![default_profile()];
    profiles.extend(load_custom_profiles(app)?);
    Ok(profiles)
}

fn find_profile(app: &AppHandle, profile_id: &str) -> Result<CodexProfile, String> {
    load_profiles(app)?
        .into_iter()
        .find(|profile| profile.id == profile_id)
        .ok_or_else(|| format!("找不到 Codex 帳號：{profile_id}"))
}

fn find_profile_or_pending(
    app: &AppHandle,
    state: &Arc<MonitorState>,
    profile_id: &str,
) -> Result<CodexProfile, String> {
    if let Ok(profile) = find_profile(app, profile_id) {
        return Ok(profile);
    }

    state
        .pending_profiles
        .lock()
        .map_err(|_| "待認證 Codex 帳號狀態異常".to_string())?
        .get(profile_id)
        .cloned()
        .ok_or_else(|| format!("找不到 Codex 帳號：{profile_id}"))
}

fn remove_managed_codex_home(app: &AppHandle, home: &str) -> Result<(), String> {
    let homes_root = app_data_dir(app)?.join("codex-homes");
    let home_path = PathBuf::from(home);
    if !home_path.exists() {
        return Ok(());
    }

    fs::create_dir_all(&homes_root)
        .map_err(|error| format!("無法建立 Codex 帳號根目錄：{error}"))?;
    let canonical_root = fs::canonicalize(&homes_root)
        .map_err(|error| format!("無法驗證 Codex 帳號根目錄：{error}"))?;
    let canonical_home = fs::canonicalize(&home_path)
        .map_err(|error| format!("無法驗證 Codex 帳號目錄：{error}"))?;
    if !canonical_home.starts_with(&canonical_root) {
        return Err("拒絕刪除不屬於 HUD 管理範圍的 Codex 帳號目錄。".to_string());
    }

    fs::remove_dir_all(&canonical_home)
        .map_err(|error| format!("無法刪除 Codex 帳號目錄：{error}"))
}

fn stop_login_process(state: &Arc<MonitorState>, profile_id: &str) {
    let pid = state
        .login_processes
        .lock()
        .ok()
        .and_then(|mut processes| processes.remove(profile_id));
    let Some(pid) = pid else {
        return;
    };

    #[cfg(windows)]
    {
        let _ = quiet_command("taskkill")
            .arg("/PID")
            .arg(pid.to_string())
            .arg("/T")
            .arg("/F")
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }

    #[cfg(not(windows))]
    {
        let _ = quiet_command("kill")
            .arg("-TERM")
            .arg(pid.to_string())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }
}

fn profile_history_name(profile_id: &str) -> String {
    if profile_id == "default" {
        return "usage-history.db".to_string();
    }

    let safe = profile_id
        .chars()
        .map(|value| {
            if value.is_ascii_alphanumeric() || value == '-' || value == '_' {
                value
            } else {
                '_'
            }
        })
        .collect::<String>();
    format!("usage-history-{safe}.db")
}

fn new_profile_id() -> String {
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    format!("account-{millis}")
}

fn apply_profile_env(command: &mut Command, profile: &CodexProfile) {
    if let Some(codex_home) = profile.codex_home.as_deref() {
        command.env("CODEX_HOME", codex_home);
    }
}

fn quiet_command(program: &str) -> Command {
    let mut command = Command::new(program);
    #[cfg(windows)]
    {
        command.creation_flags(CREATE_NO_WINDOW);
    }
    command
}

fn write_rpc(stdin: &mut ChildStdin, payload: Value) -> Result<(), String> {
    writeln!(stdin, "{payload}").map_err(|error| format!("無法寫入 Codex app-server：{error}"))?;
    stdin
        .flush()
        .map_err(|error| format!("無法刷新 Codex app-server 輸入：{error}"))
}

fn wait_for_id(
    receiver: &mpsc::Receiver<Value>,
    target_id: i64,
    timeout: Duration,
) -> Result<Value, String> {
    let deadline = Instant::now() + timeout;
    loop {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return Err(format!("等待 Codex app-server 回應 id={target_id} 逾時"));
        }
        let message = receiver
            .recv_timeout(remaining)
            .map_err(|_| format!("等待 Codex app-server 回應 id={target_id} 逾時"))?;
        if message.get("id").and_then(Value::as_i64) == Some(target_id) {
            if let Some(error) = message.get("error") {
                return Err(format!("Codex app-server 回傳錯誤：{error}"));
            }
            return Ok(message);
        }
    }
}

fn terminate_process_tree(child: &mut Child) {
    #[cfg(windows)]
    {
        let pid = child.id().to_string();
        let _ = quiet_command("taskkill")
            .arg("/PID")
            .arg(pid)
            .arg("/T")
            .arg("/F")
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }

    #[cfg(not(windows))]
    {
        let _ = child.kill();
    }

    let _ = child.wait();
}

fn spawn_app_server(profile: &CodexProfile) -> Result<Child, String> {
    #[cfg(windows)]
    let mut command = {
        let mut command = quiet_command("cmd.exe");
        command.args(["/D", "/S", "/C", "codex app-server"]);
        command
    };

    #[cfg(not(windows))]
    let mut command = {
        let mut command = quiet_command("codex");
        command.arg("app-server");
        command
    };

    apply_profile_env(&mut command, profile);

    command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|error| {
            format!(
                "無法啟動 `codex app-server`。請確認 Codex CLI 已安裝並完成 ChatGPT 登入。詳細：{error}"
            )
        })
}

fn probe_codex(profile: &CodexProfile) -> Result<RawProbe, String> {
    let mut child = spawn_app_server(profile)?;
    let result = (|| {
        let mut stdin = child
            .stdin
            .take()
            .ok_or_else(|| "無法取得 Codex app-server stdin".to_string())?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| "無法取得 Codex app-server stdout".to_string())?;

        let (sender, receiver) = mpsc::channel::<Value>();
        thread::spawn(move || {
            let reader = BufReader::new(stdout);
            for line in reader.lines().map_while(Result::ok) {
                if let Ok(message) = serde_json::from_str::<Value>(&line) {
                    if sender.send(message).is_err() {
                        break;
                    }
                }
            }
        });

        write_rpc(
            &mut stdin,
            json!({
                "method": "initialize",
                "id": 0,
                "params": {
                    "clientInfo": {
                        "name": "codex_usage_hud",
                        "title": "Codex Usage HUD",
                        "version": env!("CARGO_PKG_VERSION")
                    }
                }
            }),
        )?;
        wait_for_id(&receiver, 0, Duration::from_secs(8))?;

        write_rpc(&mut stdin, json!({ "method": "initialized", "params": {} }))?;
        write_rpc(
            &mut stdin,
            json!({ "method": "account/read", "id": 1, "params": { "refreshToken": false } }),
        )?;
        write_rpc(&mut stdin, json!({ "method": "account/rateLimits/read", "id": 2 }))?;
        write_rpc(&mut stdin, json!({ "method": "account/usage/read", "id": 3 }))?;

        let deadline = Instant::now() + Duration::from_secs(10);
        let mut responses = HashMap::<i64, Value>::new();
        while responses.len() < 3 {
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                return Err("等待 Codex 帳號 / 額度 / 使用量資料逾時".to_string());
            }
            let message = receiver
                .recv_timeout(remaining)
                .map_err(|_| "等待 Codex 帳號 / 額度 / 使用量資料逾時".to_string())?;
            if let Some(id) = message.get("id").and_then(Value::as_i64) {
                if (1..=3).contains(&id) {
                    if let Some(error) = message.get("error") {
                        return Err(format!("Codex app-server 回傳錯誤：{error}"));
                    }
                    responses.insert(id, message);
                }
            }
        }

        let account_message = responses
            .remove(&1)
            .ok_or_else(|| "account/read 沒有回應".to_string())?;
        let rate_message = responses
            .remove(&2)
            .ok_or_else(|| "account/rateLimits/read 沒有回應".to_string())?;
        let usage_message = responses
            .remove(&3)
            .ok_or_else(|| "account/usage/read 沒有回應".to_string())?;

        let account: AccountReadResult = serde_json::from_value(
            account_message
                .get("result")
                .cloned()
                .ok_or_else(|| "account/read 缺少 result".to_string())?,
        )
        .map_err(|error| format!("無法解析 account/read：{error}"))?;

        let rate_limits: RateLimitsReadResult = serde_json::from_value(
            rate_message
                .get("result")
                .cloned()
                .ok_or_else(|| "account/rateLimits/read 缺少 result".to_string())?,
        )
        .map_err(|error| format!("無法解析 account/rateLimits/read：{error}"))?;

        let usage: UsageReadResult = serde_json::from_value(
            usage_message
                .get("result")
                .cloned()
                .ok_or_else(|| "account/usage/read 缺少 result".to_string())?,
        )
        .map_err(|error| format!("無法解析 account/usage/read：{error}"))?;

        Ok(RawProbe {
            account,
            rate_limits,
            usage,
        })
    })();

    terminate_process_tree(&mut child);
    result
}

fn open_history_db(app: &AppHandle, profile_id: &str) -> Result<Connection, String> {
    let data_dir = app_data_dir(app)?;
    let connection = Connection::open(data_dir.join(profile_history_name(profile_id)))
        .map_err(|error| format!("無法開啟本機使用量資料庫：{error}"))?;

    connection
        .execute_batch(
            "
            CREATE TABLE IF NOT EXISTS usage_samples (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                sampled_at INTEGER NOT NULL,
                limit_id TEXT NOT NULL,
                limit_name TEXT,
                window_kind TEXT NOT NULL,
                window_duration_mins INTEGER NOT NULL,
                used_percent REAL NOT NULL,
                resets_at INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_usage_samples_window
            ON usage_samples(limit_id, window_kind, resets_at, sampled_at);
            ",
        )
        .map_err(|error| format!("無法初始化本機使用量資料庫：{error}"))?;

    Ok(connection)
}

fn analyse_window(
    connection: &Connection,
    sampled_at: i64,
    bucket: &RawRateLimitBucket,
    window_kind: &str,
    window: &RawRateWindow,
) -> Result<WindowSnapshot, String> {
    let lookback_seconds = if window.window_duration_mins <= 360 {
        6 * 3600
    } else {
        24 * 3600
    };
    let oldest_allowed = sampled_at - lookback_seconds;
    let latest_allowed = sampled_at - 300;

    let previous: Option<(i64, f64)> = connection
        .query_row(
            "
            SELECT sampled_at, used_percent
            FROM usage_samples
            WHERE limit_id = ?1
              AND window_kind = ?2
              AND resets_at = ?3
              AND sampled_at >= ?4
              AND sampled_at <= ?5
            ORDER BY sampled_at ASC
            LIMIT 1
            ",
            params![
                bucket.limit_id,
                window_kind,
                window.resets_at,
                oldest_allowed,
                latest_allowed
            ],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()
        .map_err(|error| format!("無法讀取額度歷史：{error}"))?;

    let burn_rate_per_hour = previous.and_then(|(previous_at, previous_used)| {
        let elapsed_seconds = sampled_at - previous_at;
        let delta = window.used_percent - previous_used;
        if elapsed_seconds >= 300 && delta > 0.01 {
            Some(delta / (elapsed_seconds as f64 / 3600.0))
        } else {
            None
        }
    });

    let remaining_percent = (100.0 - window.used_percent).clamp(0.0, 100.0);
    let eta_exhausted_at = burn_rate_per_hour.and_then(|rate| {
        if rate <= 0.0 || remaining_percent <= 0.0 {
            None
        } else {
            Some(sampled_at + ((remaining_percent / rate) * 3600.0).round() as i64)
        }
    });

    let risk = if remaining_percent <= 0.01 || bucket.rate_limit_reached_type.is_some() {
        "critical"
    } else if let Some(eta) = eta_exhausted_at {
        if eta < window.resets_at {
            let until_exhausted = eta - sampled_at;
            if until_exhausted <= 6 * 3600 || remaining_percent < 15.0 {
                "critical"
            } else {
                "warning"
            }
        } else if remaining_percent < 15.0 {
            "warning"
        } else {
            "safe"
        }
    } else if remaining_percent < 10.0 {
        "warning"
    } else {
        "safe"
    };

    connection
        .execute(
            "
            INSERT INTO usage_samples(
                sampled_at, limit_id, limit_name, window_kind,
                window_duration_mins, used_percent, resets_at
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
            ",
            params![
                sampled_at,
                bucket.limit_id,
                bucket.limit_name,
                window_kind,
                window.window_duration_mins,
                window.used_percent,
                window.resets_at
            ],
        )
        .map_err(|error| format!("無法寫入額度歷史：{error}"))?;

    Ok(WindowSnapshot {
        limit_id: bucket.limit_id.clone(),
        limit_name: bucket.limit_name.clone(),
        window_kind: window_kind.to_string(),
        used_percent: window.used_percent,
        remaining_percent,
        window_duration_mins: window.window_duration_mins,
        resets_at: window.resets_at,
        burn_rate_per_hour,
        eta_exhausted_at,
        risk: risk.to_string(),
        rate_limit_reached_type: bucket.rate_limit_reached_type.clone(),
    })
}

fn collect_snapshot(app: &AppHandle, profile: &CodexProfile) -> Result<UsageSnapshot, String> {
    let probe = probe_codex(profile)?;
    let sampled_at = unix_now();
    let connection = open_history_db(app, &profile.id)?;

    let mut buckets = if let Some(map) = probe.rate_limits.rate_limits_by_limit_id.clone() {
        if map.is_empty() {
            Vec::new()
        } else {
            map.into_values().collect::<Vec<_>>()
        }
    } else {
        Vec::new()
    };

    if buckets.is_empty() {
        if let Some(bucket) = probe.rate_limits.rate_limits.clone() {
            buckets.push(bucket);
        }
    }

    let mut windows = Vec::new();
    for bucket in &buckets {
        if let Some(primary) = &bucket.primary {
            windows.push(analyse_window(
                &connection,
                sampled_at,
                bucket,
                "primary",
                primary,
            )?);
        }
        if let Some(secondary) = &bucket.secondary {
            windows.push(analyse_window(
                &connection,
                sampled_at,
                bucket,
                "secondary",
                secondary,
            )?);
        }
    }

    windows.sort_by(|left, right| {
        left.window_duration_mins
            .cmp(&right.window_duration_mins)
            .then_with(|| left.limit_id.cmp(&right.limit_id))
            .then_with(|| left.window_kind.cmp(&right.window_kind))
    });

    let retention_cutoff = sampled_at - 45 * 86400;
    let _ = connection.execute(
        "DELETE FROM usage_samples WHERE sampled_at < ?1",
        params![retention_cutoff],
    );

    let account = probe.account.account.unwrap_or(RawAccount {
        account_type: "unknown".to_string(),
        email: None,
        plan_type: buckets.iter().find_map(|bucket| bucket.plan_type.clone()),
    });

    let mut daily = probe.usage.daily_usage_buckets.unwrap_or_default();
    daily.sort_by(|left, right| left.start_date.cmp(&right.start_date));
    let today = Local::now().date_naive().to_string();
    let today_tokens = daily
        .iter()
        .find(|bucket| bucket.start_date == today)
        .map(|bucket| bucket.tokens)
        .or(Some(0));
    if daily.len() > 14 {
        daily = daily.split_off(daily.len() - 14);
    }

    let summary = probe.usage.summary;
    let token_usage = TokenUsageSnapshot {
        lifetime_tokens: summary.as_ref().and_then(|value| value.lifetime_tokens),
        peak_daily_tokens: summary.as_ref().and_then(|value| value.peak_daily_tokens),
        longest_running_turn_sec: summary
            .as_ref()
            .and_then(|value| value.longest_running_turn_sec),
        current_streak_days: summary.as_ref().and_then(|value| value.current_streak_days),
        longest_streak_days: summary.as_ref().and_then(|value| value.longest_streak_days),
        today_tokens,
        daily_usage_buckets: daily,
    };

    Ok(UsageSnapshot {
        account: AccountSnapshot {
            account_type: account.account_type,
            email: account.email,
            plan_type: account.plan_type,
            requires_openai_auth: probe.account.requires_openai_auth,
        },
        windows,
        token_usage,
        sampled_at,
        source: "codex app-server",
    })
}

fn refresh_and_cache(
    app: &AppHandle,
    state: &Arc<MonitorState>,
    profile: &CodexProfile,
    force: bool,
) -> Result<UsageSnapshot, String> {
    let _guard = state
        .probe_lock
        .lock()
        .map_err(|_| "額度監控鎖定狀態異常".to_string())?;

    if !force {
        if let Ok(latest) = state.latest.lock() {
            if let Some(snapshot) = latest.get(&profile.id) {
                if unix_now() - snapshot.sampled_at < 60 {
                    return Ok(snapshot.clone());
                }
            }
        }
    }

    match collect_snapshot(app, profile) {
        Ok(snapshot) => {
            if let Ok(mut latest) = state.latest.lock() {
                latest.insert(profile.id.clone(), snapshot.clone());
            }
            if let Ok(mut last_error) = state.last_error.lock() {
                last_error.remove(&profile.id);
            }
            let update = ProfileUsageSnapshot {
                profile: profile.clone(),
                snapshot: Some(snapshot.clone()),
                error: None,
            };
            let _ = app.emit("profile-usage-snapshot-updated", update);
            Ok(snapshot)
        }
        Err(error) => {
            if let Ok(mut last_error) = state.last_error.lock() {
                last_error.insert(profile.id.clone(), error.clone());
            }
            let update = ProfileUsageSnapshot {
                profile: profile.clone(),
                snapshot: None,
                error: Some(error.clone()),
            };
            let _ = app.emit("profile-usage-snapshot-error", update);
            Err(error)
        }
    }
}

fn profile_usage_snapshot(
    app: &AppHandle,
    state: &Arc<MonitorState>,
    profile: CodexProfile,
    force: bool,
) -> ProfileUsageSnapshot {
    match refresh_and_cache(app, state, &profile, force) {
        Ok(snapshot) => ProfileUsageSnapshot {
            profile,
            snapshot: Some(snapshot),
            error: None,
        },
        Err(error) => ProfileUsageSnapshot {
            profile,
            snapshot: None,
            error: Some(error),
        },
    }
}

#[tauri::command]
fn list_codex_profiles(app: AppHandle) -> Result<Vec<CodexProfile>, String> {
    load_profiles(&app)
}

fn profile_login_status(profile: &CodexProfile) -> Result<bool, String> {
    #[cfg(windows)]
    let mut command = {
        let mut command = quiet_command("cmd.exe");
        command.args(["/D", "/S", "/C", "codex login status"]);
        command
    };

    #[cfg(not(windows))]
    let mut command = {
        let mut command = quiet_command("codex");
        command.args(["login", "status"]);
        command
    };

    apply_profile_env(&mut command, profile);
    let output = command
        .output()
        .map_err(|error| format!("無法檢查 Codex 登入狀態：{error}"))?;
    let text = format!(
        "{}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    Ok(text.contains("Logged in"))
}

#[tauri::command]
fn create_codex_profile(
    app: AppHandle,
    state: tauri::State<'_, Arc<MonitorState>>,
    label: String,
) -> Result<CodexProfile, String> {
    let saved_profiles = load_custom_profiles(&app)?;
    let id = new_profile_id();
    let home = app_data_dir(&app)?.join("codex-homes").join(&id);
    fs::create_dir_all(&home).map_err(|error| format!("無法建立 Codex 帳號目錄：{error}"))?;

    let fallback_label = format!("帳號 {}", saved_profiles.len() + 2);
    let normalized_label = label.trim();
    let profile = CodexProfile {
        id,
        label: if normalized_label.is_empty() {
            fallback_label
        } else {
            normalized_label.chars().take(40).collect()
        },
        codex_home: Some(home.to_string_lossy().to_string()),
        is_default: false,
    };

    state
        .pending_profiles
        .lock()
        .map_err(|_| "待認證 Codex 帳號狀態異常".to_string())?
        .insert(profile.id.clone(), profile.clone());
    Ok(profile)
}

#[tauri::command]
fn start_codex_profile_login(
    app: AppHandle,
    state: tauri::State<'_, Arc<MonitorState>>,
    profile_id: String,
) -> Result<(), String> {
    let profile = find_profile_or_pending(&app, state.inner(), &profile_id)?;
    if profile.is_default {
        return Err("主要帳號請使用既有 Codex CLI 登入；額外帳號才需要從 HUD 建立。".to_string());
    }

    #[cfg(windows)]
    let mut command = {
        let mut command = quiet_command("cmd.exe");
        command.args(["/D", "/S", "/C", "codex login"]);
        command
    };

    #[cfg(not(windows))]
    let mut command = {
        let mut command = quiet_command("codex");
        command.arg("login");
        command
    };

    apply_profile_env(&mut command, &profile);
    let child = command
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|error| format!("無法啟動 Codex 登入：{error}"))?;

    state
        .login_processes
        .lock()
        .map_err(|_| "Codex 登入程序狀態異常".to_string())?
        .insert(profile.id.clone(), child.id());
    Ok(())
}

#[tauri::command]
fn codex_profile_login_status(
    app: AppHandle,
    state: tauri::State<'_, Arc<MonitorState>>,
    profile_id: String,
) -> Result<bool, String> {
    let profile = find_profile_or_pending(&app, state.inner(), &profile_id)?;
    profile_login_status(&profile)
}

#[tauri::command]
fn finalize_codex_profile(
    app: AppHandle,
    state: tauri::State<'_, Arc<MonitorState>>,
    profile_id: String,
) -> Result<CodexProfile, String> {
    let profile = state
        .pending_profiles
        .lock()
        .map_err(|_| "待認證 Codex 帳號狀態異常".to_string())?
        .get(&profile_id)
        .cloned()
        .ok_or_else(|| "找不到待認證 Codex 帳號。".to_string())?;

    if !profile_login_status(&profile)? {
        return Err("Codex 登入尚未完成，無法加入帳號清單。".to_string());
    }

    stop_login_process(state.inner(), &profile_id);
    let mut profiles = load_custom_profiles(&app)?;
    if profiles.iter().all(|item| item.id != profile.id) {
        profiles.push(profile.clone());
        save_custom_profiles(&app, &profiles)?;
    }
    state
        .pending_profiles
        .lock()
        .map_err(|_| "待認證 Codex 帳號狀態異常".to_string())?
        .remove(&profile_id);
    Ok(profile)
}

#[tauri::command]
fn cancel_codex_profile_login(
    app: AppHandle,
    state: tauri::State<'_, Arc<MonitorState>>,
    profile_id: String,
) -> Result<(), String> {
    stop_login_process(state.inner(), &profile_id);
    let profile = state
        .pending_profiles
        .lock()
        .map_err(|_| "待認證 Codex 帳號狀態異常".to_string())?
        .remove(&profile_id)
        .ok_or_else(|| "找不到待認證 Codex 帳號。".to_string())?;

    if let Some(home) = profile.codex_home.as_deref() {
        // 登入程序可能仍短暫持有檔案；取消新增以「不加入正式清單」為優先，目錄採最佳努力清除。
        let _ = remove_managed_codex_home(&app, home);
    }
    Ok(())
}

#[tauri::command]
fn delete_codex_profile(
    app: AppHandle,
    state: tauri::State<'_, Arc<MonitorState>>,
    profile_id: String,
) -> Result<(), String> {
    if profile_id == "default" {
        return Err("主要帳號不可從 HUD 刪除。".to_string());
    }

    stop_login_process(state.inner(), &profile_id);
    let mut profiles = load_custom_profiles(&app)?;
    let profile = profiles
        .iter()
        .find(|profile| profile.id == profile_id)
        .cloned()
        .ok_or_else(|| "找不到要刪除的 Codex 帳號。".to_string())?;
    profiles.retain(|item| item.id != profile_id);
    save_custom_profiles(&app, &profiles)?;

    if let Some(home) = profile.codex_home.as_deref() {
        remove_managed_codex_home(&app, home)?;
    }
    let _ = fs::remove_file(app_data_dir(&app)?.join(profile_history_name(&profile_id)));

    if let Ok(mut latest) = state.latest.lock() {
        latest.remove(&profile_id);
    }
    if let Ok(mut last_error) = state.last_error.lock() {
        last_error.remove(&profile_id);
    }
    Ok(())
}

#[tauri::command]
async fn get_usage_snapshot(
    app: AppHandle,
    state: tauri::State<'_, Arc<MonitorState>>,
    profile_id: Option<String>,
    force: Option<bool>,
) -> Result<UsageSnapshot, String> {
    let monitor_state = state.inner().clone();
    let profile = find_profile(&app, profile_id.as_deref().unwrap_or("default"))?;
    tauri::async_runtime::spawn_blocking(move || {
        refresh_and_cache(&app, &monitor_state, &profile, force.unwrap_or(false))
    })
    .await
    .map_err(|error| format!("背景額度工作失敗：{error}"))?
}

#[tauri::command]
async fn get_all_usage_snapshots(
    app: AppHandle,
    state: tauri::State<'_, Arc<MonitorState>>,
    force: Option<bool>,
) -> Result<Vec<ProfileUsageSnapshot>, String> {
    let monitor_state = state.inner().clone();
    let profiles = load_profiles(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        profiles
            .into_iter()
            .map(|profile| profile_usage_snapshot(&app, &monitor_state, profile, force.unwrap_or(false)))
            .collect::<Vec<_>>()
    })
    .await
    .map_err(|error| format!("背景多帳號額度工作失敗：{error}"))
}

fn toggle_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        if window.is_visible().unwrap_or(false) {
            let _ = window.hide();
        } else {
            let _ = window.show();
            let _ = window.set_focus();
        }
    }
}

fn position_main_window(app: &AppHandle) {
    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    let Ok(Some(monitor)) = window.current_monitor() else {
        return;
    };
    let Ok(window_size) = window.outer_size() else {
        return;
    };

    let monitor_size = monitor.size();
    let monitor_position = monitor.position();
    let margin = (16.0 * monitor.scale_factor()) as i32;
    let x = monitor_position.x + monitor_size.width as i32 - window_size.width as i32 - margin;
    let y = monitor_position.y + monitor_size.height as i32 - window_size.height as i32 - margin;
    let _ = window.set_position(PhysicalPosition::new(x, y));
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(Arc::new(MonitorState::default()))
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        .plugin(tauri_plugin_notification::init())
        .setup(|app| {
            let toggle_item = MenuItem::with_id(app, "toggle", "顯示 / 隱藏", true, None::<&str>)?;
            let refresh_item = MenuItem::with_id(app, "refresh", "重新整理", true, None::<&str>)?;
            let quit_item = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&toggle_item, &refresh_item, &quit_item])?;

            let mut tray_builder = TrayIconBuilder::new()
                .menu(&menu)
                .tooltip("Codex Usage HUD")
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "toggle" => toggle_main_window(app),
                    "refresh" => {
                        let app_handle = app.clone();
                        let monitor_state = app.state::<Arc<MonitorState>>().inner().clone();
                        thread::spawn(move || {
                            if let Ok(profiles) = load_profiles(&app_handle) {
                                for profile in profiles {
                                    let _ = refresh_and_cache(&app_handle, &monitor_state, &profile, true);
                                }
                            }
                        });
                    }
                    "quit" => app.exit(0),
                    _ => {}
                });

            if let Some(icon) = app.default_window_icon() {
                tray_builder = tray_builder.icon(icon.clone());
            }
            tray_builder.build(app)?;

            if let Some(window) = app.get_webview_window("main") {
                let hide_window = window.clone();
                window.on_window_event(move |event| {
                    if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                        api.prevent_close();
                        let _ = hide_window.hide();
                    }
                });
            }

            position_main_window(app.handle());

            let app_handle = app.handle().clone();
            let monitor_state = app.state::<Arc<MonitorState>>().inner().clone();
            thread::spawn(move || loop {
                if let Ok(profiles) = load_profiles(&app_handle) {
                    for profile in profiles {
                        let _ = refresh_and_cache(&app_handle, &monitor_state, &profile, true);
                    }
                }
                thread::sleep(Duration::from_secs(180));
            });

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            list_codex_profiles,
            create_codex_profile,
            start_codex_profile_login,
            codex_profile_login_status,
            finalize_codex_profile,
            cancel_codex_profile_login,
            delete_codex_profile,
            get_usage_snapshot,
            get_all_usage_snapshots
        ])
        .run(tauri::generate_context!())
        .expect("Codex Usage HUD 啟動失敗");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn app_server_probe_returns_account_and_quota() {
        let probe = probe_codex(&default_profile()).expect("本機 Codex app-server 應可讀取帳號資料");
        assert!(probe.account.account.is_some(), "應取得目前 ChatGPT 帳號");

        let has_bucket = probe
            .rate_limits
            .rate_limits_by_limit_id
            .as_ref()
            .map(|items| !items.is_empty())
            .unwrap_or(false)
            || probe.rate_limits.rate_limits.is_some();
        assert!(has_bucket, "應至少取得一個 Codex rate-limit bucket");
    }
}
