# Codex Usage HUD

一個輕量、Local First 的 Windows 桌面懸浮工具，用來顯示 ChatGPT Codex 訂閱額度、重置時間、使用速度與預估耗盡時間。

> 目前狀態：`v0.1.3` MVP

## 功能

- 透過官方 `codex app-server` 讀取 ChatGPT Codex 額度。
- 動態辨識所有 rate-limit bucket，不把 5H / Weekly 規則寫死。
- 精簡 HUD 只顯示 `Codex` quota，避免其他 bucket 佔用桌面空間。
- 顯示剩餘百分比、Reset 倒數與實際 Reset 時間。
- 使用本機 SQLite 保存 quota 採樣，推算 Burn Rate 與 ETA。
- 判斷「預估耗盡時間是否早於 Reset」，以穩定 / 注意 / 危險顯示。
- Windows 系統匣常駐，HUD 可隱藏而不退出。
- 無標題列、可拖曳、可自由縮放、半透明、Always-on-top 的 Compact HUD。
- 顯示今日 Tokens、Lifetime Tokens 與最後更新時間；視窗過矮時自動收斂隱藏。
- 設定模式使用獨立不透底面板，並暫時放大視窗；關閉後恢復原本 HUD 大小。
- 移除 Windows Acrylic 與 backdrop blur，避免桌面背景出現霧化區塊。
- 可調整：
  - 冰霧 / 清透 / 煙霧面板色調
  - 5 組預設 Accent Color
  - 自訂主色
  - 透明度
  - 視窗大小（四邊與四角拖曳縮放）
  - 固定最上層
  - 開機自動啟動

## 資料來源

本工具使用 Codex 官方 App Server：

- `account/read`
- `account/rateLimits/read`
- `account/usage/read`

官方文件：

- https://developers.openai.com/codex/app-server

`account/rateLimits/read` 會提供 `usedPercent`、`windowDurationMins`、`resetsAt`，並可回傳多個 `limitId` bucket。

## 使用需求

目前 MVP 需要：

1. Windows 10 / 11。
2. 已安裝 Codex CLI。
3. `codex` 可在 PATH 中執行。
4. Codex CLI 已使用 ChatGPT 帳號登入。
5. WebView2 Runtime。

可先確認：

```powershell
codex --version
codex app-server
```

## 隱私

Codex Usage HUD 採 Local First 設計：

- 不建立額外雲端帳號。
- 不上傳使用量歷史到第三方伺服器。
- 額度採樣存放在本機 SQLite。
- UI 偏好存放在本機 WebView storage。
- 不讀取瀏覽器 Cookie。
- 不爬 ChatGPT 網頁。

SQLite 資料庫位於 Tauri 的應用程式資料目錄，檔名為：

```text
usage-history.db
```

## Burn Rate / ETA

工具會針對同一個：

```text
limitId + windowKind + resetsAt
```

比較歷史 `usedPercent`。

概念公式：

```text
Burn Rate = 額度使用百分比變化 / 經過時間
ETA       = 剩餘百分比 / Burn Rate
```

短期 window 使用最近最多 6 小時資料；長期 window 使用最近最多 24 小時資料。

剛啟動或歷史不足 5 分鐘時，HUD 會顯示「正在建立消耗基線」。

## 開發

### 環境

- Node.js 20+
- Rust stable
- Windows C++ Build Tools
- Codex CLI

### 安裝依賴

```powershell
npm install
```

### 開發模式

```powershell
npm run tauri dev
```

### 檢查

```powershell
npm run check
```

### 建置 Windows 安裝檔

```powershell
npm run tauri build
```

預設使用 Tauri NSIS `currentUser` 安裝模式，不要求管理員權限。

輸出通常位於：

```text
src-tauri\target\release\bundle\nsis\
```

## 技術

- Tauri 2
- Rust
- Vanilla JavaScript
- Vite
- SQLite / rusqlite
- Codex App Server JSONL / JSON-RPC protocol

## Roadmap

- [x] 官方 Codex rate-limit 讀取
- [x] 動態 quota bucket
- [x] Reset 倒數
- [x] Local SQLite history
- [x] Burn Rate / ETA
- [x] Compact draggable HUD
- [x] 單一 Codex quota 顯示
- [x] 自訂顏色 / 透明度
- [x] System tray
- [x] Autostart
- [ ] Mini 膠囊模式
- [ ] 7 / 30 日使用趨勢圖
- [ ] 額度恢復通知
- [ ] 預估提前耗盡通知
- [ ] GitHub Release 自動簽章流程

## License

MIT
