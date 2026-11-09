# 問題規則

數字門檻全部讀 `protocol/thresholds.json`。一條 finding 必須引用規則 id、階段名，以及 evidence 裡的數字。規則沒有觸發就不要寫進 `findings`。

這些規則由 `report/findings.js` 判斷，`report/build.js` 會呼叫它。不要手寫 findings；規則要改就改這份文件和那支程式。

## hitch

階段裡有幀的 `dt` 大於 `hitchMs`。

- `inFlight` 大於 0：`hitch-network`。證據是該幀的 `dt`、`cpu`，以及不含 query 的路徑。
- `inFlight` 為 0，而且 `cpu` 達到該幀 `dt` 的八成以上：`hitch-main-thread`。`source` 是 `longtask` 的項目也算，它的時間本來就是主執行緒。
- 其餘：`hitch-other`。GPU 時間有讀到就一併寫上。

`cpu` 是 `null` 表示那一幀沒有引擎計時，不是 0 毫秒。這時若同一段有時間相近的 long task，寫成同一次 `hitch-main-thread`；沒有就寫 `hitch-other`，證據註明 CPU 未讀到。

`channels.engineCpu` 為 false 時，所有 CPU 平均、p95、CPU% 都是 `unavailable`，`cpu-heavy` 不觸發。

## fps-drop

遊戲階段（待機、旋轉、加速、面板穩態），同類階段合在一起看。下面任一條成立就觸發，證據寫三個數字：

- 平均 FPS 低於 `fps.stageMin`
- 1% low 低於 `fps.lowMin`。1% low 是最慢那 1% 幀的 FPS。
- 超過 33 ms 的幀佔比高於 `fps.badShareMax`

`conditions.gpu` 是軟體繪製（SwiftShader、Microsoft Basic Render Driver、llvmpipe）時照樣觸發，但證據註明這是這台電腦的軟體繪製，不代表手機 GPU。

## gpu-memory-heavy

`memory.gpu.peakMb` 高於 `gpuMemoryWarnMb`。這是頁面向 WebGL 要的貼圖、緩衝和 renderbuffer 還活著的總量，不含預設畫面緩衝。`memory.gpu.status` 不是 `ok` 時不觸發。

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

## Cocos 規則

讀 `evidence.cocos.snapshots`。同一個數字取所有快照的最大值，主控台取最後一次（它是累計的）。門檻在 `thresholds.json` 的 `cocos`。這些規則由 `report/analyze.js` 判斷，和其他問題一起列在報告的「要處理的地方」。

| id | 條件 | 影響 |
| --- | --- | --- |
| `cocos-spine-realtime` | 畫面上的 realtime Spine 多於 `spineRealtimeActive` | CPU：每幀都在算骨骼 |
| `cocos-spine-cache-warning` | 主控台有 Spine 快取模式不支援的呼叫（例如 `clearTrack`） | 動畫狀態會錯，也是無效呼叫 |
| `cocos-texture-uncompressed` | 貼圖超過 `uncompressedMinMb`，而且未壓縮的比例超過 `uncompressedShare` | 記憶體 |
| `cocos-texture-npot` | 邊長不是 2 的冪的比例超過 `npotShare` | 記憶體：不能用 PVRTC，也不能生 mipmap |
| `cocos-label-no-cache` | 畫面上 cacheMode 為 NONE 的 Label 多於 `labelNoCacheActive` | draw call 與 CPU：每個 Label 自己一張貼圖 |
| `cocos-mask-many` | 畫面上的 Mask 多於 `masksActive` | draw call：每個 Mask 打斷合批 |
| `cocos-particles-many` | 畫面上粒子上限加總超過 `particlesMax` | CPU 與填色 |
| `cocos-nodes-many` | 場景節點多於 `nodesTotal` | CPU 與記憶體：隱藏的節點也還在 |
| `cocos-image-cache-kept` | `CLEANUP_IMAGE_CACHE` 為 false | 記憶體：上傳後原圖還留在 JS 記憶體 |
| `cocos-dynamic-atlas-off` | 動態合圖關閉 | draw call |
| `cocos-webgl1` | 瀏覽器有 WebGL 2，遊戲卻用 WebGL 1 | 少了 instancing 等能力 |
| `cocos-frame-rate` | `frameRate` 設成 60 以外 | 上限不是 60 |
| `cocos-console-errors` | 主控台有引擎 error，或同一句 warning 超過 `consoleRepeat` 次 | 穩定性：資源或流程有錯 |

讀不到的欄位是 `null`，該規則不觸發。

## loading-stall

`loading` 或 `enter` 階段有 `hitch-main-thread`，或 CPU% 高於 80 且平均 FPS 低於 30。`boot` 只有文件與腳本，幀數很少時不單獨觸發。`splash` 是等人按開始的時間，不觸發這條。
