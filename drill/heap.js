#!/usr/bin/env node
// Heap snapshot analysis for a drill. Snapshots stay in the agent's scratchpad, never in runs/,
// and are deleted after: they hold session strings. Output is class names, property names,
// counts and sizes only; string contents are never printed.
//
//   node drill/heap.js diff a.heapsnapshot b.heapsnapshot [top]
//       Per class: count and self size in b, and the change from a.
//   node drill/heap.js retainers a.heapsnapshot b.heapsnapshot ClassName [depth] [bfs]
//       Objects of ClassName that exist only in b, grouped by their most common retainer chain.
//       bfs: search up to 14 levels for the first holder outside Spine runtime internals.
//   node drill/heap.js pools snap.heapsnapshot
//       Every object with a _pool array (cc.NodePool): memory only that pool keeps alive.
//   node drill/heap.js spine a.heapsnapshot b.heapsnapshot
//       Spine runtime skeletons in a and b, grouped by who holds them.
//
// A 300 MB snapshot needs several GB of heap; the script restarts itself with 8 GB when the
// current limit is lower. Ported from the measuring session's heap-diff, heap-retainers,
// heap-pool-retained and heap-spine-owners scripts; the algorithms are theirs.
"use strict";
const fs = require("fs");
const v8 = require("v8");
const { spawnSync } = require("child_process");

if (v8.getHeapStatistics().heap_size_limit < 6 * 1024 ** 3 && !process.env.__DRILL_HEAP_CHILD) {
  const r = spawnSync(process.execPath, ["--max-old-space-size=8192", __filename, ...process.argv.slice(2)], { stdio: "inherit", env: Object.assign({}, process.env, { __DRILL_HEAP_CHILD: "1" }) });
  process.exit(r.status == null ? 1 : r.status);
}

// One parsed snapshot with forward edge offsets and helpers.
function load(file) {
  const snap = JSON.parse(fs.readFileSync(file, "utf8"));
  const m = snap.snapshot.meta;
  const nf = m.node_fields, ef = m.edge_fields;
  const h = {
    nodes: snap.nodes, edges: snap.edges, strings: snap.strings,
    NF: nf.length, EF: ef.length, nTypes: m.node_types[0], eTypes: m.edge_types[0],
    iType: nf.indexOf("type"), iName: nf.indexOf("name"), iId: nf.indexOf("id"), iSize: nf.indexOf("self_size"), iEC: nf.indexOf("edge_count"),
    eType: ef.indexOf("type"), eName: ef.indexOf("name_or_index"), eTo: ef.indexOf("to_node"),
  };
  h.N = h.nodes.length / h.NF;
  h.first = new Uint32Array(h.N + 1);
  for (let i = 0, e = 0; i < h.N; i++) { h.first[i] = e; e += h.nodes[i * h.NF + h.iEC] * h.EF; }
  h.first[h.N] = h.edges.length;
  h.type = (i) => h.nTypes[h.nodes[i * h.NF + h.iType]];
  h.rawName = (i) => h.strings[h.nodes[i * h.NF + h.iName]];
  h.size = (i) => h.nodes[i * h.NF + h.iSize];
  h.id = (i) => h.nodes[i * h.NF + h.iId];
  // A printable name: class or function name for objects, closures and natives; the type otherwise.
  h.name = (i) => { const t = h.type(i); return t === "object" || t === "closure" || t === "native" ? h.rawName(i) : "(" + t + ")"; };
  h.edgeType = (e) => h.eTypes[h.edges[e + h.eType]];
  h.edgeName = (e) => { const t = h.edgeType(e); const v = h.edges[e + h.eName]; return t === "element" || t === "hidden" ? "[" + v + "]" : String(h.strings[v]).slice(0, 40); };
  h.to = (e) => h.edges[e + h.eTo] / h.NF;
  h.props = (i) => { const s = new Set(); for (let e = h.first[i]; e < h.first[i + 1]; e += h.EF) if (h.edgeType(e) === "property") s.add(h.strings[h.edges[e + h.eName]]); return s; };
  return h;
}
// Reverse edges: for each node, who points at it and through which edge. Weak edges are left out.
function reverse(h) {
  const cnt = new Uint32Array(h.N);
  for (let e = 0; e < h.edges.length; e += h.EF) cnt[h.edges[e + h.eTo] / h.NF]++;
  const start = new Uint32Array(h.N + 1);
  for (let i = 0; i < h.N; i++) start[i + 1] = start[i] + cnt[i];
  const from = new Uint32Array(start[h.N]);
  const edge = new Uint32Array(start[h.N]);
  const fill = start.slice(0, h.N);
  for (let i = 0; i < h.N; i++) for (let e = h.first[i]; e < h.first[i + 1]; e += h.EF) { const t = h.to(e); from[fill[t]] = i; edge[fill[t]] = e; fill[t]++; }
  return { start, from, edge };
}
const mb = (x) => (x / 1048576).toFixed(2);

// ---------- diff ----------
function classSizes(h) {
  const agg = new Map();
  let total = 0;
  for (let i = 0; i < h.N; i++) {
    const t = h.type(i);
    const size = h.size(i);
    total += size;
    const key = /string/.test(t) ? "(" + t + ")" : t === "object" || t === "closure" || t === "native" ? t + ":" + h.rawName(i) : "(" + t + ")";
    const a = agg.get(key) || { count: 0, size: 0 };
    a.count += 1;
    a.size += size;
    agg.set(key, a);
  }
  return { agg, total };
}
function diff(fa, fb, top) {
  const A = classSizes(load(fa));
  const B = classSizes(load(fb));
  const keys = new Set([...A.agg.keys(), ...B.agg.keys()]);
  const rows = [];
  for (const k of keys) {
    const a = A.agg.get(k) || { count: 0, size: 0 };
    const b = B.agg.get(k) || { count: 0, size: 0 };
    rows.push({ k: k.length > 70 ? k.slice(0, 70) + "…" : k, dc: b.count - a.count, ds: b.size - a.size, c: b.count, s: b.size });
  }
  const out = [`total ${mb(A.total)} MB -> ${mb(B.total)} MB (${B.total >= A.total ? "+" : ""}${mb(B.total - A.total)})`, "by size growth:"];
  rows.sort((x, y) => y.ds - x.ds).slice(0, top).forEach((r) => out.push(`  ${mb(r.ds).padStart(8)} MB  ${String(r.dc).padStart(8)}  now ${String(r.c).padStart(8)}  ${r.k}`));
  out.push("by count growth:");
  rows.sort((x, y) => y.dc - x.dc).slice(0, Math.min(top, 25)).forEach((r) => out.push(`  ${String(r.dc).padStart(8)}  ${mb(r.ds).padStart(8)} MB  ${r.k}`));
  return out;
}

// ---------- retainers ----------
const SPINE_INNER = new Set(["Bone", "Slot", "Skeleton", "Array", "Object", "(array)", "system / PropertyArray", "IkConstraint", "TransformConstraint", "PathConstraint", "Color", "RegionAttachment", "MeshAttachment", "ClippingAttachment", "Skin", "SkinEntry", "Float32Array", "Vector2", "(hidden)", "(object shape)", "(string)", "(number)", "(code)", "(concatenated string)", "Map", "Set"]);
function retainers(fa, fb, cls, depth, mode) {
  const out = [];
  const oldIds = new Set();
  {
    const O = load(fa);
    for (let i = 0; i < O.N; i++) if (O.rawName(i) === cls) oldIds.add(O.id(i));
  }
  const N = load(fb);
  const R = reverse(N);
  const skip = (e) => { const t = N.edgeType(e); return t === "weak" || t === "shortcut"; };
  const fresh = [];
  for (let i = 0; i < N.N; i++) if (N.rawName(i) === cls && N.type(i) === "object" && !oldIds.has(N.id(i))) fresh.push(i);
  out.push(`${cls}: new objects ${fresh.length} (old snapshot had ${oldIds.size})`);
  if (mode === "bfs") {
    const outer = new Map();
    let current = 0;
    for (const start of fresh) {
      let isCurrent = false;
      for (let r = R.start[start]; r < R.start[start + 1]; r++) if (N.name(R.from[r]) === "sp_Skeleton" && N.edgeName(R.edge[r]) === "_skeleton") isCurrent = true;
      if (isCurrent) { current++; continue; }
      const seen = new Set([start]);
      let q = [[start, []]];
      let found = null;
      for (let d = 0; d < 14 && q.length && !found; d++) {
        const nq = [];
        for (const [cur, p] of q) {
          for (let r = R.start[cur]; r < R.start[cur + 1]; r++) {
            const e = R.edge[r];
            if (skip(e)) continue;
            const from = R.from[r];
            if (seen.has(from)) continue;
            seen.add(from);
            const fname = N.name(from);
            const step = fname + "." + N.edgeName(e).replace(/^\[\d+\]$/, "[i]");
            if (!SPINE_INNER.has(fname) && !/^system/.test(fname)) { found = [step].concat(p.slice(0, 3)); break; }
            if (seen.size < 200000) nq.push([from, [step].concat(p)]);
          }
          if (found) break;
        }
        q = nq;
      }
      const key = found ? found.join("  >  ") : "(not found within 14 levels)";
      outer.set(key, (outer.get(key) || 0) + 1);
    }
    out.push(`held by a component as its current skeleton: ${current}, others: ${fresh.length - current}`);
    [...outer.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15).forEach(([k, v]) => out.push(String(v).padStart(5) + "  " + k));
    return out;
  }
  // Walk up the first strong retainer that is not already on the chain, depth levels.
  const chains = new Map();
  for (const start of fresh.slice(0, 400)) {
    const parts = [];
    let cur = start;
    const seen = new Set([cur]);
    for (let d = 0; d < depth; d++) {
      let pick = -1, pickEdge = -1;
      for (let r = R.start[cur]; r < R.start[cur + 1]; r++) {
        const e = R.edge[r];
        if (skip(e)) continue;
        const from = R.from[r];
        if (seen.has(from)) continue;
        const fname = N.name(from);
        if (fname === "(system)" || fname === "system / Context") continue;
        pick = from; pickEdge = e;
        if (!/^\(/.test(fname)) break;
      }
      if (pick < 0) break;
      parts.push(N.name(pick) + "." + N.edgeName(pickEdge).replace(/^\[\d+\]$/, "[i]"));
      seen.add(pick);
      cur = pick;
    }
    const key = parts.join("  <  ");
    chains.set(key, (chains.get(key) || 0) + 1);
  }
  [...chains.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12).forEach(([k, v]) => out.push(String(v).padStart(5) + "  " + k));
  return out;
}

// ---------- pools ----------
function pools(file) {
  const h = load(file);
  const out = [];
  const found = [];
  for (let i = 0; i < h.N; i++) {
    if (h.type(i) !== "object") continue;
    for (let e = h.first[i]; e < h.first[i + 1]; e += h.EF) {
      if (h.edgeType(e) === "property" && h.strings[h.edges[e + h.eName]] === "_pool") {
        const arr = h.to(e);
        let cnt = 0;
        for (let f = h.first[arr]; f < h.first[arr + 1]; f += h.EF) if (h.edgeType(f) === "element") cnt++;
        found.push({ owner: i, edge: e, arr, cnt });
      }
    }
  }
  found.sort((a, b) => b.cnt - a.cnt);
  out.push(`NodePools: ${found.length} top sizes: ${found.slice(0, 6).map((p) => p.cnt).join(",")}`);
  const bfs = (starts, skipEdge) => {
    const mark = new Uint8Array(h.N);
    const q = new Uint32Array(h.N);
    let hd = 0, tl = 0;
    for (const s of starts) if (!mark[s]) { mark[s] = 1; q[tl++] = s; }
    while (hd < tl) {
      const i = q[hd++];
      for (let e = h.first[i]; e < h.first[i + 1]; e += h.EF) {
        if (h.edgeType(e) === "weak" || e === skipEdge) continue;
        const j = h.to(e);
        if (!mark[j]) { mark[j] = 1; q[tl++] = j; }
      }
    }
    return mark;
  };
  for (const p of found.slice(0, 2)) {
    const fromRoot = bfs([0], p.edge);
    const fromPool = bfs([p.arr], -1);
    let ret = 0, cnt = 0;
    const byType = new Map();
    for (let i = 0; i < h.N; i++) {
      if (fromPool[i] && !fromRoot[i]) {
        ret += h.size(i); cnt++;
        const t = h.type(i);
        const k = t === "object" ? "object:" + h.rawName(i) : t === "native" ? "native:" + h.rawName(i) : "(" + t + ")";
        const v = byType.get(k) || [0, 0]; v[0]++; v[1] += h.size(i); byType.set(k, v);
      }
    }
    out.push(`pool of ${p.cnt}: retains ${mb(ret)} MB in ${cnt} objects (${p.cnt ? (ret / p.cnt / 1024).toFixed(0) : 0} KB per element)`);
    [...byType.entries()].sort((a, b) => b[1][1] - a[1][1]).slice(0, 8).forEach(([k, v]) => out.push(`    ${mb(v[1]).padStart(6)} MB ${String(v[0]).padStart(7)} ${k}`));
  }
  return out;
}

// ---------- spine ----------
function isSkeleton(h, i) {
  if (h.type(i) !== "object") return false;
  const p = h.props(i);
  return p.has("bones") && p.has("slots") && p.has("_updateCache") && p.has("data");
}
function isSpineInternal(h, i) {
  if (h.type(i) !== "object") return h.type(i) === "array";
  const p = h.props(i);
  return p.has("bone") || p.has("skeleton") || p.has("bones") || p.has("_updateCache") || (p.has("parent") && p.has("children") && p.has("data"));
}
function spineOwners(h) {
  const rev = new Map();
  for (let i = 0; i < h.N; i++) for (let e = h.first[i]; e < h.first[i + 1]; e += h.EF) {
    if (h.edgeType(e) === "weak") continue;
    const to = h.to(e);
    let l = rev.get(to);
    if (!l) rev.set(to, (l = []));
    l.push([i, e]);
  }
  const label = (i) => { const p = h.props(i); const hint = ["node", "_skeleton", "skeletonData", "_N$skeletonData", "_name", "_objFlags", "_enabled"].filter((k) => p.has(k)).join("/"); return h.type(i) + ":" + h.rawName(i) + (hint ? "{" + hint + "}" : ""); };
  const owners = new Map();
  let n = 0;
  for (let i = 0; i < h.N; i++) {
    if (!isSkeleton(h, i)) continue;
    n++;
    const p = [];
    let cur = i, hops = 0;
    const seen = new Set([i]);
    while (hops < 10) {
      const r = (rev.get(cur) || []).filter(([o]) => !seen.has(o));
      if (!r.length) { p.push("(none)"); break; }
      const [o, e] = r.find(([x]) => !isSpineInternal(h, x)) || r[0];
      p.push(label(o) + "." + h.edgeName(e));
      seen.add(o);
      if (!isSpineInternal(h, o) && h.type(o) !== "array") {
        const r2 = (rev.get(o) || []).filter(([q]) => !seen.has(q));
        const pk = r2.find(([q]) => h.type(q) === "object" && !isSpineInternal(h, q)) || r2[0];
        if (pk) p.push(label(pk[0]) + "." + h.edgeName(pk[1]));
        break;
      }
      cur = o;
      hops++;
    }
    const k = p.join("  <  ");
    owners.set(k, (owners.get(k) || 0) + 1);
  }
  return { n, owners };
}
function spine(fa, fb) {
  const oa = spineOwners(load(fa));
  const ob = spineOwners(load(fb));
  const out = [`skeletons a=${oa.n} b=${ob.n}`];
  const keys = new Set([...oa.owners.keys(), ...ob.owners.keys()]);
  [...keys].map((k) => [k, oa.owners.get(k) || 0, ob.owners.get(k) || 0]).sort((x, y) => (y[2] - y[1]) - (x[2] - x[1])).slice(0, 12).forEach(([k, a, b]) => out.push(`${String(a).padStart(4)} -> ${String(b).padStart(4)}   ${k}`));
  return out;
}

const [cmd, ...args] = process.argv.slice(2);
const usage = "usage: node drill/heap.js diff|retainers|pools|spine ... (see the top of this file)";
let lines;
try {
  if (cmd === "diff" && args.length >= 2) lines = diff(args[0], args[1], Number(args[2]) || 40);
  else if (cmd === "retainers" && args.length >= 3) lines = retainers(args[0], args[1], args[2], Number(args[3]) || 7, args[4] === "bfs" || args[3] === "bfs" ? "bfs" : "chain");
  else if (cmd === "pools" && args.length >= 1) lines = pools(args[0]);
  else if (cmd === "spine" && args.length >= 2) lines = spine(args[0], args[1]);
  else { console.error(usage); process.exit(2); }
} catch (e) {
  console.error("heap: " + (e && e.message));
  process.exit(1);
}
console.log(lines.join("\n"));
