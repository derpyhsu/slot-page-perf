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

`window.__slotPerf.summary()` is the only measurement source. `window.__slotPerf.mark(name)` opens a stage.

## Buttons

Read engine node names and label strings when `cc` exists. Otherwise use a screenshot and click canvas coordinates. Pointer events only. Never call an internal spin handler.

Confirm the history or rules panel is actually visible before timing it. If a control is missing, record the aliases you tried in `coverage` and leave that stage out.

## Bet

Read the current bet from the screen. Ask the user to confirm it. Do not start the 50 spins, and do not change the bet, until they confirm.

## Evidence

Write `runs/<utc>-<slug>/evidence.json`.

- `urlPath` is the path only. Drop the query string.
- Build `spins` from the spin and turbo stages.
- Apply [protocol/rules.md](../../protocol/rules.md) yourself. The probe does not decide findings.
- A finding needs `id`, `stage`, and the numbers that fired the rule.
- `coverage` lists what did not run, including too few spins.

## Report

Fill [report/template.md](../../report/template.md) from the evidence file. Write the report in Traditional Chinese.

In Cursor, copy [report/template.canvas.tsx](../../report/template.canvas.tsx) into the workspace `canvases/` directory, replace the `EVIDENCE` constant with this run, and set `example` to false. Omit any chart whose stage is absent.
