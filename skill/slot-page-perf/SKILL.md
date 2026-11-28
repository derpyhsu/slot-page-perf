---
name: slot-page-perf
description: Anchor HTML5 slot performance from the page, including loading, idle, up to 40 spins, bet history, and game rules. Use when the user asks to 定錨效能, measure a slot URL, or compare FPS, CPU, GPU, texture memory, JS heap, or leaks. Prefer Chrome DevTools MCP.
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
   Then get an empty cache and a throttled network. The repo's MCP configs start Chrome with `--isolated`, a temporary profile whose cache is empty each time the MCP server starts; if this server already loaded the same game, ask the user to restart it first. If an `http` game fails with `ERR_BLOCKED_BY_CLIENT`, the server is missing the `--disable-features` argument from those configs; ask the user to add it and restart. When the server runs without `--isolated`: on an `https` game, `new_page` with `url: "about:blank"` and `isolatedContext` set to the run's `<utc>`; a new context starts with no cache. Isolated contexts refuse plain `http` pages, so on an `http` game stay on a normal page and use the reload in step 4. On the page you use, `emulate` with `networkConditions: "Fast 4G"` and nothing else: no CPU throttling. Do every later step on this page.
2. `navigate_page` to a path on the game's origin that does not exist, for example `http://host/__slot-perf.txt`, so no game file is cached before the run. A plain 404 is what you want; if that path shows the game or a styled page, use `http://host/favicon.ico` instead. The report checks the cache anyway: if most loading requests came from cache, load times are shown but not scored.
3. `evaluate_script` with `sourcePath` = absolute path of `probe/dist/stash.js`. It saves the probe in that origin's sessionStorage.
4. `navigate_page` to the game URL with `initScript` = the loader and `timeout: 120000`; under Fast 4G a slot takes far longer than the default 10 seconds. Without an isolated context, follow it at once with `navigate_page` `type: "reload"`, `ignoreCache: true`, the same `initScript` and timeout; that reload is the one measured. Skip the reload for URLs that only load once (some session tokens); load times then show but are not scored. Then `evaluate_script` `() => [typeof __slotPerf, typeof window.cc]`. Keep the second value for step 5. If the first is not `"object"`, the game moved to another origin: navigate again with `initScript` = the contents of `probe/dist/bundle.js`.
5. Only when step 4 showed `typeof window.cc` is not `"object"` (not Cocos, so the run has no engine CPU): `evaluate_script` `() => __slotPerf.auto.start()` as usual. The trace is the CPU number for these games (`cpuTracePct`). Record a window of about ten spins, not the whole run: a whole-run trace of about ten minutes timed out in the MCP and was lost. The window runs between two `needs: "gc"` stops (step 6): at the first one, take the heap snapshot, delete it, then `performance_start_trace` on this page with `reload: false` and `autoStop: false`, then `auto.resume()`. Cocos games skip the trace: the engine gives CPU, and tracing slows the frames.
6. Loop on `evaluate_script` `async () => __slotPerf.auto.wait(100000)`. It returns a short status as soon as the driver needs you, finishes, or 100 seconds pass:
   When anything stalls, take a screenshot first and decide from the picture: a `needs`, a `phase: "stuck"`, a status that has not changed for about 30 seconds, a click that did nothing, a call that returns far later than it should. Then try the cheapest thing that could work (another press, `resume()`, a real click, `ready()`) before reading code or logs. Dig into the cause only after two tries changed nothing, and say so to the user.
   Every `needs` reply starts with a fresh screenshot. Points are screenshot pixels of the whole page; the probe converts them when the game sits in an iframe. Never point at bet, auto, copy, or lobby controls; the probe refuses them anyway. Buy is pointed at only in the map, and pressed only by the driver.
   - `needs: "map"`: find on the screenshot the spin button, the menu, bet history, game rules, turbo, and the buy free game or feature buy button. `guess` lists what node names suggest, as screenshot points; use them only when they sit on the right thing. Read the on-screen bet and the balance. If the balance covers the planned spins, call `__slotPerf.auto.map({ spin: {x, y}, menu, history, rules, turbo, buy })` immediately. Do not ask the user, and do not change the bet. Stop and show the screenshot only when the bet or balance cannot be read, or the balance is short. Pass null for anything not on the main screen (history and rules are often inside the menu). With a menu point, a history or rules point that has no button under it on the main screen is refused once; pass null and give it at `needs: "menu"`, or send the same point again if it really is on the main screen.
   - A map sent before its stop (for example while loading) is kept for that stop; the reply says `kept`, and whatever the driver is waiting on now still needs its own answer.
   - `needs: "backend"`: a WebSocket closed or failed after the game was ready. Screenshot. If the game shows a disconnect, a reconnect loop or an error, stop and do not save the run; tell the user it was the backend. If it reconnected and plays on, `__slotPerf.auto.resume()`.
   - `needs: "menu"`: the menu is open. `__slotPerf.auto.map({ history, rules, close })`, where close shuts the menu.
   - `needs: "buy"`: the driver pressed buy. Read the price and the balance on the screenshot. If the balance covers the price and the screen is a plain confirm, `__slotPerf.auto.click(x, y, "confirm")` on its confirm button. Take the default price and feature; do not change the bet. `__slotPerf.auto.resume()` if the feature is already playing. If the balance is short or the screen asks for choices or a top-up, close it and call `__slotPerf.auto.skip()`. Buy only on test accounts.
   - `needs: "gc"`: `take_heapsnapshot` with `filePath` in your scratchpad, never in `runs/` (the snapshot holds session strings), delete the file, then `__slotPerf.auto.resume()`. No screenshot needed.
   - `needs: "close"`: a panel or menu is open. `__slotPerf.auto.click(x, y, "close")` on its ✕ or back button, or `__slotPerf.auto.resume()` if the game screen is already clear.
   - `needs: "screen"`: read `note`.
     - Entry: decide what to press using the 進遊戲 rules in scenarios.md, then `__slotPerf.auto.click(x, y, "label")`; `__slotPerf.auto.ready()` if the game with its spin button is already up.
     - "saw no change" after a panel button: `__slotPerf.auto.opened()` if the panel is on screen, otherwise `__slotPerf.auto.resume()`.
     - "has run Ns": `__slotPerf.auto.resume()` if a free game or win is playing; if the screen is a store or anything other than a spin, `__slotPerf.auto.click(x, y, "close")` and tell the user.
     - "turbo was pressed again": `__slotPerf.auto.click()` on turbo if it still shows on, otherwise `__slotPerf.auto.resume()`.
     - If nothing is safe to press, stop and show the user the screenshot.
   - `needs: "error"` or `phase: "stuck"`: stop and report `note`.
   - After `phase: "idle"`, check that `channels.engineCpu` is true. If `frameLoop` is `raf`, CPU is unavailable for the run.
7. When the trace is running and the next `needs: "gc"` stop comes (about ten spins later), or `phase` is `done`: `evaluate_script` `() => __slotPerf.traceEnd()` (it marks where the window ends), then `performance_stop_trace` with `filePath` = a scratchpad path such as `<scratchpad>/<utc>/trace.json`. Do this before that stop's heap snapshot, so the snapshot is not in the window. Then `node report/cpu-trace.js <that file> runs/<utc>-<slug>`. It writes `cpu-trace.json`: busy % per stage and for the window, with no URLs. The raw trace holds the game's URLs and session tokens, so it never goes into `runs/`. Then, when `phase` is `done`, `evaluate_script` `() => __slotPerf.auto.result()` with `filePath` = `runs/<utc>-<slug>/raw.json`. Do not return it inline. If `runs/` is outside the MCP roots, save to the scratchpad and pass `--raw` in step 8.
8. `node report/build.js runs/<utc>-<slug>`. It writes evidence, findings, scores and `report.html`, and prints a digest of about 20 lines. If `cpu-trace.json` is there, the digest has a `cpu trace` line and the stage table shows `忙 N%`.
9. From the digest, write `runs/<utc>-<slug>/notes.json` (below), then run step 8 again. Open `report.html`. `report.md` and `timeline.svg` are the GitHub copy of the same run. Do not make a Cursor canvas.
10. Close the test browser. Once the report is built, `close_page` on every tab this run opened (the game page, the lobby page the game was launched from, any page made for the run), and check with `list_pages` that nothing from the run is left. Never close a tab the user opened. Then tell the user the run is done and the browser was closed. If a run is stopped early, do this too.

Take screenshots only when the driver asks or the user wants to see something. Each one costs far more than a status reply.

## notes.json

The only thing the agent writes. Keep it short.

- `displayName`: the Chinese title on screen.
- `summary.smooth` and `summary.memory`: one sentence each, under 20 characters. Say what is good and what is bad. No severity words.
- `issues`: at most 5. Each has `title` (what the player meets, with one number), `stage` or `t`, `level` (`red`, `orange`, `yellow`, `green`), and `next` (one sentence on what to look at or change). Optional `area` is the table's 類別 (`CPU`, `記憶體`, `draw call`, `穩定性`, `卡頓`, `FPS`); it defaults to the stage name. Do not write 嚴重, 明顯, or 要注意. The color carries that.
- The generator already writes 要處理的地方 rows from findings (stalls, FPS, memory budget, leak, heavy panels) and Cocos rules. Their ids are in the digest's `todo` line. Do not restate them. If you know more than the generic row (for example what the stall coincides with), set `rule` to its id and your row replaces it.
- `issues` can be empty. Use it for what only you saw: a screenshot, a popup, a stuck screen.
- `missing`: what was not measured, in plain words.
- `network`: the preset set in step 1, for example `"Fast 4G"`. Leave it out if the run was not throttled; load times are then shown but not scored.

Do not hand-write findings, scores, or the report. If something important is missing, put it in `issues` or fix the generator.

## Creator preview

Local iteration uses the Creator preview, not a fresh package for every small edit. After script changes, do not ask the user to refresh the editor. Read `<project>/temp/agent-refresh.json` and `POST http://127.0.0.1:<port>/refresh`, then measure. The package is the global Creator 2.x plugin `agent-refresh`. Never refresh `db://assets` itself. See `.cursor/rules/creator-preview-refresh.mdc`.

## Not a Cocos game

`typeof cc` is `"undefined"` (or `channels.frameLoop` stays `raf`) when the engine is something else, for example a WebGL canvas with HTML controls on top. The run still gives loading, frame pacing, GPU timer, JS heap and GPU memory. It has no engine CPU, no scene snapshot and no Cocos rules (`coverage.engine` says so), and `slot-perf-drill` does not apply. Its CPU is the main-thread busy % from the Chrome trace in step 5 and 7 (`cpuTracePct` per stage, `channels.cpuTrace` for the whole run). That is not the engine's per-frame CPU, so the CPU 餘裕 score stays unscored there. The driver notices after 15 seconds with no `window.cc` and stops at `needs: "screen"` instead of waiting out the clock. To keep the same flow:

1. Before `auto.start()`, give it two small functions that read the page: `__slotPerf.auto.adapter({ loaded: () => bool, ready: () => bool })`. `loaded()` is true once the game has everything and waits for a press or is playable. Prefer a request that only returns at the end (a launch call in `performance.getEntriesByType("resource")`) over "the network went quiet": loaders pause between batches and fool that. `ready()` is true while the spin point can be pressed, for example the element at the spin point is the spin control and no `disabled` class is set on the panel. One `evaluate_script` that lists `elementFromPoint` and its ancestors' classes at each control is enough to write them; do not go deeper than that.
2. At the entry stop, screenshot. Loading bar still up: `auto.resume()`. Waiting for a press: `auto.entered(text)` just before it, press, then `auto.resume()`; `auto.ready()` if the game is already up. Try `auto.click(x, y)` first: it sends pointer and mouse events to the element under the point, which works for HTML controls. If the page ignores page events (a press on the canvas itself), press with real browser input: `click` on the canvas uid presses its center, which is where "click to continue" usually is. Keys are not presses; do not spin with a key.
3. Map and menu stops are unchanged: the points come from the screenshot. An HTML menu often closes by itself after a few seconds, so answer the `menu` stop at once with every point you need (`history`, `rules`, `close`).
4. Spin timing comes from `ready()`. Draw calls do not mark a spin on these games. If spins land in `notStarted`, `ready()` is wrong: fix it before going on.
5. A popup that waits for a press during a spin (free-game intro, win summary) shows up as a spin that runs long; the driver asks at `needs: "screen"`. Screenshot, press, `resume()`. Do not wait it out.

## Rules that still apply

- Pointer events only. The autopilot dispatches them at the points you give. Never call an internal spin handler.
- Never write the URL query string or a session token anywhere. `report/build.js` scrubs URLs, but do not rely on it.
- If `conditions.gpu` is a software renderer, the FPS numbers describe this computer, not a phone GPU. The report says so.

## Without the autopilot

When a game defeats the autopilot, drive it by hand with the same probe: `__slotPerf.mark(name)` opens a stage, `__slotPerf.entry(thresholds.entry)` and `__slotPerf.buttons(words)` find what to press, `__slotPerf.cocos(label)` takes a scene snapshot, and `__slotPerf.summary()` returns everything. Follow scenarios.md step by step, then save `{ summary, cocos: { snapshots }, entry, coverage }` as `raw.json` and continue from step 8.
