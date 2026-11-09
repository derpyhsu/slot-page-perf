---
name: slot-page-perf
description: Anchor HTML5 slot performance from the page, including loading, idle, up to 30 spins, bet history, and game rules. Use when the user asks to 定錨效能, measure a slot URL, or compare FPS, CPU, GPU, texture memory, JS heap, or leaks. Prefer Chrome DevTools MCP.
---

# slot-page-perf

Measure one slot URL and write evidence. Do not modify the game.

## Read first

- [protocol/scenarios.md](../../protocol/scenarios.md)
- [protocol/thresholds.json](../../protocol/thresholds.json)

[protocol/rules.md](../../protocol/rules.md) and [protocol/scoring.md](../../protocol/scoring.md) are applied by the scripts. Read them only to explain a result.

## Run it with the autopilot

The page drives itself. The agent starts it, answers when it asks, and saves the result to a file. Raw numbers never pass through the conversation. This keeps a full run to roughly a dozen tool calls.

Use the `chrome-devtools` MCP. If it is not connected, stop and point at the README.

1. `node probe/build.js`. It writes `probe/dist/stash.js` and prints the one-line loader.
2. `navigate_page` to the game's origin, for example `http://host/`. Any page there works, even a 404.
3. `evaluate_script` with `sourcePath` = absolute path of `probe/dist/stash.js`. It saves the probe in that origin's sessionStorage.
4. `navigate_page` to the game URL with `initScript` = the loader. Then `evaluate_script` `() => typeof __slotPerf`. If it is not `"object"`, the game moved to another origin: navigate again with `initScript` = the contents of `probe/dist/bundle.js`.
5. `evaluate_script` `() => __slotPerf.auto.start()`.
6. Loop on `evaluate_script` `async () => __slotPerf.auto.wait(100000)`. It returns a short status as soon as the driver needs you, finishes, or 100 seconds pass:
   - `needs: "bet"`: show the user `bet` (and a screenshot if `bet` is empty or unclear). Do not spin, and do not change the bet, until they confirm. Then `__slotPerf.auto.go()`.
   - `needs: "screen"`: take a screenshot, decide what to press using the 進遊戲 rules in scenarios.md, then `__slotPerf.auto.click(x, y, "label")`. If nothing is safe to press, stop and show the user the screenshot.
   - `needs: "error"` or `phase: "stuck"`: stop and report `note`.
   - After `phase: "idle"`, check that `channels.engineCpu` is true. If `frameLoop` is `raf`, CPU is unavailable for the run.
7. When `phase` is `done`, `evaluate_script` `() => __slotPerf.auto.result()` with `filePath` = `runs/<utc>-<slug>/raw.json`. Do not return it inline.
8. `node report/build.js runs/<utc>-<slug>`. It writes evidence, findings, scores and `report.html`, and prints a digest of about 20 lines.
9. From the digest, write `runs/<utc>-<slug>/notes.json` (below), then run step 8 again. Open `report.html`. `report.md` and `timeline.svg` are the GitHub copy of the same run. Do not make a Cursor canvas.

Take screenshots only when the driver asks or the user wants to see something. Each one costs far more than a status reply.

## notes.json

The only thing the agent writes. Keep it short.

- `displayName`: the Chinese title on screen.
- `summary.smooth` and `summary.memory`: one sentence each, under 20 characters. Say what is good and what is bad. No severity words.
- `issues`: at most 5. Each has `title` (what the player meets, with one number), `stage` or `t`, `level` (`red`, `orange`, `yellow`, `green`), and `next` (one sentence on what to look at or change). Optional `area` is the table's 類別 (`CPU`, `記憶體`, `draw call`, `穩定性`, `卡頓`, `FPS`); it defaults to the stage name. Do not write 嚴重, 明顯, or 要注意. The color carries that.
- The generator already writes 要處理的地方 rows from findings (stalls, FPS, memory budget, leak, heavy panels) and Cocos rules. Their ids are in the digest's `todo` line. Do not restate them. If you know more than the generic row (for example what the stall coincides with), set `rule` to its id and your row replaces it.
- `issues` can be empty. Use it for what only you saw: a screenshot, a popup, a stuck screen.
- `missing`: what was not measured, in plain words.

Do not hand-write findings, scores, or the report. If something important is missing, put it in `issues` or fix the generator.

## Rules that still apply

- Pointer events only. The autopilot dispatches them on the canvas at the node's position. Never call an internal spin handler.
- Never write the URL query string or a session token anywhere. `report/build.js` scrubs URLs, but do not rely on it.
- If `conditions.gpu` is a software renderer, the FPS numbers describe this computer, not a phone GPU. The report says so.

## Without the autopilot

When a game defeats the autopilot, drive it by hand with the same probe: `__slotPerf.mark(name)` opens a stage, `__slotPerf.entry(thresholds.entry)` and `__slotPerf.buttons(words)` find what to press, `__slotPerf.cocos(label)` takes a scene snapshot, and `__slotPerf.summary()` returns everything. Follow scenarios.md step by step, then save `{ summary, cocos: { snapshots }, entry, coverage }` as `raw.json` and continue from step 8.
