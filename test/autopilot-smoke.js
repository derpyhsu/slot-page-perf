// Drives probe/autopilot.js against a stub probe, up to the stops this test checks.
// No browser and no Cocos: the stub answers what the driver asks of window.__slotPerf.
"use strict";

const fs = require("fs");
const path = require("path");
const assert = require("assert");

const src = fs.readFileSync(path.join(__dirname, "..", "probe", "autopilot.js"), "utf8");

global.window = global;
global.document = { elementFromPoint: () => null, getElementsByTagName: () => [], querySelector: () => null };

function btn(name, x, y) {
  return { kind: "button", name, text: "", point: { x, y }, interactable: true };
}

// One fresh driver. buttons: what the engine can name on the main screen.
function load(buttons, live, quiet, entry) {
  const P = {
    quiet: quiet || (() => ({ badMs: 99999, longMs: 99999, uploadMs: 99999 })),
    entry: () => ({ spinReady: true, spin: buttons.filter((b) => /spin/i.test(b.name)), start: [], dismiss: [], dom: [], texts: [] }),
    buttons: () => ({ buttons: buttons }),
    live: () => Object.assign({ draws: 10, activeNodes: 100, heapMb: 50, stage: "idle", fps: 60 }, live && live()),
    summary: () => ({ channels: {} }),
    mark: () => {},
    cocos: () => ({}),
    census: () => ({ total: 100 })
  };
  window.__slotPerf = P;
  window.__slotPerfThresholds = {
    idleSeconds: 0.05,
    maxSpins: 15,
    neverPress: ["buy", "bet"],
    buttons: { menu: ["menu"], history: ["history"], rules: ["rules"], turbo: ["turbo"], buy: ["buy"], bet: ["bet"] },
    entry: entry || {}
  };
  new Function(src)();
  return P.auto;
}

async function until(auto, pred, ms) {
  const end = Date.now() + (ms || 3000);
  while (Date.now() < end) {
    const s = auto.status();
    if (pred(s)) return s;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error("timed out at " + JSON.stringify(auto.status()));
}

const spin = btn("btn_spin", 500, 600);
const menu = btn("btn_menu", 900, 100);
const hist = btn("btn_history", 700, 100);

async function mapCase() {
  // E. With a menu, a history point that has no button under it is refused once.
  let auto = load([spin, menu]);
  auto.start();
  await until(auto, (s) => s.needs === "map");
  auto.map({ spin: spin.point, menu: menu.point, history: { x: 850, y: 300 }, rules: null });
  let s = await until(auto, (x) => x.needs === "map");
  assert.ok(/refused history/.test(s.note) && /needs "menu"/.test(s.note), "in-menu history point refused: " + s.note);
  // The same point again (within 10 px) is taken as a main-screen button the engine cannot name.
  auto.map({ spin: spin.point, menu: menu.point, history: { x: 852, y: 304 }, rules: null });
  s = await until(auto, (x) => x.phase !== "map");
  assert.strictEqual(s.phase, "panels", "resent point accepted");

  // A point on a named main-screen history button is fine at once.
  auto = load([spin, menu, hist]);
  auto.start();
  await until(auto, (x) => x.needs === "map");
  auto.map({ spin: spin.point, menu: menu.point, history: hist.point });
  s = await until(auto, (x) => x.phase !== "map");
  assert.strictEqual(s.phase, "panels", "named history button accepted");

  // No menu: nothing to wait for, the point is taken.
  auto = load([spin]);
  auto.start();
  await until(auto, (x) => x.needs === "map");
  auto.map({ spin: spin.point, history: { x: 850, y: 300 } });
  s = await until(auto, (x) => x.phase !== "map");
  assert.strictEqual(s.phase, "panels", "no menu, point accepted");
}

async function settleCase() {
  // R9. Large uploads still going: the first stage waits, up to the cap, and says why.
  let auto = load([spin], null, () => ({ badMs: 99999, longMs: 99999, uploadMs: 0 }), { settleQuietMs: 300, settleMaxSeconds: 0.6 });
  auto.start();
  await until(auto, (s) => s.needs === "map");
  const r1 = auto.result().settle;
  assert.ok(r1 && r1.timedOut && r1.ms >= 550 && r1.still.join() === "texture uploads", "settle waits up to the cap and names what was still busy: " + JSON.stringify(r1));
  // Quiet once uploads stop: it ends as soon as everything has been quiet long enough.
  const t0 = Date.now();
  auto = load([spin], null, () => ({ badMs: 99999, longMs: 99999, uploadMs: Date.now() - t0 - 200 }), { settleQuietMs: 300, settleMaxSeconds: 5 });
  auto.start();
  await until(auto, (s) => s.needs === "map");
  const r2 = auto.result().settle;
  assert.ok(r2 && !r2.timedOut && r2.ms >= 400 && r2.ms < 1500, "settle ends once quiet: " + JSON.stringify(r2));
}

(async () => {
  await settleCase();
  await mapCase();
  console.log("autopilot smoke ok");
  process.exit(0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
