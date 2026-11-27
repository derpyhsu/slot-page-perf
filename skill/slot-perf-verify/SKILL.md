---
name: slot-perf-verify
description: Confirm a cause found by slot-perf-drill by changing the game and measuring again, on a live Cocos game page - an A/B of the same spins with and without the change (first test, clearing Spine left in cc.NodePool after each spin). Use only when the user asks to 驗證, 確認原因 or run an A/B on a slot-page-perf finding. It changes the game state and ends with a reload, so never during measuring or drilling.
---

# slot-perf-verify

The last step after [slot-page-perf](../slot-page-perf/SKILL.md) and [slot-perf-drill](../slot-perf-drill/SKILL.md): change one thing in the running game, play the same number of spins with and without it, and compare. The numbers stay in `runs/<run>/verify/`, never in the report.

## Rules

- Only when the user asks for it. Say what will change, how many spins, and that the page will be reloaded after.
- It spends 2N spins of the current bet (N plain, N with the change). Read the bet and balance on a screenshot; go on only when the balance covers 2N spins. Never change the bet.
- Drive the canvas with pointer events through the autopilot. Do not call game-internal spin handlers.
- Both arms run on a freshly loaded page, the same way: reload, wait for the game, then the spins. Compare the two arms with each other, not with the measuring run.
- The change does not get put back. Reload the page when done, before anything else is measured.
- Facts only: per spin, the highest and median draw calls, FPS and seconds, in both arms. Whether to change the game is the engineer's call.
- Never write URL query strings or session tokens.

## Pool residue A/B (Spine left in cc.NodePool)

For `pool-residue` or `draws-rise` rows: does clearing the finished Spine in the pools after each spin keep the draw calls from climbing?

1. Read `points.map` from `runs/<run>/evidence.json` (the run's spin point, in CSS pixels of the game frame) and pick N (10 is enough to see a climb; at most `verifyMaxSpins`).
2. Load the page with the probe the way slot-page-perf steps 1-4 do (stash, loader, navigate), no throttling needed. Wait until the game shows its spin button (screenshot), then check the bet and balance.
3. Arm A, plain: `evaluate_script` `() => __slotPerf.auto.verify({ spins: N, map: <points.map> })`, then loop `async () => __slotPerf.auto.wait(100000)` until `phase` is `verify-done`, answering `needs` as in slot-page-perf step 6. Save `() => __slotPerf.auto.verifyResult()` with `filePath` `runs/<run>/verify/pool-residue-a.json`.
4. Reload the page the same way (step 2).
5. Arm B, cleared: `evaluate_script` with `sourcePath` = absolute path of `verify/page.js` (returns `"verify ok"`), then `() => __slotPerf.auto.verify({ spins: N, map: <points.map>, after: () => __slotVerify.clearPoolResidue() })`, wait the same way, save to `runs/<run>/verify/pool-residue-b.json`. Each `after` entry says how many skeletons were cleared after that spin.
6. Reload the page.
7. Tell the user, per spin, the highest draw calls in A and in B, and how many skeletons B cleared each spin. If B cleared none, the residue was not there in this session; say so instead of comparing.
