#!/usr/bin/env node
// Usage: node test/drill-smoke.js
// Runs drill/page.js against a fake Cocos 2.4 scene whose draw calls come from a tiny batcher
// that flushes like RenderComponent._checkBacth (material hash or culling mask changes, opacity 0
// subtree skipped), then checks drawcalls(). Exits non-zero on the first failed check.
"use strict";

const fs = require("fs");
const path = require("path");
const assert = require("assert");

const src = fs.readFileSync(path.join(__dirname, "..", "drill", "page.js"), "utf8");

class Sprite {}
class Label {}
class Mask {}
class Camera {}
const names = new Map([[Sprite, "cc.Sprite"], [Label, "cc.Label"], [Mask, "cc.Mask"], [Camera, "cc.Camera"]]);
const tex = (file) => ({ nativeUrl: `assets/res/${file}?v=secret` });
const mat = (h, t) => ({ getHash: () => h, getProperty: (k) => (k === "texture" ? t : null) });
const T = { bg: tex("bg.png"), card: tex("card_base.png"), state: tex("card_state.png"), num: tex("digits.png"), road: tex("road.png") };

function node(name, comp, children = [], box = null) {
  const n = { name, active: true, activeInHierarchy: true, _opacity: 255, _cullingMask: 1, children, _components: [], box };
  Object.defineProperty(n, "opacity", { get() { return this._opacity; }, set(v) { this._opacity = v; }, enumerable: true });
  if (comp) { n._renderComponent = comp; comp.node = n; comp.enabled = true; comp.enabledInHierarchy = true; n._components.push(comp); }
  children.forEach((c) => { c.parent = n; });
  n.getBoundingBoxToWorld = () => {
    const boxes = [];
    const walk = (x) => { if (x.box) boxes.push(x.box); x.children.forEach(walk); };
    walk(n);
    if (!boxes.length) return { x: 0, y: 0, width: 0, height: 0 };
    const x0 = Math.min(...boxes.map((b) => b[0])), y0 = Math.min(...boxes.map((b) => b[1]));
    const x1 = Math.max(...boxes.map((b) => b[0] + b[2])), y1 = Math.max(...boxes.map((b) => b[1] + b[3]));
    return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
  };
  return n;
}
const sprite = (t, h) => Object.assign(new Sprite(), { _materials: [mat(h, t)] });
const label = (t, h) => Object.assign(new Label(), { _materials: [mat(h, t)], cacheMode: 0, useSystemFont: true });

// Ten cards whose base, state and number sit on three textures, interleaved: three batches each.
const cards = node("cards", null, Array.from({ length: 10 }, (_, i) => node(`card_${i + 1}`, null, [
  node("bg", sprite(T.card, "m-card"), [], [100 + i * 60, 100, 50, 80]),
  node("state", sprite(T.state, "m-state"), [], [100 + i * 60, 100, 50, 80]),
  node("num", sprite(T.num, "m-num"), [], [100 + i * 60, 100, 50, 30]),
])));
// A road map moved off screen but still active: still drawn.
const road = node("road", null, [node("grid", sprite(T.road, "m-road"), [], [3000, 100, 400, 300]), node("title", label(null, "m-title-label"), [], [3000, 400, 200, 40])]);
const bg = node("bg", sprite(T.bg, "m-bg"), [], [0, 0, 1280, 720]);
const cam = node("Main Camera", null);
cam._components.push(new Camera());
const canvas = node("Canvas", null, [cam, bg, cards, road]);
const scene = node("scene", null, [canvas]);
canvas.parent = scene;

// The batcher: walks in draw order, skips inactive and opacity 0 subtrees, flushes on a new
// material hash or culling mask.
function drawCount() {
  let n = 0;
  let cur = null;
  const walk = (x) => {
    if (!x.activeInHierarchy || x._opacity === 0) return;
    const c = x._renderComponent;
    if (c) {
      const k = c._materials[0].getHash() + "|" + x._cullingMask;
      if (k !== cur) { n += 1; cur = k; }
    }
    x.children.forEach(walk);
  };
  walk(scene);
  return n;
}

const listeners = {};
global.window = global;
global.performance = { now: () => Date.now() };
global.cc = {
  ENGINE_VERSION: "2.4.9",
  renderer: { drawCalls: 0 },
  Director: { EVENT_AFTER_DRAW: "director_after_draw" },
  director: {
    getScene: () => scene,
    on(e, f) { (listeners[e] = listeners[e] || []).push(f); },
    off(e, f) { listeners[e] = (listeners[e] || []).filter((g) => g !== f); },
  },
  view: { getVisibleSize: () => ({ width: 1280, height: 720 }), getVisibleOrigin: () => ({ x: 0, y: 0 }) },
  js: { getClassName: (o) => names.get(o && o.constructor) || "Other" },
  find: (p) => (p === "Canvas" ? canvas : null),
};
const timer = setInterval(() => {
  cc.renderer.drawCalls = drawCount();
  (listeners.director_after_draw || []).slice().forEach((f) => f());
}, 2);

(async () => {
  assert.strictEqual(eval(src)(), "drill ok");
  const D = global.__slotDrill;
  assert.strictEqual(D.counter, "cc.renderer.drawCalls");
  assert.strictEqual(D.method, "opacity");
  const before = drawCount();
  const r = await D.drawcalls({ frames: 3 });
  clearInterval(timer);
  assert.strictEqual(r.status, "ok", JSON.stringify(r.note));
  assert.strictEqual(r.base, before, "baseline is the batcher's count");
  // bg 1 + cards 30 (3 per card) + road 2 = 33.
  assert.strictEqual(r.base, 33);
  assert.strictEqual(r.levels[0].under, "(scene)");
  assert.strictEqual(r.levels[1].rows[0].path, "Canvas/cards", "cards found as the biggest subtree");
  assert.strictEqual(r.levels[1].rows[0].draws, 30);
  assert.ok(!r.levels[1].rows.some((x) => /Camera/.test(x.path)), "camera not toggled");
  const cardRow = r.levels[2].rows[0];
  assert.ok(cardRow.path === "Canvas/cards/card_*" && cardRow.n === 10 && cardRow.draws === 30, "ten cards measured as one group");
  const pair = r.breaks.pairs.find((p) => p.from === "Canvas/cards/card_*/bg" && p.to === "Canvas/cards/card_*/state");
  assert.ok(pair && pair.reason === "texture" && pair.n === 10 && pair.fromTex === "card_base.png" && pair.toTex === "card_state.png", "interleaved textures named as breaks");
  assert.ok(r.offscreenDrawn.some((x) => x.path === "Canvas/road" && x.draws === 2), "off-screen road still drawn");
  assert.ok(r.restore.ok, "every value restored");
  const all = [];
  (function walk(x) { all.push(x); x.children.forEach(walk); })(scene);
  assert.ok(all.every((x) => x._opacity === 255), "no node left hidden");
  assert.ok(!JSON.stringify(r).includes("secret"), "no query string in output");
  assert.ok(r.summary.some((l) => l.includes("card_base.png → card_state.png")), "summary names the textures");
  console.log(r.summary.join("\n"));
  console.log("ok drill drawcalls");
})().catch((e) => { clearInterval(timer); console.error(e); process.exit(1); });
