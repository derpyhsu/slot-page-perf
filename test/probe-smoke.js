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
const scene = node("scene", [], [startBtn, node("a", [new Skeleton(0), new Label()]), node("b", [new Skeleton(1)])], { getComponentsInChildren: () => [cam] });
const assets = [new Texture2D(2048, 2048, 35), new Texture2D(1024, 1024, 99)];
let ticks = 0;
global.cc = {
  ENGINE_VERSION: "3.8.2",
  Texture2D,
  UITransform,
  Camera,
  Vec3,
  js: { getClassName: (o) => names.get(o.constructor) || "Other" },
  assetManager: { assets: { forEach: (f) => assets.forEach(f) } },
  director: { tick() { ticks += 1; now += 3; }, mainLoop() { throw new Error("3.x never calls mainLoop"); }, getScene: () => scene },
  game: { frameRate: 60 },
  macro: {},
};

eval(src);
const P = global.__slotPerf;

function advance(ms) {
  const end = now + ms;
  while (now < end) {
    now += 13.67;
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
assert.ok(idle.fpsLow > 0 && idle.badShare === 0, "1% low and bad-frame share per stage");
assert.strictEqual(idle.gpuMemMb.peak, 5, "stage GPU memory peak");
assert.strictEqual(s.memory.gpu.peakMb, 5);
assert.strictEqual(snap.spine.realtime, 1);
assert.strictEqual(snap.console[0].count, 2, "console grouped");
assert.ok(!JSON.stringify(snap).includes("secret"), "no token in snapshot");

scene.children.push(node("notice_bg", [new Label("点击任意位置继续")], [], { hasEventListener: (e) => e === "touch-end" }));
scene.children.push(node("btn_buy_start", [new Button()], [node("t", [new Label("购买免费游戏")])]));
startBtn.activeInHierarchy = false;
assert.deepStrictEqual(pick(), { spinReady: false, start: [], dismiss: ["notice_bg"], tap: ["点击任意位置继续"] }, "touch node and tap-anywhere found, buy button avoided");
scene.children.push(node("btn_spin", [new Button()]));
assert.strictEqual(pick().spinReady, true, "spin button ready");

const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "slot-page-perf-smoke-"));
const raw = { autopilot: 1, summary: s, cocos: { snapshots: [snap] }, entry: { result: "pressed", steps: [{ kind: "button", text: "开始", afterMs: 900 }] }, coverage: { "history-before": "not found" } };
fs.writeFileSync(path.join(runDir, "raw.json"), "Script ran on page and returned:\n```json\n" + JSON.stringify(raw) + "\n```\n");
const digest = execFileSync(process.execPath, [path.join(root, "report", "build.js"), runDir], { encoding: "utf8" });
const ev = JSON.parse(fs.readFileSync(path.join(runDir, "evidence.json"), "utf8"));
const md = fs.readFileSync(path.join(runDir, "report.md"), "utf8");
assert.ok(ev.fps.some((r) => r.group === "spin" && r.stages === 12), "spins grouped in the FPS table");
assert.ok(md.includes("各階段 FPS") && md.includes("進遊戲"), "report shows FPS table and entry");
assert.ok(!/secret|token=/.test(JSON.stringify(ev) + md), "no token in evidence or report");
console.log(digest.trim());
console.log(`\nok ${ticks} ticks, run at ${runDir}`);
