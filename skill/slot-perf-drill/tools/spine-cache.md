# spineCache

Part of [slot-perf-drill](../SKILL.md); its Rules apply.

`evaluate_script`: `() => __slotDrill.spineCache().summary`, then `() => __slotDrill.last` with `filePath` `runs/<run>/drill/spine-cache-<state>.json`.

- Spine in SHARED_CACHE or PRIVATE_CACHE mode keeps every frame of every animation it has played until the skeleton data is released. Per skeleton data and animation: frames kept, about how many MB (typed arrays exactly, small object arrays estimated), and how many components in the scene use realtime, shared and private mode.
- Run it after the animations in question have played (after spins, after a free game). Components outside the scene are not walked; a shared cache is still counted when any shared component is in the scene.
- It answers which skeleton and which animation hold the cache. Whether an animation that plays rarely should be REALTIME instead is the engineer's call.
