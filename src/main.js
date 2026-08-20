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
const NORMAL_CONSTRAINTS = { minWidth: 300, minHeight: 170 };
const MINI_CONSTRAINTS = { minWidth: 260, minHeight: 108 };
const MINI_SIZE = { width: 300, height: 118 };

const state = {
  snapshot: null,
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
  if (remaining <= state.settings.criticalThreshold) return "critical";
  if (remaining <= state.settings.warningThreshold) return "warning";
  if (item?.risk === "critical" || item?.risk === "warning") return item.risk;
  return "safe";
}

function codexWindowsFrom(snapshot) {
  return (snapshot?.windows ?? []).filter(isCodexWindow);
}

async function processSnapshotAlerts(snapshot) {
  const windows = codexWindowsFrom(snapshot);
  const item = windows.find((entry) => entry.windowKind === "primary") ?? windows[0];
  if (!item) return;

  const remaining = clamp(Number(item.remainingPercent) || 0, 0, 100);
  const risk = effectiveRisk(item);
  const previous = loadStoredJson(ALERT_STATE_KEY);
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
      title: "Codex 額度已恢復",
      body: `目前剩餘 ${formatPercent(remaining)}，可以繼續使用。`
    };
  } else if (risk === "critical" && previous?.risk !== "critical") {
    notification = {
      title: "Codex 額度即將耗盡",
      body: `目前只剩 ${formatPercent(remaining)}，Reset ${formatClock(item.resetsAt)}。`
    };
  } else if (risk === "warning" && previous?.risk === "safe") {
    notification = {
      title: "Codex 額度偏低",
      body: `目前剩餘 ${formatPercent(remaining)}，請留意使用速度。`
    };
  }

  if (notification && state.settings.notificationsEnabled && await ensureNotificationPermission()) {
    sendNotification(notification);
  }

  localStorage.setItem(ALERT_STATE_KEY, JSON.stringify({
    remaining,
    risk,
    resetsAt: item.resetsAt,
    sampledAt: snapshot.sampledAt
  }));
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
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  return Array.from({ length: 7 }, (_, index) => {
    const date = new Date(today);
    date.setDate(today.getDate() - (6 - index));
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

function renderWindow(item) {
  const remaining = clamp(Number(item.remainingPercent) || 0, 0, 100);
  const risk = effectiveRisk(item);
  const rate = Number(item.burnRatePerHour);
  const hasRate = Number.isFinite(rate) && rate > 0;
  const eta = item.etaExhaustedAt ? formatCountdown(item.etaExhaustedAt) : "學習中";
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
      <div class="quota-insight">
        <span>${hasRate ? `↘ ${rate.toFixed(1)}% / hr` : "↘ 正在建立消耗基線"}</span>
        <span class="risk-label">${escapeHtml(riskLabel(risk))}${item.etaExhaustedAt ? ` · ETA ${escapeHtml(eta)}` : ""}</span>
      </div>
    </article>
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
      <p class="trend-note">資料來自本機 Codex usage 摘要，不會上傳到第三方。</p>
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
  const risk = overallRisk();
  const snapshot = state.snapshot;
  const account = snapshot?.account;
  const windows = visibleWindows();
  const todayTokens = snapshot?.tokenUsage?.todayTokens;

  root.innerHTML = `
    <main class="hud-shell" data-tauri-drag-region>
      <section class="glass-panel ${state.settingsOpen ? "settings-mode" : ""} ${state.trendOpen ? "trend-mode" : ""} ${state.miniMode ? "mini-mode" : ""}" data-tauri-drag-region>
        <header class="topbar" data-tauri-drag-region>
          <div class="brand" data-tauri-drag-region>
            <div class="brand-orb" data-tauri-drag-region aria-hidden="true"></div>
            <div data-tauri-drag-region>
              <div class="brand-line" data-tauri-drag-region>
                <h1 data-tauri-drag-region>Codex</h1>
                ${account?.planType ? `<span class="plan-badge">${escapeHtml(account.planType)}</span>` : ""}
              </div>
              <p data-tauri-drag-region>Usage HUD · Local First</p>
            </div>
          </div>
          <div class="top-actions">
            <span class="status-chip risk-${risk}"><i></i><b>${riskLabel(risk)}</b></span>
            <button class="icon-button ${state.loading ? "is-spinning" : ""}" id="refresh" title="立即重新整理" aria-label="立即重新整理">↻</button>
            <button class="icon-button secondary-action" id="open-trend" title="近 7 天使用趨勢" aria-label="近 7 天使用趨勢">▥</button>
            <button class="icon-button secondary-action" id="open-settings" title="設定" aria-label="設定">⚙</button>
            <button class="icon-button" id="toggle-mini" title="${state.miniMode ? "離開超迷你模式" : "切換超迷你模式"}" aria-label="切換超迷你模式">▭</button>
            <button class="icon-button" id="hide-window" title="隱藏到系統匣" aria-label="隱藏到系統匣">—</button>
          </div>
        </header>

        <section class="content-area">
          ${state.error ? `
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
              <div class="mini-stat">
                <span>今日 Tokens</span>
                <strong>${formatCompactNumber(todayTokens)}</strong>
              </div>
              <div class="mini-stat">
                <span>Lifetime</span>
                <strong>${formatCompactNumber(snapshot?.tokenUsage?.lifetimeTokens)}</strong>
              </div>
              <div class="mini-stat">
                <span>更新</span>
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
  if (state.loading && !state.error && !force) return;
  state.loading = true;
  state.error = null;
  render();
  try {
    const snapshot = await invoke("get_usage_snapshot", { force });
    state.snapshot = snapshot;
    await processSnapshotAlerts(snapshot);
  } catch (error) {
    state.error = String(error);
  } finally {
    state.loading = false;
    render();
  }
}

async function initialize() {
  applySettings();
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

  await listen("usage-snapshot-updated", async (event) => {
    state.snapshot = event.payload;
    state.error = null;
    state.loading = false;
    await processSnapshotAlerts(event.payload);
    render();
  });
  await listen("usage-snapshot-error", (event) => {
    if (!state.snapshot) {
      state.error = String(event.payload);
      state.loading = false;
      render();
    }
  });

  state.loading = false;
  await refresh(false);
  scheduleGeometrySave();

  state.nowTimer = window.setInterval(() => {
    if (!state.settingsOpen && !state.trendOpen && state.snapshot) render();
  }, 60_000);
}

initialize();
