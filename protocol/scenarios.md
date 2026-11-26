# 情境順序

門檻數字以 `protocol/thresholds.json` 為準。探針在開網址之前注入。

## 量測條件

- 每一輪都從空快取開始，量到的是第一次進遊戲：https 遊戲開一個全新的瀏覽器 context；http 遊戲（隔離 context 會擋）先開一次，再用忽略快取的重新整理量測。
- 網路一律限速 Fast 4G，整輪都開著。CPU 不限速。
- 存探針時開的同源頁面用一個不存在的路徑，不要先載入遊戲本身的檔案。報告會檢查：game-ready 前的請求大多來自快取時，載入時間只顯示、不計分。
- notes.json 寫上 `network`，報告靠它和空快取判斷載入時間能不能計分。

## 階段

1. `boot`：網址開始到第一個 WebGL 幀。探針自動切。
2. `loading`：第一個幀到 agent 呼叫 `mark("game-ready")`。spin 鈕可按時才打這個 mark。引擎主迴圈掛上之前，主執行緒時間只靠 long task。中間要按開始或關公告時，照下面「進遊戲」切成 `splash` 和 `enter`。
3. `settle`（進遊戲後穩定期）：`game-ready` 之後先等，直到掉幀（超過幀率上限應有幀長 1.5 倍）、long task、256 KB 以上的貼圖上傳都停了 `entry.settleQuietMs`，最多等 `entry.settleMaxSeconds`。剛進遊戲時瀏覽器常還在上傳貼圖、做一次性的初始化；不等的話，載入越快的遊戲越會把這段算進待機。等了多久、有沒有等滿上限寫進結果的 `settle`。
4. `idle`：`mark("idle")` 後等待 `idleSeconds`。這是後面所有差值的基準。
5. 截一張遊戲畫面，標出 spin、功能列表、下注紀錄、遊戲規則、加速的位置，有購買免費遊戲（Feature Buy）鈕時也標出來（見下面「按鈕位置」）。同時讀畫面上的押注和餘額。餘額夠這一次的 spin 就繼續，不改押注，也不問使用者。讀不到押注或餘額，或餘額不夠，才停下來說明。
6. `history-before`：打開下注紀錄。先記 `panelSpikeSeconds` 的尖峰，再記 `panelSteadySeconds` 的穩態，然後關閉。功能列表只負責打開，不單獨成結論。
7. `rules`：打開遊戲規則，同樣先尖峰再穩態，然後關閉。關閉後再量一段短待機，記進 `idle-after-rules`。
8. 一般 spin `normalSpins` 次。每一次 `mark("spin-N")` 開始，停穩後結束。轉動中仍可按的 spin 鍵：標完座標後先看 2 秒 spin 鍵底下顯示中的子節點（待機時的樣子）；按下後只要它顯示的子節點組合是待機時沒出現過的（例如換成停止字樣），就算忙碌，回到待機時的樣子才算停。同一個樣子持續 `settle.sigGiveUpMs` 而按鍵本身可按，就當成新的待機樣子。從按下到停穩，spin 鍵沒變忙、畫面文字和 draw call 也都沒變，就是這一下沒轉起來（例如被中獎線輪播吃掉）：不補按，記在 `notStarted`，報告把那一段當 gap、不算進 spin，並寫在「這次沒量到」。
遊戲準備好之後，遊戲有接的 WebSocket 一旦斷線或出錯，autopilot 在下一個間隔（每轉之前、轉後紀錄之前）以 `needs: "backend"` 停下：畫面顯示斷線、重連或錯誤時就停，不存這一輪；重連後照常玩才 `auto.resume()`。最多問兩次，之後只記錄。報告在「這次沒量到」寫第一次斷線在哪一段、code 幾號。只記 code 和段落，不記網址。

9. 有加速鈕時，接著 `turboSpins` 次，mark 名為 `turbo-N`。加速 spin 轉動中再按一次 spin 點（急停），玩家常這樣縮短轉動；只在連續兩次看到 spin 鍵忙碌時才按，不會變成多轉一次，認不出 spin 節點時不按。`turboQuickStop: false` 可關掉。沒有加速鈕就繼續一般 spin，直到 `maxSpins`。
10. `history-after`：轉完後再打開一次下注紀錄，量法與第 6 步相同。
11. `idle-end`：最後待機 `idleSeconds`。
12. `feature`：畫面上有購買免費遊戲或 Feature Buy 鈕時才做，沒有就在 `coverage.feature` 寫 `no buy button`，這一項不適用。見下面「購買免費遊戲」。

一般 spin 中出現的 Feature 或大獎只在該轉的 mark 上記 `tags`，不另外加轉。買 Feature 只在第 11 步做一次。

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
2. 還沒載入滿：`quietMs` 小於 `entry.quietMs`，或候選清單跟上一秒不同，就繼續等。候選要連續 `entry.stablePolls` 次一樣才算穩。進度條還在跑時不按：畫面上有「45 %」這類字時等它（最多 30 秒）；沒有百分比的遊戲看網路，`netQuietMs`（最後一個請求完成到現在）小於 `entry.netQuietMs` 就繼續等。網路一直忙的遊戲（例如定時向伺服器查詢）最多等 `entry.netWaitSeconds` 秒。
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

## 購買免費遊戲

不是每款遊戲都有免費遊戲或 Feature，有購買鈕的才量。量的是玩家花錢買下去之後，整段免費遊戲順不順，和玩完回到主遊戲後有沒有留下記憶體。

- 等畫面靜下來，記下主遊戲的畫面特徵，按 map 時標的購買鈕。
- 探針停下來請 agent 截圖（`needs: "buy"`）。agent 讀價格和餘額：餘額夠就按確認，不改價格、押注或購買的種類，用預設那一個。餘額不夠、或畫面不是單純的購買確認（要選很多選項、要儲值），就關掉畫面略過，`coverage.feature` 寫 `skipped by agent`。購買會扣餘額，只在測試帳號上跑。
- 按確認後 `feature.startSeconds` 內 spin 點變成不能按、或畫面被蓋住，才算開始；確認最多問 `feature.confirmSteps` 次，還是沒開始寫 `buy did not start`。
- 開始到回到主遊戲記成 `feature`：spin 點可按、沒有東西蓋住，而且連續 `feature.backMs` 都這樣才算回來。最長 `feature.maxSeconds`，超過寫 `did not return to the base game`。
- 中間停在「點擊繼續」之類的畫面：字不動 `feature.nudgeStillMs` 後，探針先按一次開始或確定類的字（`entry` 字表）；`feature.askStillMs` 還是不動才問 agent，最多三次。
- 回來後強制 GC 一次（`after-feature`），再待機 `feature.idleSeconds`，記進 `idle-after-feature`。前後的等待都記成 `gap`。

## 按鈕位置

每款遊戲的節點命名都不一樣，所以按哪裡由截圖決定，不靠名字。

- 進遊戲後，agent 看一張截圖，給出 spin、功能列表、下注紀錄、遊戲規則、加速的座標；沒有的給 null。`thresholds.json` 的 `buttons` 字表只用來猜候選，讓 agent 對照。
- 下注紀錄或規則在功能列表裡時，第一次打開功能列表再截一張，標出它們和關閉功能列表的位置。
- 面板打開、量完穩態之後，才截圖找關閉鈕，這樣思考時間不會算進面板。同一個面板第二次打開時沿用同一個位置。
- 按任何座標之前，探針檢查那裡的節點。名字或短字串對得上 `neverPress`（購買、押注、複製、自動、大廳等）就拒絕，請 agent 重給。這是唯一用名字判斷的規則。
- 購買鈕是例外：只在第 11 步按，位置由 agent 在 map 時標出，而且那裡的節點要對得上 `buttons.buy`，對不上就拒絕。
- 遊戲在 iframe 裡時，探針會把截圖座標換成 iframe 裡的座標。

找不到某個面板就在 `coverage` 寫 `not on screen`，不拿待機數字充當該面板。

## 停穩

同時成立才算這一轉結束：至少過了 500 ms，而且 spin 位置上的鈕可按，加上下面任一條：這一轉中它曾經不能按、draw call 回到待機附近、或畫面文字與 draw call 都靜止了 `settle.quietMs`（預設 4 秒）。下一次點擊要等這個條件。沒有停止鈕時，可以讀轉輪節點的狀態回到待機。

停穩當下就 `mark("gap")`，把等待和讀 summary 的時間切出去。`gap` 不寫進 `spins`，也不進報告。不然一轉的紀錄會含幾十秒的等待，平均值會被待機稀釋。

## Cocos 快照

`window.__slotPerf.cocos(label)` 會走一次目前的場景，讀節點、Spine、Label、Mask、粒子、貼圖格式、引擎設定和主控台警告。它不在每一幀跑，只在這幾個時間點各呼叫一次，結果依序放進 `evidence.cocos.snapshots`：

1. 待機量完
2. 遊戲規則穩態
3. 轉完後的下注紀錄穩態
4. 關掉面板後的最後待機

## 量測前的檢查

`mark("idle")` 後幾秒讀一次 summary。`channels.engineCpu` 要是 true，`frameLoop` 要是 `tick`（Creator 3.x）或 `mainLoop`（Creator 2.x）。如果是 `raf`，代表探針沒掛上引擎迴圈，CPU 全部是未讀到。在 `coverage` 寫明，不要把 0 當成很輕。
