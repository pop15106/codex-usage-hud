import "./styles.css";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { LogicalSize, PhysicalPosition, PhysicalSize } from "@tauri-apps/api/dpi";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { disable, enable, isEnabled } from "@tauri-apps/plugin-autostart";
import {
  isPermissionGranted,
  requestPermission,
  sendNotification
} from "@tauri-apps/plugin-notification";

const appWindow = getCurrentWindow();

const DEFAULT_SETTINGS = {
  accent: "#79BFFF",
  opacity: 82,
  tone: "ice",
  alwaysOnTop: true,
  autostart: false,
  notificationsEnabled: true,
  warningThreshold: 25,
  criticalThreshold: 10,
  refreshSeconds: 180
};

const ACCENT_PRESETS = [
  { name: "冰藍", value: "#79BFFF" },
  { name: "薄荷", value: "#63D8C2" },
  { name: "薰衣草", value: "#A596FF" },
  { name: "珊瑚", value: "#F29AAA" },
  { name: "月霧", value: "#A9B8C6" }
];

const WINDOW_STATE_KEY = "codex-usage-hud.window-state";
const ALERT_STATE_KEY = "codex-usage-hud.alert-state";
const MINI_MODE_KEY = "codex-usage-hud.mini-mode";
const ACTIVE_PROFILE_KEY = "codex-usage-hud.active-profile";
const ACCOUNT_VIEW_KEY = "codex-usage-hud.account-overview";
const NORMAL_CONSTRAINTS = { minWidth: 300, minHeight: 170 };
const MINI_CONSTRAINTS = { minWidth: 260, minHeight: 108 };
const MINI_SIZE = { width: 300, height: 118 };

const state = {
  snapshot: null,
  profiles: [],
  profileUsages: [],
  activeProfileId: localStorage.getItem(ACTIVE_PROFILE_KEY) || "default",
  accountOverview: localStorage.getItem(ACCOUNT_VIEW_KEY) === "true",
  accountViewInitialized: localStorage.getItem(ACCOUNT_VIEW_KEY) !== null,
  loginProfileId: null,
  pendingProfile: null,
  loginMessage: null,
  profileActionLoading: false,
  loading: true,
  error: null,
  settingsOpen: false,
  trendOpen: false,
  miniMode: localStorage.getItem(MINI_MODE_KEY) === "true",
  settings: loadSettings(),
  prePanelSize: null,
  preMiniSize: null,
  geometrySaveTimer: null,
  notificationPermission: null,
  nowTimer: null
};

function loadSettings() {
  try {
    const raw = localStorage.getItem("codex-usage-hud.settings");
    return { ...DEFAULT_SETTINGS, ...(raw ? JSON.parse(raw) : {}) };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

function saveSettings() {
  localStorage.setItem("codex-usage-hud.settings", JSON.stringify(state.settings));
}

function loadStoredJson(key) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

async function getLogicalInnerSize() {
  const physicalSize = await appWindow.innerSize();
  const scaleFactor = await appWindow.scaleFactor();
  return physicalSize.toLogical(scaleFactor);
}

async function restoreWindowGeometry() {
  const saved = loadStoredJson(WINDOW_STATE_KEY);
  if (!saved) return;

  try {
    if (saved.size && Number.isFinite(saved.size.width) && Number.isFinite(saved.size.height)) {
      await appWindow.setSize(new PhysicalSize(saved.size.width, saved.size.height));
    }
    if (saved.position && Number.isFinite(saved.position.x) && Number.isFinite(saved.position.y)) {
      await appWindow.setPosition(new PhysicalPosition(saved.position.x, saved.position.y));
    }
  } catch (error) {
    console.error("無法恢復 HUD 位置與大小", error);
  }
}

async function saveWindowGeometry() {
  try {
    const previous = loadStoredJson(WINDOW_STATE_KEY) ?? {};
    const position = await appWindow.outerPosition();
    const next = {
      ...previous,
      position: { x: position.x, y: position.y }
    };

    if (!state.settingsOpen && !state.trendOpen && !state.miniMode) {
      const size = await appWindow.innerSize();
      next.size = { width: size.width, height: size.height };
    }

    localStorage.setItem(WINDOW_STATE_KEY, JSON.stringify(next));
  } catch (error) {
    console.error("無法保存 HUD 位置與大小", error);
  }
}

function scheduleGeometrySave() {
  window.clearTimeout(state.geometrySaveTimer);
  state.geometrySaveTimer = window.setTimeout(() => saveWindowGeometry(), 220);
}

async function ensureNotificationPermission() {
  if (!state.settings.notificationsEnabled) return false;
  if (state.notificationPermission === true) return true;
  if (state.notificationPermission === false) return false;

  try {
    let granted = await isPermissionGranted();
    if (!granted) {
      granted = (await requestPermission()) === "granted";
    }
    state.notificationPermission = granted;
    return granted;
  } catch (error) {
    state.notificationPermission = false;
    console.error("無法取得通知權限", error);
    return false;
  }
}

function effectiveRisk(item) {
  const remaining = clamp(Number(item?.remainingPercent) || 0, 0, 100);
  if (item?.rateLimitReachedType) return "critical";
  if (remaining >= 80) return "safe";
  if (remaining <= state.settings.criticalThreshold) return "critical";
  if (remaining <= state.settings.warningThreshold) return "warning";
  if (item?.risk === "critical" || item?.risk === "warning") return item.risk;
  return "safe";
}

function codexWindowsFrom(snapshot) {
  return (snapshot?.windows ?? []).filter(isCodexWindow);
}

async function processSnapshotAlerts(snapshot, profileId = "default", profileLabel = "主要帳號") {
  const windows = codexWindowsFrom(snapshot);
  const item = windows.find((entry) => entry.windowKind === "primary") ?? windows[0];
  if (!item) return;

  const remaining = clamp(Number(item.remainingPercent) || 0, 0, 100);
  const risk = effectiveRisk(item);
  const alertKey = `${ALERT_STATE_KEY}.${profileId}`;
  const previous = loadStoredJson(alertKey);
  const resetChanged = Boolean(previous && previous.resetsAt !== item.resetsAt);
  const recovered = Boolean(
    previous
    && (previous.risk === "critical" || previous.risk === "warning")
    && risk === "safe"
    && remaining >= 80
    && (resetChanged || remaining - Number(previous.remaining || 0) >= 40)
  );

  let notification = null;
  if (recovered) {
    notification = {
      title: `${profileLabel} · Codex 額度已恢復`,
      body: `目前剩餘 ${formatPercent(remaining)}，可以繼續使用。`
    };
  } else if (risk === "critical" && previous?.risk !== "critical") {
    notification = {
      title: `${profileLabel} · Codex 額度即將耗盡`,
      body: `目前只剩 ${formatPercent(remaining)}，Reset ${formatClock(item.resetsAt)}。`
    };
  } else if (risk === "warning" && previous?.risk === "safe") {
    notification = {
      title: `${profileLabel} · Codex 額度偏低`,
      body: `目前剩餘 ${formatPercent(remaining)}，請留意使用速度。`
    };
  }

  if (notification && state.settings.notificationsEnabled && await ensureNotificationPermission()) {
    sendNotification(notification);
  }

  localStorage.setItem(alertKey, JSON.stringify({
    remaining,
    risk,
    resetsAt: item.resetsAt,
    sampledAt: snapshot.sampledAt
  }));
}

function profileUsageById(profileId) {
  return state.profileUsages.find((item) => item.profile?.id === profileId) ?? null;
}

function profileById(profileId) {
  return state.profiles.find((profile) => profile.id === profileId)
    ?? state.profileUsages.find((item) => item.profile?.id === profileId)?.profile
    ?? null;
}

function activeProfile() {
  return profileById(state.activeProfileId) ?? state.profiles[0] ?? null;
}

function primaryCodexWindow(snapshot) {
  const windows = codexWindowsFrom(snapshot);
  return windows.find((item) => item.windowKind === "primary") ?? windows[0] ?? null;
}

function snapshotRisk(snapshot) {
  const windows = codexWindowsFrom(snapshot);
  if (windows.some((item) => effectiveRisk(item) === "critical")) return "critical";
  if (windows.some((item) => effectiveRisk(item) === "warning")) return "warning";
  return "safe";
}

function syncActiveSnapshot() {
  const usage = profileUsageById(state.activeProfileId);
  if (usage) {
    state.snapshot = usage.snapshot ?? null;
    state.error = usage.error ?? null;
    return;
  }

  state.snapshot = null;
  state.error = null;
}

function upsertProfileUsage(update) {
  if (!update?.profile?.id) return;
  const index = state.profileUsages.findIndex((item) => item.profile?.id === update.profile.id);
  if (index >= 0) {
    state.profileUsages[index] = update;
  } else {
    state.profileUsages.push(update);
  }

  const profileIndex = state.profiles.findIndex((profile) => profile.id === update.profile.id);
  if (profileIndex >= 0) {
    state.profiles[profileIndex] = update.profile;
  } else {
    state.profiles.push(update.profile);
  }

  syncActiveSnapshot();
}

function setAccountOverview(enabled) {
  state.accountOverview = enabled;
  localStorage.setItem(ACCOUNT_VIEW_KEY, String(enabled));
  render();
}

async function selectProfile(profileId) {
  if (!profileById(profileId)) return;
  if (state.miniMode) await setMiniMode(false);
  state.activeProfileId = profileId;
  localStorage.setItem(ACTIVE_PROFILE_KEY, profileId);
  state.accountOverview = false;
  localStorage.setItem(ACCOUNT_VIEW_KEY, "false");
  syncActiveSnapshot();
  render();
}

async function showAccountOverview() {
  if (state.miniMode) await setMiniMode(false);
  state.settingsOpen = false;
  state.trendOpen = false;
  state.accountOverview = true;
  localStorage.setItem(ACCOUNT_VIEW_KEY, "true");
  render();
}

function localDateKey(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function getSevenDayUsage(snapshot = state.snapshot) {
  const tokenMap = new Map(
    (snapshot?.tokenUsage?.dailyUsageBuckets ?? []).map((item) => [item.startDate, Number(item.tokens) || 0])
  );
  const reportedThrough = parseLocalDateKey(snapshot?.tokenUsage?.latestDailyUsageDate);
  const anchor = reportedThrough ?? new Date();
  anchor.setHours(0, 0, 0, 0);

  return Array.from({ length: 7 }, (_, index) => {
    const date = new Date(anchor);
    date.setDate(anchor.getDate() - (6 - index));
    const key = localDateKey(date);
    return {
      key,
      label: `${date.getMonth() + 1}/${date.getDate()}`,
      tokens: tokenMap.get(key) ?? 0
    };
  });
}

function hexToRgb(hex) {
  const normalized = hex.replace("#", "");
  const value = Number.parseInt(normalized, 16);
  return `${(value >> 16) & 255} ${(value >> 8) & 255} ${value & 255}`;
}

function applySettings() {
  const root = document.documentElement;
  root.style.setProperty("--accent", state.settings.accent);
  root.style.setProperty("--accent-rgb", hexToRgb(state.settings.accent));
  root.style.setProperty("--glass-opacity", String(state.settings.opacity / 100));
  document.body.dataset.tone = state.settings.tone;
  appWindow.setAlwaysOnTop(Boolean(state.settings.alwaysOnTop)).catch(() => {});
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function formatPercent(value) {
  return `${Math.round(clamp(Number(value) || 0, 0, 100))}%`;
}

function formatWindow(minutes) {
  if (!Number.isFinite(minutes)) return "Quota";
  if (minutes % 10080 === 0) return `${minutes / 10080}W`;
  if (minutes % 1440 === 0) return `${minutes / 1440}D`;
  if (minutes % 60 === 0) return `${minutes / 60}H`;
  return `${minutes}M`;
}

function formatCompactNumber(value) {
  if (!Number.isFinite(Number(value))) return "—";
  return new Intl.NumberFormat("zh-TW", {
    notation: "compact",
    maximumFractionDigits: 1
  }).format(Number(value));
}

function formatOptionalCompactNumber(value) {
  if (value === null || value === undefined || value === "") return "—";
  return formatCompactNumber(value);
}

function parseLocalDateKey(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value ?? ""));
  if (!match) return null;
  const [, year, month, day] = match;
  return new Date(Number(year), Number(month) - 1, Number(day));
}

function formatUsageDate(value) {
  const date = parseLocalDateKey(value);
  return date ? `${date.getMonth() + 1}/${date.getDate()}` : "—";
}

function usageFreshnessText(snapshot = state.snapshot) {
  const tokenUsage = snapshot?.tokenUsage;
  const latestDate = tokenUsage?.latestDailyUsageDate;
  if (!latestDate) return "尚無資料";
  const lagDays = Number(tokenUsage?.usageDataLagDays);
  if (Number.isFinite(lagDays) && lagDays > 0) return `截至 ${formatUsageDate(latestDate)}`;
  return "今日已回報";
}

function usageFreshnessTitle(snapshot = state.snapshot) {
  const tokenUsage = snapshot?.tokenUsage;
  const latestDate = tokenUsage?.latestDailyUsageDate;
  if (!latestDate) return "Codex 官方 account/usage/read 尚未提供每日 Token 明細。";
  const lagDays = Number(tokenUsage?.usageDataLagDays);
  if (Number.isFinite(lagDays) && lagDays > 0) {
    return `Codex 官方 Token usage 明細目前回報至 ${latestDate}，落後本機日期 ${lagDays} 天。`;
  }
  return `Codex 官方 Token usage 明細已回報至 ${latestDate}。`;
}

function formatCountdown(epochSeconds) {
  if (!epochSeconds) return "—";
  let seconds = Math.max(0, Math.floor(epochSeconds - Date.now() / 1000));
  const days = Math.floor(seconds / 86400);
  seconds %= 86400;
  const hours = Math.floor(seconds / 3600);
  seconds %= 3600;
  const minutes = Math.floor(seconds / 60);
  if (days > 0) return `${days}天 ${hours}小時`;
  if (hours > 0) return `${hours}小時 ${minutes}分`;
  return `${minutes}分`;
}

function formatClock(epochSeconds) {
  if (!epochSeconds) return "—";
  return new Intl.DateTimeFormat("zh-TW", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).format(new Date(epochSeconds * 1000));
}

function riskLabel(risk) {
  if (risk === "critical") return "危險";
  if (risk === "warning") return "注意";
  return "穩定";
}

function isCodexWindow(item) {
  const limitId = String(item?.limitId ?? "").trim().toLowerCase();
  const limitName = String(item?.limitName ?? "").trim().toLowerCase();
  return limitId === "codex" || limitName === "codex";
}

function visibleWindows() {
  return codexWindowsFrom(state.snapshot);
}

function overallRisk() {
  const windows = visibleWindows();
  if (windows.some((item) => effectiveRisk(item) === "critical")) return "critical";
  if (windows.some((item) => effectiveRisk(item) === "warning")) return "warning";
  return "safe";
}

function allAccountsRisk() {
  const risks = state.profileUsages
    .filter((item) => item.snapshot)
    .map((item) => snapshotRisk(item.snapshot));
  if (risks.includes("critical")) return "critical";
  if (risks.includes("warning")) return "warning";
  return "safe";
}

function renderWindow(item) {
  const remaining = clamp(Number(item.remainingPercent) || 0, 0, 100);
  const risk = effectiveRisk(item);
  const rate = Number(item.burnRatePerHour);
  const hasRate = Number.isFinite(rate) && rate > 0;
  const etaConfidence = clamp(Number(item.etaConfidencePercent) || 0, 0, 100);
  const etaReady = etaConfidence >= 100 && Boolean(item.etaExhaustedAt);
  const eta = etaReady ? formatCountdown(item.etaExhaustedAt) : "學習中";
  const etaDetails = `ETA 信心 ${Math.round(etaConfidence)}% · 樣本 ${Number(item.etaSampleCount) || 1} · 跨度 ${Number(item.etaSampleSpanMins) || 0} 分 · 消耗差 ${(Number(item.etaUsageDeltaPercent) || 0).toFixed(1)}%`;
  const title = item.limitName || (item.limitId === "codex" ? "Codex" : item.limitId);

  return `
    <article class="quota-card risk-${escapeHtml(risk)}">
      <div class="quota-head">
        <div class="quota-title-wrap">
          <span class="window-pill">${escapeHtml(formatWindow(item.windowDurationMins))}</span>
          <div>
            <div class="quota-title">${escapeHtml(title)}</div>
            <div class="quota-meta">${escapeHtml(item.windowKind === "primary" ? "主要視窗" : "次要視窗")}</div>
          </div>
        </div>
        <div class="remaining-block">
          <strong>${formatPercent(remaining)}</strong>
          <span>剩餘</span>
        </div>
      </div>
      <div class="progress-track" aria-label="剩餘 ${formatPercent(remaining)}">
        <div class="progress-fill" style="width:${remaining}%"></div>
      </div>
      <div class="quota-foot">
        <span>↻ ${escapeHtml(formatCountdown(item.resetsAt))}</span>
        <span title="${escapeHtml(formatClock(item.resetsAt))}">Reset ${escapeHtml(formatClock(item.resetsAt))}</span>
      </div>
      <div class="quota-insight" title="${escapeHtml(etaDetails)}">
        <span>${hasRate ? `↘ ${rate.toFixed(1)}% / hr` : `↘ ETA 信心 ${Math.round(etaConfidence)}%`}</span>
        <span class="risk-label">${escapeHtml(riskLabel(risk))} · ETA ${escapeHtml(eta)}</span>
      </div>
    </article>
  `;
}

function renderAccountOverview() {
  const entries = state.profiles.map((profile) => {
    const usage = profileUsageById(profile.id);
    return { profile, usage, snapshot: usage?.snapshot ?? null, error: usage?.error ?? null };
  });
  const validEntries = entries.filter((entry) => entry.snapshot);
  const reportedTodayEntries = validEntries.filter(
    (entry) => entry.snapshot?.tokenUsage?.todayTokens !== null && entry.snapshot?.tokenUsage?.todayTokens !== undefined
  );
  const totalToday = reportedTodayEntries.length
    ? reportedTodayEntries.reduce((sum, entry) => sum + Number(entry.snapshot.tokenUsage.todayTokens), 0)
    : null;
  const severity = { safe: 0, warning: 1, critical: 2 };
  const worst = validEntries.reduce((best, entry) => {
    if (!best) return entry;
    return severity[snapshotRisk(entry.snapshot)] > severity[snapshotRisk(best.snapshot)] ? entry : best;
  }, null);
  const fastestReset = validEntries
    .map((entry) => ({ entry, window: primaryCodexWindow(entry.snapshot) }))
    .filter((item) => item.window?.resetsAt)
    .sort((left, right) => left.window.resetsAt - right.window.resetsAt)[0] ?? null;

  return `
    <div class="account-overview">
      <div class="account-summary-grid">
        <div class="account-summary-card">
          <span>今日總 Tokens</span>
          <strong title="僅加總 Codex 官方已回報今日 Token bucket 的帳號。">${formatOptionalCompactNumber(totalToday)}</strong>
        </div>
        <div class="account-summary-card">
          <span>風險最高</span>
          <strong>${worst ? `${escapeHtml(worst.profile.label)} · ${escapeHtml(riskLabel(snapshotRisk(worst.snapshot)))}` : "—"}</strong>
        </div>
        <div class="account-summary-card">
          <span>最快 Reset</span>
          <strong>${fastestReset ? `${escapeHtml(fastestReset.entry.profile.label)} · ${escapeHtml(formatCountdown(fastestReset.window.resetsAt))}` : "—"}</strong>
        </div>
      </div>

      <div class="account-list">
        ${entries.map(({ profile, snapshot, error }) => {
          const windows = codexWindowsFrom(snapshot);
          const primary = primaryCodexWindow(snapshot);
          // account/read 的 requiresOpenaiAuth 不是目前登入狀態；只要 app-server 已成功回傳 snapshot，就視為可用帳號。
          const requiresLogin = !snapshot && !error && !profile.isDefault;
          const risk = snapshot ? snapshotRisk(snapshot) : "safe";
          const remaining = primary ? formatPercent(primary.remainingPercent) : "—";
          const email = snapshot?.account?.email;
          const planType = snapshot?.account?.planType;
          const windowSummary = windows.length
            ? windows.map((item) => `${formatWindow(item.windowDurationMins)} ${formatPercent(item.remainingPercent)}`).join(" · ")
            : "尚無額度視窗";
          const statusText = error
            ? "讀取失敗"
            : requiresLogin
              ? "尚未登入"
              : primary
                ? `${riskLabel(risk)} · Reset ${formatCountdown(primary.resetsAt)}`
                : "等待額度資料";
          return `
            <div class="account-row ${state.activeProfileId === profile.id ? "is-active" : ""} ${error || requiresLogin ? "needs-login" : `risk-${risk}`}" data-select-profile="${escapeHtml(profile.id)}" tabindex="0" role="button">
              <div class="account-row-main">
                <div class="account-identity">
                  <span class="account-dot"></span>
                  <div>
                    <div class="account-name-line">
                      <strong>${escapeHtml(profile.label)}</strong>
                      ${planType ? `<span class="account-plan-badge">${escapeHtml(planType)}</span>` : ""}
                    </div>
                    <small>${email ? escapeHtml(email) : (profile.isDefault ? "目前 Codex CLI 帳號" : "獨立 Codex 帳號")}</small>
                  </div>
                </div>
                <div class="account-quota">
                  <strong>${remaining}</strong>
                  <span>${escapeHtml(statusText)}</span>
                </div>
              </div>
              <div class="account-row-meta">
                <span>${escapeHtml(windowSummary)}</span>
                <span title="${escapeHtml(usageFreshnessTitle(snapshot))}">今日 ${formatOptionalCompactNumber(snapshot?.tokenUsage?.todayTokens)}</span>
                <span>${primary?.etaExhaustedAt ? `ETA ${escapeHtml(formatCountdown(primary.etaExhaustedAt))}` : "ETA 學習中"}</span>
                <div class="account-row-actions">
                  ${!profile.isDefault && (requiresLogin || error) ? `<button class="account-action" data-login-profile="${escapeHtml(profile.id)}" ${state.profileActionLoading ? "disabled" : ""}>登入</button>` : ""}
                  ${!profile.isDefault ? `<button class="account-action danger" data-delete-profile="${escapeHtml(profile.id)}" ${state.profileActionLoading ? "disabled" : ""}>刪除</button>` : ""}
                </div>
              </div>
            </div>
          `;
        }).join("")}
      </div>

      <div class="account-add-section">
        <div>
          <strong>新增 Codex 帳號</strong>
          <small>每個帳號使用獨立 CODEX_HOME，登入憑證仍由 Codex CLI 管理。</small>
        </div>
        <div class="account-add-row">
          <input id="new-profile-label" maxlength="40" placeholder="例如：備用帳號" ${state.profileActionLoading ? "disabled" : ""} />
          <button id="add-profile" ${state.profileActionLoading ? "disabled" : ""}>＋ 新增帳號</button>
        </div>
        ${state.loginMessage ? `
          <div class="account-login-banner">
            <span>${escapeHtml(state.loginMessage)}</span>
            ${state.pendingProfile ? `<button id="cancel-pending-profile" class="account-action danger">取消新增</button>` : ""}
          </div>
        ` : ""}
      </div>
    </div>
  `;
}

function renderSettings() {
  const s = state.settings;
  return `
    <section class="settings-panel ${state.settingsOpen ? "is-open" : ""}" aria-hidden="${!state.settingsOpen}">
      <div class="settings-heading">
        <div>
          <h2>外觀與行為</h2>
          <p>調整 HUD 顏色與透明度</p>
        </div>
        <button class="icon-button" id="close-settings" aria-label="關閉設定">×</button>
      </div>

      <div class="setting-group">
        <label>玻璃色調</label>
        <div class="tone-row">
          ${[
            ["ice", "冰霧"],
            ["clear", "清透"],
            ["smoke", "煙霧"]
          ].map(([value, label]) => `<button class="tone-button ${s.tone === value ? "active" : ""}" data-tone-value="${value}">${label}</button>`).join("")}
        </div>
      </div>

      <div class="setting-group">
        <label>主色</label>
        <div class="accent-row">
          ${ACCENT_PRESETS.map((preset) => `<button class="accent-swatch ${s.accent.toLowerCase() === preset.value.toLowerCase() ? "active" : ""}" data-accent="${preset.value}" style="--swatch:${preset.value}" title="${preset.name}" aria-label="${preset.name}"></button>`).join("")}
          <label class="custom-color" title="自訂顏色">
            <span>＋</span>
            <input id="custom-accent" type="color" value="${escapeHtml(s.accent)}" aria-label="自訂主色" />
          </label>
        </div>
      </div>

      ${renderSlider("opacity", "透明度", s.opacity, 40, 100, "%")}
      ${renderSlider("warningThreshold", "低額度提醒", s.warningThreshold, 15, 40, "%")}
      ${renderSlider("criticalThreshold", "危險提醒", s.criticalThreshold, 5, 20, "%")}

      <div class="setting-switches">
        <label class="switch-row">
          <span><b>額度通知</b><small>額度偏低、即將耗盡或恢復時提醒</small></span>
          <input id="notifications-enabled" type="checkbox" ${s.notificationsEnabled ? "checked" : ""} />
        </label>
        <label class="switch-row">
          <span><b>固定最上層</b><small>讓 HUD 保持在其他視窗上方</small></span>
          <input id="always-on-top" type="checkbox" ${s.alwaysOnTop ? "checked" : ""} />
        </label>
        <label class="switch-row">
          <span><b>開機自動啟動</b><small>登入 Windows 後自動顯示</small></span>
          <input id="autostart" type="checkbox" ${s.autostart ? "checked" : ""} />
        </label>
      </div>

      <button class="reset-style-button" id="reset-style">恢復預設值</button>
    </section>
  `;
}

function renderTrendPanel() {
  const days = getSevenDayUsage();
  const maxTokens = Math.max(1, ...days.map((day) => day.tokens));
  const totalTokens = days.reduce((sum, day) => sum + day.tokens, 0);
  const peak = days.reduce((best, day) => day.tokens > best.tokens ? day : best, days[0] ?? { label: "—", tokens: 0 });

  return `
    <section class="trend-panel ${state.trendOpen ? "is-open" : ""}" aria-hidden="${!state.trendOpen}">
      <div class="trend-heading">
        <div>
          <h2>近 7 天使用趨勢</h2>
          <p>每日 Codex Token 使用量</p>
        </div>
        <button class="icon-button" id="close-trend" aria-label="關閉趨勢">×</button>
      </div>
      <div class="trend-summary">
        <div><span>7 日總量</span><strong>${formatCompactNumber(totalTokens)}</strong></div>
        <div><span>最高日</span><strong>${escapeHtml(peak.label)} · ${formatCompactNumber(peak.tokens)}</strong></div>
      </div>
      <div class="trend-chart" role="img" aria-label="近七日 Codex Token 使用趨勢">
        ${days.map((day) => {
          const height = Math.max(4, Math.round((day.tokens / maxTokens) * 100));
          return `
            <div class="trend-day" title="${escapeHtml(day.key)} · ${formatCompactNumber(day.tokens)} Tokens">
              <span class="trend-value">${formatCompactNumber(day.tokens)}</span>
              <div class="trend-track"><div class="trend-bar" style="height:${height}%"></div></div>
              <span class="trend-label">${escapeHtml(day.label)}</span>
            </div>
          `;
        }).join("")}
      </div>
      <p class="trend-note">資料來自 Codex 官方 usage 摘要；圖表以「最新已回報日期」為終點。${state.snapshot?.tokenUsage?.usageDataLagDays > 0 ? `目前 ${escapeHtml(usageFreshnessText(state.snapshot))}，尚未回報的日期不會當成 0。` : ""}</p>
    </section>
  `;
}

function renderSlider(key, label, value, min, max, suffix) {
  return `
    <div class="setting-group slider-group">
      <div class="slider-label"><label for="setting-${key}">${label}</label><output id="output-${key}">${value}${suffix}</output></div>
      <input id="setting-${key}" data-setting-range="${key}" type="range" min="${min}" max="${max}" value="${value}" />
    </div>
  `;
}

function renderResizeHandles() {
  return `
    <div class="resize-handle resize-n" data-resize-direction="North"></div>
    <div class="resize-handle resize-e" data-resize-direction="East"></div>
    <div class="resize-handle resize-s" data-resize-direction="South"></div>
    <div class="resize-handle resize-w" data-resize-direction="West"></div>
    <div class="resize-handle resize-ne" data-resize-direction="NorthEast"></div>
    <div class="resize-handle resize-nw" data-resize-direction="NorthWest"></div>
    <div class="resize-handle resize-se" data-resize-direction="SouthEast" title="拖曳調整大小"></div>
    <div class="resize-handle resize-sw" data-resize-direction="SouthWest"></div>
  `;
}

function delay(ms) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

async function waitForProfileLogin(profile, { pending = false } = {}) {
  state.loginProfileId = profile.id;
  state.loginMessage = `已開啟 ${profile.label} 的 Codex 官方登入，認證成功後才會加入帳號清單。`;
  render();

  for (let attempt = 0; attempt < 60; attempt += 1) {
    await delay(2000);
    if (state.loginProfileId !== profile.id) return;

    try {
      const loggedIn = await invoke("codex_profile_login_status", { profileId: profile.id });
      if (!loggedIn || state.loginProfileId !== profile.id) continue;

      state.loginMessage = `${profile.label} 認證完成，正在讀取額度…`;
      render();

      let finalizedProfile = profile;
      if (pending) {
        finalizedProfile = await invoke("finalize_codex_profile", { profileId: profile.id });
        state.pendingProfile = null;
        state.profiles.push(finalizedProfile);
        state.profileUsages.push({ profile: finalizedProfile, snapshot: null, error: null });
      }

      state.loginProfileId = null;
      state.profileActionLoading = false;
      state.loginMessage = null;
      await refresh(true);
      await selectProfile(finalizedProfile.id);
      return;
    } catch (error) {
      console.error("檢查 Codex 帳號登入狀態失敗", error);
    }
  }

  if (pending && state.loginProfileId === profile.id) {
    try {
      await invoke("cancel_codex_profile_login", { profileId: profile.id });
    } catch (error) {
      console.error("清除未完成 Codex 帳號失敗", error);
    }
    state.pendingProfile = null;
  }
  if (state.loginProfileId === profile.id) state.loginProfileId = null;
  state.profileActionLoading = false;
  state.loginMessage = pending
    ? `${profile.label} 認證逾時，未加入帳號清單。`
    : `${profile.label} 尚未完成登入，可稍後按「登入」重試。`;
  render();
}

async function startProfileLogin(profileId) {
  const profile = profileById(profileId);
  if (!profile || profile.isDefault || state.loginProfileId) return;

  state.profileActionLoading = true;
  state.loginProfileId = profile.id;
  state.loginMessage = `正在啟動 ${profile.label} 的 Codex 官方登入…`;
  render();

  try {
    await invoke("start_codex_profile_login", { profileId: profile.id });
    await waitForProfileLogin(profile);
  } catch (error) {
    state.profileActionLoading = false;
    state.loginProfileId = null;
    state.loginMessage = `無法啟動 ${profile.label} 登入：${String(error)}`;
    render();
  }
}

async function addProfile() {
  if (state.profileActionLoading || state.loginProfileId || state.pendingProfile) return;
  const input = document.querySelector("#new-profile-label");
  const label = input?.value?.trim() ?? "";

  state.profileActionLoading = true;
  state.loginMessage = "正在建立待認證的 Codex 帳號環境…";
  render();

  let profile = null;
  try {
    profile = await invoke("create_codex_profile", { label });
    state.pendingProfile = profile;
    state.loginProfileId = profile.id;
    state.loginMessage = `${profile.label} 尚未加入帳號清單，正在啟動官方登入…`;
    render();
    await invoke("start_codex_profile_login", { profileId: profile.id });
    await waitForProfileLogin(profile, { pending: true });
  } catch (error) {
    if (profile?.id) {
      try {
        await invoke("cancel_codex_profile_login", { profileId: profile.id });
      } catch {
        // 建立流程失敗時盡力清除待認證資料。
      }
    }
    state.pendingProfile = null;
    state.profileActionLoading = false;
    state.loginProfileId = null;
    state.loginMessage = `新增帳號失敗：${String(error)}`;
    render();
  }
}

async function cancelPendingProfile() {
  const profile = state.pendingProfile;
  if (!profile) return;

  // 先清除目前輪詢識別，避免登入剛完成時與取消流程競爭。
  state.loginProfileId = null;
  state.profileActionLoading = true;
  state.loginMessage = `正在取消 ${profile.label}…`;
  render();

  try {
    await invoke("cancel_codex_profile_login", { profileId: profile.id });
    state.pendingProfile = null;
    state.loginMessage = `${profile.label} 已取消，沒有加入帳號清單。`;
  } catch (error) {
    state.loginMessage = `取消新增失敗：${String(error)}`;
  } finally {
    state.profileActionLoading = false;
    render();
  }
}

async function deleteProfile(profileId) {
  const profile = profileById(profileId);
  if (!profile || profile.isDefault) return;
  if (!window.confirm(`確定刪除「${profile.label}」？\n只會刪除 HUD 建立的獨立 CODEX_HOME 與該帳號的本機歷史。`)) return;

  state.profileActionLoading = true;
  render();
  try {
    await invoke("delete_codex_profile", { profileId });
    state.profiles = state.profiles.filter((item) => item.id !== profileId);
    state.profileUsages = state.profileUsages.filter((item) => item.profile?.id !== profileId);
    if (state.activeProfileId === profileId) {
      state.activeProfileId = "default";
      localStorage.setItem(ACTIVE_PROFILE_KEY, "default");
    }
    syncActiveSnapshot();
    state.loginMessage = `${profile.label} 已刪除。`;
  } catch (error) {
    state.loginMessage = `刪除帳號失敗：${String(error)}`;
  } finally {
    state.profileActionLoading = false;
    render();
  }
}

async function openPanel(panel) {
  if (state.miniMode) {
    await setMiniMode(false);
  }

  try {
    if (!state.prePanelSize) {
      const logicalSize = await getLogicalInnerSize();
      state.prePanelSize = { width: logicalSize.width, height: logicalSize.height };
    }

    state.settingsOpen = panel === "settings";
    state.trendOpen = panel === "trend";
    render();

    const logicalSize = await getLogicalInnerSize();
    const minimum = panel === "settings"
      ? { width: 420, height: 500 }
      : { width: 440, height: 380 };
    await appWindow.setSize(new LogicalSize(
      Math.max(logicalSize.width, minimum.width),
      Math.max(logicalSize.height, minimum.height)
    ));
  } catch (error) {
    console.error("無法調整面板視窗大小", error);
  }
}

async function closePanel() {
  state.settingsOpen = false;
  state.trendOpen = false;
  render();

  const previousSize = state.prePanelSize;
  state.prePanelSize = null;
  if (!previousSize) return;

  try {
    await appWindow.setSize(new LogicalSize(previousSize.width, previousSize.height));
  } catch (error) {
    console.error("無法恢復 HUD 大小", error);
  }
}

function openSettings() {
  return openPanel("settings");
}

function closeSettings() {
  return closePanel();
}

function openTrend() {
  return openPanel("trend");
}

function closeTrend() {
  return closePanel();
}

async function setMiniMode(enabled) {
  if (enabled === state.miniMode) return;

  try {
    if (enabled) {
      const logicalSize = await getLogicalInnerSize();
      state.preMiniSize = { width: logicalSize.width, height: logicalSize.height };
      state.miniMode = true;
      localStorage.setItem(MINI_MODE_KEY, "true");
      await appWindow.setSizeConstraints(MINI_CONSTRAINTS);
      await appWindow.setSize(new LogicalSize(MINI_SIZE.width, MINI_SIZE.height));
    } else {
      state.miniMode = false;
      localStorage.setItem(MINI_MODE_KEY, "false");
      await appWindow.setSizeConstraints(NORMAL_CONSTRAINTS);
      const restoreSize = state.preMiniSize ?? { width: 420, height: 270 };
      state.preMiniSize = null;
      await appWindow.setSize(new LogicalSize(restoreSize.width, restoreSize.height));
    }
  } catch (error) {
    console.error("無法切換超迷你模式", error);
  }

  render();
}

function toggleMiniMode() {
  return setMiniMode(!state.miniMode);
}

function render() {
  const root = document.querySelector("#app");
  const risk = state.accountOverview ? allAccountsRisk() : overallRisk();
  const snapshot = state.snapshot;
  const account = snapshot?.account;
  const selectedProfile = activeProfile();
  const windows = visibleWindows();
  const todayTokens = snapshot?.tokenUsage?.todayTokens;
  const brandTitle = state.accountOverview ? "Codex 帳號" : "Codex";
  const brandSubtitle = state.accountOverview
    ? `${state.profiles.length || 1} 個帳號 · Local First`
    : `${selectedProfile?.label ?? "主要帳號"} · Local First`;

  root.innerHTML = `
    <main class="hud-shell">
      <section class="glass-panel ${state.settingsOpen ? "settings-mode" : ""} ${state.trendOpen ? "trend-mode" : ""} ${state.miniMode ? "mini-mode" : ""} ${state.accountOverview ? "account-overview-mode" : ""}">
        <header class="topbar" data-tauri-drag-region>
          <div class="brand" data-tauri-drag-region>
            <div class="brand-orb" data-tauri-drag-region aria-hidden="true"></div>
            <div data-tauri-drag-region>
              <div class="brand-line" data-tauri-drag-region>
                <h1 data-tauri-drag-region>${escapeHtml(brandTitle)}</h1>
                ${!state.accountOverview && account?.planType ? `<span class="plan-badge">${escapeHtml(account.planType)}</span>` : ""}
              </div>
              <p data-tauri-drag-region>${escapeHtml(brandSubtitle)}</p>
            </div>
          </div>
          <div class="top-actions">
            <span class="status-chip risk-${risk}"><i></i><b>${riskLabel(risk)}</b></span>
            <button class="icon-button ${state.loading ? "is-spinning" : ""}" id="refresh" title="立即重新整理全部帳號" aria-label="立即重新整理全部帳號">↻</button>
            <button class="icon-button ${state.accountOverview ? "is-active" : ""}" id="show-accounts" title="帳號總覽" aria-label="帳號總覽">◎</button>
            ${state.accountOverview ? "" : `<button class="icon-button secondary-action" id="open-trend" title="近 7 天使用趨勢" aria-label="近 7 天使用趨勢">▥</button>`}
            <button class="icon-button secondary-action" id="open-settings" title="設定" aria-label="設定">⚙</button>
            ${state.accountOverview ? "" : `<button class="icon-button" id="toggle-mini" title="${state.miniMode ? "離開超迷你模式" : "切換超迷你模式"}" aria-label="切換超迷你模式">▭</button>`}
            <button class="icon-button" id="hide-window" title="隱藏到系統匣" aria-label="隱藏到系統匣">—</button>
          </div>
        </header>

        <section class="content-area">
          ${state.accountOverview ? renderAccountOverview() : state.error ? `
            <div class="error-state">
              <div class="error-icon">!</div>
              <h2>無法讀取 Codex 額度</h2>
              <p>${escapeHtml(state.error)}</p>
              <button id="retry">再試一次</button>
            </div>
          ` : state.loading && !snapshot ? `
            <div class="loading-state">
              <div class="loading-orb"></div>
              <p>正在讀取 Codex 額度…</p>
            </div>
          ` : `
            <div class="quota-list">
              ${windows.length ? windows.map(renderWindow).join("") : `<div class="empty-state">目前沒有可顯示的 quota bucket。</div>`}
            </div>
            <div class="mini-stats">
              <div class="mini-stat" title="${escapeHtml(usageFreshnessTitle(snapshot))}">
                <span>今日 Tokens</span>
                <strong>${formatOptionalCompactNumber(todayTokens)}</strong>
              </div>
              <div class="mini-stat" title="${escapeHtml(usageFreshnessTitle(snapshot))}">
                <span>Lifetime</span>
                <strong>${formatOptionalCompactNumber(snapshot?.tokenUsage?.lifetimeTokens)}</strong>
              </div>
              <div class="mini-stat" title="${escapeHtml(usageFreshnessTitle(snapshot))}">
                <span>Token 資料</span>
                <strong>${escapeHtml(usageFreshnessText(snapshot))}</strong>
              </div>
              <div class="mini-stat" title="最後一次成功從 codex app-server 取得額度資料的時間">
                <span>刷新時間</span>
                <strong>${snapshot?.sampledAt ? new Intl.DateTimeFormat("zh-TW", { hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(snapshot.sampledAt * 1000)) : "—"}</strong>
              </div>
            </div>
          `}
        </section>

        ${renderSettings()}
        ${renderTrendPanel()}
        ${state.settingsOpen || state.trendOpen ? "" : renderResizeHandles()}
      </section>
    </main>
  `;

  bindEvents();
}

function bindEvents() {
  document.querySelector("#refresh")?.addEventListener("click", () => refresh(true));
  document.querySelector("#retry")?.addEventListener("click", () => refresh(true));
  document.querySelector("#show-accounts")?.addEventListener("click", () => showAccountOverview());
  document.querySelector("#add-profile")?.addEventListener("click", () => addProfile());
  document.querySelector("#cancel-pending-profile")?.addEventListener("click", () => cancelPendingProfile());
  document.querySelector("#new-profile-label")?.addEventListener("keydown", (event) => {
    if (event.key === "Enter") addProfile();
  });
  document.querySelectorAll("[data-select-profile]").forEach((row) => {
    const select = () => selectProfile(row.dataset.selectProfile);
    row.addEventListener("click", (event) => {
      if (event.target.closest("button")) return;
      select();
    });
    row.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        select();
      }
    });
  });
  document.querySelectorAll("[data-login-profile]").forEach((button) => {
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      startProfileLogin(button.dataset.loginProfile);
    });
  });
  document.querySelectorAll("[data-delete-profile]").forEach((button) => {
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      deleteProfile(button.dataset.deleteProfile);
    });
  });
  document.querySelector("#open-settings")?.addEventListener("click", () => openSettings());
  document.querySelector("#close-settings")?.addEventListener("click", () => closeSettings());
  document.querySelector("#open-trend")?.addEventListener("click", () => openTrend());
  document.querySelector("#close-trend")?.addEventListener("click", () => closeTrend());
  document.querySelector("#toggle-mini")?.addEventListener("click", () => toggleMiniMode());
  document.querySelector("#hide-window")?.addEventListener("click", () => appWindow.hide());

  document.querySelectorAll("[data-resize-direction]").forEach((handle) => {
    handle.addEventListener("pointerdown", async (event) => {
      event.preventDefault();
      event.stopPropagation();
      try {
        await appWindow.startResizeDragging(handle.dataset.resizeDirection);
      } catch (error) {
        console.error("無法調整 HUD 大小", error);
      }
    });
  });

  document.querySelectorAll("[data-accent]").forEach((button) => {
    button.addEventListener("click", () => updateSetting("accent", button.dataset.accent));
  });
  document.querySelector("#custom-accent")?.addEventListener("input", (event) => updateSetting("accent", event.target.value, false));
  document.querySelectorAll("[data-tone-value]").forEach((button) => {
    button.addEventListener("click", () => updateSetting("tone", button.dataset.toneValue));
  });
  document.querySelectorAll("[data-setting-range]").forEach((input) => {
    input.addEventListener("input", (event) => {
      const key = event.target.dataset.settingRange;
      state.settings[key] = Number(event.target.value);
      if (key === "warningThreshold" && state.settings.warningThreshold <= state.settings.criticalThreshold) {
        state.settings.criticalThreshold = Math.max(5, state.settings.warningThreshold - 5);
        const output = document.querySelector("#output-criticalThreshold");
        const slider = document.querySelector("#setting-criticalThreshold");
        if (output) output.textContent = `${state.settings.criticalThreshold}%`;
        if (slider) slider.value = String(state.settings.criticalThreshold);
      }
      if (key === "criticalThreshold" && state.settings.criticalThreshold >= state.settings.warningThreshold) {
        state.settings.warningThreshold = Math.min(40, state.settings.criticalThreshold + 5);
        const output = document.querySelector("#output-warningThreshold");
        const slider = document.querySelector("#setting-warningThreshold");
        if (output) output.textContent = `${state.settings.warningThreshold}%`;
        if (slider) slider.value = String(state.settings.warningThreshold);
      }
      const suffix = key === "blur" ? "px" : "%";
      document.querySelector(`#output-${key}`).textContent = `${event.target.value}${suffix}`;
      applySettings();
      saveSettings();
    });
  });
  document.querySelector("#notifications-enabled")?.addEventListener("change", async (event) => {
    const checked = event.target.checked;
    if (checked) {
      state.settings.notificationsEnabled = true;
      state.notificationPermission = null;
      const granted = await ensureNotificationPermission();
      if (!granted) {
        state.settings.notificationsEnabled = false;
        event.target.checked = false;
      }
    } else {
      state.settings.notificationsEnabled = false;
    }
    saveSettings();
  });
  document.querySelector("#always-on-top")?.addEventListener("change", (event) => {
    updateSetting("alwaysOnTop", event.target.checked, false);
  });
  document.querySelector("#autostart")?.addEventListener("change", async (event) => {
    const checked = event.target.checked;
    try {
      checked ? await enable() : await disable();
      state.settings.autostart = checked;
      saveSettings();
    } catch (error) {
      event.target.checked = !checked;
      console.error("無法更新開機啟動設定", error);
    }
  });
  document.querySelector("#reset-style")?.addEventListener("click", () => {
    state.settings = { ...DEFAULT_SETTINGS, autostart: state.settings.autostart };
    saveSettings();
    applySettings();
    render();
  });
}

function updateSetting(key, value, rerender = true) {
  state.settings[key] = value;
  saveSettings();
  applySettings();
  if (rerender) render();
}

async function refresh(force = false) {
  if (state.loading && state.profileUsages.length && !force) return;
  state.loading = true;
  if (!state.accountOverview) state.error = null;
  render();
  try {
    const usages = await invoke("get_all_usage_snapshots", { force });
    state.profileUsages = usages;
    state.profiles = usages.map((item) => item.profile);

    if (!state.profiles.some((profile) => profile.id === state.activeProfileId)) {
      state.activeProfileId = state.profiles[0]?.id ?? "default";
      localStorage.setItem(ACTIVE_PROFILE_KEY, state.activeProfileId);
    }
    syncActiveSnapshot();

    for (const usage of usages) {
      if (usage.snapshot) {
        await processSnapshotAlerts(usage.snapshot, usage.profile.id, usage.profile.label);
      }
    }
  } catch (error) {
    if (!state.accountOverview) state.error = String(error);
    console.error("無法讀取多帳號額度", error);
  } finally {
    state.loading = false;
    render();
  }
}

async function initialize() {
  applySettings();

  try {
    state.profiles = await invoke("list_codex_profiles");
  } catch (error) {
    console.error("無法讀取 Codex 帳號清單", error);
    state.profiles = [{ id: "default", label: "主要帳號", isDefault: true, codexHome: null }];
  }

  if (!state.profiles.some((profile) => profile.id === state.activeProfileId)) {
    state.activeProfileId = state.profiles[0]?.id ?? "default";
    localStorage.setItem(ACTIVE_PROFILE_KEY, state.activeProfileId);
  }
  if (!state.accountViewInitialized && state.profiles.length > 1) {
    state.accountOverview = true;
    localStorage.setItem(ACCOUNT_VIEW_KEY, "true");
  }
  if (state.accountOverview && state.miniMode) {
    state.miniMode = false;
    localStorage.setItem(MINI_MODE_KEY, "false");
  }

  await restoreWindowGeometry();

  if (state.miniMode) {
    try {
      state.preMiniSize = await getLogicalInnerSize();
      await appWindow.setSizeConstraints(MINI_CONSTRAINTS);
      await appWindow.setSize(new LogicalSize(MINI_SIZE.width, MINI_SIZE.height));
    } catch (error) {
      console.error("無法恢復超迷你模式", error);
    }
  } else {
    await appWindow.setSizeConstraints(NORMAL_CONSTRAINTS).catch(() => {});
  }

  await appWindow.onMoved(() => scheduleGeometrySave());
  await appWindow.onResized(() => scheduleGeometrySave());

  try {
    state.settings.autostart = await isEnabled();
    saveSettings();
  } catch {
    // 無法讀取時保留既有設定，避免影響主要額度功能。
  }

  await listen("profile-usage-snapshot-updated", async (event) => {
    upsertProfileUsage(event.payload);
    state.loading = false;
    if (event.payload?.snapshot) {
      await processSnapshotAlerts(
        event.payload.snapshot,
        event.payload.profile.id,
        event.payload.profile.label
      );
    }
    render();
  });
  await listen("profile-usage-snapshot-error", (event) => {
    upsertProfileUsage(event.payload);
    state.loading = false;
    render();
  });

  state.loading = false;
  await refresh(false);
  scheduleGeometrySave();

  state.nowTimer = window.setInterval(() => {
    if (!state.settingsOpen && !state.trendOpen && state.profileUsages.length) render();
  }, 60_000);
}

initialize();
