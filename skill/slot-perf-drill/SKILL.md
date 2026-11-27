---
name: slot-perf-drill
description: Dig into one finding of a slot-page-perf run on a live Cocos game page - which subtree draws the most and where batches break, what grows in the JS heap and who holds it, and whether low FPS is fill rate. Starts from the run's evidence.json leads and reads only the tool files it needs. Use after a slot-page-perf run when the user asks to 往下查, 下鑽, 排查 or explain a finding (draw calls, panel heavier, leak, low FPS). Not for measuring a URL; that is slot-page-perf.
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

Start from the run's `evidence.json`, not the report. The report says, for each deduction, where and why in plain words; `leads` holds the same deductions, largest first, with what the report leaves out. Read only the lead you drill:

- `reach`: the state to get the page into. `loading` needs a reload with the probe; `idle`, `history`, `rules` and `menu` are screens; `spin`, `turbo` and `feature` mean while it plays, so press spin and measure during it.
- `suspects`: `stall` (the work a stall was in, by name, and how many stalls), `label` (a label path whose unchanged text was uploaded again, and how often), `subtree` (a path with its screens of coverage or its node counts), `file`, `image`, `texture`, `made` (an instantiated node group that grew), `batch` (a path and class that started many draw calls on the busiest sampled spin frame).
- `numbers`, and `tool` when the run already knows which tool answers it.

`points` in the same file has the run's map (spin, menu, history, rules) in CSS pixels of the game's frame, the frame's offset on the page, and the viewport. On a page of that size, the map plus `frame` gives page points that press the same buttons; check them on a screenshot first.

For each lead: reach its state, run `tool` or the tool for its suspects below, then confirm in that state with `fps` and `hide` on the suspect's subtree. FPS is capped at the display rate, so a gain shows only where FPS was below it. Tell the user the suspect, the measured difference, and what the report said. Drill the first lead before the others.

| Finding or symptom | Tool |
| --- | --- |
| Many draw calls: `stall`/`fps` rows with high draw calls, `panel-heavier`, `panel-left-open` (draw call), `cocos-mask-*`, `cocos-label-no-cache`, `cocos-dynamic-atlas-off` | `drawcalls` |
| `leak-suspected` or `heap-step` where `nodeGrowth` shows no group growing (the heap grows, the node count does not) | `spineCache` first when the scene has Spine in a cache mode, then `heap` |
| Low FPS while engine CPU per frame is low, `fill-layers` | `coverage` (in the state that is slow, for example while the reels spin), then `fps` with `hide` on the biggest subtree; fill rate to confirm |
| `loading-progress-stop`, `image-bloated`, slow loading with large picture files | `images` |

By suspect kind in a lead:

| Suspect | First look |
| --- | --- |
| `subtree` | `fps` with `hide` on its path in the lead's state; `drawcalls` with it as root for draw calls and batch breaks |
| `label` | `fps` with `hide` on the label's parent while its text changes (during a spin); `drawcalls` for its batch breaks |
| `stall` | The named component, script, label or Spine ran during the stalls; no page tool times it alone. State it with the stall count, and hide its subtree with `fps` where it has one |
| `file`, `image` | `images` |
| `texture` | `images` for its file; its size and format are already in the lead |
| `made` | `heap` retainers for that node name |
| `batch` | `drawcalls` with its parent as `root` during a spin, `batchBreaks` on the subtree; `fps` with `hide` on it while the reels spin |

By symptom, in the order to check them:

| Symptom in the report | What to do |
| --- | --- |
| A stage loses FPS while its engine CPU p95 is low (idle often) | fill rate. If FPS comes back at a quarter of the pixels, `drawcalls` on that state lists the big subtrees and `offscreenDrawn`; hide them one by one by hand (2.x `opacity = 0`) and read `__slotDrill.fps(4000)` each time. |
| A stage has high engine CPU p95 | `drawcalls` on that state: draw calls per subtree, where batches break, and groups drawn off screen. A subtree whose box is much larger than the screen is a long list or something parked outside. |
| Long frames of 50 ms or more while the main loop takes 1-2 ms | Read the stall row's cause first: `websocket`, `activate` and `handler` (and `inside` on other causes) say whether the time went to a WebSocket message handler, node activation (with same-frame switch-backs) or an editor-wired callback. None of the page tools measures this further. |
| `worse-from-spin`: a level that steps at one spin and stays | What was added is still there after the spins. `drawcalls` on the screen after the run shows which subtree draws it; if `nodeGrowth` names a growing group, start there. A one-off animation left on its last transparent frame shows up as a group that costs draw calls with nothing visible. |
| `cocos-invisible-drawn` | `drawcalls` on the state the census was taken in (its `offscreenDrawn` and the cut per group confirm what the census counted); `batchBreaks` on a subtree with empty skeletons shows the break they cause. |
| `draws-rise` or `pool-residue`: draw calls climb over the spins, Spine left in `cc.NodePool` | `drawcalls` after the spins on the subtree the batch-breaks row names; whether clearing the residue each spin brings the draw calls back is a [slot-perf-verify](../slot-perf-verify/SKILL.md) A/B, when the user asks |
| Win effects or cascades that cost only while they play | Measure while they play: run `drawcalls` during the effect. `moving: true` means cuts within `noise` may be the animation itself. |

| Tool | Read before using it |
| --- | --- |
| `drawcalls`, `batchBreaks` | [tools/drawcalls.md](tools/drawcalls.md) |
| `coverage`, `fps` with `hide` | [tools/coverage.md](tools/coverage.md) |
| `images`, `node drill/images.js` | [tools/images.md](tools/images.md) |
| `spineCache` | [tools/spine-cache.md](tools/spine-cache.md) |
| `heap` (snapshots and `drill/heap.js`) | [tools/heap.md](tools/heap.md) |
| fill rate | [tools/fill-rate.md](tools/fill-rate.md) |

Read only the file of the tool you are about to use.

To confirm a cause by changing the game and measuring again (for example clearing Spine left in pools after each spin), use [slot-perf-verify](../slot-perf-verify/SKILL.md). It changes the game state and ends with a reload, so it comes after drilling, when the user asks for it.

## Report

Per finding, a short table: node path (digits as `*`), component, what was measured, how to measure it again. Add the one line a person can run on the page to see it (for example `cc.find("Canvas/cards").opacity = 0` and read the draw calls). Facts only.
