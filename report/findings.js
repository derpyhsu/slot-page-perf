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

const GAME_GROUPS = new Set(["idle", "spin", "turbo", "history-before", "rules", "idle-after-rules", "history-after", "idle-end"]);

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

function findings(ev, T) {
  const out = [];
  const stages = ev.stages || [];
  const byName = (n) => stages.find((s) => s.name === n);
  const gs = groups(stages);
  const g = (n) => gs.find((x) => x.group === n);
  const soft = SOFTWARE_GPU.test((ev.conditions && ev.conditions.gpu) || "");
  const engineCpu = !!(ev.channels && ev.channels.engineCpu);

  stages.forEach((s) => {
    if (s.name === "splash" || s.name === "gap" || s.name === "boot") return;
    (s.hitches || []).forEach((h) => {
      let id = "hitch-other";
      if (h.inFlight > 0) id = "hitch-network";
      else if (h.source === "longtask" || (h.cpu != null && h.cpu >= 0.8 * h.dt)) id = "hitch-main-thread";
      out.push({ id, stage: s.name, t: h.t, value: h.dt, cpu: h.cpu == null ? null : h.cpu, urls: h.urls && h.urls.length ? h.urls : undefined });
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
  if (gcA && gcB && gcB.spins > gcA.spins) {
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

module.exports = { findings, groups, groupOf, heapFit, SOFTWARE_GPU };
