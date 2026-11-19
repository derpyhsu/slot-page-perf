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
- Save results with `evaluate_script` `filePath` under `runs/<the run>/drill/`. Read only `summary` lines into the conversation. Never write URL query strings or session tokens.
- Heap snapshots go to your scratchpad, never `runs/`, and are deleted after: they hold session strings.

## Load

On the game page, once it shows the state the finding is about (idle, a panel open, after spins):

1. `evaluate_script` with `sourcePath` = absolute path of `drill/page.js`. It returns `"drill ok"` and leaves `window.__slotDrill` (`engine`, `counter`, `method`). It does not need the slot-page-perf probe.
2. Get the game into the state to measure with pointer events, as slot-page-perf does. Do not call game-internal handlers.

## Which tool

| Finding or symptom | Tool |
| --- | --- |
| Many draw calls: `stall`/`fps` rows with high draw calls, `panel-heavier`, `panel-left-open` (draw call), `cocos-mask-*`, `cocos-label-no-cache`, `cocos-dynamic-atlas-off` | `drawcalls` |
| `leak-suspected` where `nodeGrowth` shows no group growing (the heap grows, the node count does not) | `heap` |
| Low FPS while engine CPU per frame is low | fill rate |

### drawcalls

`evaluate_script`: `async () => (await __slotDrill.drawcalls({ frames: 8 })).summary`, then `() => __slotDrill.last` with `filePath` `runs/<run>/drill/drawcalls-<state>.json`.

- It hides each child group of the scene for a few frames and reads the engine's draw call count (2.x `cc.renderer.drawCalls`, 3.x `device.numDrawCalls`, else WebGL calls). Siblings with the same name apart from digits (`card_1`..`card_30`) are one group. It goes down into the group that cut the most, up to `depth` levels (default 4), and stops when no group cuts `minShare` (default 5%) of the frame.
- 2.x hides with `opacity = 0`, which runs no game code. 3.x still draws opacity 0, so it uses `active = false`, which runs `onDisable`/`onEnable`; say so when you report a 3.x result.
- In the group it ended on, it walks draw order and lists where a new batch starts: different texture (with both file names), different material, a label without cache that has its own texture, a mask, Graphics, Spine without batching. 2.x compares what `RenderComponent._checkBacth` compares (material hash and culling mask); 3.x is approximated by material and texture. A Spine counts as one break here; slots on several textures or blend modes add more inside it, which only the measured draw call cut shows.
- `offscreenDrawn` lists groups whose world box is outside the visible area yet still cost draw calls. Spine and empty containers often have no box; they are left out, not claimed.
- `baseAfter` is the count after all values were put back. A large gap from `base` means the screen was animating; measure again.
- Options: `root` (a `cc.find` path to start from), `depth`, `frames`, `minShare`, `budgetMs` (default 90 s; on timeout the result is partial).
- `__slotDrill.batchBreaks("Canvas/path")` lists batch breaks of one subtree without hiding anything.

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
