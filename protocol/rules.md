# 問題規則

數字門檻全部讀 `protocol/thresholds.json`。一條 finding 必須引用規則 id、階段名，以及 evidence 裡的數字。規則沒有觸發就不要寫進 `findings`。

這些規則由 `report/findings.js` 判斷，`report/build.js` 會呼叫它。不要手寫 findings；規則要改就改這份文件和那支程式。

## hitch

階段裡有幀的 `dt` 大於 `hitchMs`。

- `inFlight` 大於 0：`hitch-network`。證據是該幀的 `dt`、`cpu`，以及不含 query 的路徑。
- `inFlight` 為 0，而且 `cpu` 達到該幀 `dt` 的八成以上：`hitch-main-thread`。`source` 是 `longtask` 的項目也算，它的時間本來就是主執行緒。
- 其餘：`hitch-other`。GPU 時間有讀到就一併寫上。

要處理的地方每個階段只列一列，改法跟最長那一幀走：那一幀在等下載就寫下載和檔名，附近有貼圖上傳就寫上傳的 MB，主執行緒佔了那一幀才寫拆幀。不拿「網路卡頓是否過半」決定整句。

`cpu` 是 `null` 表示那一幀沒有引擎計時，不是 0 毫秒。這時若同一段有時間相近的 long task，寫成同一次 `hitch-main-thread`；沒有就寫 `hitch-other`，證據註明 CPU 未讀到。

`channels.engineCpu` 為 false 時，所有 CPU 平均、p95、CPU% 都是 `unavailable`，`cpu-heavy` 不觸發。

## 幀節奏

引擎主迴圈不一定跟著螢幕更新跑：Creator 2.x 的上限不是 30 或 60 時改用 setTimeout，所以主迴圈的間隔不是畫面真正換幀的間隔。探針另有一條每個 vsync 跑一次的 rAF，量出螢幕更新間隔（vsync），並在每次看到新的引擎幀時記一次「上螢幕的幀」，間隔以 vsync 的整數倍記錄（`stages[].presented`）。

- 應有幀長 E：vsync 與 `1000 / cc.game 幀率上限` 較長者。
- 壞幀：上螢幕間隔超過 `frames.badFactor` × E。60 上限在 60 Hz 時，33 ms 是壞幀；40 上限時 E 是 25 ms，33 ms 不是壞幀。
- 節奏不齊：上螢幕間隔離 E 超過 `frames.paceTolerance` × E。40 上限在 60 Hz 會 16.7、33.3 ms 交替，幾乎每一幀都不齊。
- 下面的 FPS、1% low、掉幀、壞幀都用上螢幕的幀；舊探針沒有這組資料時，退回引擎幀與 33 ms。
- 每 250 ms 的 bucket 也記上螢幕的幀數（`presentedFrames`），計分的「55 FPS 以上」用它算每一秒的 FPS。

## fps-drop

遊戲階段（待機、spin、加速、面板穩態）與載入（`loading`、`enter`），同類階段合在一起看。載入跟遊戲階段用同一套門檻和顏色。下面任一條成立就觸發，證據寫三個數字：

- 平均 FPS 低於 `fps.stageMin` × 應有 FPS / 60
- 掉幀比例 `dropShare` 高於 `fps.dropShareMax`。掉幀是「應該出現卻沒出現」的幀占比，應有 FPS 是 1000 / E。所以 64 Hz 螢幕配 60 上限的正常跳幀不算掉幀，40 上限跑滿 40 也不算。
- 壞幀佔比 `badShare` 高於 `fps.badShareMax`
- 1% low 低於 `fps.lowMin` × 應有 FPS / 60。1% low 是最慢那 1% 幀的 FPS；幀長只會落在螢幕更新的整數倍，所以它常在 60 和 30 之間跳，只當輔助。

`stageMin` 和 `lowMin` 是照 60 的目標寫的，所以依上限換算。上限本身低於 60，已經反映在計分的「55 FPS 以上」，並由 `cocos-frame-rate` 說明原因，不在這裡再算一次。

`conditions.gpu` 是軟體繪製（SwiftShader、Microsoft Basic Render Driver、llvmpipe）時照樣觸發，但證據註明這是這台電腦的軟體繪製，不代表手機 GPU。

## gpu-memory-heavy

`memory.gpu.peakMb` 高於 `gpuMemoryWarnMb`。這是頁面向 WebGL 要的貼圖、緩衝和 renderbuffer 還活著的總量，不含預設畫面緩衝。`memory.gpu.status` 不是 `ok` 時不觸發。

## cpu-heavy

僅用 1 倍 CPU 的遊戲階段（idle、spin、turbo、面板穩態）。該階段 CPU p95 大於 `cpuHeavyP95Ms`，而且 GPU timer 的 p95 小於 `gpuLightP95Ms`。GPU timer 不可用時不觸發這條。

## gpu-heavy

GPU timer 的 p95 大於 `gpuHeavyP95Ms`。擴充不存在時整條保持 `unavailable`，不要估一個百分比。

## texture-heavy

貼圖駐留 MB 大於 `textureWarnMb`。證據含張數、格式、最大的幾張尺寸與檔名。位元組數依格式算，ASTC 依區塊大小（4×4 每像素 1 byte、8×8 是 0.25）。讀不到格式時駐留標 `unavailable`，不觸發。

## leak-suspected

只看 `warmupSpins` 之後的轉，由 `report/findings.js` 的 `heapFit` 算，結果寫在 evidence 的 `heapFit`。

- 每轉的地板：從該轉開始往後 `heap.floorWindowMs`（或整轉，取較長者）裡最低的 heap 取樣。短的一轉也能涵蓋幾次取樣，避開 GC 鋸齒。
- Feature 轉：牆鐘時間超過同組（spin、加速各自）中位數 `heap.featureFactor` 倍的轉，例如免費遊戲。它會載入之後一直留著的資源，不參與計算。
- 大 GC：相鄰兩轉的地板掉了 `heap.majorGcDropMb` 以上。
- 地板以 Feature 轉和大 GC 切段，每段各自扣掉平均後合起來算斜率（MB／轉），所以 Feature 帶來的階梯和 GC 的回落都不算增長。

判定：

- 有大 GC：最後一次大 GC 之後的最低地板，比第一個地板高出 `leakMb` 以上，標 `leak-suspected`，狀態 `retained-after-gc`。這是 GC 收不回來的部分。
- 沒有大 GC：斜率 × 轉數大於 `leakMb`，而且最後 `leakTailSpins` 轉的斜率高於 `heap.tailSlopeMb`，標 `leak-suspected`，狀態 `no-major-gc`。大 GC 可能還會收回，所以只是疑似，要多轉或用 heap snapshot 確認。

有強制 GC 點時（`evidence.gc` 裡的 `after-warmup` 和 `end`，各在一次 heap snapshot 之後量），上面的切段都不用：兩次 GC 後地板的差大於 `leakMb` 就標 `leak-suspected`，狀態 `retained-after-gc`。

轉數不夠就寫 `not-enough-spins`，不要當成沒有洩漏。

## panel-heavier

`history-before`、`history-after` 或 `rules` 的穩態，相對 `idle`：FPS 下降超過 10，或 draw call 平均增加超過三成，或尖峰窗出現 `hitchMs` 以上的幀。證據寫明減掉待機之後的差。

報告把 `history-before` 和 `history-after` 收成一列 `panel-history`，寫出較重的那一次和另一次的 draw call。那一頁的快照若有超過 `labelNoCacheActive` 個沒開快取的系統字，改法寫這個，不再另列 `cocos-label-no-cache`。

## gpu-fill

待機或 spin 的 GPU timer p95 大於 `gpuHeavyP95Ms`，而且 CPU p95 小於 `gpuLightP95Ms`。只列一列，用較忙的那個階段。若遊戲規則或下注紀錄的 draw call 比它高過五成、GPU p95 卻不到一半，改法寫出那個對照：時間在被蓋住的轉輪，不在面板。GPU timer 不可用時不觸發。各階段的 `gpu-heavy` 仍留在 findings，不各佔一列。

## network-blocked

`resources.status` 是 `ok` 時才看。同一個 host 的請求數達到 `network.hostRequests`，而且排隊（`requestStart` 減去連線完成）達到 80 ms 的請求數達到 `network.queuedToFire`。路徑不含 query。沒有 resource timing 時不觸發。

## network-duplicate

同一個路徑（不含 query）出現至少 `network.duplicate` 次。

## network-json-unmerged

`resources.load` 存在時才看。game-ready 之前、路徑含 `/import/` 的 JSON 請求數達到 `network.importJson`。Cocos 預設每個資源一個 import JSON；Asset Bundle 的壓縮類型設成「合併所有 JSON」時，同一個 bundle 只剩少數幾個檔。150 個以上為橘色。

## network-many-images

`resources.load` 存在時才看。game-ready 之前的圖片請求數達到 `network.loadImages`。300 張以上為橘色。

## context-flags

`conditions.context.antialias` 或 `preserveDrawingBuffer` 為 true。`alpha` 單獨成立不觸發。

## canvas-large

畫布像素數 `canvas.w * canvas.h` 大於 `canvasPixels`（1920×1080）。

## shader-stall

單次 `compileShader`、`linkProgram`，或之後第一次查狀態的 `getShaderParameter`、`getProgramParameter` 達到 `hitchMs`。Chrome 在背景編譯，等待通常落在查狀態那一次。探針沒掛到呼叫時是 `none`，不觸發。

## audio-decode

`decodeAudioData` 解出來的 PCM 達到 `audioMb`，或單次解碼達到 `hitchMs` 而且 PCM 至少 4 MB。沒有解碼時是 `none`，不觸發。

## render-target

`memory.gpu.renderbufferMb` 大於 `renderbufferMb`。這是頁面自己建的 renderbuffer，不含預設畫面緩衝。

## panel-left-open

`idle-after-rules` 的 draw call 平均比 `idle` 高過三成，或 heap 地板比打開面板前高過 `leakMb`。

## Cocos 規則

讀 `evidence.cocos.snapshots`。同一個數字取所有快照的最大值，標題寫出最大值在哪一次快照（`at`）；報告「貼圖與場景」那一列是最後一次快照，並註明。主控台取最後一次（它是累計的）。門檻在 `thresholds.json` 的 `cocos`。這些規則由 `report/analyze.js` 判斷，和其他問題一起列在報告的「要處理的地方」。

建議文字依 `engine` 分三條線：2.0–2.3、2.4、3.x。貼圖壓縮與 WebGL 的做法在這三條線不一樣，不能寫成同一句。能定位的就附上：最大幾張貼圖的檔名（不含 query）、即時 Spine 依 skeletonData 分組的數量、Label 與 Mask 的前幾個節點路徑。

| id | 條件 | 影響 |
| --- | --- | --- |
| `cocos-spine-realtime` | 畫面上的 realtime Spine 多於 `spineRealtimeActive`。若已觸發 `cocos-spine-retained` 就不再列這條 | CPU：每幀都在算骨骼 |
| `cocos-spine-retained` | 最後一次快照比待機多出 `spineCopiesRetained` 個即時 Spine，或骨頭多出 `spineBonesRetained` | 面板關掉後符號骨架還留在場景裡 |
| `cocos-spine-hidden` | 某次快照裡 active、沒暫停的 realtime Spine，自己或父節點透明度 0、顏色 alpha 0 或縮放 0，個數達到 `spineHiddenRealtime`。依去掉數字的節點路徑加 skeletonData 分組 | CPU：畫不出來仍每幀算骨骼 |
| `cocos-spine-unused` | 最後一次快照裡，整輪每次取樣（探針每 500 ms 走一次場景）都沒能畫出來的 Spine 達到 `spineUnused`。只陳述這輪的現況，不推論用不到；改不改由工程師決定 | 記憶體與載入：建好沒用的骨架 |
| `cocos-mask-stencil` | 畫面上的 `IMAGE_STENCIL` 達到 `imageStencil`。個數沒超過 `masksActive` 也要列，因為類型本身比矩形遮罩貴 | draw call 與填色 |
| `cocos-extra-camera` | 同時在畫的相機多於 `camerasActive`。快照沒有這個欄位時不觸發 | 每台相機多清一次畫面 |
| `cocos-render-texture` | RenderTexture 合計達到 `renderTextureMb`。快照沒有這個欄位時不觸發 | GPU 記憶體與填色 |
| `cocos-spine-cache-warning` | 主控台有 Spine 快取模式不支援的呼叫（例如 `clearTrack`） | 動畫狀態會錯，也是無效呼叫 |
| `cocos-texture-uncompressed` | 貼圖超過 `uncompressedMinMb`，而且未壓縮的比例超過 `uncompressedShare` | 記憶體 |
| `cocos-texture-npot` | 邊長不是 2 的冪的比例超過 `npotShare`。同一輪已經列了未壓縮貼圖時，這句併進那一列，不單獨佔一列 | 只有 PVRTC 和 mipmap 才需要 POT。ETC、ASTC 不用，把圖墊成 POT 會更佔記憶體 |
| `cocos-label-no-cache` | 畫面上 cacheMode 為 NONE 的 TTF 或系統字 Label 多於 `labelNoCacheActive`。BMFont 本來就跟圖集合批，cacheMode 對它無效，不算。舊探針分不出 BMFont 時算全部，標題註明可能高估 | draw call 與 CPU：每個 Label 自己一張貼圖 |
| `cocos-mask-many` | 畫面上的 Mask 多於 `masksActive` | draw call：每個 Mask 要寫 stencil，前後打斷合批，矩形 Mask 也一樣 |
| `cocos-particles-many` | 畫面上粒子上限加總超過 `particlesMax` | CPU 與填色 |
| `cocos-nodes-many` | 場景節點多於 `nodesTotal` | CPU 與記憶體：隱藏的節點也還在 |
| `cocos-image-cache-kept` | `CLEANUP_IMAGE_CACHE` 為 false，而且動態合圖也是關的。動態合圖開著時這不是一個該撥的開關，不列 | 上傳後原圖還留在 JS。動態合圖開著時不能同時把 CLEANUP_IMAGE_CACHE 設成 true |
| `cocos-dynamic-atlas-off` | 動態合圖關閉 | draw call |
| `cocos-webgl1` | 瀏覽器有 WebGL 2，遊戲卻用 WebGL 1，而且引擎是 3.x。2.x 沒有這個開關，不列 | 3.x 用 WebGL 1 時檢查設定是否被關掉 |
| `cocos-frame-rate` | 上限不能整除螢幕更新率（橘）、高出螢幕更新率 5% 以上（黃）、或低於 60 但能整除（黃）。高出 5% 以內（60 讀成 61、40 讀成 41）是計時浮動，不列 | 說明 FPS 為什麼到不了 60 或節奏不齊；本身不計分 |
| `cocos-console-errors` | 主控台有引擎 error，或同一句 warning 超過 `consoleRepeat` 次 | 穩定性：資源或流程有錯 |

讀不到的欄位是 `null`，該規則不觸發。

## loading-stall

`loading` 或 `enter` 階段有 `hitch-main-thread`，或 CPU% 高於 80 且平均 FPS 低於 30。`boot` 只有文件與腳本，幀數很少時不單獨觸發。`splash` 是等人按開始的時間，不觸發這條。
