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

### 長幀歸因

每次 hitch 另外看那一幀量到的工作（探針 `hitches[].work`），以及時間重疊的 Long Animation Frame（`timeline.loafs`）。只有一項量到的工作佔該次 `dt` 一半以上，而且說得出具體對象，才寫原因（finding 的 `cause`）；否則不寫，原始數字留在 evidence。原因只陳述量到的事和該從哪裡查，不判斷要不要改。

依序判斷：

- `loading-burst`：這一幀收完 2 個以上下載，且資源解析（`cc.deserialize`、`JSON.parse`）加貼圖上傳的時間過半。寫同時下載數、收完的檔名、解析與上傳各多久，最大一張貼圖 1 MB 以上就寫尺寸與檔名。
- `label`：Label 排版與繪字（各版本都收在 assembler 的 `updateRenderData`：2.4 的 onEnable 和 RenderFlow、3.x 的 `updateRenderData`）時間過半。這段時間包在元件和繪製時間裡，所以排在 `component`、`render`、`texture-upload` 前面。寫次數和時間，再依去掉數字的節點路徑分組列前三組：個數、時間、字型種類（系統字、TTF、BMFont）與名稱、字級、`cacheMode`、`overflow`、最長字數、自動換行、描邊或陰影。不記 Label 的文字內容。
- `texture-upload`：`texImage2D` 等上傳時間過半。寫張數、MB、最大一張的尺寸與檔名（圖片來源有網址才有）。
- `deserialize`：資源解析時間過半。
- `shader-compile`：shader 編譯與連結時間過半。
- `instantiate`：`cc.instantiate` 時間過半；來源名稱可讀才寫名稱。
- `spine-build`：Spine 骨架資料第一次解析（`SkeletonData.getRuntimeData` 從 JSON 或二進位建出執行用資料）時間過半。它包在 instantiate 和 onLoad 裡，所以排在它們前面。寫份數、時間、最慢那份的名稱。
- `component`：單一元件類別的 `update`、`lateUpdate`、`onLoad`、`start`、`onEnable` 時間過半，類別名可讀（不是一兩個字母、不是 uuid）。巢狀呼叫只算最外層。元件計時每幀額外成本超過 0.3 ms 就自動關掉（`componentTiming.status` 為 `off-overhead`）。
- `render`：引擎繪製時間扣掉上傳和 shader 後仍過半，而且有 draw call 數。
- `layout`：重疊的 LoAF 樣式與版面時間過半。
- `script`：重疊的 LoAF 裡最長的腳本過半，檔案不是引擎檔，也不是引擎每幀的 rAF 回呼。函式名可讀才寫函式名；呼叫來源（事件、回呼、Promise、腳本載入）一併寫。
- 下面三項是「容器」：裡面的工作上面各項可能已經量到。上面沒有一項過半時才當原因；有的話，過半的容器寫在原因的 `inside`，報告接在原因後面（「發生在…裡」），由外到內。
  - `activate`：`director._nodeActivator.activateNode`（`node.active` 切換、節點加到啟用中的父節點下，連同整棵子樹的 onEnable、onDisable）時間過半。只算最外層。寫啟用、停用各幾次，同一幀內同一個節點切回去的次數（關了又開、開了又關），最慢一次的節點路徑。
  - `handler`：編輯器綁定的回呼（`Component.EventHandler.prototype.emit`，按鈕 clickEvents 等）時間過半，名稱可讀。名稱是編輯器裡填的元件名加方法名；`customEventData` 不讀。
  - `websocket`：WebSocket 訊息處理（`onmessage` 和 `addEventListener("message")`）時間過半。寫則數、時間、最慢一則的大小；訊息內容不讀不存。

`activate`、`handler` 跟元件計時一起受 0.3 ms 上限管；`websocket` 一直量。

系統字或 TTF Label 的貼圖上傳（來源是 canvas）佔該次 `dt` 四分之一以上、而原因不是 `texture-upload` 時，finding 的 `canvas` 寫上傳次數、MB、時間，以及依節點路徑分組的前三組，報告接在改法後面（「其中系統字貼圖上傳…」）。canvas 依它屬於哪個 Label 對回節點；Label 排版途中上傳的 canvas 也算那個 Label。

原因不是 `label`、但 Label 時間佔該次 `dt` 四分之一以上時，finding 的 `labels` 寫同樣的明細，報告接在改法後面（「其中 Label 更新…」）。Label 計時跟元件計時一起受 0.3 ms 上限管，關掉就不量。

不歸因：GC、非同步音訊解碼、量不到 `work` 的舊探針。`source` 是 `longtask` 而且和某個幀 hitch 時間重疊時，視為同一次停頓，只留幀那筆。

`channels.engineCpu` 為 false 時，所有 CPU 平均、p95、CPU% 都是 `unavailable`，`cpu-heavy` 不觸發。

## 幀節奏

引擎主迴圈不一定跟著螢幕更新跑：Creator 2.x 的上限不是 30 或 60 時改用 setTimeout，所以主迴圈的間隔不是畫面真正換幀的間隔。探針另有一條每個 vsync 跑一次的 rAF，量出螢幕更新間隔（vsync），並在每次看到新的引擎幀時記一次「上螢幕的幀」，間隔以 vsync 的整數倍記錄（`stages[].presented`）。

- 應有幀長 E：vsync 與 `1000 / cc.game 幀率上限` 較長者。
- 壞幀：上螢幕間隔超過 `frames.badFactor` × E。60 上限在 60 Hz 時，33 ms 是壞幀；40 上限時 E 是 25 ms，33 ms 不是壞幀。
- 節奏不齊：上螢幕間隔離 E 超過 `frames.paceTolerance` × E。40 上限在 60 Hz 會 16.7、33.3 ms 交替，幾乎每一幀都不齊。
- 下面的 FPS、1% low、掉幀、壞幀都用上螢幕的幀；舊探針沒有這組資料時，退回引擎幀與 33 ms。
- 每 250 ms 的 bucket 也記上螢幕的幀數（`presentedFrames`），計分的「平均 FPS」用它算每一秒的 FPS。

## fps-drop

遊戲階段（待機、spin、加速、面板穩態）與載入（`loading`、`enter`），同類階段合在一起看。載入跟遊戲階段用同一套門檻和顏色。下面任一條成立就觸發，證據寫三個數字：

- 平均 FPS 低於 `fps.stageMin` × 應有 FPS / 60
- 掉幀比例 `dropShare` 高於 `fps.dropShareMax`。掉幀是「應該出現卻沒出現」的幀占比，應有 FPS 是 1000 / E。所以 64 Hz 螢幕配 60 上限的正常跳幀不算掉幀，40 上限跑滿 40 也不算。
- 壞幀佔比 `badShare` 高於 `fps.badShareMax`
- 1% low 低於 `fps.lowMin` × 應有 FPS / 60。1% low 是最慢那 1% 幀的 FPS；幀長只會落在螢幕更新的整數倍，所以它常在 60 和 30 之間跳，只當輔助。

`stageMin` 和 `lowMin` 是照 60 的目標寫的，所以依上限換算。上限本身低於 60，已經反映在計分的「平均 FPS」，並由 `cocos-frame-rate` 說明原因，不在這裡再算一次。

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

有強制 GC 點時（`evidence.gc` 裡的 `after-warmup`、`mid`、`end`，各在一次 heap snapshot 之後量），上面的切段都不用：

- 三個點都有：分成前半（`after-warmup` 到 `mid`）和後半（`mid` 到 `end`），各算每轉增加多少，取較小的那一半乘上暖機後的轉數，當作兩半都有的增長。大於 `leakMb` 才標 `leak-suspected`，狀態 `retained-after-gc`。只有一半增加、但總共多了 `leakMb` 以上時，標 `heap-step`（一次性的增加，例如第一次出現的畫面或特效載入後留著），不封頂。
- 只有 `after-warmup` 和 `end`（舊探針）：兩次 GC 後地板的差大於 `leakMb` 就標 `leak-suspected`，狀態 `retained-after-gc`。

`mid` 落在暖機後剩下轉數的一半（15 轉時是第 10 轉後）。兩半各不到 2 轉時不拍 `mid`。

## heap-step

三個強制 GC 點裡只有一半在增加，暖機後總共多了 `leakMb` 以上。寫三個地板和兩半各多少，不說是洩漏。要看多出來的是什麼，用 slot-perf-drill 的 heap 工具。

轉數不夠就寫 `not-enough-spins`，不要當成沒有洩漏。

### 節點數

autopilot 在 `idle` 之後、面板關掉之後（`after-rules`），以及每次強制 GC 之後（`after-warmup`、`mid`、`end`）各做一次 census（`evidence.census`），都在 gap 裡做，不算進量測：

- 場景節點依去掉數字的節點路徑分組計數（含不顯示的節點），最多 1000 組。
- `cc.instantiate` 做出來的節點用 WeakRef 記著，GC 後還活著的依來源名稱（prefab 名）分成：在場景裡、不在場景也沒 destroy、已 destroy。用 `new cc.Node` 建的節點看不到。

`nodeGrowth` 是 `after-warmup` 到 `end` 之間多出 `census.minNodes` 個以上的組，前五名，附每轉多幾個。`leak-suspected` 那一列和記憶體表的「節點」列照實寫出來。放在 `cc.NodePool` 裡的節點（探針從 put、get、size、clear 認得池子，再讀它的 `_pool`）另外算「在 cc.NodePool 裡」，不算進「不在場景也沒 destroy」；遊戲自己用陣列做的池子認不出來，所以這兩類都只寫數字，不說是洩漏。有中段普查（`mid`）時寫三個數字，後半沒再增加就註明「後半沒再增加」，也不寫每轉增加多少。

`panel-left-open` 那一列另外寫 `idle` 到 `after-rules` 之間多出的組（`panelNodes`），附顯示中的個數。

## fill-layers

普查（`census[].invisible.coverage`）把每個在畫的節點在畫面內、遮罩框內的面積加起來，換算成幾個螢幕：2.x 即時 Spine 依每個有畫的 slot 的三角形面積算（標出加色混合），快取模式與 3.x 的 Spine 不算面積，只計個數；其他節點用自己的內容框。待機、看完規則後、轉完後這三次普查裡最多的那次達到 `coverage.screens` 就列，`coverage.orange` 以上橘色。寫總層數、幾乎蓋滿畫面的節點數、加色層數，以及依節點路徑前三層分組的前四組。只陳述，不計分。轉動中的畫面在 slot-perf-drill 用 `coverage` 量。

## panel-cover

開著面板的穩態量完、關面板前的間隔，探針找最後畫的、蓋住畫面九成以上的節點，記下它的不透明度（透明度與顏色 alpha 相乘）和在它之前畫了幾個節點（待機時也記一次）。紀錄、規則頁這個節點跟待機時不同、底下有 `panelCover.minUnder` 個以上的節點時列一列：不透明度低於 99% 寫「底圖半透明，底下照畫也看得到」，否則寫「底下被蓋住仍在畫」。只陳述，改不改是畫面設計的取捨。

## label-redraw

同一段裡，同一個系統字或 TTF Label 文字沒變卻又上傳了一次貼圖（探針對每次上傳時的文字算雜湊比對，不存文字）。整段合計達到 `labelRedraw.minSame` 次或 `labelRedraw.minMb` MB 才列。報告只列一列，寫最多的那段和前三段，各段依節點路徑分組，附上傳發生在啟用時（onEnable，節點啟用途中）、繪製時，還是元件的程式裡。

## 停頓表

報告把每一次停頓依時間列出：時間、段、長度、原因的簡稱（同上面的歸因，外層容器括號附上），以及系統字貼圖佔的比例。「算進頻率」是卡頓頻率那一項數了幾次：載入、開始畫面不算；和畫面停頓重疊的 long task 也被數了一次，寫 2。另外列出比同一串 spin 中位數長 3 倍（`longSpinFactor`）以上的轉：秒數、FPS、1% low、最多 draw call、停頓次數。只陳述，不判斷那一轉是什麼。

## worse-from-spin

某一轉起變差、之後每一轉都沒回來。看三個量：每轉 draw call 的中位數、每轉轉完時顯示中的節點數（autopilot 在間隔記的 `spinNodes`）、每轉 FPS。一般 spin 和加速 spin 各算一串，每串第一轉不算（第一次載入）。

從第 k 轉切開，前面至少 `worseFrom.minBefore` 轉、後面至少 `minAfter` 轉。draw call 與節點：後面每一轉都比前面每一轉多，最少的那轉比最多的那轉多超過 `abs` 和前面最多值 × `rel` 兩者較大的那個；FPS：後面最高的比前面最低的低超過 `abs`。有多個切點時取差距最大的。同一串、同一轉起的幾個量合成一列，寫前後兩段的極值與中位數。只陳述現況，不計分。

這條抓的是台階，以及每轉漲幅都大於門檻的上升。每轉只多一點的緩慢上升不會列，節點看 `nodeGrowth`、記憶體看增長項。第 1 轉就出現、之後一直在的（例如第一轉後停在畫面外的池子節點）也不會列，那類看 `cocos-invisible-drawn`。

## draws-rise

一般 spin 每轉最高 draw call 有起伏地越來越多。最後 `drawsRise.last` 轉的平均 ÷ 第 `first` 轉（2–4）的平均大於 `ratio`，而且多出 `minAbs` 以上才列；至少要 `minSpins` 轉。比平常長 `longSpinFactor` 倍以上的轉（購買或自然觸發的免費遊戲、大獎）不算進前後兩段，但序列照列。寫前後兩段平均、倍數，和每轉最高 draw call 的序列。只陳述現況，不計分；扣分項在轉動時的平均 FPS、CPU 餘裕下面也會寫一句爬升。

## batch-breaks

轉動中取樣幾幀（每轉最多 12 幀、間隔至少 0.5 秒，只在上一幀 draw call 接近這一轉最高值時），在那一幀裡讓引擎自己的合批器記：每開一個新的 draw call，記給讓它換手的那個繪製元件（2.x 看 ModelBatcher 的 flush 與 RenderComponent 的批次檢查，3.x 看 Batcher2D 的合批與 commit）。連續同材質、同貼圖才合得起來；沒有東西可畫的元件不送資料，也不會被記。依節點路徑（去數字）與元件類別分組，另記前後元件的類別（同一個元件自己換貼圖記成「內部」）。計數只掛在那一幀，畫完立刻拿掉、元件參照當場丟掉。記到的次數和引擎那一幀的 draw call 差太多時標成不完整，不採用。取 draw call 最多的那一幀，達 `batchBreaks.minDraws` 才列。只陳述現況，不計分；轉動時的平均 FPS、CPU 餘裕下面寫一句換手最多的類別，路徑只放在可優化項目與 leads。

## pool-residue

cc.NodePool 裡的節點底下有 sp.Skeleton，所有 track 都是不循環、已播完的動畫，骨架上還有可畫的附件（slot 有 attachment，骨架、slot、附件的 alpha 相乘大於 0）。每次 census（暖機後、中間、轉完後）各記一次，依池內節點路徑（去數字）分組。轉完後達 `poolResidue.min` 個才列。快取模式的 Spine 與讀不到 track 或繪製順序的（3.x 的 Spine 在 wasm 裡）分開算，不當成沒有殘留；全部讀不到時是 `unavailable`。只陳述現況，不計分；同一輪有 draws-rise 時兩列互相提到。

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
| `cocos-invisible-drawn` | 間隔時的節點普查（`census[].invisible`）裡，畫面外與縮放 0 的繪製節點合計達到 `invisibleNodes`，或 2.x realtime Spine 裡 alpha 0 的附件達到 `spineTransparent`，或沒有東西可畫的骨架達到 `spineEmpty`。取合計最多的那次普查，寫各類個數、透明附件約佔幾屏、依去掉數字的節點路徑分組的前三組。畫面外只看節點自己的內容框（不含子節點）是否整個落在它的相機視野外；在視野內、但整個落在上層遮罩（`cc.Mask`，反向遮罩除外）的框外，另算「遮罩框外」；透明度 0 的子樹引擎本來就跳過，不算；看不見的 Spine 骨骼另見 `cocos-spine-hidden`。不計分 | draw call 與填色：看不見仍組頂點、送 draw call、打斷合批 |
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

## loading-progress-stop

探針在 `game-ready` 之前每 0.5 秒讀一次載入畫面上的百分比（`progress`），並記下 `game-ready` 之前每個請求的起訖時間、大小和路徑（`resources.files`，不含 query；檔名是 uuid 時對回引擎裡已載入資源的名稱或 bundle 路徑）。百分比停住 `loadProgress.stopMs` 以上（最後一次變化到能轉也算）就列，最長的一段寫：停在幾 %、幾秒、這段收完幾個檔案和 MB、正在下載最久的五個檔案與起訖秒數。跨網域的 CDN 沒給 `Timing-Allow-Origin` 時拿不到大小，寫「大小不明」，時間照樣有。

## image-bloated

圖檔大小除以像素數超過 4 bytes（比沒壓縮還大）而且超過 200 KB，表示檔案裡夾了圖以外的東西，常見是編輯軟體寫入的中繼資料。只在拿得到檔案大小時（本機或同網域的打包）由探針判斷；拿不到大小時用 slot-perf-drill 的 `images` 在頁面上重新讀檔檢查。

## loading-stall

`loading` 或 `enter` 階段有 `hitch-main-thread`，或 CPU% 高於 80 且平均 FPS 低於 30。`boot` 只有文件與腳本，幀數很少時不單獨觸發。`splash` 是等人按開始的時間，不觸發這條。
