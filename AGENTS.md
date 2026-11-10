# slot-page-perf

This repo anchors performance of an HTML5 slot from the page. The game source is not required. A run is one game URL.

Before measuring, read `skill/slot-page-perf/SKILL.md`, then `protocol/scenarios.md` and `protocol/thresholds.json`.

## Boundaries

- Install the probe before navigation so loading is recorded. `node probe/build.js` bundles it; the skill shows how to load it without pasting it.
- Spend as few tokens as possible. Let `__slotPerf.auto` drive the page, poll its short status, and save results with `evaluate_script` `filePath`. Do not pull raw summaries or screenshots into the conversation unless needed.
- Prefer the Chrome DevTools MCP server named `chrome-devtools`.
- Drive the canvas with pointer events. Do not call game-internal spin handlers.
- Do not change the bet. Read the on-screen bet and balance. Continue when the balance covers the planned spins. Stop and tell the user only when the bet or balance cannot be read, or the balance is short.
- History and rules opens are not spins. The spin cap is `maxSpins` in `protocol/thresholds.json`.
- Never write URL query strings or session tokens into `runs/` or the report.
- A finding must match a rule in `protocol/rules.md`. Missing probes stay `unavailable`.
- CPU% is main-thread busy time divided by wall time for that stage. It is not OS CPU usage.
- GPU% is GPU timer time divided by `frameBudgetMs`. Without the timer extension, GPU% is `unavailable`.

## Output

Save `__slotPerf.auto.result()` as `runs/<utc>-<slug>/raw.json`, write the short `notes.json`, and run `node report/build.js runs/<utc>-<slug>`. It writes `evidence.json` per `probe/schema.json`, applies `protocol/rules.md` and `protocol/scoring.md`, and generates `report.html`. That page is the report: stage zoom on the timeline, and the readings up top. `report.md` plus `timeline.svg` is only the GitHub copy. Do not hand-write findings, scores, or the report, and do not make a Cursor canvas.
