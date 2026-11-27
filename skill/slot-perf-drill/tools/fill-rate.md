# fill rate

Part of [slot-perf-drill](../SKILL.md); its Rules apply.

When FPS is low but engine CPU per frame is low:

1. `evaluate_script`: `() => __slotDrill.fps(4000)`.
2. `resize_page` to half the width and half the height (a quarter of the pixels), wait two seconds, `__slotDrill.fps(4000)` again.
3. Put the page size back.

If FPS comes back at a quarter of the pixels, the frame is bound by how many pixels are drawn (fill rate), not by CPU. Under software rendering (no GPU, as on the shared measuring machine) fill cost is much higher than on a phone; say so with the result.
