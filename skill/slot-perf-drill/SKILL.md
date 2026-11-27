---
name: slot-perf-drill
description: Dig into one finding of a slot-page-perf run on a live Cocos game page - which subtree draws the most and where batches break, what grows in the JS heap and who holds it, and whether low FPS is fill rate. Use after a slot-page-perf run when the user asks to 往下查, 下鑽, 排查 or explain a finding (draw calls, panel heavier, leak, low FPS). Not for measuring a URL; that is slot-page-perf.
---

# slot-perf-drill

Small tools an agent combines to explain one finding of a [slot-page-perf](../slot-page-perf/SKILL.md) run. Each tool answers one question in one call and saves its result to a file. Pick tools from the table below; there is no fixed flow.

## Rules

- Cocos only (2.x and 3.x). Engine-level facts only: node paths, components, asset file names, counts. No company framework names, no game semantics.
- The page tools change the live page only while they measure (they hide subtrees) and put every value back. They never edit game files. If a result says `restore.ok: false`, tell the user which nodes and reload the page before trusting anything else.
- State what was measured and where to look. Whether to change it is the engineer's call.
- Keep the page visible. A minimized or hidden page draws no frames; the tools then return `status: "partial"` or "no frames drawn".
- This is for troubleshooting after the report, not part of measuring. Its numbers are never added to the report.
- Save results with `evaluate_script` `filePath` under `runs/<the run>/drill/` as `<tool>-<state>.json`. Read only `summary` lines into the conversation. Never write URL query strings or session tokens.
- Heap snapshots go to your scratchpad, never `runs/`, and are deleted after: they hold session strings.

## Load

On the game page, once it shows the state the finding is about (idle, a panel open, after spins):

1. `evaluate_script` with `sourcePath` = absolute path of `drill/page.js`. It returns `"drill ok"` and leaves `window.__slotDrill` (`engine`, `counter`, `method`). It does not need the slot-page-perf probe.
2. Get the game into the state to measure with pointer events, as slot-page-perf does. Do not call game-internal handlers. On a page where a slot-page-perf run has just finished, `__slotPerf.auto.goto("history" | "rules" | "idle")` does it with the run's points, then `__slotPerf.auto.wait(60000)` until `phase` is `drill:<state>`; it never presses spin or buy.

## Which tool

Start from the report's first screen: 扣最多分的地方 lists the three items that cost the most points, the stage each comes from, and the tool below that answers it. Drill the first one before the others.

| Finding or symptom | Tool |
| --- | --- |
| Many draw calls: `stall`/`fps` rows with high draw calls, `panel-heavier`, `panel-left-open` (draw call), `cocos-mask-*`, `cocos-label-no-cache`, `cocos-dynamic-atlas-off` | `drawcalls` |
| `leak-suspected` or `heap-step` where `nodeGrowth` shows no group growing (the heap grows, the node count does not) | `spineCache` first when the scene has Spine in a cache mode, then `heap` |
| Low FPS while engine CPU per frame is low, `fill-layers` | `coverage` (in the state that is slow, for example while the reels spin), then `fps` with `hide` on the biggest subtree; fill rate to confirm |
| `loading-progress-stop`, `image-bloated`, slow loading with large picture files | `images` |

By symptom, in the order to check them:

| Symptom in the report | What to do |
| --- | --- |
| A stage loses FPS while its engine CPU p95 is low (idle often) | fill rate. If FPS comes back at a quarter of the pixels, `drawcalls` on that state lists the big subtrees and `offscreenDrawn`; hide them one by one by hand (2.x `opacity = 0`) and read `__slotDrill.fps(4000)` each time. |
| A stage has high engine CPU p95 | `drawcalls` on that state: draw calls per subtree, where batches break, and groups drawn off screen. A subtree whose box is much larger than the screen is a long list or something parked outside. |
| Long frames of 50 ms or more while the main loop takes 1-2 ms | Read the stall row's cause first: `websocket`, `activate` and `handler` (and `inside` on other causes) say whether the time went to a WebSocket message handler, node activation (with same-frame switch-backs) or an editor-wired callback. None of the page tools measures this further. |
| `worse-from-spin`: a level that steps at one spin and stays | What was added is still there after the spins. `drawcalls` on the screen after the run shows which subtree draws it; if `nodeGrowth` names a growing group, start there. A one-off animation left on its last transparent frame shows up as a group that costs draw calls with nothing visible. |
| `cocos-invisible-drawn` | `drawcalls` on the state the census was taken in (its `offscreenDrawn` and the cut per group confirm what the census counted); `batchBreaks` on a subtree with empty skeletons shows the break they cause. |
| Win effects or cascades that cost only while they play | Measure while they play: run `drawcalls` during the effect. `moving: true` means cuts within `noise` may be the animation itself. |

### drawcalls

`evaluate_script`: `async () => (await __slotDrill.drawcalls({ frames: 8 })).summary`, then `() => __slotDrill.last` with `filePath` `runs/<run>/drill/drawcalls-<state>.json`.

- It hides each child group of the scene for a few frames and reads the engine's draw call count (2.x `cc.renderer.drawCalls`, 3.x `device.numDrawCalls`, else WebGL calls). Siblings with the same name apart from digits (`card_1`..`card_30`) are one group. It goes down into the group that cut the most, up to `depth` levels (default 4), and stops when no group cuts `minShare` (default 5%) of the frame.
- 2.x hides with `opacity = 0`, which runs no game code. 3.x still draws opacity 0, so it uses `active = false`, which runs `onDisable`/`onEnable`; say so when you report a 3.x result.
- Each group is compared with the count measured right before it was hidden, so slow animation does not pile into one group. `moving: true` (with `baseRange` and `noise`) means the count moved by more than a few calls while measuring; cuts within `noise` may be animation, and the tool does not go down into them. The summary says so; no need to re-run by hand.
- In the group it ended on, it walks draw order and lists where a new batch starts: different texture (with both names), different material, a label without cache that has its own texture, a mask, Graphics, Spine without batching. 2.x compares what `RenderComponent._checkBacth` compares (material hash and culling mask); 3.x is approximated by material and texture. A Spine counts as one break here; slots on several textures or blend modes add more inside it, which only the measured draw call cut shows.
- Texture names: the file when the texture has one; `動態合圖#n（frame，原圖 file）` for a 2.4 dynamic atlas page, with the sprite frame and the file it was packed from; `文字貼圖#n` for a label's own canvas; `Spine <skeleton data>` for Spine. The same `#n` is the same texture.
- `offscreenDrawn` lists groups whose world box is outside the visible area yet still cost draw calls. Spine and empty containers often have no box; they are left out, not claimed.
- `baseAfter` is the count after all values were put back. A large gap from `base` means the screen was animating; measure again.
- Options: `root` (a `cc.find` path to start from), `depth`, `frames`, `minShare`, `budgetMs` (default 90 s; on timeout the result is partial).
- `__slotDrill.batchBreaks("Canvas/path")` lists batch breaks of one subtree without hiding anything.

### coverage

`evaluate_script`: `async () => (await __slotDrill.coverage({ seconds: 3 })).summary` while the page is in the slow state (press spin first to sample a spin), then `() => __slotDrill.last` with `filePath` `runs/<run>/drill/coverage-<state>.json`.

- Samples the slot-page-perf probe's coverage walk every 250 ms: the area each drawn node fills inside its camera view and any ancestor mask, in screens, grouped by the first three levels of the node path (digits as `*`). 2.x realtime Spine is measured per drawn slot (additive blend noted); cached and 3.x Spine are counted as not measured. Needs the probe on the page; it is there after a measuring run.
- `__slotDrill.fps(4000, { hide: ["Canvas/BG/bg_spine"] })` measures FPS as is and with those subtrees hidden, then puts them back: what one layer costs right now. Same hiding as `drawcalls` (2.x opacity 0, 3.x active false).

### images

`evaluate_script`: `async () => (await __slotDrill.images()).summary`, then `() => __slotDrill.last` with `filePath` `runs/<run>/drill/images.json`.

- Fetches each loaded texture's picture file again (normally from the HTTP cache) and reads its blocks: PNG text, Exif, XMP and private chunks, JPEG APP and comment segments, WebP EXIF and XMP. Lists files carrying `minKb` (default 20) or more that can go without changing a pixel, and files larger than their raw pixels (over 4 bytes a pixel). Colour profiles, JFIF and Exif are kept (Exif may hold the orientation).
- Prints block types, keys and sizes only, never what is inside a block. File names only, no query.
- For a build or project folder instead of a page: `node drill/images.js <folder>` (same parser).

### spineCache

`evaluate_script`: `() => __slotDrill.spineCache().summary`, then `() => __slotDrill.last` with `filePath` `runs/<run>/drill/spine-cache-<state>.json`.

- Spine in SHARED_CACHE or PRIVATE_CACHE mode keeps every frame of every animation it has played until the skeleton data is released. Per skeleton data and animation: frames kept, about how many MB (typed arrays exactly, small object arrays estimated), and how many components in the scene use realtime, shared and private mode.
- Run it after the animations in question have played (after spins, after a free game). Components outside the scene are not walked; a shared cache is still counted when any shared component is in the scene.
- It answers which skeleton and which animation hold the cache. Whether an animation that plays rarely should be REALTIME instead is the engineer's call.

### heap

For a heap that grows while node counts do not:

1. Bring the game to a steady state (for example idle after a few spins). `take_heapsnapshot` with `filePath` `<scratchpad>/a.heapsnapshot` (it also forces a GC).
2. Repeat what the finding is about (more spins, open and close the panel), then `<scratchpad>/b.heapsnapshot`.
3. `node drill/heap.js diff a b` lists classes by growth in size and count.
4. For the class that grew: `node drill/heap.js retainers a b <Class>`; add `bfs` when the objects are Spine runtime objects, to skip Spine internals.
5. `node drill/heap.js pools b` shows memory held only by `cc.NodePool` arrays; `node drill/heap.js spine a b` counts Spine runtime skeletons by holder.
6. Delete both snapshots. Report class names, holders, counts and MB.

Release builds minify class names to one or two letters; report the property names on the chain, which usually survive.

### fill rate

When FPS is low but engine CPU per frame is low:

1. `evaluate_script`: `() => __slotDrill.fps(4000)`.
2. `resize_page` to half the width and half the height (a quarter of the pixels), wait two seconds, `__slotDrill.fps(4000)` again.
3. Put the page size back.

If FPS comes back at a quarter of the pixels, the frame is bound by how many pixels are drawn (fill rate), not by CPU. Under software rendering (no GPU, as on the shared measuring machine) fill cost is much higher than on a phone; say so with the result.

## Report

Per finding, a short table: node path (digits as `*`), component, what was measured, how to measure it again. Add the one line a person can run on the page to see it (for example `cc.find("Canvas/cards").opacity = 0` and read the draw calls). Facts only.
