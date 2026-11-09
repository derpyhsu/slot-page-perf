# slot-page-perf

從網頁定錨 HTML5 slot 的效能。遊戲原始碼不必在這個 repo 裡。clone 之後用 Codex、Claude Code 或 Cursor 打開這個資料夾，把遊戲網址交給 agent。

一次完整定錨會記錄：

- 進網址到第一個 WebGL 幀，以及接著的 loading
- 待機
- 功能列表裡的下注紀錄（50 轉前、50 轉後各一次）與遊戲規則
- 最多 50 轉（預設 40 轉一般、10 轉加速）
- 各階段的 FPS、主執行緒 CPU%、GPU%、draw call、JS heap、貼圖駐留

CPU% 是主執行緒佔該階段幀時間的比例，不是工作管理員的整機 CPU%。

## 瀏覽器

優先使用 Chrome DevTools MCP（`chrome-devtools-mcp`）。

- Cursor 讀 `.cursor/mcp.json`
- Claude Code 讀 `.mcp.json`
- Codex 把 `docs/codex-mcp.toml` 合併進 Codex 的設定

MCP 沒連上時不要改用猜的數字。先把這個伺服器接上。

## 怎麼跑

在這個 repo 裡說：定錨這個網址，然後貼上遊戲網址。

Agent 會在開頁之前注入 `probe/install.js`。50 轉會花掉目前押注，開始前會先把押注顯示給你確認。

結果寫在 `runs/<時間>-<遊戲>/evidence.json`。這個目錄不進 git。報告用 `report/template.md`。Cursor 另外把 `report/template.canvas.tsx` 抄到工作區的 `canvases/`，換上這次的 `EVIDENCE`。

## 邊界

流程與門檻在 `protocol/`。問題必須對得上 `protocol/rules.md`。evidence 只留網址路徑，不留 query string，避免把 session 寫進檔案。

`examples/life-of-pets.short.json` 是建立這套流程之前的短測，用來對照報告長什麼樣子。它沒有 loading、沒有兩個面板，也沒有 50 轉。
