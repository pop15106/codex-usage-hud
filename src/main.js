import "./styles.css";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { disable, enable, isEnabled } from "@tauri-apps/plugin-autostart";

const appWindow = getCurrentWindow();

const DEFAULT_SETTINGS = {
  accent: "#79BFFF",
  opacity: 82,
  tone: "ice",
  alwaysOnTop: true,
  autostart: false,
  refreshSeconds: 180
};

const ACCENT_PRESETS = [
  { name: "冰藍", value: "#79BFFF" },
  { name: "薄荷", value: "#63D8C2" },
  { name: "薰衣草", value: "#A596FF" },
  { name: "珊瑚", value: "#F29AAA" },
  { name: "月霧", value: "#A9B8C6" }
];

const state = {
  snapshot: null,
  loading: true,
  error: null,
  settingsOpen: false,
  settings: loadSettings(),
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
  return (state.snapshot?.windows ?? []).filter(isCodexWindow);
}

function overallRisk() {
  const windows = visibleWindows();
  if (windows.some((item) => item.risk === "critical")) return "critical";
  if (windows.some((item) => item.risk === "warning")) return "warning";
  return "safe";
}

function renderWindow(item) {
  const remaining = clamp(Number(item.remainingPercent) || 0, 0, 100);
  const rate = Number(item.burnRatePerHour);
  const hasRate = Number.isFinite(rate) && rate > 0;
  const eta = item.etaExhaustedAt ? formatCountdown(item.etaExhaustedAt) : "學習中";
  const title = item.limitName || (item.limitId === "codex" ? "Codex" : item.limitId);

  return `
    <article class="quota-card risk-${escapeHtml(item.risk)}">
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
        <span class="risk-label">${escapeHtml(riskLabel(item.risk))}${item.etaExhaustedAt ? ` · ETA ${escapeHtml(eta)}` : ""}</span>
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

      <div class="setting-switches">
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

function render() {
  const root = document.querySelector("#app");
  const risk = overallRisk();
  const snapshot = state.snapshot;
  const account = snapshot?.account;
  const windows = visibleWindows();

  root.innerHTML = `
    <main class="hud-shell" data-tauri-drag-region>
      <section class="glass-panel" data-tauri-drag-region>
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
            <button class="icon-button" id="open-settings" title="設定" aria-label="設定">⚙</button>
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
          `}
        </section>

        ${renderSettings()}
        ${renderResizeHandles()}
      </section>
    </main>
  `;

  bindEvents();
}

function bindEvents() {
  document.querySelector("#refresh")?.addEventListener("click", () => refresh(true));
  document.querySelector("#retry")?.addEventListener("click", () => refresh(true));
  document.querySelector("#open-settings")?.addEventListener("click", () => {
    state.settingsOpen = true;
    render();
  });
  document.querySelector("#close-settings")?.addEventListener("click", () => {
    state.settingsOpen = false;
    render();
  });
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
      const suffix = key === "blur" ? "px" : "%";
      document.querySelector(`#output-${key}`).textContent = `${event.target.value}${suffix}`;
      applySettings();
      saveSettings();
    });
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
    state.snapshot = await invoke("get_usage_snapshot", { force });
  } catch (error) {
    state.error = String(error);
  } finally {
    state.loading = false;
    render();
  }
}

async function initialize() {
  applySettings();
  try {
    state.settings.autostart = await isEnabled();
    saveSettings();
  } catch {
    // 無法讀取時保留既有設定，避免影響主要額度功能。
  }

  await listen("usage-snapshot-updated", (event) => {
    state.snapshot = event.payload;
    state.error = null;
    state.loading = false;
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

  state.nowTimer = window.setInterval(() => {
    if (!state.settingsOpen && state.snapshot) render();
  }, 60_000);
}

initialize();
