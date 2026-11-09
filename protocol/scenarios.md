# 情境順序

門檻數字以 `protocol/thresholds.json` 為準。探針在開網址之前注入。

## 階段

1. `boot`：網址開始到第一個 WebGL 幀。探針自動切。
2. `loading`：第一個幀到 agent 呼叫 `mark("game-ready")`。旋轉鈕可按時才打這個 mark。引擎主迴圈掛上之前，主執行緒時間只靠 long task。
3. `idle`：`mark("idle")` 後等待 `idleSeconds`。這是後面所有差值的基準。
4. 功能列表只負責打開，不單獨成結論。
5. `history-before`：打開下注紀錄。先記 `panelSpikeSeconds` 的尖峰，再記 `panelSteadySeconds` 的穩態，然後關閉。
6. `rules`：打開遊戲規則，同樣先尖峰再穩態，然後關閉。關閉後再量一段短待機，記進 `idle-after-rules`。
7. 向使用者確認畫面上的目前押注。未確認不開始 50 轉。
8. 一般旋轉 `normalSpins` 轉。每一轉 `mark("spin-N")` 開始，停穩後結束。
9. 有加速鈕時，接著 `turboSpins` 轉，mark 名為 `turbo-N`。沒有加速鈕就繼續一般旋轉，直到 `maxSpins`。
10. `history-after`：50 轉後再打開一次下注紀錄，量法與第 5 步相同。

Feature 或大獎只在該轉的 mark 上記 `tags`。不另外加轉，不買 Feature。

4 倍 CPU 慢速不在這一次裡。要測時另開一輪，只量待機與少數幾轉。

## 按鈕別名

先讀引擎節點名與 Label 字串。沒有引擎文字時才用截圖座標。點擊後確認面板出現才計時。

| 目標 | 可接受的字 |
| --- | --- |
| 功能列表 | 功能列表、選單、menu、Menu |
| 下注紀錄 | 下注紀錄、遊戲紀錄、歷史、Bet History、History |
| 遊戲規則 | 遊戲規則、規則、說明、Help、Paytable、Game Rules |
| 旋轉 | Spin、旋轉，或節點名含 Spin 的可點擊鈕 |
| 加速 | 加速、Turbo、Speed |

找不到就在 evidence 的 `coverage` 寫明試過的字，不拿待機數字充當該面板。

## 停穩

同時成立才算這一轉結束：至少過了 500 ms，而且停止鈕已關掉或 draw call 回到這一轉開始前的待機附近。下一次點擊要等這個條件。沒有停止鈕時，可以讀轉輪節點的狀態回到待機。

停穩當下就 `mark("gap")`，把等待和讀 summary 的時間切出去。`gap` 不寫進 `spins`，也不進報告。不然一轉的紀錄會含幾十秒的等待，平均值會被待機稀釋。

## Cocos 快照

`window.__slotPerf.cocos(label)` 會走一次目前的場景，讀節點、Spine、Label、Mask、粒子、貼圖格式、引擎設定和主控台警告。它不在每一幀跑，只在這幾個時間點各呼叫一次，結果依序放進 `evidence.cocos.snapshots`：

1. 待機量完
2. 遊戲規則穩態
3. 50 轉後的下注紀錄穩態
4. 關掉面板後的最後待機

## 量測前的檢查

`mark("idle")` 後幾秒讀一次 summary。`channels.engineCpu` 要是 true，`frameLoop` 要是 `tick`（Creator 3.x）或 `mainLoop`（Creator 2.x）。如果是 `raf`，代表探針沒掛上引擎迴圈，CPU 全部是未讀到。在 `coverage` 寫明，不要把 0 當成很輕。
