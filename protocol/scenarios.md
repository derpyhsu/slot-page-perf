# 情境順序

門檻數字以 `protocol/thresholds.json` 為準。探針在開網址之前注入。

## 階段

1. `boot`：網址開始到第一個 WebGL 幀。探針自動切。
2. `loading`：第一個幀到 agent 呼叫 `mark("game-ready")`。spin 鈕可按時才打這個 mark。引擎主迴圈掛上之前，主執行緒時間只靠 long task。中間要按開始或關公告時，照下面「進遊戲」切成 `splash` 和 `enter`。
3. `idle`：`mark("idle")` 後等待 `idleSeconds`。這是後面所有差值的基準。
4. 功能列表只負責打開，不單獨成結論。
5. `history-before`：打開下注紀錄。先記 `panelSpikeSeconds` 的尖峰，再記 `panelSteadySeconds` 的穩態，然後關閉。
6. `rules`：打開遊戲規則，同樣先尖峰再穩態，然後關閉。關閉後再量一段短待機，記進 `idle-after-rules`。
7. 向使用者確認畫面上的目前押注。未確認不開始 spin。
8. 一般 spin `normalSpins` 次。每一次 `mark("spin-N")` 開始，停穩後結束。
9. 有加速鈕時，接著 `turboSpins` 次，mark 名為 `turbo-N`。沒有加速鈕就繼續一般 spin，直到 `maxSpins`。
10. `history-after`：轉完後再打開一次下注紀錄，量法與第 5 步相同。

Feature 或大獎只在該轉的 mark 上記 `tags`。不另外加轉，不買 Feature。

4 倍 CPU 慢速不在這一次裡。要測時另開一輪，只量待機與少數幾轉。

## 進遊戲

每款遊戲從載入到能轉的路都不一樣，不能假設有開始鈕，也不能假設它在哪裡。可能是：

- 載入完直接進遊戲，沒有任何畫面要按。
- 一張主視覺加一顆開始鈕，位置每款不同。
- 開始鈕不是 `cc.Button`，而是掛了 touch 事件的節點，或是蓋在畫布上的 HTML 按鈕。
- 畫面寫「點擊任意處開始」，沒有按鈕。
- 開始之後還有一兩層公告、玩法說明、「知道了」。

所以這一段是一個迴圈，不是固定步驟。字表全在 `thresholds.json` 的 `entry`。

每秒呼叫一次 `__slotPerf.entry(entry)`，最多 `entry.maxSeconds` 秒、最多按 `entry.maxSteps` 次：

1. `spinReady` 是 true：已經在遊戲裡，`mark("game-ready")`，結束迴圈。
2. 還沒載入滿：`quietMs` 小於 `entry.quietMs`，或候選清單跟上一秒不同，就繼續等。候選要連續 `entry.stablePolls` 次一樣才算穩。進度條還在跑時不按。
3. 載入滿了但不能轉，就先截圖，看畫面上要按什麼。第一次走到這裡時 `mark("splash")`。
4. 依這個順序選一個來按，只選一個：
   1. `start` 裡 `interactable` 的。
   2. `dismiss` 裡的，用於公告和說明。
   3. `dom` 裡的，用於 HTML 按鈕。
   4. `tapAnywhere` 有字時，點畫布正中央。
   5. 都沒有，就看截圖：畫面上有明顯的開始或確認鈕，就點它的位置；看不出來就停下來，回報截圖，不要亂點。
5. 按之前 `mark("enter")`，用 pointer 事件點 `point`。`point` 是 null 或跟截圖對不上時，用截圖上的位置。按完回到第 1 步。

不要按 `avoidWords` 對得上的東西，像購買、加注、自動、不再顯示、返回大廳。`entry()` 已經把它們濾掉，但用截圖選位置時也要照這個規則。

每按一次就在 `evidence.entry.steps` 記一筆 `{ kind, text, afterMs }`。`kind` 是 `button`、`touch`、`dom`、`tap-anywhere` 或 `screenshot`，`afterMs` 是從開網址算起的毫秒。`evidence.entry.result` 寫下面其中一個：

- `direct`：沒按就能轉。
- `pressed`：按了之後能轉。
- `stuck`：到上限還不能轉。這時停止量測，回報截圖和 `texts`。

`splash` 是等人按的時間，由 agent 決定長短，不評分。`enter` 是按下去到下一個畫面，跟 `loading` 一樣算載入。有好幾層就會有好幾段 `splash` 和 `enter`，報告會合在一起畫。

## 按鈕別名

進遊戲用的字表在 `thresholds.json` 的 `entry`。其他按鈕先用 `__slotPerf.buttons(["字1", "字2"])` 讀引擎節點名與 Label 字串。沒有引擎文字時才用截圖座標。點擊後確認面板出現才計時。

| 目標 | 可接受的字 |
| --- | --- |
| 功能列表 | 功能列表、選單、menu、Menu |
| 下注紀錄 | 下注紀錄、遊戲紀錄、歷史、Bet History、History |
| 遊戲規則 | 遊戲規則、規則、說明、Help、Paytable、Game Rules |
| spin | Spin、旋轉，或節點名含 Spin 的可點擊鈕 |
| 加速 | 加速、Turbo、Speed |

找不到就在 evidence 的 `coverage` 寫明試過的字，不拿待機數字充當該面板。

## 停穩

同時成立才算這一轉結束：至少過了 500 ms，而且停止鈕已關掉或 draw call 回到這一轉開始前的待機附近。下一次點擊要等這個條件。沒有停止鈕時，可以讀轉輪節點的狀態回到待機。

停穩當下就 `mark("gap")`，把等待和讀 summary 的時間切出去。`gap` 不寫進 `spins`，也不進報告。不然一轉的紀錄會含幾十秒的等待，平均值會被待機稀釋。

## Cocos 快照

`window.__slotPerf.cocos(label)` 會走一次目前的場景，讀節點、Spine、Label、Mask、粒子、貼圖格式、引擎設定和主控台警告。它不在每一幀跑，只在這幾個時間點各呼叫一次，結果依序放進 `evidence.cocos.snapshots`：

1. 待機量完
2. 遊戲規則穩態
3. 轉完後的下注紀錄穩態
4. 關掉面板後的最後待機

## 量測前的檢查

`mark("idle")` 後幾秒讀一次 summary。`channels.engineCpu` 要是 true，`frameLoop` 要是 `tick`（Creator 3.x）或 `mainLoop`（Creator 2.x）。如果是 `raf`，代表探針沒掛上引擎迴圈，CPU 全部是未讀到。在 `coverage` 寫明，不要把 0 當成很輕。
