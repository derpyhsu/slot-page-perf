#!/usr/bin/env node
// Usage: node test/probe-smoke.js
// Runs probe/install.js in a fake Cocos 3.x page and checks the parts agents rely on, then feeds
// a fake run through report/build.js. Exits non-zero on the first failed check.
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const assert = require("assert");
const { execFileSync } = require("child_process");

const root = path.join(__dirname, "..");
const src = fs.readFileSync(path.join(root, "probe", "install.js"), "utf8");
const T = JSON.parse(fs.readFileSync(path.join(root, "protocol", "thresholds.json"), "utf8"));

let now = 0;
const rafQ = [];
const intervals = [];
const canvasEl = { width: 1280, height: 720, getBoundingClientRect: () => ({ left: 0, top: 0, width: 640, height: 360 }) };
global.performance = { now: () => now, memory: { usedJSHeapSize: 50 * 1048576 } };
global.window = global;
global.location = { href: "https://x.test/game/?token=secret", pathname: "/game/" };
Object.defineProperty(global, "navigator", { value: { webdriver: true }, configurable: true });
global.document = { hidden: false, visibilityState: "visible", title: "t", querySelector: () => canvasEl };
global.innerWidth = 1280;
global.innerHeight = 720;
global.devicePixelRatio = 1;
global.requestAnimationFrame = (f) => rafQ.push(f);
global.setInterval = (f, ms) => intervals.push({ f, ms, next: ms });
global.XMLHttpRequest = function () {};
XMLHttpRequest.prototype.open = function () {};
XMLHttpRequest.prototype.send = function () {};
XMLHttpRequest.prototype.addEventListener = function () {};
global.PerformanceObserver = function (cb) { global.__lt = cb; };
PerformanceObserver.prototype.observe = function () {};

// Minimal WebGL so the GPU memory hooks have something to wrap.
global.WebGLRenderingContext = function () {};
["drawArrays", "drawElements", "texImage2D", "texSubImage2D", "compressedTexImage2D", "activeTexture", "bindTexture", "deleteTexture", "generateMipmap", "bindBuffer", "bufferData", "deleteBuffer", "bindRenderbuffer", "renderbufferStorage", "deleteRenderbuffer", "getExtension", "getParameter"].forEach((n) => {
  WebGLRenderingContext.prototype[n] = function () { return null; };
});
global.HTMLCanvasElement = function () {};
HTMLCanvasElement.prototype.getContext = () => new WebGLRenderingContext();

class Texture2D { constructor(w, h, f) { this.width = w; this.height = h; this._format = f; } }
Texture2D.PixelFormat = { RGBA8888: 35, RGBA_ASTC_4x4: 99 };
class Skeleton { constructor(mode) { this._cacheMode = mode; this.enabled = true; this._skeleton = { bones: new Array(30) }; } }
class Label { constructor(s) { this.cacheMode = 0; this.enabled = true; if (s) this.string = s; } }
class Button { constructor() { this.enabled = true; this.interactable = true; } }
class UITransform { getBoundingBoxToWorld() { return { x: 540, y: 300, width: 200, height: 80 }; } }
class Camera { constructor() { this.visibility = 1; } worldToScreen(out, p) { out.x = p.x; out.y = p.y; return out; } }
class Vec3 { constructor(x = 0, y = 0, z = 0) { this.x = x; this.y = y; this.z = z; } }
const names = new Map([[Skeleton, "sp.Skeleton"], [Label, "cc.Label"], [Texture2D, "cc.Texture2D"], [Button, "cc.Button"], [UITransform, "cc.UITransform"]]);
const ui = new UITransform();
const cam = new Camera();
const node = (name, components, children = [], extra = {}) => Object.assign({ name, active: true, activeInHierarchy: true, components, children }, extra);
const startBtn = node("btn_start", [new Button(), ui], [node("txt", [new Label("开始")])], { layer: 1, getComponent: (k) => (k === UITransform ? ui : null) });
// Five realtime Spine under a transparent parent (hidden, still posing) and one never activated.
const hiddenFx = node("fx_layer", [], [1, 2, 3, 4, 5].map((i) => node(`Symbol_${i}`, [new Skeleton(0)])), { opacity: 0 });
hiddenFx.children.forEach((c) => { c.parent = hiddenFx; });
const scene = node("scene", [], [startBtn, node("a", [new Skeleton(0), new Label()]), node("b", [new Skeleton(1)]), hiddenFx, node("off", [new Skeleton(0)], [], { active: false, activeInHierarchy: false })], { getComponentsInChildren: () => [cam] });
const assets = [new Texture2D(2048, 2048, 35), new Texture2D(1024, 1024, 99)];
let ticks = 0;
// One game component with a readable class name; its update stalls once during spin 3.
class Component {}
class SlotReelController extends Component { update() { if (slowUpdate) { slowUpdate = false; now += 80; } } onLoad() {} }
let slowUpdate = false;
const reel = new SlotReelController();
names.set(SlotReelController, "SlotReelController");
// Label text layout through a 3.x-style assembler. spin-5: the label itself takes most of a frame.
// spin-7: a localisation component's onLoad takes most of it, a smaller part being label layout.
const ttfAsm = { updateRenderData(comp) { now += comp.cost || 0; if (comp.upload) gl.texImage2D(0x0de1, 0, 0x1908, 0x1908, 0x1401, comp._assemblerData.canvas); } };
// Uploading a canvas takes 30 ms here, inside the upload call as in a browser.
WebGLRenderingContext.prototype.texImage2D = function () { const src = arguments[arguments.length - 1]; if (src && typeof src.getContext === "function") now += 30; return null; };
Label.Assembler = { getAssembler: () => ttfAsm };
const lblNode = node("lbl_win", []);
const lblWin = Object.assign(new Label("PLAYER-8848"), { node: lblNode, overflow: 2, fontSize: 40, useSystemFont: true, fontFamily: "Arial", cost: 90 });
lblNode.components.push(lblWin);
const locNode = node("txt_title", []);
const lblTitle = Object.assign(new Label("Title 1"), { node: locNode, overflow: 0, fontSize: 24, cost: 22 });
class LocalizableLabel extends Component { onLoad() { now += 33; Label.Assembler.getAssembler(lblTitle).updateRenderData(lblTitle); } }
names.set(LocalizableLabel, "localizable.label");
let slowLabel = false;
let slowLoc = false;
// 2.4 shape: assembler classes registered on cc.Label.__assembler__, made by _resetAssembler on
// enable, then called by _applyFontTexture (spin-9) or straight from the render flow (spin-11).
class TTF24 { updateRenderData(comp) { now += comp.cost || 0; } }
Label.__assembler__ = { getConstructor: function () { return TTF24; }, TTF: TTF24 };
Label.prototype._resetAssembler = function () { this._assembler = new TTF24(); };
const node24 = node("lbl_jackpot", []);
const lbl24 = Object.assign(new Label("88,888.00"), { node: node24, overflow: 0, fontSize: 30, cost: 60 });
let slow24 = 0;
// spin-8: a TTF label drawn and uploaded twice with the same text in one frame (R1).
// spin-10: Spine skeleton data parsed on first use (R2 cause).
const ruleNode = node("txt_rule_3", []);
const lblRule = Object.assign(new Label("Rules"), { node: ruleNode, overflow: 0, fontSize: 24, cost: 5, upload: 30, _assemblerData: { canvas: { width: 1024, height: 512, getContext() { return null; } } } });
ruleNode.components.push(lblRule);
let ruleTwice = false;
class SkeletonData { getRuntimeData() { if (!this._skeletonCache) { now += this.cost; this._skeletonCache = {}; } return this._skeletonCache; } }
let spineFirst = false;
// Work outside the engine tick: a WebSocket message (spin-4) whose handler switches a node off and
// on again, and a button callback wired in the editor (spin-6) that lays out a label.
class FakeWS extends EventTarget {
  fire(data) {
    const ev = Object.assign(new Event("message"), { data });
    this.dispatchEvent(ev);
    const f = this._om;
    if (f) f.call(this, ev);
  }
}
Object.defineProperty(FakeWS.prototype, "onmessage", { configurable: true, enumerable: true, get() { return this._om || null; }, set(f) { this._om = f; } });
global.WebSocket = FakeWS;
const between = [];
const panelNode = node("PanelRoot", []);
const activator = { activateNode(n) { now += n.cost || 0; } };
class EventHandler {
  constructor(component, handler, fn) { this.component = component; this.handler = handler; this.fn = fn; }
  emit() { this.fn(); }
}
Component.EventHandler = EventHandler;
const betNode = node("lbl_bet", []);
const lblBet = Object.assign(new Label("1.00"), { node: betNode, overflow: 0, fontSize: 28, cost: 70 });
betNode.components.push(lblBet);
const listeners = {};
class NodePool { constructor() { this._pool = []; } put(n) { this._pool.push(n); } get() { return this._pool.pop(); } size() { return this._pool.length; } }
global.cc = {
  NodePool,
  ENGINE_VERSION: "3.8.2",
  Texture2D,
  UITransform,
  Camera,
  Vec3,
  js: { getClassName: (o) => names.get(o) || names.get(o && o.constructor) || "Other", getClassByName: (n) => (n === "sp.SkeletonData" ? SkeletonData : null), _registeredClassNames: { SlotReelController, LocalizableLabel } },
  Component,
  Label,
  Director: { EVENT_AFTER_UPDATE: "director_after_update" },
  instantiate: (x) => x,
  deserialize: (x) => x,
  assetManager: { assets: { forEach: (f) => assets.forEach(f) } },
  director: { _nodeActivator: activator, on(e, f) { listeners[e] = f; }, tick() { ticks += 1; now += 2; reel.update(); if (slowLabel) { slowLabel = false; Label.Assembler.getAssembler(lblWin).updateRenderData(lblWin); } if (slowLoc) { slowLoc = false; new LocalizableLabel().onLoad(); } if (slow24 === 1) { lbl24._resetAssembler(); lbl24._assembler.updateRenderData(lbl24); } if (slow24 === 2) lbl24._assembler.updateRenderData(lbl24); slow24 = 0; if (ruleTwice) { ruleTwice = false; Label.Assembler.getAssembler(lblRule).updateRenderData(lblRule); Label.Assembler.getAssembler(lblRule).updateRenderData(lblRule); } if (spineFirst) { spineFirst = false; Object.assign(new SkeletonData(), { name: "bigwin_fx", cost: 70 }).getRuntimeData(); } (listeners.director_after_update || (() => {}))(); now += 1; }, mainLoop() { throw new Error("3.x never calls mainLoop"); }, getScene: () => scene },
  game: { frameRate: 60 },
  macro: {},
};

eval(src);
const P = global.__slotPerf;
// The page reads back the handler it set; a removed listener is not called.
const sock = new FakeWS();
const onMsg = function () { now += 50; };
sock.onmessage = onMsg;
assert.strictEqual(sock.onmessage, onMsg, "onmessage reads back the page's own handler");
let heard = 0;
const ear = () => { heard += 1; };
sock.addEventListener("message", ear);
sock.removeEventListener("message", ear);
sock.onmessage = null;
sock.fire("x");
assert.strictEqual(heard, 0, "removed message listener not called");
sock.onmessage = onMsg;

function advance(ms) {
  const end = now + ms;
  while (now < end) {
    now += 13.67;
    between.splice(0).forEach((f) => f());
    cc.director.tick(1 / 60);
    rafQ.splice(0).forEach((f) => f(now));
    intervals.forEach((i) => { while (i.next <= now) { i.f(); i.next += i.ms; } });
  }
}
const pick = () => {
  const e = P.entry(T.entry);
  return { spinReady: e.spinReady, start: e.start.map((b) => b.name), dismiss: e.dismiss.map((b) => b.name), tap: e.tapAnywhere };
};

// GPU memory: a 1024x1024 RGBA texture, a 1 MB buffer, then free the texture.
const gl = new HTMLCanvasElement().getContext("webgl");
const tex = {};
const buf = {};
gl.bindTexture(0x0de1, tex);
gl.texImage2D(0x0de1, 0, 0x1908, 1024, 1024, 0, 0x1908, 0x1401, null);
gl.bindBuffer(0x8892, buf);
gl.bufferData(0x8892, 1048576, 0x88e4);

advance(1000);
assert.deepStrictEqual(pick(), { spinReady: false, start: ["btn_start"], dismiss: [], tap: [] }, "start button found");
const sb = P.buttons(["开始"]).buttons[0];
assert.deepStrictEqual(sb.point, { x: 320, y: 190 }, "start button page coordinate");
P.mark("game-ready");
P.mark("idle");
console.warn("Spine: clearTrack is not supported in cache mode https://a.b/c.png?token=secret");
console.warn("Spine: clearTrack is not supported in cache mode https://a.b/c.png?token=other");
__lt({ getEntries: () => [{ startTime: now, duration: 120 }] });
advance(3000);
assert.strictEqual(P.live().gpuMb, 5, "live GPU memory is texture + buffer");
gl.deleteTexture(tex);
assert.strictEqual(P.live().gpuMb, 1, "deleted texture is freed");
for (let i = 1; i <= 12; i += 1) {
  P.mark("spin-" + i);
  if (i === 3) { advance(500); slowUpdate = true; }
  if (i === 4) { advance(500); between.push(() => sock.fire("y".repeat(3072))); sock.onmessage = function () { now += 10; panelNode.cost = 25; cc.director._nodeActivator.activateNode(panelNode, false); cc.director._nodeActivator.activateNode(panelNode, true); }; }
  if (i === 6) { advance(500); between.push(() => new EventHandler("SpinPanel", "onClickBet", () => { now += 5; Label.Assembler.getAssembler(lblBet).updateRenderData(lblBet); }).emit()); }
  if (i === 5) { advance(500); slowLabel = true; }
  if (i === 7) { advance(500); slowLoc = true; }
  if (i === 8) { advance(500); ruleTwice = true; }
  if (i === 10) { advance(500); spineFirst = true; }
  if (i === 12) sock.dispatchEvent(Object.assign(new Event("close"), { code: 1006, wasClean: false }));
  if (i === 9) { advance(500); slow24 = 1; }
  if (i === 11) { advance(500); slow24 = 2; }
  advance(2000);
  P.mark("gap");
  advance(200);
}
const s = P.summary();
const snap = P.cocos("idle");
const idle = s.stages.find((x) => x.name === "idle");
assert.strictEqual(s.channels.frameLoop, "tick");
assert.strictEqual(s.channels.engineCpu, true);
assert.strictEqual(idle.cpuMs.p95, 3, "per-frame CPU from director.tick");
assert.ok(idle.fpsLow > 0 && idle.badShare === 0 && idle.dropShare === 0, "1% low, bad-frame and dropped-frame share per stage");
assert.strictEqual(idle.gpuMemMb.peak, 5, "stage GPU memory peak");
assert.strictEqual(s.memory.gpu.peakMb, 5);
assert.strictEqual(snap.spine.realtime, 6);
assert.strictEqual(snap.spine.hiddenRealtime, 5, "transparent parent hides realtime Spine");
assert.strictEqual(snap.spine.hiddenBones, 150);
assert.deepStrictEqual(snap.spine.hiddenBy, { "Symbol_* · ?": 5 }, "hidden Spine grouped by folded path");
assert.strictEqual(snap.spine.unused, 6, "hidden and never-active Spine were never drawable");
assert.strictEqual(snap.spine.unusedLive, 5);
assert.ok(snap.spine.samples > 0, "Spine sampled on a timer");
assert.strictEqual(snap.console[0].count, 2, "console grouped");
assert.ok(!JSON.stringify(snap).includes("secret"), "no token in snapshot");

scene.children.push(node("notice_bg", [new Label("点击任意位置继续")], [], { hasEventListener: (e) => e === "touch-end" }));
scene.children.push(node("btn_buy_start", [new Button()], [node("t", [new Label("购买免费游戏")])]));
startBtn.activeInHierarchy = false;
assert.deepStrictEqual(pick(), { spinReady: false, start: [], dismiss: ["notice_bg"], tap: ["点击任意位置继续"] }, "touch node and tap-anywhere found, buy button avoided");
scene.children.push(node("btn_spin", [new Button()]));
assert.strictEqual(pick().spinReady, true, "spin button ready");

// Census: instantiated nodes still held (detached, destroyed, in scene) and scene groups by path.
const coinLayer = node("coin_layer", [], [], { parent: scene });
scene.children.push(coinLayer);
const held = [];
const make = (name, extra) => { const n = cc.instantiate(node(name, [], [], Object.assign({ parent: null, isValid: true }, extra))); held.push(n); return n; };
const addCoins = (k) => { for (let j = 0; j < k; j += 1) { const c = make("Coin", { parent: coinLayer }); coinLayer.children.push(c); } };
for (let j = 0; j < 3; j += 1) make("WinFx");
make("WinFx", { isValid: false });
addCoins(2);
const c1 = Object.assign(P.census(), { at: "after-warmup", spins: 5 });
assert.strictEqual(c1.status, "ok");
assert.deepStrictEqual((({ detached, destroyed, inScene }) => ({ detached, destroyed, inScene }))(c1.made), { detached: 3, destroyed: 1, inScene: 2 }, "instantiated nodes split by where they are");
for (let j = 0; j < 7; j += 1) make("WinFx");
addCoins(9);
// Six symbols handed to a cc.NodePool: held on purpose, counted apart from detached.
const symPool = new cc.NodePool();
for (let j = 0; j < 6; j += 1) symPool.put(make("Symbol"));
const c2 = Object.assign(P.census(), { at: "end", spins: 12 });
assert.ok(c2.paths.some((p) => p[0] === "coin_layer/Coin" && p[1] === 11), "scene grouped by folded path");

const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "slot-page-perf-smoke-"));
const raw = { autopilot: 1, summary: s, cocos: { snapshots: [snap] }, census: [c1, c2], entry: { result: "pressed", steps: [{ kind: "button", text: "开始", afterMs: 900 }] }, coverage: { "history-before": "not found" } };
fs.writeFileSync(path.join(runDir, "raw.json"), "Script ran on page and returned:\n```json\n" + JSON.stringify(raw) + "\n```\n");
const digest = execFileSync(process.execPath, [path.join(root, "report", "build.js"), runDir], { encoding: "utf8" });
const ev = JSON.parse(fs.readFileSync(path.join(runDir, "evidence.json"), "utf8"));
const md = fs.readFileSync(path.join(runDir, "report.md"), "utf8");
assert.ok(ev.fps.some((r) => r.group === "spin" && r.stages === 12), "spins grouped in the FPS table");
assert.ok(ev.todo.some((t) => t.rule === "cocos-spine-hidden"), "hidden Spine listed for the team");
assert.ok(md.includes("各階段 FPS") && md.includes("進遊戲"), "report shows FPS table and entry");
assert.ok(!/secret|token=/.test(JSON.stringify(ev) + md), "no token in evidence or report");
assert.strictEqual(s.timeline.componentTiming.status, "ok", "component timing ran");
const slow = s.stages.find((x) => x.name === "spin-3").hitches[0];
assert.ok(slow && slow.work && slow.work.updMs >= 80 && slow.work.rndMs != null, "hitch carries the update/render split");
assert.strictEqual(slow.work.comps[0][0], "SlotReelController.update", "slow component named");
const hit = ev.findings.find((f) => f.stage === "spin-3" && /^hitch-/.test(f.id));
assert.ok(hit && hit.cause && hit.cause.kind === "component" && hit.cause.ms <= hit.value, "stall cause attributed to the component");
assert.ok(!ev.findings.some((f) => f.stage === "idle" && f.cause), "no cause for the idle long task without detail");
const lblHit = ev.findings.find((f) => f.stage === "spin-5" && /^hitch-/.test(f.id));
assert.ok(lblHit && lblHit.cause && lblHit.cause.kind === "label", "label layout named as the cause");
assert.deepStrictEqual(
  (({ path, n, font, fontName, cache, overflow, size, chars }) => ({ path, n, font, fontName, cache, overflow, size, chars }))(lblHit.cause.top[0]),
  { path: "lbl_win", n: 1, font: "system", fontName: "Arial", cache: "NONE", overflow: "SHRINK", size: 40, chars: 11 },
  "label node, font and settings"
);
const locHit = ev.findings.find((f) => f.stage === "spin-7" && /^hitch-/.test(f.id));
assert.ok(locHit && locHit.cause && locHit.cause.kind === "component" && locHit.cause.name === "localizable.label.onLoad", "localisation component is the cause");
assert.ok(locHit.labels && locHit.labels.top[0].path === "txt_title" && locHit.labels.ms >= 22, "label part of the component named beside it");
for (const st of ["spin-9", "spin-11"]) {
  const h24 = ev.findings.find((f) => f.stage === st && /^hitch-/.test(f.id));
  assert.ok(h24 && h24.cause && h24.cause.kind === "label" && h24.cause.top[0].path === "lbl_jackpot", "2.4 label assembler timed on " + st);
}
assert.ok(s.timeline.componentTiming.labelAssemblers >= 2, "3.x and 2.4 label assemblers wrapped");
const wsHit = ev.findings.find((f) => f.stage === "spin-4" && /^hitch-/.test(f.id));
assert.ok(wsHit && wsHit.cause && wsHit.cause.kind === "activate" && wsHit.cause.churn === 1 && wsHit.cause.n === 1 && wsHit.cause.off === 1 && wsHit.cause.top === "PanelRoot", "node activation inside the message handler is the cause");
assert.ok(wsHit.cause.inside && wsHit.cause.inside[0].kind === "websocket" && wsHit.cause.inside[0].n === 1 && wsHit.cause.inside[0].topKb === 3, "message handler named as the container");
const hdHit = ev.findings.find((f) => f.stage === "spin-6" && /^hitch-/.test(f.id));
assert.ok(hdHit && hdHit.cause && hdHit.cause.kind === "label" && hdHit.cause.top[0].path === "lbl_bet", "label inside the callback is the cause");
assert.ok(hdHit.cause.inside && hdHit.cause.inside[0].kind === "handler" && hdHit.cause.inside[0].name === "SpinPanel.onClickBet", "callback named from the editor strings");
const { causeText } = require(path.join(root, "report", "findings.js"));
assert.ok(/^節點啟用 1 次、停用 1 次.*同一幀內切回 1 次.*PanelRoot.*；發生在WebSocket 訊息處理（1 則，\d+ ms，最慢一則 3 KB）裡$/.test(causeText(wsHit.cause).fact), "activation text names the message handler: " + causeText(wsHit.cause).fact);
assert.ok(/lbl_bet.*；發生在回呼 SpinPanel\.onClickBet（1 次，\d+ ms）裡$/.test(causeText(hdHit.cause).fact), "label text names the callback: " + causeText(hdHit.cause).fact);
// A spin the autopilot saw not start is left out of the spins and named in the report.
const runDir2 = fs.mkdtempSync(path.join(os.tmpdir(), "slot-page-perf-smoke-"));
fs.writeFileSync(path.join(runDir2, "raw.json"), JSON.stringify(Object.assign({}, raw, { notStarted: ["spin-2"] })));
execFileSync(process.execPath, [path.join(root, "report", "build.js"), runDir2], { encoding: "utf8" });
const ev2 = JSON.parse(fs.readFileSync(path.join(runDir2, "evidence.json"), "utf8"));
assert.ok(!ev2.stages.some((x) => x.name === "spin-2") && ev2.fps.some((r) => r.group === "spin" && r.stages === 11), "unstarted spin left out of the spins");
assert.ok(ev2.coverage.notStarted === "spin-2" && fs.readFileSync(path.join(runDir2, "report.html"), "utf8").includes("第 2 轉按下後畫面沒變"), "report names the unstarted spin");
assert.ok((ev.missing || []).every((m) => /WebSocket/.test(m)), "only the socket note in missing when every spin started");
// Three forced GCs: a rise in one half only is a step, not growth; a rise in both halves is.
const gcRun = (mbs) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "slot-page-perf-smoke-"));
  const gc = [["after-warmup", 5], ["mid", 10], ["end", 15]].map(([at, spins], i) => ({ at, spins, beforeMb: mbs[i] + 5, mb: mbs[i] }));
  fs.writeFileSync(path.join(d, "raw.json"), JSON.stringify(Object.assign({}, raw, { gc })));
  execFileSync(process.execPath, [path.join(root, "report", "build.js"), d], { encoding: "utf8" });
  return JSON.parse(fs.readFileSync(path.join(d, "evidence.json"), "utf8"));
};
const stepEv = gcRun([100, 130, 131]);
const growthItem = (e) => Object.values(e.score).filter((x) => x && x.items).flatMap((x) => x.items).find((i) => i.id === "growth");
assert.ok(stepEv.findings.some((f) => f.id === "heap-step") && !stepEv.findings.some((f) => f.id === "leak-suspected"), "one-half rise is a step, not a leak");
assert.ok(growthItem(stepEv).value <= 0.2 && growthItem(stepEv).basis === "gc-halves", "growth takes the smaller half");
assert.ok(stepEv.todo.some((t) => t.rule === "heap-step" && t.fix.includes("100 → 130 → 131")), "report states the three floors");
const leakEv = gcRun([100, 120, 140]);
const lk = leakEv.findings.find((f) => f.id === "leak-suspected");
assert.ok(lk && lk.status === "retained-after-gc" && lk.delta === 40, "rise in both halves is a leak");
assert.ok(!leakEv.findings.some((f) => f.id === "heap-step") && growthItem(leakEv).value === 4, "steady growth per spin");
assert.ok(!/PLAYER-8848|Title 1|88,888/.test(JSON.stringify(ev) + JSON.stringify(s)), "label text never kept");
// R21. Five forced GCs over 40 spins: growth is the median pairwise slope.
{
  const gcRun5 = (mbs) => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), "slot-page-perf-smoke-"));
    const gc = [["after-warmup", 5], ["gc-15", 15], ["mid", 25], ["gc-35", 35], ["end", 40]].map(([at, spins], i) => ({ at, spins, beforeMb: mbs[i] + 5, mb: mbs[i] }));
    fs.writeFileSync(path.join(d, "raw.json"), JSON.stringify(Object.assign({}, raw, { gc })));
    execFileSync(process.execPath, [path.join(root, "report", "build.js"), d], { encoding: "utf8" });
    return JSON.parse(fs.readFileSync(path.join(d, "evidence.json"), "utf8"));
  };
  // The same build twice: about 0.18 MB a spin, each floor off by up to a MB.
  const a = gcRun5([57.4, 58.6, 61.2, 62.6, 63.6]);
  const b = gcRun5([57.2, 59.4, 60.6, 63.3, 63.3]);
  const ga = growthItem(a), gb = growthItem(b);
  assert.ok(ga.basis === "gc-line" && Math.abs(ga.value - 0.18) < 0.05 && Math.abs(gb.value - 0.18) < 0.05, "both runs near 0.18 MB a spin: " + ga.value + " " + gb.value);
  assert.ok(Math.abs(ga.score - gb.score) <= 5 && !a.findings.some((f) => f.id === "leak-suspected"), "noisy floors score alike: " + ga.score + " " + gb.score);
  assert.ok(a.leads.some((l) => l.id === "growth" && /GC 後 heap：57.4 → 58.6 → 61.2 → 62.6 → 63.6 MB/.test(l.why[0])) || !a.losses.all.some((r) => r.id === "growth"), "the floors in plain words");
  const st5 = gcRun5([100, 130, 130.5, 131, 131.2]);
  assert.ok(growthItem(st5).value < 0.1 && st5.findings.some((f) => f.id === "heap-step") && !st5.findings.some((f) => f.id === "leak-suspected"), "a one-off step is not growth: " + growthItem(st5).value);
  const lk5 = gcRun5([100, 116, 131, 146, 154]);
  assert.ok(lk5.findings.some((f) => f.id === "leak-suspected" && f.line) && lk5.todo.some((t) => t.rule === "leak-suspected" && t.fix.includes("100 → 116 → 131 → 146 → 154")), "a rise that keeps going at 1.5 MB a spin is a leak");
}
const html = fs.readFileSync(path.join(runDir, "report.html"), "utf8");
assert.ok(html.includes("<details class=\"acc\"") && !/<details class="acc"[^>]* open>/.test(html), "todo rows start closed");
assert.ok(html.includes("lbl_win") && html.includes("overflow SHRINK"), "report names the labels on the worst spin stall");
const ng = ev.nodeGrowth;
assert.ok(ng && ng.spins === 7 && ng.paths[0].path === "coin_layer/Coin" && ng.paths[0].from === 2 && ng.paths[0].to === 11, "scene group growth between the GC points");
assert.deepStrictEqual(ng.made.byName[0], { name: "WinFx", detached: [3, 10], destroyed: [1, 1], inScene: [0, 0] }, "detached instantiated nodes by source name");
assert.ok(html.includes("coin_layer/Coin 2 → 11") && html.includes("WinFx（不在場景也沒 destroy 3 → 10"), "report shows node growth");
const symRow = ng.made.byName.find((x) => x.name === "Symbol");
assert.ok(symRow && symRow.pooled[1] === 6 && symRow.detached[1] === 0 && c2.made.pooled === 6 && c2.made.pools === 1, "pooled nodes counted apart from detached");
assert.ok(html.includes("Symbol（在 cc.NodePool 裡 0 → 6"), "report names the pool");
// R14. A middle census shows a group that stopped growing in the second half.
{
  const cut = (c, at, spins, coin, sym) => Object.assign({}, c, { at, spins, paths: [["coin_layer/Coin", coin, coin]], made: Object.assign({}, c.made, { byName: [{ name: "Symbol", inScene: 0, detached: 0, destroyed: 0, pooled: sym }] }) });
  const dM = fs.mkdtempSync(path.join(os.tmpdir(), "slot-page-perf-smoke-"));
  fs.writeFileSync(path.join(dM, "raw.json"), JSON.stringify(Object.assign({}, raw, { census: [cut(c1, "after-warmup", 5, 2, 0), cut(c1, "mid", 10, 11, 259), cut(c1, "end", 15, 11, 259)] })));
  execFileSync(process.execPath, [path.join(root, "report", "build.js"), dM], { encoding: "utf8" });
  const evM = JSON.parse(fs.readFileSync(path.join(dM, "evidence.json"), "utf8"));
  const t = require(path.join(root, "report", "findings.js")).nodeGrowthText(evM.nodeGrowth);
  assert.ok(t.includes("coin_layer/Coin 2 → 11 → 11（後半沒再增加）") && t.includes("在 cc.NodePool 裡 0 → 259 → 259（後半沒再增加）") && !t.includes("每轉"), "plateau stated: " + t);
}
assert.ok(fs.readFileSync(path.join(runDir, "report.html"), "utf8").includes("SlotReelController.update"), "report shows the cause");

// Invisible but drawn, on a 2.4-shaped scene: census reads window.cc when called.
const cc3 = global.cc;
{
  class Sprite24 {}
  class Skel24 {}
  const names24 = new Map([[Sprite24, "cc.Sprite"], [Skel24, "sp.Skeleton"]]);
  const mat = (a, d, tx, ty) => { const m = new Float32Array(16); m[0] = a; m[5] = d; m[10] = 1; m[15] = 1; m[12] = tx; m[13] = ty; return { m }; };
  // Each node carries its world transform as (scale, x, y), already composed.
  class Mask24 {}
  names24.set(Mask24, "cc.Mask");
  const n24 = (name, opts = {}, kids = []) => {
    const sc = opts.scale == null ? 1 : opts.scale;
    const n = { name, _activeInHierarchy: true, activeInHierarchy: true, _opacity: opts.opacity == null ? 255 : opts.opacity, _children: kids, _contentSize: { width: opts.w || 0, height: opts.h || 0 }, _anchorPoint: { x: 0.5, y: 0.5 }, _worldMatrix: mat(sc, sc, opts.x || 0, opts.y || 0), _updateWorldMatrix() {} };
    if (opts.comp) { n._renderComponent = opts.comp; opts.comp.node = n; opts.comp.enabledInHierarchy = true; n._components = [opts.comp]; }
    kids.forEach((k) => { k.parent = n; });
    return n;
  };
  const spr = () => new Sprite24();
  // A region attachment covering 640x360 skeleton units: a quarter of the 1280x720 view.
  const region = () => ({ uvs: new Float32Array(8), offset: new Float32Array(8), color: { a: 1 }, computeWorldVertices(bone, v) { v.set([0, 0, 640, 0, 640, 360, 0, 360]); } });
  const slot = (att, a) => ({ color: { a }, bone: { active: true }, getAttachment: () => att });
  const skel = (slots, mode) => Object.assign(new Skel24(), { _cacheMode: mode || 0, _skeleton: { color: { a: 1 }, drawOrder: slots } });
  const pool = n24("pool", {}, Array.from({ length: 30 }, (_, i) => n24(`sym_${i + 1}`, { comp: spr(), w: 100, h: 100, x: -100000, y: -100000 })));
  const portrait = n24("portrait", { scale: 0 }, Array.from({ length: 5 }, (_, i) => n24(`btn_${i}`, { comp: spr(), w: 80, h: 80, scale: 0, x: 640, y: 360 })));
  const faded = n24("faded", { opacity: 0 }, [n24("far", { comp: spr(), w: 100, h: 100, x: -5000, y: 0 })]);
  const fxRt = n24("fx_rt", { comp: skel([slot(region(), 0), slot(region(), 0), slot(region(), 1)]), x: 640, y: 360 });
  const fxEmpty = n24("fx_empty", { comp: skel([slot(null, 1), slot(null, 1)]), x: 640, y: 360 });
  const fxCached = n24("fx_cached", { comp: skel([slot(region(), 0)], 1), x: 640, y: 360 });
  // A reel window mask 500×300 at the centre; one symbol below it is inside the view but clipped away.
  const reelMask = n24("reel_mask", { comp: new Mask24(), w: 500, h: 300, x: 640, y: 360 }, [n24("sym_in", { comp: spr(), w: 100, h: 100, x: 640, y: 360 }), n24("sym_below", { comp: spr(), w: 100, h: 100, x: 640, y: 650 })]);
  // A half-transparent full-screen dim on top, as a panel's backdrop.
  const dim = n24("dim", { comp: spr(), w: 1280, h: 720, x: 640, y: 360, opacity: 128 });
  const canvas24 = n24("Canvas", {}, [n24("bg", { comp: spr(), w: 1280, h: 720, x: 640, y: 360 }), pool, portrait, faded, fxRt, fxEmpty, fxCached, reelMask, dim]);
  const scene24 = { name: "scene", _children: [canvas24], activeInHierarchy: false };
  canvas24.parent = scene24;
  const cam24 = { getScreenToWorldPoint: (p) => ({ x: p.x, y: p.y }) };
  global.cc = {
    ENGINE_VERSION: "2.4.9",
    js: { getClassName: (o) => names24.get(o && o.constructor) || "Other" },
    v2: (x, y) => ({ x, y }),
    view: { getVisibleSize: () => ({ width: 1280, height: 720 }), getVisibleOrigin: () => ({ x: 0, y: 0 }) },
    Camera: { findCamera: () => cam24 },
    director: { getScene: () => scene24 },
  };
  const inv = P.census().invisible;
  global.cc = cc3;
  assert.strictEqual(inv.status, "ok");
  assert.strictEqual(inv.offscreen, 30, "parked pool nodes counted, opacity-0 subtree skipped");
  assert.deepStrictEqual(inv.offscreenBy[0], ["Canvas/pool/sym_*", 30], "grouped by folded path");
  assert.strictEqual(inv.scale0, 5, "scale-0 children counted");
  assert.ok(inv.outsideMask === 1 && inv.outsideMaskBy[0][0] === "Canvas/reel_mask/sym_below", "clipped by an ancestor mask, inside the view");
  assert.strictEqual(inv.spine.transparent, 2, "alpha-0 attachments on a realtime skeleton");
  assert.strictEqual(inv.spine.transparentScreens, 0.5, "two quarter-screen attachments");
  assert.strictEqual(inv.spine.empty, 1, "skeleton with nothing to draw");
  assert.deepStrictEqual(inv.spine.emptyBy[0], ["Canvas/fx_empty", 1]);
  assert.strictEqual(inv.spine.skeletons, 2, "cached skeletons not read");
  // R15. Coverage: bg one screen, the drawn Spine slot a quarter, the mask box and the symbol in it.
  const cv = inv.coverage;
  assert.ok(Math.abs(cv.screens - (2 + 0.25 + (500 * 300 + 100 * 100) / 921600)) < 0.01 && cv.full === 2, "coverage in screens: " + JSON.stringify(cv));
  assert.deepStrictEqual(cv.cover, { path: "Canvas/dim", alpha: 0.5, under: 4, over: 0 }, "topmost full-screen node, its alpha and what is drawn under it");
  assert.deepStrictEqual(cv.groups[0], ["Canvas/bg", 1, 1], "grouped by the first levels of the path");
  assert.ok(cv.groups.some((g) => g[0] === "Canvas/fx_rt" && g[1] === 0.25) && cv.spineNoArea === 1, "Spine by slot; cached Spine not measured");

  // Through the report: one cocos row with the counts and the paths.
  const dI = fs.mkdtempSync(path.join(os.tmpdir(), "slot-page-perf-smoke-"));
  const cInv = Object.assign({}, c2, { invisible: inv });
  fs.writeFileSync(path.join(dI, "raw.json"), JSON.stringify(Object.assign({}, raw, { census: [c1, cInv] })));
  execFileSync(process.execPath, [path.join(root, "report", "build.js"), dI], { encoding: "utf8" });
  const evI = JSON.parse(fs.readFileSync(path.join(dI, "evidence.json"), "utf8"));
  const row = evI.todo.find((t) => t.rule === "cocos-invisible-drawn");
  assert.ok(row, "invisible-but-drawn row listed");
  assert.ok(/30/.test(row.title) && row.fix.includes("Canvas/pool/sym_*") && row.fix.includes("Canvas/fx_empty"), "row names counts and paths: " + row.title + " / " + row.fix);
  assert.ok(!ev.todo.some((t) => t.rule === "cocos-invisible-drawn"), "no row without the census field");
  assert.strictEqual(JSON.stringify(evI.score), JSON.stringify(ev.score), "not scored");
  assert.ok(!evI.todo.some((t) => t.rule === "fill-layers"), "1.4 screens is not many layers");
  const dF = fs.mkdtempSync(path.join(os.tmpdir(), "slot-page-perf-smoke-"));
  const cIdle = Object.assign({}, c1, { at: "idle", invisible: Object.assign({}, inv, { coverage: { screens: 8.6, full: 7, additiveScreens: 2.1, groups: [["Canvas/BG", 4.2, 3], ["Canvas/Reels", 2.5, 60]] } }) });
  fs.writeFileSync(path.join(dF, "raw.json"), JSON.stringify(Object.assign({}, raw, { census: [cIdle, c1, c2] })));
  execFileSync(process.execPath, [path.join(root, "report", "build.js"), dF], { encoding: "utf8" });
  const fr = JSON.parse(fs.readFileSync(path.join(dF, "evidence.json"), "utf8")).todo.find((t) => t.rule === "fill-layers");
  assert.ok(fr && fr.level === "orange" && fr.title === "待機每幀畫的面積約 8.6 個螢幕" && fr.fix.includes("Canvas/BG 4.2 層"), "fill-layers row: " + (fr && fr.fix));
}

// A level that steps up at spin 6 and stays: draw calls and active nodes, one row.
{
  const dW = fs.mkdtempSync(path.join(os.tmpdir(), "slot-page-perf-smoke-"));
  const sW = JSON.parse(JSON.stringify(s));
  const spinNodes = [];
  sW.stages.forEach((x) => {
    const m = x.name.match(/^spin-(\d+)$/);
    if (!m) return;
    const n = Number(m[1]);
    x.draws.p50 = n === 1 ? 200 : n < 6 ? 40 + n : 100 + n;
    spinNodes.push([x.name, n < 6 ? 500 : 800]);
  });
  fs.writeFileSync(path.join(dW, "raw.json"), JSON.stringify(Object.assign({}, raw, { summary: sW, spinNodes })));
  execFileSync(process.execPath, [path.join(root, "report", "build.js"), dW], { encoding: "utf8" });
  const evW = JSON.parse(fs.readFileSync(path.join(dW, "evidence.json"), "utf8"));
  const wf = evW.findings.filter((f) => f.id === "worse-from-spin");
  assert.deepStrictEqual(wf.map((f) => [f.metric, f.from]).sort(), [["draws", 6], ["nodes", 6]], "draw calls and nodes step at spin 6, spin 1 left out");
  const wr = evW.todo.filter((t) => t.rule === "worse-from-spin");
  assert.ok(wr.length === 1 && wr[0].title.includes("從第 6 轉起") && wr[0].fix.includes("第 2–5 轉最多 45") && wr[0].fix.includes("第 6–12 轉最少 106"), "one row with both levels: " + (wr[0] && wr[0].fix));
  assert.ok(!ev.findings.some((f) => f.id === "worse-from-spin"), "flat run has no step");
}

// Where the points went: each score's losses add up to 100 minus its uncapped score.
{
  const sumOf = (e, k) => e.losses.all.filter((r) => r.category === k).reduce((a, r) => a + r.points, 0);
  ["loading", "smooth", "memory"].forEach((k) => assert.strictEqual(sumOf(ev, k), 100 - ev.score[k].score, "losses add up for " + k));
  assert.ok(ev.losses.top.length <= 3 && ev.losses.top[0].points >= ev.losses.top[ev.losses.top.length - 1].points, "top three, largest first");
  const steady = ev.losses.all.find((r) => r.id === "steady");
  assert.ok(!steady || (steady.stage === "spin" && steady.tool === "coverage, fill rate"), "low FPS with little engine CPU points to coverage and fill rate");
  assert.ok(fs.readFileSync(path.join(runDir, "report.html"), "utf8").includes("扣最多分的地方"), "losses on the first screen");
  const cap = leakEv.losses.caps.find((c) => c.category === "memory");
  assert.ok(cap && cap.cap === leakEv.score.memory.score && cap.fatal.includes("leak-suspected") && sumOf(leakEv, "memory") === 100 - cap.uncapped, "a fatal cap is stated beside the losses");
}

// Why and where for each deduction, from the evidence: plain lines in the report, the same
// deductions with suspects and numbers in ev.leads for slot-perf-drill.
{
  assert.ok(ev.losses.top.every((r) => Array.isArray(r.why) && r.why.length <= 2), "top losses carry why");
  assert.ok(ev.losses.top.some((r) => r.why.length), "at least one why from the smoke evidence: " + JSON.stringify(ev.losses.top));
  assert.strictEqual(ev.leads.length, ev.losses.all.length, "a lead per deduction");
  assert.ok(ev.leads.every((l) => l.reach && Array.isArray(l.suspects) && l.numbers), "leads have a state to reach, suspects and numbers");
  const labelLead = ev.leads.find((l) => l.suspects.some((x) => x.kind === "label"));
  assert.ok(!labelLead || labelLead.why.some((w) => /文字內容沒變卻重新繪製上傳/.test(w)), "label re-upload said in plain words");
  const htmlW = fs.readFileSync(path.join(runDir, "report.html"), "utf8");
  const box = htmlW.slice(htmlW.indexOf('<div class="losses">'), htmlW.indexOf("</ol></div>", htmlW.indexOf('<div class="losses">')));
  const paths = ev.leads.flatMap((l) => l.suspects.map((x) => x.path || x.what).filter((p) => p && String(p).length > 3));
  assert.ok(box.length > 0 && !/slot-perf-drill/.test(box) && paths.every((p) => !box.includes(p)), "the report's losses name no tool and no suspect path");
  ev.losses.top.forEach((r) => r.why.forEach((w) => assert.ok(box.includes(w.replace(/&/g, "&amp;").replace(/</g, "&lt;")), "why shown: " + w)));
}

// R17. Highest draw calls per spin climbing with ups and downs (real series from two games).
{
  const { drawsRise } = require("../report/findings");
  const thresholds = JSON.parse(fs.readFileSync(path.join(root, "protocol", "thresholds.json"), "utf8"));
  const mk = (xs, longAt) => ({ stages: xs.map((v, i) => ({ name: "spin-" + (i + 1), draws: { max: v }, wallMs: (longAt || []).includes(i + 1) ? 60000 : 4000 })) });
  const ge = drawsRise(mk([51, 55, 73, 86, 81, 106, 94, 95, 118, 124, 141]), thresholds);
  assert.ok(ge && ge.base.avg === 71.3 && ge.last.avg === 127.7 && ge.series.length === 11, "golden empire series is a rise: " + JSON.stringify(ge));
  assert.ok(drawsRise(mk([54, 58, 61, 70, 66, 80, 77, 95, 104, 118, 126]), thresholds), "buffalo king 54 to 126 is a rise");
  assert.strictEqual(drawsRise(mk([50, 52, 51, 53, 50, 54, 52, 51, 53, 52, 51]), thresholds), null, "flat is not");
  assert.strictEqual(drawsRise(mk([6, 6, 7, 6, 7, 8, 8, 9, 9, 9, 9]), thresholds), null, "a small absolute rise is not");
  assert.strictEqual(drawsRise(mk([50, 52, 51, 53, 50, 54, 52, 51, 53, 52, 140], [11]), thresholds), null, "a long last spin (feature, big win) is left out");
}

// R19. Spine in a cc.NodePool left on a finished animation with something to draw.
{
  const slotOf = (a) => ({ color: { a: 1 }, bone: { active: true }, attachment: { color: { a } } });
  const skel = (tracks, alphas, mode) => Object.assign(new Skeleton(mode || 0), { _state: { tracks }, _skeleton: { color: { a: 1 }, drawOrder: alphas.map(slotOf) } });
  const done = { loop: false, isComplete: () => true };
  const resPool = new cc.NodePool();
  for (let j = 0; j < 12; j += 1) resPool.put(node("Reel_" + (j % 3), [], [node("Symbol", [], [node("gold", [skel([done], [0, 1])])])]));
  resPool.put(node("Reel_0", [], [node("Symbol", [], [node("gold", [skel([{ loop: true, isComplete: () => false }], [1])])])]));
  resPool.put(node("Reel_0", [], [node("Symbol", [], [node("gold", [skel([done], [0, 0])])])]));
  resPool.put(node("Reel_0", [], [node("Symbol", [], [node("gold", [skel([], [1], 1)])])]));
  resPool.put(node("Reel_0", [], [node("Symbol", [], [node("gold", [Object.assign(new Skeleton(0), { _skeleton: {} })])])]));
  const cr = P.census();
  assert.deepStrictEqual((({ residue, checked, cacheMode, unreadable }) => ({ residue, checked, cacheMode, unreadable }))(cr.poolResidue), { residue: 12, checked: 16, cacheMode: 1, unreadable: 1 }, "pool residue counted, cache mode and unreadable apart: " + JSON.stringify(cr.poolResidue));
  assert.deepStrictEqual(cr.poolResidue.byPath[0], ["Reel_*/Symbol/gold", 12], "grouped by folded pool path");
  const dR = fs.mkdtempSync(path.join(os.tmpdir(), "slot-page-perf-smoke-"));
  fs.writeFileSync(path.join(dR, "raw.json"), JSON.stringify(Object.assign({}, raw, { census: [c1, Object.assign(cr, { at: "end", spins: 12 })] })));
  execFileSync(process.execPath, [path.join(root, "report", "build.js"), dR], { encoding: "utf8" });
  const evR = JSON.parse(fs.readFileSync(path.join(dR, "evidence.json"), "utf8"));
  const row = evR.todo.find((t) => t.rule === "pool-residue");
  assert.ok(row && /12 個 Spine 停在播完的最後一幀/.test(row.title) && row.fix.includes("Reel_*/Symbol/gold 12 個") && row.fix.includes("快取模式 1 個不算"), "pool residue row: " + JSON.stringify(row));
  resPool._pool.length = 0;
}

// R18. The sampled spin frame with the most draw calls: who started each draw call.
{
  const sB = JSON.parse(JSON.stringify(s));
  const bt = (draws, top) => ({ draws, breaks: draws, top, classes: [["sp.Skeleton", Math.round(draws * 0.6)], ["cc.Sprite", Math.round(draws * 0.4)]], pairs: [["cc.Sprite → sp.Skeleton", 30], ["sp.Skeleton 內部", 12]], ms: 0.3 });
  sB.stages.find((x) => x.name === "spin-3").batches = bt(70, [["Reel_*/wheel_*/Symbol/gold [sp.Skeleton]", 40]]);
  sB.stages.find((x) => x.name === "spin-5").batches = bt(120, [["Reel_*/wheel_*/Symbol/gold [sp.Skeleton]", 60], ["Reel_*/frame [cc.Sprite]", 20]]);
  sB.stages.find((x) => x.name === "spin-6").batches = Object.assign(bt(200, [["x [cc.Sprite]", 2]]), { partial: true });
  const dB = fs.mkdtempSync(path.join(os.tmpdir(), "slot-page-perf-smoke-"));
  fs.writeFileSync(path.join(dB, "raw.json"), JSON.stringify(Object.assign({}, raw, { summary: sB })));
  execFileSync(process.execPath, [path.join(root, "report", "build.js"), dB], { encoding: "utf8" });
  const evB = JSON.parse(fs.readFileSync(path.join(dB, "evidence.json"), "utf8"));
  assert.ok(evB.batchPeak && evB.batchPeak.stage === "spin-5" && evB.batchPeak.draws === 120, "peak is the largest complete sample: " + JSON.stringify(evB.batchPeak));
  const rowB = evB.todo.find((t) => t.rule === "batch-breaks");
  assert.ok(rowB && /120 個，換手最多在 Spine（72 次）、Sprite（48 次）/.test(rowB.title) && rowB.fix.includes("Reel_*/wheel_*/Symbol/gold [sp.Skeleton] 60 次"), "batch breaks row: " + JSON.stringify(rowB));
  const lead = evB.leads.find((l) => l.suspects.some((x) => x.kind === "batch"));
  assert.ok(!lead || lead.suspects.find((x) => x.kind === "batch").path === "Reel_*/wheel_*/Symbol/gold", "lead suspects carry the path");
}

// R1, R2. Label textures by owner, the same text uploaded twice, Spine parse, every stall listed.
{
  const st8 = s.stages.find((x) => x.name === "spin-8");
  assert.ok(st8.uploads && st8.uploads.canvas.n === 2 && st8.uploads.canvas.mb === 4, "canvas uploads counted per stage");
  assert.deepStrictEqual((({ path, labels, n, same }) => ({ path, labels, n, same }))(st8.uploads.labels.top[0]), { path: "txt_rule_*", labels: 1, n: 2, same: 1 }, "label owner and same-text re-upload");
  const h8 = ev.findings.find((f) => f.stage === "spin-8" && /^hitch-/.test(f.id));
  assert.ok(h8 && h8.work.texCanvas.n === 2 && h8.work.texCanvas.top[0].path === "txt_rule_*", "stall carries the label uploads");
  const rd = ev.findings.find((f) => f.id === "label-redraw" && f.stage === "spin-8");
  assert.ok(rd && rd.same === 1 && rd.sameMb === 2, "same text uploaded again is a finding");
  const rr = ev.todo.find((t) => t.rule === "label-redraw");
  assert.ok(rr && rr.fix.includes("txt_rule_*") && rr.fix.includes("繪製時 2"), "row names the label and when: " + (rr && rr.fix));
  const h10 = ev.findings.find((f) => f.stage === "spin-10" && /^hitch-/.test(f.id));
  assert.ok(h10 && h10.cause && h10.cause.kind === "spine-build" && h10.cause.name === "bigwin_fx", "Spine parse named as the cause");
  assert.ok(ev.stalls.length >= 8 && ev.stalls.every((r, i) => !i || r.t >= ev.stalls[i - 1].t), "every stall listed in time order");
  assert.ok(ev.stalls.find((r) => r.stage === "spin-10").cause.startsWith("Spine 骨架資料解析 bigwin_fx"), "short cause in the stall table");
  assert.ok(ev.stalls.filter((r) => r.stage === "spin-8")[0].canvasShare > 0.5, "stall table shows the label texture share");
  const html1 = fs.readFileSync(path.join(runDir, "report.html"), "utf8");
  assert.ok(html1.includes("每一次停頓") && html1.includes("算進頻率"), "stall table in the report");
}

// R12, R13. The loading percentage stood still while a file downloaded; a picture file larger than
// its raw pixels.
{
  const dL = fs.mkdtempSync(path.join(os.tmpdir(), "slot-page-perf-smoke-"));
  const sL = JSON.parse(JSON.stringify(s));
  const ld = sL.stages.find((x) => x.name === "loading");
  ld.startMs = 0;
  ld.wallMs = 50000;
  sL.progress = [[1000, 10], [16000, 98], [47000, 99]];
  sL.resources = { status: "ok", count: 2, sizes: "ok", files: [[15000, 45000, 5324, "ab/abcdef12-0000-0000-0000-000000000000.png", "reel_frame"], [17000, 20000, 100, "cfg/config.json"]], bloated: [{ file: "abcdef12.png", name: "reel_frame", w: 786, h: 608, kb: 5324, bpp: 11.4 }] };
  fs.writeFileSync(path.join(dL, "raw.json"), JSON.stringify(Object.assign({}, raw, { summary: sL })));
  execFileSync(process.execPath, [path.join(root, "report", "build.js"), dL], { encoding: "utf8" });
  const evL = JSON.parse(fs.readFileSync(path.join(dL, "evidence.json"), "utf8"));
  const st = evL.loadStops[0];
  assert.ok(st.pct === 98 && st.sec === 31 && st.files[0].name === "reel_frame" && st.done === 2 && st.mb === 5.3, "loading stop at 98% with the file downloading: " + JSON.stringify(st));
  assert.ok(!evL.loadStops.some((x) => x.pct === 99) && evL.loadStops[1].pct === 10, "a short tail is not a stop; longest first");
  const lr = evL.todo.find((t) => t.rule === "loading-progress-stop");
  assert.ok(lr && lr.title === "載入停在 98% 有 31 秒" && lr.fix.includes("reel_frame") && lr.fix.includes("5.2 MB"), "loading stop row: " + (lr && lr.fix));
  const br = evL.todo.find((t) => t.rule === "image-bloated");
  assert.ok(br && br.fix.includes("786×608") && br.fix.includes("每像素 11.4 bytes"), "bloated picture row");
  assert.ok(fs.readFileSync(path.join(dL, "report.html"), "utf8").includes("載入時下載最久"), "loading files table");
}

// R6, R8. A WebSocket closed during play is noted; a translucent or opaque panel backdrop is a fact row.
{
  const dP = fs.mkdtempSync(path.join(os.tmpdir(), "slot-page-perf-smoke-"));
  const panels = { idle: { cover: { path: "Canvas/bg", alpha: 1, under: 0, over: 80 } }, rules: { cover: { path: "Canvas/RulePanel/mask_bg", alpha: 0.6, under: 113, over: 40 } }, "history-before": { cover: { path: "Canvas/History/bg", alpha: 1, under: 90, over: 30 } } };
  fs.writeFileSync(path.join(dP, "raw.json"), JSON.stringify(Object.assign({}, raw, { panels })));
  execFileSync(process.execPath, [path.join(root, "report", "build.js"), dP], { encoding: "utf8" });
  const evP = JSON.parse(fs.readFileSync(path.join(dP, "evidence.json"), "utf8"));
  const pr = evP.todo.find((t) => t.rule === "panel-cover-rules");
  const ph = evP.todo.find((t) => t.rule === "panel-cover-history-before");
  assert.ok(pr && pr.title.includes("不透明度 60%") && pr.title.includes("底下 113 個節點"), "translucent backdrop: " + (pr && pr.title));
  assert.ok(ph && ph.title.includes("底下 90 個節點被蓋住仍在畫"), "opaque backdrop: " + (ph && ph.title));
  assert.ok(s.ws && s.ws.some((e) => e.kind === "close" && e.code === 1006 && e.afterReady && e.stage === "spin-12") && !JSON.stringify(s.ws).includes("x.test"), "socket close recorded without the URL");
  assert.ok((ev.missing || []).some((m) => m.includes("WebSocket 在第 12 轉斷線（code 1006）")), "report notes the close: " + JSON.stringify(ev.missing));
  assert.deepStrictEqual(P.wsEvents(0).map((e) => e.code), [1006], "autopilot sees closes after game-ready");
}

// R9. A stall in the settle wait counts in the loading stall item, never as a loading fatal, and
// stays out of smoothness. P.quiet reports the long task the page just had.
{
  assert.ok(P.quiet().longMs >= 0 && typeof P.quiet().uploadMs === "number", "quiet() reports times");
  const dS = fs.mkdtempSync(path.join(os.tmpdir(), "slot-page-perf-smoke-"));
  const sS = JSON.parse(JSON.stringify(s));
  const idleSt = sS.stages.find((x) => x.name === "idle");
  const settleSt = Object.assign(JSON.parse(JSON.stringify(idleSt)), { name: "settle", startMs: idleSt.startMs - 6000, wallMs: 6000, hitches: [{ t: idleSt.startMs - 3000, dt: 1500, cpu: 1500, draws: 10, inFlight: 0, urls: [] }] });
  sS.stages.splice(sS.stages.indexOf(idleSt), 0, settleSt);
  fs.writeFileSync(path.join(dS, "raw.json"), JSON.stringify(Object.assign({}, raw, { summary: sS, settle: { ms: 6000 } })));
  execFileSync(process.execPath, [path.join(root, "report", "build.js"), dS], { encoding: "utf8" });
  const evS = JSON.parse(fs.readFileSync(path.join(dS, "evidence.json"), "utf8"));
  const item = (k, id) => evS.score[k].items.find((i) => i.id === id);
  assert.ok(item("loading", "stall").value === 1500 && item("loading", "stall").stage === "settle", "settle stall in the loading stall item");
  assert.ok(!evS.score.loading.fatal.length, "settle stall is not a loading fatal");
  assert.ok(item("smooth", "stall").value !== 1500, "settle stall stays out of smoothness");
  assert.ok(fs.readFileSync(path.join(dS, "report.html"), "utf8").includes("進遊戲後等穩定"), "report says how long it waited");
}

console.log(digest.trim());
console.log(`\nok ${ticks} ticks, run at ${runDir}`);
