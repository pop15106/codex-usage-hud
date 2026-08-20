# Codex Usage HUD

一個輕量、Local First 的 Windows 桌面懸浮工具，用來顯示 ChatGPT Codex 訂閱額度、重置時間、使用速度與預估耗盡時間。

> 目前狀態：`v0.3.2`
>
> 📘 **完整使用說明書**：[`docs/USER_GUIDE.zh-TW.md`](docs/USER_GUIDE.zh-TW.md)
> 內容包含安裝、主畫面、ETA 信心度、多帳號、通知、趨勢、Portable、資安與疑難排解。

## 功能

- 透過官方 `codex app-server` 讀取 ChatGPT Codex 額度。
- 動態辨識所有 rate-limit bucket，不把 5H / Weekly 規則寫死。
- 精簡 HUD 只顯示 `Codex` quota，避免其他 bucket 佔用桌面空間。
- 顯示剩餘百分比、Reset 倒數與實際 Reset 時間。
- 底部固定保留今日 Tokens / Lifetime / 更新時間三格摘要。
- 使用本機 SQLite 保存 quota 採樣，推算 Burn Rate、ETA 與 ETA 信心度。
- ETA 只有在樣本數、時間跨度與實際消耗差都成熟後才參與風險判斷，避免短期波動被過度外推。
- 80% 以上剩餘額度原則上維持穩定；低額度、成熟 ETA 提前耗盡或 Codex 官方 hard limit 才提高警示。
- Windows 系統匣常駐，HUD 可隱藏而不退出。
- 無標題列、可拖曳、可自由縮放、半透明、Always-on-top 的 Compact HUD。
- 記住最後的視窗位置與大小，重新開啟後自動恢復。
- 一鍵切換超迷你模式，縮成只保留核心 quota 的小型 HUD。
- 顯示今日 Tokens、Lifetime Tokens 與最後更新時間。
- 支援多帳號 Codex Home：每個額外帳號使用獨立 `CODEX_HOME` 與獨立歷史資料庫。
- 帳號總覽同時顯示各帳號的方案類型、Codex window 額度、Reset、ETA、風險與今日 Tokens。
- 外層總覽提供全部帳號今日 Tokens 總量、最高風險帳號與最快 Reset；點進帳號後才顯示該帳號的三格摘要與詳細 quota。
- 新增帳號時由 HUD 啟動官方 `codex login`；認證完成後才正式加入帳號清單，取消或逾時不會留下半成品帳號。登入憑證仍由 Codex CLI 自己保存，HUD 不複製 token。
- 點擊帳號列會一鍵切換 HUD 的監看帳號；不會修改其他獨立 Codex CLI / VS Code 行程的 `CODEX_HOME` 或登入狀態。
- 近 7 天 Token 使用趨勢圖，直接讀取目前選取帳號的本機 Codex usage 摘要。
- 額度偏低、危險與恢復時可使用 Windows 系統通知。
- 設定模式使用獨立不透底面板，並暫時放大視窗；關閉後恢復原本 HUD 大小。
- 移除 Windows Acrylic 與 backdrop blur，避免桌面背景出現霧化區塊。
- 可調整：
  - 冰霧 / 清透 / 煙霧面板色調
  - 5 組預設 Accent Color
  - 自訂主色
  - 透明度
  - 視窗大小（四邊與四角拖曳縮放）
  - 低額度 / 危險提醒門檻
  - Windows 額度通知
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

目前需要：

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
- 額外 Codex 帳號以獨立 `CODEX_HOME` 保存，由 Codex CLI 管理登入憑證。
- HUD 不讀取、複製或匯出 Codex access token。
- 每個帳號的額度採樣存放在獨立本機 SQLite，避免 Burn Rate / ETA 跨帳號混算。
- UI 偏好存放在本機 WebView storage。
- 不讀取瀏覽器 Cookie。
- 不爬 ChatGPT 網頁。

SQLite 資料庫位於 Tauri 的應用程式資料目錄。主要帳號使用：

```text
usage-history.db
```

額外帳號則使用獨立檔案，例如：

```text
usage-history-account-xxxxxxxx.db
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

ETA 會先進入學習期。信心度同時考慮：

- 至少 3 個有效樣本。
- 5H 這類短窗至少跨 30 分鐘；日窗至少 1 小時；週窗至少 6 小時。
- 同一個 Reset window 內實際 `usedPercent` 至少增加 2%。

三項都達標後 ETA 信心才會到 100%，Burn Rate / ETA 才正式顯示並參與風險判斷。資料不足時 HUD 會顯示 `穩定 · ETA 學習中`，並在提示資訊中顯示目前 ETA 信心度、樣本數、時間跨度與消耗差。

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

### 建置 Windows 安裝檔與 Portable 執行檔

```powershell
npm run tauri build
```

預設使用 Tauri NSIS `currentUser` 安裝模式，不要求管理員權限。

安裝檔通常位於：

```text
src-tauri\target\release\bundle\nsis\
```

不安裝版本可直接使用：

```text
src-tauri\target\release\codex-usage-hud.exe
```

GitHub Actions 會另外整理成 `Codex.Usage.HUD_*_x64-portable.exe` 並一起產生 `SHA256SUMS.txt`。

## GitHub Release / Windows 簽章

推送 `v*` tag 後，GitHub Actions 會自動：

1. 跑 `npm run check`。
2. 建置 Windows x64 portable EXE。
3. 建置 NSIS 安裝檔。
4. 產生 SHA-256 checksum。
5. 發布 GitHub Release。

如果 repository secrets 有設定下列兩項，Release workflow 會在打包前簽署應用程式 EXE，並在打包後簽署 NSIS 安裝檔：

```text
WINDOWS_CERTIFICATE_BASE64
WINDOWS_CERTIFICATE_PASSWORD
```

`WINDOWS_CERTIFICATE_BASE64` 應為 PFX Code Signing 憑證的 Base64 內容。沒有設定憑證時仍可正常發布，但檔案會是未簽章版本。

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
- [x] 超迷你模式
- [x] 7 日使用趨勢圖
- [x] 額度恢復通知
- [x] 額度偏低 / 危險通知
- [x] 視窗位置與大小記憶
- [x] Portable 執行檔
- [x] GitHub Release 自動 build + SHA-256
- [x] 可選 Windows Code Signing pipeline
- [x] 多帳號 Codex Home 切換與總覽
- [x] 多帳號額度 / Reset / ETA 聚合評估
- [ ] 30 日使用趨勢圖

## License

MIT
