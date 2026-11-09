# slot-page-perf

This repo anchors performance of an HTML5 slot from the page. The game source is not required. A run is one game URL.

Before measuring, read `skill/slot-page-perf/SKILL.md`, then `protocol/scenarios.md`, `protocol/rules.md`, and `protocol/thresholds.json`.

## Boundaries

- Install `probe/install.js` before navigation so loading is recorded.
- Prefer the Chrome DevTools MCP server named `chrome-devtools`.
- Drive the canvas with pointer events. Do not call game-internal spin handlers.
- Do not change the bet. Before 50 spins, show the current bet and wait for confirmation.
- History and rules opens are not spins. The spin cap is `maxSpins` in `protocol/thresholds.json`.
- Never write URL query strings or session tokens into `runs/` or the report.
- A finding must match a rule in `protocol/rules.md`. Missing probes stay `unavailable`.
- CPU% is main-thread busy time divided by wall time for that stage. It is not OS CPU usage.
- GPU% is GPU timer time divided by `frameBudgetMs`. Without the timer extension, GPU% is `unavailable`.

## Output

Write `runs/<utc>-<slug>/evidence.json` using `probe/schema.json`. Fill `report/template.md` from that file. In Cursor, also copy `report/template.canvas.tsx` into the workspace `canvases/` directory and replace its `EVIDENCE` object.
