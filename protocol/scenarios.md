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

同時成立才算這一轉結束：至少過了 500 ms，而且停止鈕已關掉或 draw call 回到這一轉開始前的待機附近。下一次點擊要等這個條件。
