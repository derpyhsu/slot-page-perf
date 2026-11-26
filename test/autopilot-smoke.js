// Drives probe/autopilot.js against a stub probe, up to the stops this test checks.
// No browser and no Cocos: the stub answers what the driver asks of window.__slotPerf.
"use strict";

const fs = require("fs");
const path = require("path");
const assert = require("assert");

const src = fs.readFileSync(path.join(__dirname, "..", "probe", "autopilot.js"), "utf8");

global.window = global;
// Presses land on a stand-in canvas, so a press counts as made.
const fakeCanvas = { tagName: "CANVAS", dispatchEvent: () => true, getBoundingClientRect: () => ({ left: 0, top: 0, width: 1280, height: 720 }) };
global.MouseEvent = class { constructor(t, o) { this.type = t; this.init = o; } };
global.document = { elementFromPoint: () => null, getElementsByTagName: () => [], querySelector: () => fakeCanvas };

function btn(name, x, y) {
  return { kind: "button", name, text: "", point: { x, y }, interactable: true, sig: "" };
}

// One fresh driver. buttons: what the engine can name on the main screen.
let onMark = null;
function load(buttons, live, quiet, entry, extra, pExtra) {
  // Earlier drivers keep running in the background; each one has its own marks.
  const myMarks = [];
  const myOnMark = onMark;
  const P = {
    quiet: quiet || (() => ({ badMs: 99999, longMs: 99999, uploadMs: 99999 })),
    entry: () => ({ spinReady: true, spin: buttons.filter((b) => /spin/i.test(b.name)), start: [], dismiss: [], dom: [], texts: [] }),
    buttons: () => ({ buttons: buttons }),
    live: () => Object.assign({ draws: 10, activeNodes: 100, heapMb: 50, stage: "idle", fps: 60 }, live && live()),
    summary: () => ({ channels: {} }),
    mark: (n) => { myMarks.push([n, Date.now()]); if (myOnMark) myOnMark(n); },
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
  Object.assign(window.__slotPerfThresholds, extra || {});
  Object.assign(P, pExtra || {});
  new Function(src)();
  P.auto.marks = myMarks;
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

// R16. A map sent before its stop is kept for it; the stop then does not ask.
async function earlyMapCase() {
  const t0 = Date.now();
  const sp = btn("btn_spin", 500, 600);
  const auto = load([sp], null, () => ({ badMs: 99999, longMs: 99999, uploadMs: Date.now() - t0 - 400 }), { settleQuietMs: 300, settleMaxSeconds: 5 });
  auto.start();
  const k = auto.map({ spin: sp.point });
  assert.ok(/map kept for the map stop/.test(k.kept), "early map kept: " + JSON.stringify(k));
  let asked = false;
  const end = Date.now() + 4000;
  while (Date.now() < end) {
    const s = auto.status();
    if (s.needs === "map") asked = true;
    if (s.phase === "panels" || s.phase === "spins") break;
    await new Promise((r) => setTimeout(r, 20));
  }
  assert.ok(!asked && ["panels", "spins"].includes(auto.status().phase), "map stop used the kept map without asking");
}

// R16. A spin button that stays pressable while the reels turn but shows a stop child: the spin
// lasts until the button looks as it did while idle again.
async function spinFor(showStop) {
  const sp = btn("btn_spin", 500, 600);
  onMark = (n) => {
    if (n !== "spin-1" || !showStop) return;
    sp.sig = "1:StopText";
    setTimeout(() => { sp.sig = ""; }, 1500);
  };
  const auto = load([sp], null, null, null, { maxSpins: 1, normalSpins: 1, settle: { pollMs: 50, minMs: 200, confirmMs: 200, stablePolls: 2, quietMs: 60000, nudgeAfterMs: 60000 } });
  auto.start();
  await until(auto, (s) => s.needs === "map");
  auto.map({ spin: sp.point }, 1);
  await until(auto, (s) => s.needs === "gc", 15000);
  onMark = null;
  const marks = auto.marks;
  const i = marks.findIndex((m) => m[0] === "spin-1");
  const g = marks.slice(i + 1).find((m) => m[0] === "gap");
  return g[1] - marks[i][1];
}
// R3. Turbo spins press the spin point again while the spin is seen busy; normal spins do not.
async function quickStopCase() {
  const sp = btn("btn_spin", 500, 600);
  const tb = btn("btn_turbo", 300, 600);
  onMark = (n) => {
    if (!/^(spin|turbo)-1$/.test(n)) return;
    sp.sig = "1:StopText";
    setTimeout(() => { sp.sig = ""; }, 1200);
  };
  const auto = load([sp, tb], null, null, null, { maxSpins: 2, normalSpins: 1, settle: { pollMs: 50, minMs: 200, confirmMs: 200, stablePolls: 2, quietMs: 60000, nudgeAfterMs: 60000 } });
  auto.start();
  await until(auto, (s) => s.needs === "map");
  auto.map({ spin: sp.point, turbo: tb.point }, 2);
  await until(auto, (s) => s.needs === "gc" || s.needs === "screen", 20000);
  onMark = null;
  const log = auto.result().log.map((l) => l[1]);
  assert.ok(log.includes("quick stop turbo-1") && !log.some((l) => /quick stop spin-/.test(l)), "quick stop on turbo spins only: " + log.filter((l) => /quick|press/.test(l)).join(" | "));
}

// R6. A socket closed after the game was ready stops the driver at the next gap, once per close.
async function backendCase() {
  const sp = btn("btn_spin", 500, 600);
  let evs = [];
  const auto = load([sp], null, null, null, { maxSpins: 2, normalSpins: 2, settle: { pollMs: 50, minMs: 200, confirmMs: 200, stablePolls: 2, quietMs: 60000, nudgeAfterMs: 60000 } }, { wsEvents: (from) => evs.slice(from || 0) });
  auto.start();
  await until(auto, (s) => s.needs === "map");
  evs = [{ kind: "close", code: 1006, clean: false, stage: "idle", afterReady: true }];
  auto.map({ spin: sp.point }, 2);
  const s = await until(auto, (x) => x.needs === "backend", 10000);
  assert.ok(/code 1006/.test(s.note) && /do not save/.test(s.note) && auto.marks.every((m) => m[0] !== "spin-1"), "asked before the first spin: " + s.note);
  auto.resume();
  await until(auto, (x) => auto.marks.some((m) => m[0] === "spin-1"), 10000);
}

// Auto-drill. After the run, goto brings the game to a state with the run's points; never spins.
async function gotoCase() {
  const sp = btn("btn_spin", 500, 600);
  const auto = load([sp], null, null, null, { maxSpins: 1, normalSpins: 1, settle: { pollMs: 50, minMs: 200, confirmMs: 200, stablePolls: 2, quietMs: 60000, nudgeAfterMs: 60000 } });
  assert.ok(auto.goto("rules").error, "goto refused before the run is done");
  auto.start();
  await until(auto, (s) => s.needs === "map");
  auto.map({ spin: sp.point }, 1);
  await until(auto, (s) => s.needs === "gc", 15000);
  auto.resume();
  await until(auto, (s) => s.phase === "done", 20000);
  const spinsBefore = auto.marks.filter((m) => /^spin-/.test(m[0])).length;
  auto.goto("rules");
  let s = await until(auto, (x) => /^drill:/.test(x.phase), 5000);
  assert.ok(s.phase === "drill:rules" && /not on screen/.test(auto.status().note || s.note || ""), "rules not on the map: said so: " + JSON.stringify(s));
  auto.goto("idle");
  s = await until(auto, (x) => x.phase === "drill:idle", 5000);
  assert.strictEqual(auto.marks.filter((m) => /^spin-/.test(m[0])).length, spinsBefore, "goto never spins");
}

// Auto-drill through the menu: history given inside the menu during the run; goto opens the menu
// first, then history, and never presses spin.
async function gotoMenuCase() {
  const sp = btn("btn_spin", 500, 600);
  const mn = btn("btn_menu", 900, 100);
  const H = { x: 850, y: 300 };
  const auto = load([sp, mn], null, null, null, { maxSpins: 1, normalSpins: 1, panelSpikeSeconds: 0.05, panelSteadySeconds: 0.05, settle: { pollMs: 50, minMs: 200, confirmMs: 200, stablePolls: 2, quietMs: 60000, nudgeAfterMs: 60000 } });
  auto.start();
  const answer = async (stopAt) => {
    for (let i = 0; i < 40; i += 1) {
      const s = await until(auto, (x) => x.needs || stopAt(x), 20000);
      if (!s.needs) return s;
      if (s.needs === "map") auto.map({ spin: sp.point, menu: mn.point, history: null, rules: null }, 1);
      else if (s.needs === "menu") auto.map({ history: H, close: { x: 1200, y: 60 } });
      else if (s.needs === "screen" && /pressed history/.test(s.note)) auto.opened();
      else auto.resume();
      await new Promise((r) => setTimeout(r, 30));
    }
    throw new Error("too many stops");
  };
  await answer((x) => x.phase === "done");
  const before = auto.result().log.length;
  auto.goto("history");
  let s = await answer((x) => /^drill:/.test(x.phase));
  assert.strictEqual(s.phase, "drill:history", "history reached through the menu: " + JSON.stringify(s));
  assert.ok(!s.note, "no note left from an earlier goto");
  const presses = auto.result().log.slice(before).map((l) => l[1]).filter((t) => /^press /.test(t));
  assert.ok(/^press menu @900,100/.test(presses[0]) && /^press history @850,300/.test(presses[1]), "menu first, then history: " + presses.join(" / "));
  auto.goto("idle");
  s = await answer((x) => x.phase === "drill:idle");
  const all = auto.result().log.slice(before).map((l) => l[1]).filter((t) => /^press /.test(t));
  assert.ok(!all.some((t) => /@500,600/.test(t) || /^press spin/.test(t)), "goto never presses spin: " + all.join(" / "));
}

async function busyCase() {
  const plain = await spinFor(false);
  const stop = await spinFor(true);
  assert.ok(plain < 1200 && stop >= 1500, `spin waits for the stop child to go: plain ${plain} ms, with stop ${stop} ms`);
}

(async () => {
  await earlyMapCase();
  await gotoCase();
  await gotoMenuCase();
  await backendCase();
  await busyCase();
  await quickStopCase();
  await settleCase();
  await mapCase();
  console.log("autopilot smoke ok");
  process.exit(0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
