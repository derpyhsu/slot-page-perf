---
name: slot-page-perf
description: Anchor HTML5 slot performance from the page, including loading, idle, up to 50 spins, bet history, and game rules. Use when the user asks to 定錨效能, measure a slot URL, or compare FPS, CPU, GPU, texture memory, JS heap, or leaks. Prefer Chrome DevTools MCP.
---

# slot-page-perf

Measure one slot URL and write evidence. Do not modify the game.

## Read first

- [protocol/scenarios.md](../../protocol/scenarios.md)
- [protocol/rules.md](../../protocol/rules.md)
- [protocol/thresholds.json](../../protocol/thresholds.json)
- [probe/schema.json](../../probe/schema.json)

## Browser

Use the `chrome-devtools` MCP. Pass the full source of [probe/install.js](../../probe/install.js) as the navigation `initScript` before the game URL loads. If that MCP is not connected, stop and point at the README. Do not inject the probe after the game is already playable.

`window.__slotPerf.summary()` is the only measurement source. `window.__slotPerf.mark(name)` opens a stage. `window.__slotPerf.buttons(words)` lists clickable Cocos nodes with their text and page coordinates.

Do not assume how a game gets from loading to the first spin. Some go straight in. Others stop on a start screen, a tap-anywhere screen, or one or more notices, with the button anywhere. Run the 進遊戲 loop in [protocol/scenarios.md](../../protocol/scenarios.md) with `window.__slotPerf.entry(thresholds.entry)` once a second until `spinReady`. If nothing safe can be pressed, stop and report a screenshot instead of guessing.

After `mark("idle")`, check `channels.frameLoop` and `channels.engineCpu` before going further. They must show `tick` or `mainLoop` and true. If they show `raf`, CPU is unavailable for the run.

## Buttons

Read engine node names and label strings when `cc` exists. Otherwise use a screenshot and click canvas coordinates. Pointer events only. Never call an internal spin handler.

Confirm the history or rules panel is actually visible before timing it. If a control is missing, record the aliases you tried in `coverage` and leave that stage out.

## Bet

Read the current bet from the screen. Ask the user to confirm it. Do not start the 50 spins, and do not change the bet, until they confirm.

## Cocos snapshots

Call `window.__slotPerf.cocos(label)` at the points in [protocol/scenarios.md](../../protocol/scenarios.md) and append each result to `evidence.cocos.snapshots`. It walks the live scene, so do not call it every frame.

## Evidence

Write `runs/<utc>-<slug>/evidence.json` from the final `summary()`, including `timeline`.

- `urlPath` is the path only. Drop the query string.
- Build `spins` from the spin and turbo stages.
- Apply [protocol/rules.md](../../protocol/rules.md) yourself. The probe does not decide findings.
- A finding needs `id`, `stage`, and the numbers that fired the rule.
- `coverage` lists what did not run, including too few spins.
- `game.displayName` is the Chinese title on screen.

Then add the three fields the reader sees first. Keep them short.

- `summary.smooth` and `summary.memory`: one sentence each, under 20 characters. Say what is good and what is bad. No severity words.
- `issues`: at most 5. Each has `title` (what the player meets, with one number), `stage` or `t`, `level` (`red`, `orange`, `yellow`, `green`), and `next` (one sentence on what to look at or change). Optional `area` is the table's 類別 (`CPU`, `記憶體`, `draw call`, `穩定性`, `卡頓`); it defaults to the stage name. Do not write 嚴重, 明顯, or 要注意. The color carries that.
- Do not restate a Cocos rule that `analyze.js` already reports. If you have a more specific version of one, set `rule` to its id and your row replaces the generic one.
- `missing`: what was not measured, in plain words.

## Report

```
node report/analyze.js runs/<run>/evidence.json
node report/markdown.js runs/<run>/evidence.json
node report/canvas.js runs/<run>/evidence.json <workspace>/canvases/<slug>.canvas.tsx
```

`analyze.js` writes the two scores from [protocol/scoring.md](../../protocol/scoring.md), the Cocos advice from the Cocos rules, and `todo`, which merges `issues` with the Cocos advice into the one 要處理的地方 table, worst color first. Do not compute scores by hand, and do not edit the generated report to add raw numbers. If something important is missing from the report, put it in `issues` or fix the generator.

The canvas step is for Cursor. Other agents stop after the markdown.
