# heap

Part of [slot-perf-drill](../SKILL.md); its Rules apply.

For a heap that grows while node counts do not:

1. Bring the game to a steady state (for example idle after a few spins). `take_heapsnapshot` with `filePath` `<scratchpad>/a.heapsnapshot` (it also forces a GC).
2. Repeat what the finding is about (more spins, open and close the panel), then `<scratchpad>/b.heapsnapshot`.
3. `node drill/heap.js diff a b` lists classes by growth in size and count.
4. For the class that grew: `node drill/heap.js retainers a b <Class>`; add `bfs` when the objects are Spine runtime objects, to skip Spine internals.
5. `node drill/heap.js pools b` shows memory held only by `cc.NodePool` arrays; `node drill/heap.js spine a b` counts Spine runtime skeletons by holder.
6. Delete both snapshots. Report class names, holders, counts and MB.

Release builds minify class names to one or two letters; report the property names on the chain, which usually survive.
