// Applies protocol/rules.md to an evidence object. Used by report/build.js.
"use strict";

const { stageFrames } = require("./frames");

const SOFTWARE_GPU = /swiftshader|basic render driver|llvmpipe|softpipe|warp/i;

function round(n, d = 1) {
  const k = Math.pow(10, d);
  return Math.round(n * k) / k;
}

// Stage name to report group. Spins and turbo spins collapse into one group each.
function groupOf(name) {
  if (/^spin-\d+$/.test(name)) return "spin";
  if (/^turbo-\d+$/.test(name)) return "turbo";
  return name.replace(/-spike$/, "");
}

const GAME_GROUPS = new Set(["idle", "spin", "turbo", "history-before", "rules", "idle-after-rules", "history-after", "idle-end", "feature", "idle-after-feature"]);

// Frame-weighted stats per group. Spike windows stay separate from the steady panel stage.
function groups(stages) {
  const out = new Map();
  stages.forEach((s) => {
    if (!s.frames || s.name === "gap") return;
    const g = s.name.endsWith("-spike") ? s.name : groupOf(s.name);
    const row = out.get(g) || { group: g, stages: 0, frames: 0, ms: 0, bad: 0, drop: 0, dropFrames: 0, lows: [], cpuP95: [], draws: 0, gpuPeak: null, heapEnd: null, hitches: [], pres: { frames: 0, ms: 0, bad: 0, off: 0, exp: 0, lows: [], wasted: 0 } };
    row.stages += 1;
    row.frames += s.frames;
    if (s.fps) row.ms += (s.frames * 1000) / s.fps;
    if (s.badShare != null) row.bad += s.badShare * s.frames;
    if (s.dropShare != null) {
      row.drop += s.dropShare * s.frames;
      row.dropFrames += s.frames;
    }
    if (s.fpsLow != null) row.lows.push(s.fpsLow);
    if (s.cpuMs && s.cpuFrames) row.cpuP95.push(s.cpuMs.p95);
    if (s.draws) row.draws += s.draws.avg * s.frames;
    if (s.gpuMemMb && (row.gpuPeak == null || s.gpuMemMb.peak > row.gpuPeak)) row.gpuPeak = s.gpuMemMb.peak;
    if (s.heapEndMb != null) row.heapEnd = s.heapEndMb;
    (s.hitches || []).forEach((h) => row.hitches.push(Object.assign({ stage: s.name }, h)));
    const f = stageFrames(s);
    if (f) {
      const p = row.pres;
      p.frames += f.frames;
      p.ms += (f.frames * 1000) / f.fps;
      p.bad += f.badShare * f.frames;
      p.off += f.offShare * f.frames;
      p.exp += f.expectedMs * f.frames;
      p.wasted += f.wasted;
      if (f.fpsLow != null) p.lows.push(f.fpsLow);
    }
    out.set(g, row);
  });
  // Across many spins, the 1% low is the 10th percentile of per-spin 1% lows.
  const low = (xs) => {
    const lows = xs.slice().sort((a, b) => a - b);
    return lows.length ? lows[Math.floor((lows.length - 1) * (lows.length > 5 ? 0.1 : 0))] : null;
  };
  return [...out.values()].map((r) => {
    // Presented frames when the probe saw them (protocol/rules.md 幀節奏); engine frames otherwise.
    const p = r.pres.frames ? r.pres : null;
    const fps = p ? round((1000 * p.frames) / p.ms) : r.ms ? round((1000 * r.frames) / r.ms) : null;
    const expectedFps = p ? round((1000 * p.frames) / p.exp) : null;
    return {
      group: r.group,
      stages: r.stages,
      frames: r.frames,
      fps,
      fpsLow: p ? low(p.lows) : low(r.lows),
      badShare: p ? round(p.bad / p.frames, 3) : r.frames ? round(r.bad / r.frames, 3) : null,
      dropShare: p ? round(Math.max(0, 1 - fps / expectedFps), 3) : r.dropFrames ? round(r.drop / r.dropFrames, 3) : null,
      presented: !!p,
      expectedFps,
      offShare: p ? round(p.off / p.frames, 3) : null,
      wasted: p ? p.wasted : null,
      cpuP95: r.cpuP95.length ? round(Math.max(...r.cpuP95)) : null,
      draws: r.frames ? round(r.draws / r.frames) : null,
      gpuPeakMb: r.gpuPeak,
      heapEndMb: r.heapEnd,
      worstHitch: r.hitches.sort((a, b) => b.dt - a.dt)[0] || null,
      hitchCount: r.hitches.length,
    };
  });
}

// Heap floor per spin: the lowest heap sample from the spin's start over floorWindowMs (or the
// spin, if longer), so a short spin still spans a few samples. A spin that runs featureFactor
// times longer than its group's median is a feature (free games, bonus): it loads assets that
// stay. A floor drop of majorGcDropMb or more is a major GC. Floors are fitted per segment
// between features and major GCs, so neither step counts as growth. Slopes are MB per spin,
// pooled across segments. The floor after the last major GC tells whether the rise was reclaimed.
function heapFit(ev, T) {
  const stages = ev.stages || [];
  const spins = stages.filter((s) => /^(spin|turbo)-\d+$/.test(s.name));
  if (spins.length < T.warmupSpins + T.leakTailSpins) return { status: "not-enough-spins", spins: spins.length };
  const heap = (ev.timeline && ev.timeline.heap) || [];
  const floorOf = (s) => {
    const end = s.startMs + Math.max(s.wallMs, T.heap.floorWindowMs);
    const xs = heap.filter((p) => p[0] >= s.startMs && p[0] <= end).map((p) => p[1]);
    return xs.length ? Math.min(...xs) : s.heapEndMb;
  };
  const median = (xs) => {
    const a = xs.slice().sort((x, y) => x - y);
    return a.length ? a[Math.floor((a.length - 1) / 2)] : null;
  };
  const wall = {};
  ["spin", "turbo"].forEach((k) => (wall[k] = median(spins.filter((s) => groupOf(s.name) === k).map((s) => s.wallMs))));
  const rows = spins.map((s, i) => ({ i, name: s.name, floor: floorOf(s), feature: wall[groupOf(s.name)] != null && s.wallMs > T.heap.featureFactor * wall[groupOf(s.name)] }));
  const used = rows.slice(T.warmupSpins);
  const segments = [];
  const gcs = [];
  let cur = [];
  used.forEach((r) => {
    if (r.feature) {
      if (cur.length) segments.push(cur);
      cur = [];
      return;
    }
    if (r.floor == null) return;
    const prev = cur[cur.length - 1];
    if (prev && prev.floor - r.floor >= T.heap.majorGcDropMb) {
      gcs.push({ spin: r.name, from: prev.floor, to: r.floor });
      segments.push(cur);
      cur = [];
    }
    cur.push(r);
  });
  if (cur.length) segments.push(cur);
  const slope = (segs) => {
    let sxy = 0;
    let sxx = 0;
    segs.forEach((seg) => {
      if (seg.length < 2) return;
      const mx = seg.reduce((a, r) => a + r.i, 0) / seg.length;
      const my = seg.reduce((a, r) => a + r.floor, 0) / seg.length;
      seg.forEach((r) => {
        sxy += (r.i - mx) * (r.floor - my);
        sxx += (r.i - mx) * (r.i - mx);
      });
    });
    return sxx ? sxy / sxx : null;
  };
  const points = segments.reduce((a, seg) => a + seg.length, 0);
  const tailIds = new Set(segments.flat().slice(-T.leakTailSpins).map((r) => r.i));
  const all = slope(segments);
  const tail = slope(segments.map((seg) => seg.filter((r) => tailIds.has(r.i))));
  const kept = segments.flat();
  return {
    status: all == null ? "too-few-points" : "ok",
    slopeMb: all == null ? null : round(all, 3),
    tailSlopeMb: tail == null ? null : round(tail, 3),
    points,
    growthMb: all == null ? null : round(all * points),
    featureSpins: rows.filter((r) => r.feature).map((r) => r.name),
    majorGcs: gcs,
    // Lowest floor after the last major GC, against the first floor: what the heap kept.
    retainedMb: gcs.length && kept.length ? round(Math.min(...segments[segments.length - 1].map((r) => r.floor)) - kept[0].floor) : null,
    from: kept.length ? kept[0].floor : null,
    to: kept.length ? kept[kept.length - 1].floor : null,
  };
}

// Cause of one stall, per protocol/rules.md "長幀歸因". Returns null unless one measured factor
// covers at least half of the stall and names something specific to look at.
const ENGINE_FILE = /cocos|cc\.js|cc-|engine|_virtual|polyfill|system\.bundle|import-map|physics|spine|dragonbones/i;
const READABLE = (n) => typeof n === "string" && n.length >= 4 && !/^[\w$]{1,2}$/.test(n) && !/^[0-9a-f]{5,}/i.test(n) && !/^[\w$]{1,2}\./.test(n) && n !== "?";
const INVOKER = { "user-callback": "回呼", "event-listener": "事件", "resolve-promise": "Promise", "reject-promise": "Promise", "classic-script": "腳本載入", "module-script": "模組載入" };
function stallCause(h, loafs) {
  const dt = h.dt;
  if (!(dt > 0)) return null;
  const half = dt * 0.5;
  const c = [];
  const w = h.work;
  if (w) {
    // Many downloads landing at once: the parse and upload work they bring, counted together.
    const loadMs = (w.desMs || 0) + (w.texMs || 0);
    if (w.dlDone >= 2 && loadMs >= half) c.push({ kind: "loading-burst", ms: loadMs, inFlight: w.dlMax, done: w.dlDone, names: w.dlNames, desMs: w.desMs, texMs: w.texMs, texN: w.texN, mb: w.texMb, top: w.texTop, topMb: w.texTopMb, rank: 1 });
    else {
      if (w.texMs >= half && w.texN) c.push({ kind: "texture-upload", ms: w.texMs, n: w.texN, mb: w.texMb, top: w.texTop, topMb: w.texTopMb });
      if (w.desMs >= half && w.desN) c.push({ kind: "deserialize", ms: w.desMs, n: w.desN });
    }
    if (w.shMs >= half && w.shN) c.push({ kind: "shader-compile", ms: w.shMs, n: w.shN });
    if (w.instMs >= half && w.instN) c.push({ kind: "instantiate", ms: w.instMs, n: w.instN, name: READABLE(w.instTop) ? w.instTop : undefined });
    // Spine data parsed on first use sits inside instantiate or onLoad, so it outranks them.
    const sp = w.sp;
    if (sp && sp.ms >= half) c.push({ kind: "spine-build", ms: sp.ms, n: sp.n, name: READABLE(sp.top) ? sp.top : undefined, topMs: sp.topMs, rank: 1 });
    // Label time sits inside component and render time, so it outranks them: it names the nodes.
    const lb = w.lbl;
    if (lb && lb.ms >= half && lb.top && lb.top.length) c.push({ kind: "label", ms: lb.ms, n: lb.n, top: lb.top, rank: 1 });
    const top = (w.comps || [])[0];
    if (top && top[1] >= half && READABLE(top[0].replace(/\.(update|lateUpdate)$/, ""))) c.push({ kind: "component", ms: top[1], name: top[0] });
    const heavy = (w.texMs || 0) + (w.shMs || 0);
    if (w.rndMs != null && h.draws != null && w.rndMs - heavy >= half) c.push({ kind: "render", ms: w.rndMs, draws: h.draws });
    // Containers: node activation, editor-wired callbacks and WebSocket message handlers hold the
    // work above. They win only when nothing inside them is named; otherwise they go into inside.
    const act = w.act;
    if (act && act.ms >= half) c.push({ kind: "activate", ms: act.ms, n: act.n, off: act.off, churn: act.churn, top: act.top, topMs: act.topMs, rank: -1 });
    const hd = w.hd;
    if (hd && hd.ms >= half && READABLE(hd.top)) c.push({ kind: "handler", ms: hd.ms, n: hd.n, name: hd.top, rank: -2 });
    const ws = w.ws;
    if (ws && ws.ms >= half) c.push({ kind: "websocket", ms: ws.ms, n: ws.n, topMs: ws.topMs, topKb: ws.topKb, rank: -3 });
  }
  // A Long Animation Frame overlapping the stall: forced layout, or one script outside the engine.
  const lf = loafs.filter((l) => l[0] < h.t + dt && h.t < l[0] + l[1]).sort((a, b) => b[1] - a[1])[0];
  if (lf) {
    if (lf[3] >= half) c.push({ kind: "layout", ms: lf[3] });
    const s = (lf[4] || [])[0];
    if (s && s[4] >= half && s[2] && !ENGINE_FILE.test(s[2]) && !(s[0] === "user-callback" && /FrameRequestCallback/i.test(s[1]))) {
      const file = s[2].split("/").filter(Boolean).slice(-2).join("/");
      c.push({ kind: "script", ms: s[4], file, fn: READABLE(s[3]) ? s[3] : undefined, invoker: s[1] || undefined, via: INVOKER[s[0]] || s[0] });
    }
  }
  if (!c.length) return null;
  // A factor longer than the stall means the ledger spanned more than this frame; trust none of it.
  if (c.some((f) => f.ms > dt * 1.1)) return null;
  const best = c.sort((a, b) => (b.rank || 0) - (a.rank || 0) || b.ms - a.ms)[0];
  const inside = c.filter((x) => x !== best && x.rank < 0).sort((a, b) => a.rank - b.rank);
  c.forEach((x) => delete x.rank);
  best.ms = round(best.ms);
  best.share = round(best.ms / dt, 2);
  if (inside.length) best.inside = inside.map((x) => Object.assign({}, x, { ms: round(x.ms) }));
  return best;
}

// System-font and TTF label textures uploaded in a stall, when they took a quarter of it or more.
function canvasNote(h) {
  const tc = h.work && h.work.texCanvas;
  if (!tc || !(h.dt > 0) || tc.ms < h.dt * 0.25 || tc.ms > h.dt * 1.1) return undefined;
  return tc;
}
function canvasText(tc, dt) {
  const who = (tc.top || []).map((g) => `${g.path} ${g.n} 次 ${g.mb} MB`).join("、");
  return `系統字貼圖上傳 ${tc.n} 次、${tc.mb} MB、${round(tc.ms)} ms（佔這次停頓 ${Math.round((tc.ms / dt) * 100)}%）${who ? `：${who}` : ""}`;
}

// Labels a stall spent time on, as measured: folded node path, how many, time, font and settings.
const FONT_KIND = { system: "系統字", ttf: "TTF", bmfont: "BMFont" };
function labelList(top) {
  return (top || []).map((g) => {
    const bits = [`${g.n} 個 ${round(g.ms)} ms`, `${FONT_KIND[g.font] || g.font}${g.fontName ? ` ${g.fontName}` : ""}${g.size ? ` ${g.size}px` : ""}`, `cacheMode ${g.cache}`, `overflow ${g.overflow}`];
    if (g.chars != null) bits.push(`最長 ${g.chars} 字`);
    if (g.wrap) bits.push("自動換行");
    if (g.effects) bits.push(g.effects.join("+"));
    return `${g.path}（${bits.join("，")}）`;
  }).join("；");
}
// Label time worth naming on a stall whose cause is something else, or that has no cause.
function labelNote(h) {
  const lb = h.work && h.work.lbl;
  if (!lb || !(h.dt > 0) || lb.ms < h.dt * 0.25 || !lb.top || !lb.top.length || lb.ms > h.dt * 1.1) return undefined;
  return lb;
}
function labelText(lb, dt) {
  return `Label 更新 ${lb.n} 次，花 ${round(lb.ms)} ms（佔 ${Math.round((lb.ms / dt) * 100)}%）：${labelList(lb.top)}`;
}

// Heap floors after the three forced GCs (after-warmup, mid, end). Each half's rise per spin; the
// smaller one, taken over all the spins, is the rise both halves share (steadyMb).
function gcHalves(ev) {
  const gc = (ev.gc || []).filter((x) => x.mb != null);
  const a = gc.find((x) => x.at === "after-warmup");
  const m = gc.find((x) => x.at === "mid");
  const b = gc.find((x) => x.at === "end");
  if (!a || !m || !b || !(m.spins > a.spins) || !(b.spins > m.spins)) return null;
  const d1 = m.mb - a.mb;
  const d2 = b.mb - m.mb;
  const rate = Math.max(0, Math.min(d1 / (m.spins - a.spins), d2 / (b.spins - m.spins)));
  return { from: a.mb, mid: m.mb, to: b.mb, spins: [a.spins, m.spins, b.spins], deltas: [round(d1, 2), round(d2, 2)], ratePerSpin: rate, steadyMb: round(rate * (b.spins - a.spins), 2), totalMb: round(b.mb - a.mb, 2) };
}

// Node counts between two probe censuses (autopilot takeCensus): scene groups by folded path
// that gained at least minNodes, and instantiated nodes still referenced after the forced GC,
// by source name. A group missing from a capped list is skipped, not taken as zero.
function censusAt(ev, at) {
  return ((ev.census || []).filter((c) => c && c.status === "ok" && c.at === at)).slice(-1)[0] || null;
}
function sceneDiff(a, b, min) {
  const am = new Map((a.paths || []).map((p) => [p[0], p]));
  const out = [];
  (b.paths || []).forEach((p) => {
    const q = am.get(p[0]);
    const from = q ? q[1] : a.truncated ? null : 0;
    if (from == null || p[1] - from < min) return;
    out.push({ path: p[0], from, to: p[1], activeFrom: q ? q[2] : 0, activeTo: p[2] });
  });
  return out.sort((x, y) => (y.to - y.from) - (x.to - x.from)).slice(0, 5);
}
function madeDiff(a, b, min, m) {
  const al = (a.made && a.made.byName) || [];
  const am = new Map(al.map((g) => [g.name, g]));
  const mm = new Map(((m && m.made && m.made.byName) || []).map((g) => [g.name, g]));
  const zero = { inScene: 0, detached: 0, destroyed: 0 };
  const out = [];
  ((b.made && b.made.byName) || []).forEach((g) => {
    const q = am.get(g.name) || (al.length >= 40 ? null : zero);
    if (!q) return;
    const d = g.detached - q.detached;
    const x = g.destroyed - q.destroyed;
    const pl = (g.pooled || 0) - (q.pooled || 0);
    if (d < min && x < min && pl < min) return;
    const row = { name: g.name, detached: [q.detached, g.detached], destroyed: [q.destroyed, g.destroyed], inScene: [q.inScene, g.inScene] };
    if (g.pooled || q.pooled) row.pooled = [q.pooled || 0, g.pooled || 0];
    const mid = mm.get(g.name);
    if (mid) row.mid = { detached: mid.detached, destroyed: mid.destroyed, pooled: mid.pooled || 0 };
    out.push(row);
  });
  return out.sort((x, y) => (y.detached[1] - y.detached[0] + y.destroyed[1] - y.destroyed[0]) - (x.detached[1] - x.detached[0] + x.destroyed[1] - x.destroyed[0])).slice(0, 5);
}
function nodeGrowth(ev, T) {
  const min = (T.census && T.census.minNodes) || 5;
  const a = censusAt(ev, "after-warmup");
  const b = censusAt(ev, "end");
  if (!a || !b) return null;
  // The middle census, when there is one, says whether a group kept growing or stopped (a pool
  // that filled up, an effect made once).
  const m = censusAt(ev, "mid");
  const made = a.made && b.made && a.made.status !== "unavailable" ? {
    status: b.made.status,
    detached: [a.made.detached, b.made.detached],
    destroyed: [a.made.destroyed, b.made.destroyed],
    pooled: b.made.pooled != null ? [a.made.pooled || 0, b.made.pooled] : undefined,
    byName: madeDiff(a, b, min, m),
  } : null;
  const paths = sceneDiff(a, b, min);
  if (m) {
    const mm = new Map((m.paths || []).map((p) => [p[0], p[1]]));
    paths.forEach((p) => { if (mm.has(p.path)) p.mid = mm.get(p.path); });
  }
  return { spins: b.spins - a.spins, midSpins: m ? m.spins - a.spins : undefined, min, nodes: [a.nodes, b.nodes], paths, made };
}
function panelNodes(ev, T) {
  const min = (T.census && T.census.minNodes) || 5;
  const a = censusAt(ev, "idle");
  const b = censusAt(ev, "after-rules");
  return a && b ? { nodes: [a.nodes, b.nodes], paths: sceneDiff(a, b, min) } : null;
}
const perSpin = (d, spins) => (spins > 0 ? `，每轉 +${round(d / spins, 1)}` : "");
// One line of what the node counts did between the two points. Facts only; a pool holds
// detached nodes on purpose, so detached is not called a leak.
function nodeGrowthText(g) {
  if (!g) return null;
  const bits = [];
  // a → mid → b, and whether the second half added nothing.
  const span = (from, mid, to) => (mid != null ? `${from} → ${mid} → ${to}${to - mid <= 0 && mid > from ? "（後半沒再增加）" : ""}` : `${from} → ${to}`);
  if (g.paths.length) bits.push("場景節點變多：" + g.paths.map((p) => `${p.path} ${span(p.from, p.mid, p.to)}${p.mid != null && p.to - p.mid <= 0 ? "" : perSpin(p.to - p.from, g.spins)}${p.activeTo !== p.to ? `（顯示中 ${p.activeTo}）` : ""}`).join("；"));
  const m = g.made;
  if (m && m.byName.length) bits.push("instantiate 出來、GC 後仍被參考：" + m.byName.map((x) => {
    const parts = [];
    const md = x.mid || {};
    if (x.detached[1] - x.detached[0] > 0) parts.push(`不在場景也沒 destroy ${span(x.detached[0], md.detached, x.detached[1])}`);
    if (x.destroyed[1] - x.destroyed[0] > 0) parts.push(`已 destroy ${span(x.destroyed[0], md.destroyed, x.destroyed[1])}`);
    if (x.pooled && x.pooled[1] - x.pooled[0] > 0) parts.push(`在 cc.NodePool 裡 ${span(x.pooled[0], md.pooled, x.pooled[1])}`);
    const grow = x.detached[1] - x.detached[0] + x.destroyed[1] - x.destroyed[0];
    const stopped = x.mid && x.detached[1] - md.detached <= 0 && x.destroyed[1] - md.destroyed <= 0;
    return `${x.name}（${parts.join("，")}${grow > 0 && !stopped ? perSpin(grow, g.spins) : ""}）`;
  }).join("；"));
  if (!bits.length) return `暖機後到最後，場景節點 ${g.nodes[0]} → ${g.nodes[1]}，沒有哪一組多 ${g.min} 個以上${m ? "；instantiate 的節點 GC 後也沒有變多" : ""}`;
  return `暖機後到最後（${g.spins} 轉）${bits.join("。")}`;
}

// Text for a measured cause: what was measured, and where to look. Facts only.
// A container a named cause ran inside, in short form for "inside".
function insideText(c) {
  switch (c.kind) {
    case "activate": return `節點啟用 ${c.n}／停用 ${c.off} 次（${round(c.ms)} ms${c.churn ? `，同一幀內切回 ${c.churn} 次` : ""}）`;
    case "handler": return `回呼 ${c.name}（${c.n} 次，${round(c.ms)} ms）`;
    case "websocket": return `WebSocket 訊息處理（${c.n} 則，${round(c.ms)} ms${c.topKb != null ? `，最慢一則 ${c.topKb} KB` : ""}）`;
  }
  return "";
}
function causeText(c) {
  if (!c) return null;
  const t = causeTextBase(c);
  if (t && c.inside && c.inside.length) t.fact += `；發生在${c.inside.map(insideText).join("裡的")}裡`;
  return t;
}
function causeTextBase(c) {
  const pct = `${Math.round(c.share * 100)}%`;
  switch (c.kind) {
    case "activate": return { fact: `節點啟用 ${c.n} 次、停用 ${c.off} 次，花 ${c.ms} ms（佔 ${pct}）${c.churn ? `；同一幀內切回 ${c.churn} 次` : ""}${c.top ? `；最慢一次是 ${c.top}（${round(c.topMs)} ms）` : ""}`, look: c.top ? `從 ${c.top} 的 active 切換和它底下的 onEnable、onDisable 查` : "從這一刻切換 active 的節點查" };
    case "handler": return { fact: `編輯器綁定的回呼 ${c.name} 花 ${c.ms} ms（佔 ${pct}${c.n > 1 ? `，共 ${c.n} 次回呼` : ""}）`, look: `從 ${c.name} 查` };
    case "spine-build": return { fact: `Spine 骨架資料第一次解析 ${c.n} 份，花 ${c.ms} ms（佔 ${pct}）${c.name ? `；最慢的是 ${c.name}（${round(c.topMs)} ms）` : ""}`, look: c.name ? `從 ${c.name} 第一次用到的地方查（可提早解析，或改用二進位格式）` : "從這一刻第一次出現的 Spine 查" };
    case "websocket": return { fact: `WebSocket 訊息處理 ${c.n} 則，花 ${c.ms} ms（佔 ${pct}）${c.topKb != null ? `；最慢一則 ${c.topKb} KB、${round(c.topMs)} ms` : ""}`, look: "從收到訊息後執行的處理查（訊息內容不讀）" };
    case "loading-burst": return {
      fact: `同時下載 ${c.inFlight} 個、這一幀收完 ${c.done} 個${c.names ? `（${c.names.join("、")}）` : ""}；解析 ${round(c.desMs || 0)} ms、貼圖上傳 ${c.texN || 0} 張${c.mb ? ` ${c.mb} MB` : ""} ${round(c.texMs || 0)} ms，合計 ${c.ms} ms（佔 ${pct}）${c.top && c.topMb >= 1 ? `；最大一張 ${c.top}（解碼後 ${c.topMb} MB）` : ""}`,
      look: "從同一時間收進來的這批資源查" };
    case "texture-upload": return { fact: `貼圖上傳 ${c.n} 張${c.mb ? ` ${c.mb} MB` : ""}，花 ${c.ms} ms（佔 ${pct}）${c.top ? `；最大一張 ${c.top}${c.topMb ? `（解碼後 ${c.topMb} MB）` : ""}` : ""}`, look: c.top && /\./.test(c.top) ? `從 ${c.top.split(" ").pop()} 這張圖查` : "從這一刻上傳的貼圖查" };
    case "deserialize": return { fact: `資源解析（cc.deserialize / JSON.parse）${c.n} 次，花 ${c.ms} ms（佔 ${pct}）`, look: "從這一刻載入的場景、prefab 或設定檔查" };
    case "shader-compile": return { fact: `編譯 shader ${c.n} 次，花 ${c.ms} ms（佔 ${pct}）`, look: "從這一刻第一次出現的材質或特效查" };
    case "instantiate": return { fact: `cc.instantiate ${c.n} 次，花 ${c.ms} ms（佔 ${pct}）${c.name ? `，最慢的是 ${c.name}` : ""}`, look: c.name ? `從 ${c.name} 的建立查` : "從這一刻建立的 prefab 查" };
    case "component": return { fact: `${c.name} 花 ${c.ms} ms（佔 ${pct}）`, look: `從 ${c.name} 查` };
    case "label": return { fact: `Label 更新 ${c.n} 次，花 ${c.ms} ms（佔 ${pct}）：${labelList(c.top)}`, look: `從 ${c.top.map((g) => g.path).join("、")} 查` };
    case "render": return { fact: `繪製花 ${c.ms} ms（佔 ${pct}），draw call ${c.draws}`, look: "從這一幀畫的內容查" };
    case "layout": return { fact: `樣式與版面計算花 ${c.ms} ms（佔 ${pct}）`, look: "從 canvas 以外的 DOM 變動查" };
    case "script": return { fact: `${c.file}${c.fn ? ` 的 ${c.fn}` : ""}（${c.via}${c.invoker ? `：${c.invoker}` : ""}）花 ${c.ms} ms（佔 ${pct}）`, look: `從 ${c.file}${c.fn ? ` 的 ${c.fn}` : ""} 查` };
  }
  return null;
}

// A level that steps at one spin and never comes back in any later spin: draw calls (median of
// the spin) and active nodes after it settled going up, FPS going down. Every spin after the step
// must be worse than every spin before it, by more than the margin. Normal and turbo spins are
// separate series and the first of each is left out (first-time loading). Ranked by the jump.
function worseFrom(ev, T) {
  const W = T.worseFrom || {};
  const minBefore = W.minBefore || 2;
  const minAfter = W.minAfter || 3;
  const nodesAt = new Map(ev.spinNodes || []);
  const out = [];
  ["spin", "turbo"].forEach((kind) => {
    const re = new RegExp(`^${kind}-(\\d+)$`);
    const spins = (ev.stages || []).filter((s) => re.test(s.name)).map((s) => ({ n: Number(s.name.match(re)[1]), s })).sort((a, b) => a.n - b.n).slice(1);
    const metrics = [
      { metric: "draws", up: true, of: (x) => (x.s.draws && x.s.draws.p50 > 0 ? x.s.draws.p50 : null), abs: (W.draws || {}).abs || 5, rel: (W.draws || {}).rel || 0.15 },
      { metric: "nodes", up: true, of: (x) => (nodesAt.has(x.s.name) ? nodesAt.get(x.s.name) : null), abs: (W.nodes || {}).abs || 20, rel: (W.nodes || {}).rel || 0.05 },
      { metric: "fps", up: false, of: (x) => (x.s.fps != null ? x.s.fps : null), abs: (W.fps || {}).abs || 3, rel: 0 },
    ];
    metrics.forEach((m) => {
      const pts = spins.map((x) => ({ n: x.n, v: m.of(x) })).filter((p) => p.v != null);
      let best = null;
      for (let k = minBefore; k <= pts.length - minAfter; k += 1) {
        const before = pts.slice(0, k).map((p) => p.v);
        const after = pts.slice(k).map((p) => p.v);
        const edge = m.up ? Math.max(...before) : Math.min(...before);
        const far = m.up ? Math.min(...after) : Math.max(...after);
        const jump = m.up ? far - edge : edge - far;
        const margin = Math.max(m.abs, m.rel * Math.abs(edge));
        if (jump > margin && (!best || jump > best.jump)) best = { k, jump, before, after, edge, far };
      }
      if (!best) return;
      const med = (xs) => { const s = xs.slice().sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };
      out.push({ id: "worse-from-spin", stage: kind, metric: m.metric, from: pts[best.k].n, spins: [pts[0].n, pts[pts.length - 1].n], before: { edge: round(best.edge), median: round(med(best.before)), n: best.before.length }, after: { edge: round(best.far), median: round(med(best.after)), n: best.after.length } });
    });
  });
  return out;
}

// Draw calls that climb across the normal spins with ups and downs, which worse-from-spin (every
// later spin above every earlier one) misses: the highest draw calls of each spin, the mean of the
// last few against the mean of spins 2-4. Spins far longer than the others (longSpinFactor times
// the median: a feature, a big win) are left out of both windows. Facts only, not scored.
function drawsRise(ev, T) {
  const R = T.drawsRise || {};
  const first = R.first || [2, 4];
  const lastN = R.last || 3;
  const re = /^spin-(\d+)$/;
  const all = (ev.stages || []).filter((s) => re.test(s.name) && s.draws && s.draws.max > 0).map((s) => ({ n: Number(s.name.match(re)[1]), max: s.draws.max, ms: s.wallMs })).sort((a, b) => a.n - b.n);
  if (all.length < (R.minSpins || 7)) return null;
  const times = all.map((x) => x.ms).filter((x) => x > 0).sort((a, b) => a - b);
  const med = times.length ? times[Math.floor(times.length / 2)] : 0;
  const long = (x) => med > 0 && x.ms > med * (T.longSpinFactor || 3);
  const pts = all.filter((x) => !long(x));
  const base = pts.filter((x) => x.n >= first[0] && x.n <= first[1]);
  const last = pts.slice(-lastN);
  if (base.length < 2 || last.length < lastN || last[0].n <= base[base.length - 1].n) return null;
  const avg = (xs) => xs.reduce((a, x) => a + x.max, 0) / xs.length;
  const a = avg(base);
  const b = avg(last);
  if (!(a > 0) || b / a <= (R.ratio || 1.3) || b - a < (R.minAbs || 10)) return null;
  return { id: "draws-rise", stage: "spin", metric: "draws.max", base: { spins: base.map((x) => x.n), avg: round(a, 1) }, last: { spins: last.map((x) => x.n), avg: round(b, 1) }, ratio: round(b / a, 2), series: all.map((x) => [x.n, x.max, long(x) ? 1 : 0]) };
}

// Spine left in cc.NodePool on a finished animation with something to draw (census poolResidue),
// at each census of the spins. Listed from poolResidue.min at the last one. Not scored.
function poolResidue(ev, T) {
  const at = (name) => ((ev.census || []).filter((c) => c && c.status === "ok" && c.at === name && c.poolResidue && c.poolResidue.status === "ok")).slice(-1)[0];
  const end = at("end");
  if (!end || end.poolResidue.residue < ((T.poolResidue || {}).min || 10)) return null;
  const points = (ev.census || []).filter((c) => c && c.status === "ok" && c.poolResidue && c.poolResidue.status === "ok" && c.spins != null && c.at !== "idle" && c.at !== "after-rules").map((c) => ({ at: c.at, spins: c.spins, residue: c.poolResidue.residue }));
  const r = end.poolResidue;
  return { id: "pool-residue", stage: "spin", value: r.residue, checked: r.checked, cacheMode: r.cacheMode, unreadable: r.unreadable, points, byPath: r.byPath };
}

function findings(ev, T) {
  const out = [];
  const stages = ev.stages || [];
  const byName = (n) => stages.find((s) => s.name === n);
  const gs = groups(stages);
  const g = (n) => gs.find((x) => x.group === n);
  const soft = SOFTWARE_GPU.test((ev.conditions && ev.conditions.gpu) || "");
  const engineCpu = !!(ev.channels && ev.channels.engineCpu);

  const loafs = (ev.timeline && ev.timeline.loafs) || [];
  stages.forEach((s) => {
    if (s.name === "splash" || s.name === "gap" || s.name === "boot") return;
    const hs = s.hitches || [];
    hs.forEach((h) => {
      // A long task that overlaps a frame hitch is the same stall; keep the frame, which has more detail.
      if (h.source === "longtask" && hs.some((o) => o !== h && o.source !== "longtask" && o.t < h.t + h.dt && h.t < o.t + o.dt)) return;
      let id = "hitch-other";
      if (h.inFlight > 0) id = "hitch-network";
      else if (h.source === "longtask" || (h.cpu != null && h.cpu >= 0.8 * h.dt)) id = "hitch-main-thread";
      const cause = stallCause(h, loafs);
      const labels = cause && cause.kind === "label" ? undefined : labelNote(h);
      const canvas = canvasNote(h);
      out.push({ id, stage: s.name, t: h.t, value: h.dt, cpu: h.cpu == null ? null : h.cpu, urls: h.urls && h.urls.length ? h.urls : undefined, cause: cause || undefined, labels, canvas, work: h.work || undefined });
    });
  });

  const F = T.fps || {};
  gs.filter((x) => GAME_GROUPS.has(x.group) || x.group === "loading" || x.group === "enter").forEach((x) => {
    const why = [];
    // stageMin and lowMin are written for a 60 FPS target; scale them to what the cap allows.
    const scale = (x.expectedFps || 60) / 60;
    if (x.fps != null && x.fps < F.stageMin * scale) why.push("fps");
    if (x.fpsLow != null && x.fpsLow < F.lowMin * scale) why.push("fpsLow");
    if (x.dropShare != null && x.dropShare > F.dropShareMax) why.push("dropShare");
    if (x.badShare != null && x.badShare > F.badShareMax) why.push("badShare");
    if (why.length) out.push({ id: "fps-drop", stage: x.group, fps: x.fps, fpsLow: x.fpsLow, dropShare: x.dropShare, badShare: x.badShare, why, softwareGpu: soft || undefined });
  });

  if (engineCpu) {
    gs.filter((x) => GAME_GROUPS.has(x.group)).forEach((x) => {
      const st = stages.filter((s) => groupOf(s.name) === x.group && s.gpuMs);
      const gpuP95 = st.length ? Math.max(...st.map((s) => s.gpuMs.p95)) : null;
      if (x.cpuP95 != null && x.cpuP95 > T.cpuHeavyP95Ms && gpuP95 != null && gpuP95 < T.gpuLightP95Ms) out.push({ id: "cpu-heavy", stage: x.group, value: x.cpuP95, gpuP95 });
    });
  }
  stages.forEach((s) => {
    if (s.gpuMs && s.gpuMs.p95 > T.gpuHeavyP95Ms) out.push({ id: "gpu-heavy", stage: s.name, value: s.gpuMs.p95 });
  });

  const tex = ev.memory && ev.memory.textures;
  if (tex && tex.status === "ok" && tex.mb > T.textureWarnMb) out.push({ id: "texture-heavy", value: tex.mb, count: tex.count, largest: (tex.largest || []).slice(0, 3) });
  const gpu = ev.memory && ev.memory.gpu;
  if (gpu && gpu.status === "ok" && gpu.peakMb > T.gpuMemoryWarnMb) out.push({ id: "gpu-memory-heavy", value: gpu.peakMb, textureMb: gpu.textureMb, bufferMb: gpu.bufferMb, renderbufferMb: gpu.renderbufferMb });

  const fit = heapFit(ev, T);
  const gc = (ev.gc || []).filter((x) => x.mb != null);
  const gcA = gc.find((x) => x.at === "after-warmup");
  const gcB = gc.find((x) => x.at === "end");
  const halves = gcHalves(ev);
  if (halves) {
    // Three forced GCs: only the rise both halves share counts as staying growth. A rise in one
    // half only (something loaded once and kept) is stated, not called a leak.
    if (halves.steadyMb > T.leakMb) out.push({ id: "leak-suspected", status: "retained-after-gc", from: halves.from, mid: halves.mid, to: halves.to, delta: halves.steadyMb, halves: halves.deltas, forced: true });
    else if (halves.totalMb > T.leakMb) out.push({ id: "heap-step", from: halves.from, mid: halves.mid, to: halves.to, delta: halves.totalMb, halves: halves.deltas, spins: halves.spins });
  } else if (gcA && gcB && gcB.spins > gcA.spins) {
    // Both ends were taken right after a forced full GC, so the difference is what really stayed.
    const delta = gcB.mb - gcA.mb;
    if (delta > T.leakMb) out.push({ id: "leak-suspected", status: "retained-after-gc", from: gcA.mb, to: gcB.mb, delta, forced: true });
  } else if (fit.status === "not-enough-spins") out.push({ id: "leak-check", status: "not-enough-spins", spins: fit.spins });
  else if (fit.status === "ok" && fit.majorGcs.length) {
    // A major GC ran: only what it did not reclaim counts.
    if (fit.retainedMb > T.leakMb) out.push({ id: "leak-suspected", status: "retained-after-gc", from: fit.from, to: fit.from + fit.retainedMb, delta: fit.retainedMb, slopeMb: fit.slopeMb, majorGcs: fit.majorGcs, featureSpins: fit.featureSpins });
  } else if (fit.status === "ok" && fit.growthMb > T.leakMb && fit.tailSlopeMb != null && fit.tailSlopeMb > T.heap.tailSlopeMb) {
    // No major GC in the run: the rise may still be reclaimable. Suspected, not confirmed.
    out.push({ id: "leak-suspected", status: "no-major-gc", from: fit.from, to: fit.to, delta: fit.growthMb, slopeMb: fit.slopeMb, tailSlopeMb: fit.tailSlopeMb, featureSpins: fit.featureSpins });
  }

  worseFrom(ev, T).forEach((f) => out.push(f));
  const rise = drawsRise(ev, T);
  if (rise) out.push(rise);
  const residue = poolResidue(ev, T);
  if (residue) out.push(residue);

  // The same label uploaded again with unchanged text, within one stage: drawn again for nothing.
  const R = T.labelRedraw || {};
  stages.forEach((s) => {
    const lb = s.uploads && s.uploads.labels;
    if (!lb || !lb.same) return;
    if (lb.same < (R.minSame || 3) && lb.sameMb < (R.minMb || 1)) return;
    out.push({ id: "label-redraw", stage: s.name, same: lb.same, sameMb: lb.sameMb, labels: lb.labels, top: lb.top.filter((g) => g.same) });
  });

  const idle = g("idle");
  ["history-before", "rules", "history-after"].forEach((p) => {
    const x = g(p);
    if (!x || !idle) return;
    const spike = g(p + "-spike");
    const fpsDrop = idle.fps != null && x.fps != null ? round(idle.fps - x.fps) : null;
    const drawRatio = idle.draws ? round(x.draws / idle.draws - 1, 2) : null;
    const spikeHitch = spike && spike.worstHitch && spike.worstHitch.dt >= T.hitchMs ? spike.worstHitch.dt : null;
    if ((fpsDrop != null && fpsDrop > 10) || (drawRatio != null && drawRatio > 0.3) || spikeHitch) out.push({ id: "panel-heavier", stage: p, fpsDrop, drawRatio, spikeHitchMs: spikeHitch });
  });
  const after = g("idle-after-rules");
  if (after && idle) {
    const drawRatio = idle.draws ? round(after.draws / idle.draws - 1, 2) : null;
    const before = byName("idle");
    const heapUp = before && before.heapEndMb != null && after.heapEndMb != null ? round(after.heapEndMb - before.heapEndMb) : null;
    if ((drawRatio != null && drawRatio > 0.3) || (heapUp != null && heapUp > T.leakMb)) out.push({ id: "panel-left-open", drawRatio, heapUpMb: heapUp });
  }

  ["loading", "enter"].forEach((n) => {
    stages.filter((s) => s.name === n).forEach((s) => {
      const main = out.some((f) => f.id === "hitch-main-thread" && f.stage === n);
      if (main || (s.cpuPct != null && s.cpuPct > 80 && s.fps != null && s.fps < 30)) out.push({ id: "loading-stall", stage: n });
    });
  });

  // One row for a steady stage whose GPU time fills the frame while the CPU stays light.
  // A later stage that covers the reels and drops GPU time is the contrast, not a second problem.
  const gpuOf = (name) => {
    const st = stages.filter((s) => groupOf(s.name) === name && !String(s.name).endsWith("-spike") && s.gpuMs && s.frames >= 30);
    return st.length ? Math.max(...st.map((s) => s.gpuMs.p95)) : null;
  };
  let fill = null;
  gs.filter((x) => x.group === "idle" || x.group === "spin").forEach((x) => {
    const gpuP95 = gpuOf(x.group);
    if (gpuP95 == null || x.cpuP95 == null || gpuP95 <= T.gpuHeavyP95Ms || x.cpuP95 >= T.gpuLightP95Ms) return;
    if (!fill || gpuP95 > fill.gpuP95) fill = { stage: x.group, gpuP95, cpuP95: x.cpuP95, draws: x.draws };
  });
  if (fill) {
    let contrast = null;
    ["rules", "history-before", "history-after"].forEach((name) => {
      const x = g(name);
      const gpuP95 = gpuOf(name);
      if (!x || gpuP95 == null || !fill.draws || x.draws < fill.draws * 1.5 || gpuP95 > fill.gpuP95 * 0.5) return;
      if (!contrast || x.draws > contrast.draws) contrast = { stage: name, gpuP95, draws: x.draws };
    });
    out.push({ id: "gpu-fill", stage: fill.stage, gpuP95: fill.gpuP95, cpuP95: fill.cpuP95, draws: fill.draws, contrast });
  }

  const net = ev.resources;
  const N = T.network || {};
  if (net && net.status === "ok") {
    const blocked = (net.hosts || []).filter((h) => h.count >= (N.hostRequests || 30) && h.queued >= (N.queuedToFire || 8));
    if (blocked.length) out.push({ id: "network-blocked", hosts: blocked.slice(0, 2) });
    const dups = (net.duplicates || []).filter((d) => d.count >= (N.duplicate || 3));
    if (dups.length) out.push({ id: "network-duplicate", files: dups.slice(0, 3) });
    const ld = net.load;
    if (ld && ld.importJson >= (N.importJson || 30)) out.push({ id: "network-json-unmerged", importJson: ld.importJson, json: ld.json, count: ld.count });
    if (ld && ld.images >= (N.loadImages || 100)) out.push({ id: "network-many-images", images: ld.images, count: ld.count });
  }

  const ctx = ev.conditions && ev.conditions.context;
  if (ctx && (ctx.preserveDrawingBuffer || ctx.antialias)) out.push({ id: "context-flags", antialias: !!ctx.antialias, preserveDrawingBuffer: !!ctx.preserveDrawingBuffer, alpha: !!ctx.alpha, bufferW: ctx.bufferW, bufferH: ctx.bufferH });
  const canvas = ev.conditions && ev.conditions.canvas;
  if (canvas && canvas.w * canvas.h > (T.canvasPixels || 1920 * 1080)) out.push({ id: "canvas-large", w: canvas.w, h: canvas.h, dpr: ev.conditions.viewport && ev.conditions.viewport.dpr });

  const sh = ev.shaders;
  if (sh && sh.stalls && sh.stalls.length) {
    const worst = sh.stalls.reduce((a, b) => (b.ms > a.ms ? b : a));
    out.push({ id: "shader-stall", value: worst.ms, count: sh.stalls.length, t: worst.t, kind: worst.kind });
  }
  const au = ev.audio;
  if (au && au.status === "ok" && (au.pcmMb >= (T.audioMb || 16) || (au.maxMs != null && au.maxMs >= T.hitchMs && au.pcmMb >= 4))) out.push({ id: "audio-decode", pcmMb: au.pcmMb, count: au.count, maxMs: au.maxMs });
  if (gpu && gpu.status === "ok" && gpu.renderbufferMb > (T.renderbufferMb || 8)) out.push({ id: "render-target", mb: gpu.renderbufferMb });

  return { findings: out, groups: gs, softwareGpu: soft };
}

module.exports = { findings, drawsRise, gcHalves, stallCause, causeText, canvasText, labelText, nodeGrowth, nodeGrowthText, panelNodes, groups, groupOf, heapFit, SOFTWARE_GPU };
