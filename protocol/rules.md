# 問題規則

數字門檻全部讀 `protocol/thresholds.json`。一條 finding 必須引用規則 id、階段名，以及 evidence 裡的數字。規則沒有觸發就不要寫進 `findings`。

## hitch

階段裡有幀的 `dt` 大於 `hitchMs`。

- `inFlight` 大於 0：`hitch-network`。證據是該幀的 `dt`、`cpu`，以及不含 query 的路徑。
- `inFlight` 為 0，而且 `cpu` 達到該幀 `dt` 的八成以上：`hitch-main-thread`。
- 其餘：`hitch-other`。GPU 時間有讀到就一併寫上。

## cpu-heavy

僅用 1 倍 CPU 的遊戲階段（idle、spin、turbo、面板穩態）。該階段 CPU p95 大於 `cpuHeavyP95Ms`，而且 GPU timer 的 p95 小於 `gpuLightP95Ms`。GPU timer 不可用時不觸發這條。

## gpu-heavy

GPU timer 的 p95 大於 `gpuHeavyP95Ms`。擴充不存在時整條保持 `unavailable`，不要估一個百分比。

## texture-heavy

貼圖駐留 MB 大於 `textureWarnMb`。證據含張數、格式、最大的幾張尺寸。讀不到格式時駐留標 `unavailable`，不觸發。

## leak-suspected

只在完成至少 `warmupSpins` 之後、而且有第 `warmupSpins` 轉停穩與最後一轉停穩的 heap 地板時才判斷。

- 增量大於 `leakMb`
- 最後 `leakTailSpins` 轉的地板仍在上升

兩件都成立才標 `leak-suspected`。沒有第 5 轉與最後一轉的 heap snapshot 差值時，狀態寫「疑似」，不寫「已證實」。轉數不夠就寫 `not-enough-spins`，不要當成沒有洩漏。

## panel-heavier

`history-before`、`history-after` 或 `rules` 的穩態，相對 `idle`：FPS 下降超過 10，或 draw call 平均增加超過三成，或尖峰窗出現 `hitchMs` 以上的幀。證據寫明減掉待機之後的差。

## panel-left-open

`idle-after-rules` 的 draw call 平均比 `idle` 高過三成，或 heap 地板比打開面板前高過 `leakMb`。

## loading-stall

`loading` 階段有 `hitch-main-thread`，或 CPU% 高於 80 且平均 FPS 低於 30。`boot` 只有文件與腳本，幀數很少時不單獨觸發。
