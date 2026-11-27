# drawcalls

Part of [slot-perf-drill](../SKILL.md); its Rules apply.

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
