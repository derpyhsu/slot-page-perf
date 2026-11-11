# slot-page-perf

從網頁定錨 HTML5 slot 的效能。遊戲原始碼不必在這個 repo 裡。clone 之後用 Codex、Claude Code 或 Cursor 打開這個資料夾，把遊戲網址交給 agent。

目標有三個：載入時畫面不卡、穩定 60 FPS，以及低階裝置也不會 OOM。報告最上面就是這三個分數（載入階段、幀率穩定度、資源占用），接著是像 DevTools 總覽那樣的全程時間軸（CPU、卡頓、記憶體），再來是要處理的地方。這張表把卡頓、記憶體這些現象和 Cocos 角度的改法（Spine 模式、貼圖壓縮、Label 快取等）放在一起，用顏色排先後。

一次完整定錨會跑：

- 進網址到第一個 WebGL 幀，以及接著的 loading
- 待機
- 功能列表裡的下注紀錄（轉之前、轉完後各一次）與遊戲規則
- 最多 30 轉（預設 24 轉一般、6 轉加速）

探針沿時間記錄每 250 ms 的幀、主執行緒時間、draw call，以及 long task、JS heap、貼圖駐留。Cocos 2.x 掛 `mainLoop`，3.x 掛 `director.tick`。另外會讀場景：節點、Spine 快取模式、Label 快取、Mask、粒子、貼圖格式、引擎設定與主控台警告。

評分規則在 `protocol/scoring.md`。記憶體預算預設 300 MB，是低階手機的經驗值，不是實測，可以在 `protocol/thresholds.json` 改。

## 瀏覽器

優先使用 Chrome DevTools MCP（`chrome-devtools-mcp`）。

- Cursor 讀 `.cursor/mcp.json`
- Claude Code 讀 `.mcp.json`
- Codex 把 `docs/codex-mcp.toml` 合併進 Codex 的設定

設定都帶 `--isolated`：每次啟動 MCP 用一個全新的暫時設定檔，快取是空的，載入時間才能計分。同一款遊戲要重量時，先重啟 MCP。

`--disable-features=HttpsUpgrades,...` 關掉 Chrome 的 HTTPS-First。新版 Chrome 的全新設定檔預設會擋 `http` 網站（`ERR_BLOCKED_BY_CLIENT`），測試環境常常只有 `http`。

MCP 沒連上時不要改用猜的數字。先把這個伺服器接上。

## 怎麼跑

在這個 repo 裡說：定錨這個網址，然後貼上遊戲網址。

Agent 會在開頁之前注入 `probe/install.js`。30 轉會花掉目前押注。Agent 讀畫面上的押注和餘額，餘額夠就直接轉，不夠或讀不到才停下來問。

結果寫在 `runs/<時間>-<遊戲>/`。這個目錄不進 git。報告由腳本產生：

```
node report/build.js runs/<run>
```

產出 `report.html`（階段可切換的時間軸）。`report.md` 和 `timeline.svg` 是給 GitHub 看的同一份。

## 邊界

流程與門檻在 `protocol/`。問題必須對得上 `protocol/rules.md`。evidence 只留網址路徑，不留 query string，避免把 session 寫進檔案。

`examples/life-of-pets.short.json` 是建立這套流程之前的短測，`examples/life-of-pets.md` 是它產生的報告。它沒有 loading、沒有兩個面板，也沒有整段 spin，Cocos 數字是當時手動讀的。
