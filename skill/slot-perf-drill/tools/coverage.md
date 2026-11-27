# coverage

Part of [slot-perf-drill](../SKILL.md); its Rules apply.

`evaluate_script`: `async () => (await __slotDrill.coverage({ seconds: 3 })).summary` while the page is in the slow state (press spin first to sample a spin), then `() => __slotDrill.last` with `filePath` `runs/<run>/drill/coverage-<state>.json`.

- Samples the slot-page-perf probe's coverage walk every 250 ms: the area each drawn node fills inside its camera view and any ancestor mask, in screens, grouped by the first three levels of the node path (digits as `*`). 2.x realtime Spine is measured per drawn slot (additive blend noted); cached and 3.x Spine are counted as not measured. Needs the probe on the page; it is there after a measuring run.
- `__slotDrill.fps(4000, { hide: ["Canvas/BG/bg_spine"] })` measures FPS as is and with those subtrees hidden, then puts them back: what one layer costs right now. Same hiding as `drawcalls` (2.x opacity 0, 3.x active false).
