#!/usr/bin/env node
// Usage: node test/heap-smoke.js
// Writes two real V8 heap snapshots of this process (a planted class that grows, a NodePool-like
// _pool, a secret string) and checks drill/heap.js diff, retainers and pools on them.
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const v8 = require("v8");
const assert = require("assert");
const { execFileSync } = require("child_process");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "drill-heap-"));
const heap = path.join(__dirname, "..", "drill", "heap.js");
const run = (...a) => execFileSync(process.execPath, [heap, ...a], { encoding: "utf8", env: Object.assign({}, process.env, { __DRILL_HEAP_CHILD: "1" }) });

class SymbolFx { constructor(i) { this.i = i; this.buf = new Array(32).fill(i); } }
class FxHolder { constructor() { this.live = []; } }
class NodePool { constructor() { this._pool = []; } }
class Skeleton { constructor() { this.bones = []; this.slots = []; this._updateCache = []; this.data = {}; } }
class SpComp { constructor() { this.node = {}; this._skeleton = new Skeleton(); } }
const holder = new FxHolder();
const pool = new NodePool();
global.__keep = { holder, pool, secret: "SESSION-TOKEN-" + "abc123xyz" };
for (let i = 0; i < 5; i++) holder.live.push(new SymbolFx(i));
const a = v8.writeHeapSnapshot(path.join(dir, "a.heapsnapshot"));
for (let i = 5; i < 205; i++) holder.live.push(new SymbolFx(i));
holder.spines = [new SpComp(), new SpComp(), new SpComp()];
for (let i = 0; i < 50; i++) pool._pool.push({ kind: "pooled", data: new Array(64).fill(i) });
const b = v8.writeHeapSnapshot(path.join(dir, "b.heapsnapshot"));

try {
  const d = run("diff", a, b, "20");
  assert.ok(/^\s+200\s.*object:SymbolFx$/m.test(d), "diff counts the 200 new SymbolFx");
  const r = run("retainers", a, b, "SymbolFx", "3");
  assert.ok(/SymbolFx: new objects 200/.test(r) && /FxHolder\.live/.test(r), "new SymbolFx held through FxHolder.live");
  const p = run("pools", b);
  assert.ok(/NodePools: \d+ top sizes: 50/.test(p) && /pool of 50: retains/.test(p), "the 50-element pool found and sized");
  const sp = run("spine", a, b);
  assert.ok(/skeletons a=0 b=3/.test(sp) && sp.includes("object:SpComp{node/_skeleton}._skeleton"), "Spine skeletons counted with their holder");
  assert.ok(!/SESSION-TOKEN|abc123xyz/.test(d + r + p + sp), "no string contents printed");
  console.log("ok drill heap");
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
