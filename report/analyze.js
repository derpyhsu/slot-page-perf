#!/usr/bin/env node
// Usage: node report/analyze.js runs/<run>/evidence.json
// Writes evidence.score (protocol/scoring.md), evidence.cocosAdvice (Cocos rules in protocol/rules.md),
// and evidence.todo, the merged list the reports render as 要處理的地方.
"use strict";

const fs = require("fs");
const path = require("path");

const evidencePath = process.argv[2];
if (!evidencePath) {
  console.error("usage: node report/analyze.js <evidence.json>");
  process.exit(1);
}

const thresholds = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "protocol", "thresholds.json"), "utf8"));
const cfg = thresholds.scoring;
const ev = JSON.parse(fs.readFileSync(evidencePath, "utf8"));

const { stageFrames } = require("./frames");
const { heapFit } = require("./findings");

const NOT_GAME = new Set(["boot", "loading", "splash", "enter", "game-ready", "gap"]);
const stages = ev.stages || [];
const gameStages = stages.filter((s) => !NOT_GAME.has(s.name) && s.frames > 0);
const spinStages = stages.filter((s) => /^(spin|turbo)-\d+$/.test(s.name));
const loadStages = stages.filter((s) => (s.name === "loading" || s.name === "enter") && s.frames > 0);

function round(n, d = 1) {
  const k = Math.pow(10, d);
  return Math.round(n * k) / k;
}

// 0..1. Lower values are better unless higherIsBetter.
function curve(value, full, zero, { log = false, higherIsBetter = false } = {}) {
  if (value == null) return null;
  const f = log ? Math.log(Math.max(value, 1e-6)) : value;
  const a = log ? Math.log(Math.max(full, 1e-6)) : full;
  const b = log ? Math.log(Math.max(zero, 1e-6)) : zero;
  let t = (f - a) / (b - a);
  if (higherIsBetter) t = (a - f) / (a - b);
  return Math.max(0, Math.min(1, 1 - t));
}

function gameReadyMs() {
  const ready = stages.find((s) => s.name === "game-ready");
  if (ready && ready.startMs != null) return ready.startMs;
  const marks = ev.timeline && ev.timeline.marks;
  const m = marks && marks.find((x) => x[0] === "game-ready");
  return m ? m[1] : null;
}

// Share of whole seconds whose presented FPS reached minFps (protocol/scoring.md 55 FPS 以上).
// Buckets from older probes have no presented count, so they use engine frames.
// inWindow picks the seconds: after game-ready for 幀率穩定度, loading and enter for 載入階段.
function steadyShare(inWindow, minFps, fallbackStages) {
  const B = (ev.timeline && ev.timeline.bucketMs) || (thresholds.timeline && thresholds.timeline.bucketMs) || 250;
  const buckets = (ev.timeline && ev.timeline.buckets) || [];
  const per = Math.round(1000 / B);
  const secs = new Map();
  buckets.forEach((b) => {
    if (!inWindow(b[0], B)) return;
    const k = Math.floor(b[0] / 1000);
    const a = secs.get(k) || [];
    a.push(b.length > 8 ? b[8] : b[1]);
    secs.set(k, a);
  });
  const whole = [...secs.values()].filter((a) => a.length === per);
  if (whole.length) {
    const ok = whole.filter((a) => a.reduce((x, y) => x + y, 0) >= minFps).length;
    return { share: ok / whole.length, seconds: whole.length, approx: false };
  }
  // Coarse fallback from stage summaries: wall time of stages whose FPS reached minFps.
  let total = 0;
  let ok = 0;
  fallbackStages.forEach((s) => {
    const f = stageFrames(s);
    const fps = f ? f.fps : s.fps;
    if (fps == null) return;
    total += s.wallMs;
    if (fps >= minFps) ok += s.wallMs;
  });
  return total ? { share: ok / total, approx: true } : null;
}

// gap is the driver waiting on the agent or a forced GC, not play. Its seconds are left out.
const gapStages = stages.filter((s) => s.name === "gap" && s.startMs != null);
function inGap(t, B) {
  return gapStages.some((s) => t + B > s.startMs && t < s.startMs + s.wallMs);
}
function stableShare() {
  const ready = gameReadyMs();
  if (ready == null) return steadyShare(() => false, cfg.smooth.steady.minFps, gameStages);
  return steadyShare((t, B) => t >= ready && !inGap(t, B), cfg.smooth.steady.minFps, gameStages);
}

// Same measure over the loading and enter stages only. splash waits for a person.
function loadingStableShare() {
  if (!loadStages.length) return null;
  const inLoad = (t, B) => loadStages.some((s) => t >= s.startMs && t + B <= s.startMs + s.wallMs);
  return steadyShare(inLoad, cfg.loading.steady.minFps, loadStages);
}

function worstStall(list = gameStages) {
  let worst = { dt: 0, stage: null, t: null };
  list.forEach((s) => {
    (s.hitches || []).forEach((h) => {
      if (h.dt > worst.dt) worst = { dt: h.dt, stage: s.name, t: h.t != null ? h.t : null };
    });
  });
  return worst;
}

function cpuP95() {
  if (!(ev.channels && ev.channels.engineCpu)) return null;
  let best = null;
  gameStages.forEach((s) => {
    if (!s.cpuMs || s.cpuFrames === 0 || s.cpuMs.p95 == null) return;
    if (!best || s.cpuMs.p95 > best.value) best = { value: s.cpuMs.p95, stage: s.name };
  });
  return best;
}

function heapPeak() {
  let peak = 0;
  stages.forEach((s) => {
    [s.heapStartMb, s.heapEndMb].forEach((v) => {
      if (v != null && v > peak) peak = v;
    });
  });
  ((ev.timeline && ev.timeline.heap) || []).forEach((p) => {
    if (p[1] > peak) peak = p[1];
  });
  return peak || null;
}

// GPU side of the estimate. Live WebGL allocations when the probe saw them, else Cocos textures.
function gpuSource() {
  const gpu = ev.memory && ev.memory.gpu;
  return gpu && gpu.status === "ok" && gpu.peakMb > 0 ? "gpu" : "textures";
}

function texturePeak() {
  if (gpuSource() === "gpu") return ev.memory.gpu.peakMb;
  const tex = ev.memory && ev.memory.textures;
  let peak = tex && tex.status === "ok" ? tex.mb : null;
  ((ev.timeline && ev.timeline.textures) || []).forEach((p) => {
    if (peak == null || p[1] > peak) peak = p[1];
  });
  return peak;
}

function framebufferMb() {
  const c = ev.conditions && (ev.conditions.canvas || ev.conditions.viewport);
  if (!c) return 0;
  const dpr = (ev.conditions.canvas ? 1 : ev.conditions.viewport.dpr) || 1;
  return (c.w * dpr * c.h * dpr * 4 * 3) / 1048576;
}

// Heap floor slope per spin, fitted between feature spins and major GCs (findings.js heapFit).
// After a major GC, growth is what the GC did not reclaim, spread over the fitted spins.
const fit = heapFit(ev, thresholds);
ev.heapFit = fit;
// Forced GC points (heap snapshots after warm-up and after the last spin) beat any fit: the
// difference is what really stayed. Without them and without a major GC, growth is provisional.
function gcRetained() {
  const gc = (ev.gc || []).filter((g) => g.mb != null);
  const a = gc.find((g) => g.at === "after-warmup");
  const b = gc.find((g) => g.at === "end");
  if (!a || !b || b.spins <= a.spins) return null;
  return { from: a.mb, to: b.mb, spins: b.spins - a.spins, retainedMb: round(b.mb - a.mb, 2) };
}
const gcFit = gcRetained();
ev.heapGc = gcFit;
function growthPerSpin() {
  if (gcFit) return { value: Math.max(0, gcFit.retainedMb) / gcFit.spins, basis: "gc" };
  if (fit.status !== "ok") return null;
  if (fit.majorGcs.length) return { value: Math.max(0, fit.retainedMb) / fit.points, basis: "major-gc" };
  return { value: Math.max(0, fit.slopeMb), basis: "no-gc" };
}

// Presented-frame view of the game stages, frame-weighted: share off cadence and expected FPS.
function gameFrames() {
  let n = 0;
  let off = 0;
  let exp = 0;
  let hz = 0;
  let cap = null;
  gameStages.forEach((s) => {
    const f = stageFrames(s);
    if (!f) return;
    n += f.frames;
    off += f.offShare * f.frames;
    exp += f.expectedFps * f.frames;
    hz += f.hz * f.frames;
    cap = f.cap;
  });
  return n ? { frames: n, offShare: off / n, expectedFps: exp / n, hz: Math.round(hz / n), cap } : null;
}
const gf = gameFrames();

// Larger than 16 MB, so a 2048x2048 RGBA atlas (exactly 16 MB) does not count. New probes count
// every texture; older ones only list the largest 8.
function bigTextureCount() {
  const tex = ev.memory && ev.memory.textures;
  if (!tex || tex.status !== "ok") return null;
  if (tex.bigCount != null) return tex.bigCount;
  if (!tex.largest) return null;
  const limit = cfg.memory.bigTextures.mb * 1048576;
  return tex.largest.filter((t) => (t.w && t.h && /8888/.test(t.format || "") ? t.w * t.h * 4 : t.mb * 1048576) > limit + 1).length;
}

// JS heap floor once the game is up: the 10th percentile of heap samples after game-ready.
function heapFloor() {
  const ready = gameReadyMs();
  const xs = ((ev.timeline && ev.timeline.heap) || []).filter((p) => ready == null || p[0] >= ready).map((p) => p[1]).sort((a, b) => a - b);
  return xs.length ? xs[Math.floor(xs.length * 0.1)] : null;
}

// GPU memory a panel left behind: right after it closed versus right before it opened.
function gpuAt(t) {
  const g = (ev.timeline && ev.timeline.gpu) || [];
  let v = null;
  g.forEach((p) => {
    if (p[0] <= t) v = p[1];
  });
  return v;
}
function panelResidue() {
  const by = (n) => stages.find((s) => s.name === n);
  const pairs = [];
  const firstPanel = by("history-before-spike") || by("rules-spike");
  const afterRules = by("idle-after-rules");
  if (firstPanel && afterRules) pairs.push([firstPanel.startMs, afterRules.startMs + afterRules.wallMs]);
  const lateOpen = by("history-after-spike");
  const end = by("idle-end");
  if (lateOpen && end) pairs.push([lateOpen.startMs, end.startMs + end.wallMs]);
  const deltas = pairs.map(([a, b]) => {
    const x = gpuAt(a);
    const y = gpuAt(b);
    return x == null || y == null ? null : Math.max(0, y - x);
  }).filter((d) => d != null);
  return deltas.length ? Math.max(...deltas) : null;
}

function total(items, cap) {
  const scored = items.filter((i) => i.score != null);
  const weight = items.reduce((a, i) => a + i.weight, 0);
  const got = scored.reduce((a, i) => a + i.weight, 0);
  if (!got) return { score: null, coverage: 0, provisional: true };
  let score = Math.round((100 * scored.reduce((a, i) => a + i.weight * i.score, 0)) / got);
  if (cap != null) score = Math.min(score, cap);
  return { score, coverage: Math.round((100 * got) / weight), provisional: got < weight };
}

const S = cfg.smooth;
const stable = stableShare();
const stall = worstStall();
const low1 = lowOnePercent(gameStages, S.gpu.minFrames);
const pace = gf ? gf.offShare : null;
// Stalls of 50 ms or more per minute of play.
const playMs = gameStages.reduce((a, s) => a + s.wallMs, 0);
const stallRate = playMs ? gameStages.reduce((a, s) => a + (s.hitches || []).length, 0) / (playMs / 60000) : null;
// Worst GPU timer p95 among stages long enough to trust.
function gpuP95() {
  let best = null;
  gameStages.forEach((s) => {
    if (!s.gpuMs || s.gpuMs.p95 == null || s.frames < S.gpu.minFrames) return;
    if (!best || s.gpuMs.p95 > best.value) best = { value: s.gpuMs.p95, stage: s.name };
  });
  return best;
}
const gpuStat = ev.channels && ev.channels.gpuTimer ? gpuP95() : null;
const cpuStat = cpuP95();
const cpu = cpuStat && cpuStat.value;
const smoothItems = [
  {
    id: "steady",
    label: "55 FPS 以上",
    weight: S.steady.weight,
    value: stable ? round(stable.share * 100, 1) : null,
    unit: "%",
    approx: stable ? stable.approx : false,
    full: `${S.steady.full * 100}%`,
    zero: `${S.steady.zero * 100}%`,
    score: stable ? curve(stable.share, S.steady.full, S.steady.zero, { higherIsBetter: true }) : null,
  },
  {
    id: "stall",
    label: "卡頓",
    weight: S.stall.weight,
    value: round(stall.dt, 0),
    unit: "ms",
    stage: stall.stage,
    t: stall.t,
    full: `${S.stall.full} ms`,
    zero: `${S.stall.zero} ms`,
    score: stall.dt <= S.stall.full ? 1 : curve(stall.dt, S.stall.full, S.stall.zero, { log: true }),
  },
  {
    id: "cpu",
    label: "CPU 餘裕",
    weight: S.cpu.weight,
    value: cpu == null ? null : round(cpu, 1),
    unit: "ms",
    stage: cpuStat && cpuStat.stage,
    full: `${S.cpu.full} ms`,
    zero: `${S.cpu.zero} ms`,
    score: cpu == null ? null : cpu <= S.cpu.full ? 1 : curve(cpu, S.cpu.full, S.cpu.zero, { log: true }),
  },
  { id: "low", label: "1% low", weight: S.low.weight, value: low1 == null ? null : round(low1, 1), unit: "FPS", full: `${S.low.full} FPS`, zero: `${S.low.zero} FPS`, score: low1 == null ? null : curve(low1, S.low.full, S.low.zero, { higherIsBetter: true }) },
  { id: "pace", label: "節奏不齊", weight: S.pace.weight, value: pace == null ? null : round(pace * 100, 1), unit: "%", full: `${S.pace.full * 100}%`, zero: `${S.pace.zero * 100}%`, score: pace == null ? null : pace <= S.pace.full ? 1 : curve(pace, S.pace.full, S.pace.zero) },
  { id: "stallRate", label: "卡頓頻率", weight: S.stallRate.weight, value: stallRate == null ? null : round(stallRate, 1), unit: "次/分", full: `${S.stallRate.full} 次/分`, zero: `${S.stallRate.zero} 次/分`, score: stallRate == null ? null : stallRate <= S.stallRate.full ? 1 : curve(stallRate, S.stallRate.full, S.stallRate.zero) },
  { id: "gpu", label: "GPU 餘裕", weight: S.gpu.weight, value: gpuStat ? round(gpuStat.value, 1) : null, unit: "ms", stage: gpuStat && gpuStat.stage, full: `${S.gpu.full} ms`, zero: `${S.gpu.zero} ms`, score: gpuStat ? (gpuStat.value <= S.gpu.full ? 1 : curve(gpuStat.value, S.gpu.full, S.gpu.zero, { log: true })) : null },
];

const L = cfg.loading;
const loadStable = loadingStableShare();
const loadStall = worstStall(loadStages);
const inLoad = (t0, t1) => loadStages.reduce((a, s) => a + Math.max(0, Math.min(t1, s.startMs + s.wallMs) - Math.max(t0, s.startMs)), 0);
const loadWall = loadStages.reduce((a, s) => a + s.wallMs, 0);
// Every stall of 50 ms or more while loading, added up.
const loadStallTotal = loadStages.length ? loadStages.reduce((a, s) => a + (s.hitches || []).reduce((b, h) => b + h.dt, 0), 0) : null;
// Share of loading wall time inside long tasks: the main thread was blocked.
const longTasks = (ev.timeline && ev.timeline.longTasks) || [];
const loadLongShare = loadWall ? longTasks.reduce((a, l) => a + inLoad(l[0], l[0] + l[1]), 0) / loadWall : null;
// Longest single shader wait. Older probes only kept waits of hitchMs or more, so below that the
// whole-run total is an upper bound.
function shaderWait() {
  const sh = ev.shaders;
  if (!sh || !sh.status) return null;
  if (sh.status === "none") return { value: 0, approx: false };
  if (sh.maxMs != null) return { value: sh.maxMs, approx: false };
  const worst = Math.max(0, ...(sh.stalls || []).map((x) => x.ms));
  return worst ? { value: worst, approx: false } : { value: Math.min(sh.ms || 0, (thresholds.hitchMs || 50) - 1), approx: true };
}
const shader = shaderWait();
// 1% low over every presented frame of the given stages: the gap the slowest 1% reach.
// Older probes have no presented histogram, so they use the stages' own 1% low, frame-weighted.
function lowOnePercent(list, minFrames) {
  const hist = [];
  let vsync = null;
  let total = 0;
  list.forEach((s) => {
    const p = s.presented;
    if (!p || !p.hist) return;
    vsync = vsync || p.vsyncMs;
    p.hist.forEach((n, k) => {
      hist[k] = (hist[k] || 0) + n;
      total += n;
    });
  });
  if (!total || !vsync) {
    const xs = list.filter((s) => s.fpsLow != null && s.frames >= minFrames);
    const n = xs.reduce((a, s) => a + s.frames, 0);
    return n ? xs.reduce((a, s) => a + s.fpsLow * s.frames, 0) / n : null;
  }
  let acc = 0;
  for (let k = hist.length - 1; k >= 1; k -= 1) {
    acc += hist[k] || 0;
    if (acc >= total * 0.01) return 1000 / (k * vsync);
  }
  return 1000 / vsync;
}
const loadLow = loadStages.length ? lowOnePercent(loadStages, 1) : null;
const lower = (v, item, log) => (v == null ? null : v <= item.full ? 1 : curve(v, item.full, item.zero, { log }));
const loadingItems = [
  {
    id: "steady",
    label: "55 FPS 以上",
    weight: L.steady.weight,
    value: loadStable ? round(loadStable.share * 100, 1) : null,
    unit: "%",
    approx: loadStable ? loadStable.approx : false,
    full: `${L.steady.full * 100}%`,
    zero: `${L.steady.zero * 100}%`,
    score: loadStable ? curve(loadStable.share, L.steady.full, L.steady.zero, { higherIsBetter: true }) : null,
  },
  {
    id: "stall",
    label: "卡頓",
    weight: L.stall.weight,
    value: loadStages.length ? round(loadStall.dt, 0) : null,
    unit: "ms",
    stage: loadStall.stage,
    t: loadStall.t,
    full: `${L.stall.full} ms`,
    zero: `${L.stall.zero} ms`,
    score: !loadStages.length ? null : loadStall.dt <= L.stall.full ? 1 : curve(loadStall.dt, L.stall.full, L.stall.zero, { log: true }),
  },
  { id: "stallTotal", label: "卡頓總量", weight: L.stallTotal.weight, value: loadStallTotal == null ? null : round(loadStallTotal, 0), unit: "ms", full: `${L.stallTotal.full} ms`, zero: `${L.stallTotal.zero} ms`, score: lower(loadStallTotal, L.stallTotal, true) },
  { id: "longTask", label: "主執行緒堵塞", weight: L.longTask.weight, value: loadLongShare == null ? null : round(loadLongShare * 100, 1), unit: "%", full: `${L.longTask.full * 100}%`, zero: `${L.longTask.zero * 100}%`, score: lower(loadLongShare, L.longTask) },
  { id: "shader", label: "shader 編譯", weight: L.shader.weight, value: shader == null ? null : round(shader.value, 0), approx: shader ? shader.approx : false, unit: "ms", full: `${L.shader.full} ms`, zero: `${L.shader.zero} ms`, score: shader == null ? null : lower(shader.value, L.shader, true) },
  { id: "low", label: "1% low", weight: L.low.weight, value: loadLow == null ? null : round(loadLow, 1), unit: "FPS", full: `${L.low.full} FPS`, zero: `${L.low.zero} FPS`, score: loadLow == null ? null : curve(loadLow, L.low.full, L.low.zero, { higherIsBetter: true }) },
];

const M = cfg.memory;
const heap = heapPeak();
const texture = texturePeak();
const fb = framebufferMb();
const estimate = heap != null && texture != null ? heap + texture + fb : null;
const ratio = estimate == null ? null : estimate / cfg.memoryBudgetMb;
const growthRow = growthPerSpin();
const growth = growthRow && growthRow.value;
const big = bigTextureCount();
const heapLow = heapFloor();
const audioMb = ev.audio && ev.audio.status === "ok" ? ev.audio.pcmMb : ev.audio && ev.audio.status === "none" ? 0 : null;
const residue = panelResidue();
const lowerIsBetter = (v, item) => (v == null ? null : v <= item.full ? 1 : curve(v, item.full, item.zero));
// No GC seen: the rise may still be reclaimable, so it costs at most half the item.
function growthScore() {
  if (growth == null) return null;
  const s = growth <= M.growth.full ? 1 : curve(growth, M.growth.full, M.growth.zero, { log: true });
  return growthRow.basis === "no-gc" ? 0.5 + s / 2 : s;
}
const memoryItems = [
  { id: "gpu", label: "GPU 記憶體", weight: M.gpu.weight, value: texture == null ? null : round(texture, 0), unit: "MB", full: `${M.gpu.full} MB`, zero: `${M.gpu.zero} MB`, score: lowerIsBetter(texture, M.gpu) },
  { id: "heap", label: "JS heap", weight: M.heap.weight, value: heapLow == null ? null : round(heapLow, 0), unit: "MB", full: `${M.heap.full} MB`, zero: `${M.heap.zero} MB`, score: lowerIsBetter(heapLow, M.heap) },
  {
    id: "growth",
    label: "增長",
    weight: M.growth.weight,
    value: growth == null ? null : round(growth, 2),
    unit: "MB/轉",
    basis: growthRow && growthRow.basis,
    provisional: growthRow ? growthRow.basis === "no-gc" : false,
    full: `${M.growth.full} MB/轉`,
    zero: `${M.growth.zero} MB/轉`,
    score: growthScore(),
  },
  { id: "bigTextures", label: "大貼圖", weight: M.bigTextures.weight, value: big, unit: "張", full: `${M.bigTextures.full} 張`, zero: `${M.bigTextures.zero} 張`, score: big == null ? null : curve(big, M.bigTextures.full, M.bigTextures.zero) },
  { id: "audio", label: "音效", weight: M.audio.weight, value: audioMb == null ? null : round(audioMb, 0), unit: "MB", full: `${M.audio.full} MB`, zero: `${M.audio.zero} MB`, score: lowerIsBetter(audioMb, M.audio) },
  { id: "panelResidue", label: "面板殘留", weight: M.panelResidue.weight, value: residue == null ? null : round(residue, 1), unit: "MB", full: `${M.panelResidue.full} MB`, zero: `${M.panelResidue.zero} MB`, score: lowerIsBetter(residue, M.panelResidue) },
];

const F = cfg.fatal;
// Fatal below minFps on presented frames, whatever the cap. Returns the FPS when fatal.
function lowFps(s) {
  const f = stageFrames(s);
  const fps = f ? f.fps : s.fps;
  return fps != null && fps < F.minFps ? fps : null;
}
const smoothFatal = [];
const memoryFatal = [];
const loadingFatal = [];
if (loadStall.dt > F.stallMs) loadingFatal.push({ id: "stall", stage: loadStall.stage, t: loadStall.t, value: round(loadStall.dt, 0) });
loadStages.forEach((s) => {
  if (lowFps(s)) loadingFatal.push({ id: "low-fps", stage: s.name, value: lowFps(s) });
});
if (stall.dt > F.stallMs) smoothFatal.push({ id: "stall", stage: stall.stage, t: stall.t, value: round(stall.dt, 0) });
gameStages.forEach((s) => {
  if (lowFps(s)) smoothFatal.push({ id: "low-fps", stage: s.name, value: lowFps(s) });
});
if (ratio != null && ratio > (F.memoryBudgetFactor || 2)) memoryFatal.push({ id: "over-budget", value: round(estimate, 0) });
if ((ev.findings || []).some((f) => f.id === "leak-suspected" && f.status === "retained-after-gc")) memoryFatal.push({ id: "leak-suspected" });

ev.score = {
  version: 5,
  // presented: bad frames and 節奏 from frames that reached the screen; engine-33ms: older probe.
  frameRule: gf ? "presented" : "engine-33ms",
  loading: Object.assign(total(loadingItems, loadingFatal.length ? F.cap : null), { items: loadingItems, fatal: loadingFatal }),
  smooth: Object.assign(total(smoothItems, smoothFatal.length ? F.cap : null), { items: smoothItems, fatal: smoothFatal }),
  memory: Object.assign(total(memoryItems, memoryFatal.length ? F.cap : null), {
    items: memoryItems,
    fatal: memoryFatal,
    budgetMb: cfg.memoryBudgetMb,
    estimateMb: estimate == null ? null : { heap: round(heap), texture: round(texture), framebuffer: round(fb), total: round(estimate), gpuSource: gpuSource() },
  }),
};
loadingItems.concat(smoothItems, memoryItems).forEach((i) => {
  if (i.score != null) i.score = Math.round(i.score * 100);
});

// cocos-frame-rate explains a cap that keeps FPS off 60 or off cadence; it is not scored. Level set below.
let frameRateLevel = "yellow";
const COCOS_LEVEL = {
  "cocos-spine-realtime": "orange",
  "cocos-spine-retained": "orange",
  "cocos-spine-cache-warning": "orange",
  "cocos-texture-uncompressed": memoryFatal.length ? "red" : "orange",
  "cocos-texture-npot": "yellow",
  "cocos-label-no-cache": "yellow",
  "cocos-mask-many": "yellow",
  "cocos-mask-stencil": "yellow",
  "cocos-particles-many": "orange",
  "cocos-nodes-many": "yellow",
  "cocos-image-cache-kept": "orange",
  "cocos-dynamic-atlas-off": "yellow",
  "cocos-webgl1": "yellow",
  "cocos-extra-camera": "yellow",
  "cocos-render-texture": "orange",
  get "cocos-frame-rate"() {
    return frameRateLevel;
  },
  "cocos-console-errors": "yellow",
};

const STAGE_NAMES = {
  boot: "開機",
  loading: "載入",
  splash: "開始畫面",
  enter: "進遊戲",
  idle: "待機",
  menu: "功能列表",
  "history-before": "下注紀錄",
  rules: "遊戲規則",
  "idle-after-rules": "規則後待機",
  "history-after": "轉後下注紀錄",
  "idle-end": "最後待機",
  spin: "spin",
  turbo: "加速 spin",
};
function stageName(name) {
  if (!name) return null;
  if (/^spin-\d+$/.test(name)) return "spin";
  if (/^turbo-\d+$/.test(name)) return "加速 spin";
  return STAGE_NAMES[name.replace(/-spike$/, "")] || name;
}

ev.cocosAdvice = cocosAdvice();
ev.findingRows = findingRows();
ev.todo = todo();
ev.fps = fpsTable();

// One row per stage group for the FPS table, in the order the run visits them.
function fpsTable() {
  const { groups } = require("./findings");
  const ORDER = ["loading", "enter", "idle", "menu", "history-before", "rules", "idle-after-rules", "spin", "turbo", "history-after", "idle-end"];
  const F = thresholds.fps || {};
  return groups(stages)
    .filter((g) => ORDER.includes(g.group) && g.frames >= 30)
    .sort((a, b) => ORDER.indexOf(a.group) - ORDER.indexOf(b.group))
    .map((g) => {
      const scale = (g.expectedFps || 60) / 60;
      const fails =
        (g.fps != null && g.fps < F.stageMin * scale) ||
        (g.dropShare != null && g.dropShare > F.dropShareMax) ||
        (g.badShare != null && g.badShare > F.badShareMax) ||
        (g.fpsLow != null && g.fpsLow < F.lowMin * scale);
      const bad = (g.fps != null && g.fps < 45 * scale) || (g.dropShare != null && g.dropShare > 0.1);
      const level = bad ? "red" : fails ? "orange" : g.dropShare > F.dropShareMax / 2 ? "yellow" : "green";
      return { group: g.group, label: stageName(g.group), stages: g.stages, fps: g.fps, fpsLow: g.fpsLow, dropShare: g.dropShare, badShare: g.badShare, gpuPeakMb: g.gpuPeakMb, expectedFps: g.expectedFps, offShare: g.offShare, presented: g.presented, level };
    });
}

// Rows written from findings, so the table does not depend on the agent writing issues.
// rule ids: stall-<group>, fps-*, memory-budget, leak-suspected, panel-history, panel-<stage>, panel-left-open, gpu-fill, network-*.
function findingRows() {
  const { groups } = require("./findings");
  const found = ev.findings || [];
  const tex = ev.memory && ev.memory.textures && ev.memory.textures.status === "ok" ? ev.memory.textures : null;
  const gs = groups(stages);
  const grp = (n) => gs.find((x) => x.group === n);
  const sec = (ms) => (ms >= 1000 ? `${round(ms / 1000, 1)} 秒` : `${Math.round(ms)} ms`);
  const rows = [];
  const snaps = (ev.cocos && ev.cocos.snapshots) || [];
  const cap = ((snaps[snaps.length - 1] || {}).settings || {}).frameRate;
  const fileOf = (url) => String(url || "").split("?")[0].split("/").filter(Boolean).slice(-1)[0] || "";

  // texUploadMb is bucket field 6. Sum the buckets that overlap the hitch.
  const uploadMbAt = (t, dt) => {
    const tl = ev.timeline;
    if (!tl || !tl.buckets || t == null) return 0;
    const end = t + (dt || 0);
    const width = tl.bucketMs || 250;
    return tl.buckets.reduce((sum, b) => (b[0] + width >= t && b[0] <= end ? sum + (b[6] || 0) : sum), 0);
  };
  const stallFix = (worst) => {
    const upload = uploadMbAt(worst.t, worst.value);
    const file = worst.urls && worst.urls.length ? fileOf(worst.urls[0]) : "";
    const cpu = worst.cpu;
    const waiting = worst.id === "hitch-network" || (cpu != null && worst.value && cpu < worst.value * 0.2 && file);
    if (waiting) {
      const cpuBit = cpu != null ? `，主執行緒只花了 ${cpu} ms` : "";
      return `最長的這次是在等下載${file ? `（${file}）` : ""}${cpuBit}。先看這個請求有沒有被同網域的其他請求堵住，大檔改到進遊戲前載完。`;
    }
    if (upload >= 1) return `這一幀附近上傳了 ${round(upload, 1)} MB 貼圖。不要在開面板的那一幀同步上傳，拆成幾幀做。`;
    if (worst.id === "hitch-main-thread") return "主執行緒一次做太多；把初始化拆成幾幀做，不要一次建完。";
    return "在這一刻錄一次 DevTools Performance，看這段時間在做什麼；常見是一次建好整頁節點或同步上傳貼圖。";
  };

  const hitches = found.filter((f) => /^hitch-/.test(f.id) && f.value >= thresholds.hitchMs);
  const byGroup = new Map();
  hitches.forEach((h) => {
    const g = /^(spin|turbo)-\d+$/.test(h.stage) ? h.stage.replace(/-\d+$/, "") : h.stage.replace(/-spike$/, "");
    byGroup.set(g, (byGroup.get(g) || []).concat(h));
  });
  byGroup.forEach((hs, g) => {
    const worst = hs.reduce((a, b) => (b.value > a.value ? b : a));
    const name = stageName(g);
    const loading = g === "loading" || g === "enter";
    const title = loading
      ? `${name}時頓了 ${hs.length} 次，最長 ${sec(worst.value)}`
      : hs.length > 1 ? `${name}時畫面停了 ${hs.length} 次，最長 ${sec(worst.value)}` : `${name}時畫面停 ${sec(worst.value)}`;
    const level = worst.value >= 250 ? "red" : worst.value >= 100 ? "orange" : "yellow";
    rows.push({ rule: `stall-${g}`, level, title, area: "卡頓", fix: stallFix(worst), stage: worst.stage, t: worst.t });
  });

  // Low FPS that just follows a frame cap under 60 is the cocos-frame-rate row. Stages with the
  // same symptom share one row so the table stays short.
  const F = thresholds.fps;
  const drops = found.filter((f) => f.id === "fps-drop" && !(cap && cap < 60 && f.fps != null && Math.abs(f.fps - cap) < 2));
  const kinds = { low: [], drop: [], bad: [] };
  drops.forEach((f) => {
    if (f.fps != null && f.fps < F.stageMin) kinds.low.push(f);
    else if (f.dropShare != null && f.dropShare > F.dropShareMax) kinds.drop.push(f);
    else kinds.bad.push(f);
  });
  const names = (xs) => xs.map((f) => stageName(f.stage)).join("、");
  const worstOf = (xs, k, dir) => xs.reduce((a, b) => ((dir < 0 ? b[k] < a[k] : b[k] > a[k]) ? b : a));
  const fpsHint = (f) => {
    if (f.stage === "loading" || f.stage === "enter") {
      const hs = byGroup.get(f.stage) || [];
      const worst = hs.reduce((a, b) => (a && a.value >= b.value ? a : b), null);
      return worst ? stallFix(worst) : "主執行緒一次做太多；把初始化拆成幾幀做，不要一次建完。";
    }
    const g = grp(f.stage);
    return g && g.cpuP95 != null && g.cpuP95 > 12 ? `${stageName(f.stage)}每幀 CPU 到 ${g.cpuP95} ms，先看腳本和動畫。` : `${stageName(f.stage)}每幀畫 ${g ? Math.round(g.draws) : "?"} 次，先減少 draw call 和疊圖。`;
  };
  if (kinds.low.length) {
    const w = worstOf(kinds.low, "fps", -1);
    rows.push({ rule: "fps-low", level: w.fps < 45 ? "red" : "orange", title: `${names(kinds.low)}平均只有 ${w.fps} FPS`, area: "FPS", fix: fpsHint(w), stage: w.stage, t: null });
  }
  if (kinds.drop.length) {
    const w = worstOf(kinds.drop, "dropShare", 1);
    rows.push({ rule: "fps-drop", level: w.dropShare > 0.1 ? "red" : "orange", title: `${names(kinds.drop)}掉了 ${round(w.dropShare * 100, 1)}% 的幀`, area: "FPS", fix: fpsHint(w), stage: w.stage, t: null });
  }
  if (kinds.bad.length) {
    const w = worstOf(kinds.bad, "badShare", 1);
    rows.push({ rule: "fps-bad", level: "orange", title: `${names(kinds.bad)}有 ${round((w.badShare || 0) * 100, 1)}% 的幀是壞幀`, area: "FPS", fix: fpsHint(w), stage: w.stage, t: null });
  }

  if (ratio != null && ratio > 0.5) {
    const est = ev.score.memory.estimateMb;
    const big = [...new Set((tex && tex.largest ? tex.largest : []).map((x) => `${x.w}×${x.h}`))].slice(0, 2).join("、");
    rows.push({
      rule: "memory-budget",
      level: ratio > (F.memoryBudgetFactor || 2) ? "red" : ratio > 1 ? "orange" : "yellow",
      title: `記憶體推估 ${Math.round(est.total)} MB，佔 ${cfg.memoryBudgetMb} MB 預算 ${Math.round(ratio * 100)}%`,
      area: "記憶體",
      fix: `GPU ${Math.round(est.texture)} MB 是大頭${big ? `，最大的是 ${big}` : ""}。待機時這些貼圖就在卡上，不是切場景會放掉的。格式見下面的未壓縮那條。`,
      stage: null,
      t: null,
    });
  }

  const leak = found.find((f) => f.id === "leak-suspected");
  if (leak && leak.status === "retained-after-gc") rows.push({ rule: "leak-suspected", level: "red", title: `大 GC 之後 JS 記憶體地板仍比轉前高 ${Math.round(leak.delta)} MB`, area: "記憶體", fix: "轉前、轉後各拍一次 heap snapshot 比對，看哪一類物件越來越多；常見是事件沒解除或動畫節點沒回收。", stage: null, t: null });
  else if (leak) rows.push({ rule: "leak-suspected", level: "orange", title: `JS 記憶體地板每轉多 ${leak.slopeMb} MB，這輪沒看到大 GC`, area: "記憶體", fix: "還不能確定是洩漏：大 GC 可能會收回。多轉幾十轉看地板會不會掉回來，或轉前、轉後各拍一次 heap snapshot 比對。", stage: null, t: null });

  const idle = grp("idle");
  const labelCount = (snap) => (snap && snap.labels ? (snap.labels.noCacheTtf != null ? snap.labels.noCacheTtf : snap.labels.noCache) : null);
  const panelFix = (stage) => {
    const snap = snaps.find((s) => s.at === stage);
    const n = labelCount(snap);
    if (n != null && n > thresholds.cocos.labelNoCacheActive) {
      const samples = ((snap.labels && snap.labels.samples) || []).slice(0, 3).join("、");
      return `這一頁有 ${n} 個沒開快取的系統字，每個自己一張貼圖，不能跟圖集合批。固定文字改 BitmapFont 或 BITMAP，常變的數字用 CHAR。${samples ? `例如 ${samples}。` : ""}`;
    }
    return "這頁的圖合成圖集，被面板蓋住的層關掉。";
  };
  const heavy = found.filter((f) => f.id === "panel-heavier" && f.drawRatio != null && f.drawRatio > 0.3 && grp(f.stage) && idle);
  const hist = heavy.filter((f) => f.stage === "history-before" || f.stage === "history-after");
  const rest = heavy.filter((f) => f.stage !== "history-before" && f.stage !== "history-after");
  if (hist.length) {
    const ranked = hist.map((f) => ({ f, g: grp(f.stage) })).sort((a, b) => b.g.draws - a.g.draws);
    const top = ranked[0];
    const other = ranked[1];
    const ratio = top.g.draws / idle.draws;
    const title = other
      ? `下注紀錄開了 ${ranked.length} 次，較重的一次每幀畫 ${Math.round(top.g.draws)} 次，是待機的 ${round(ratio, 1)} 倍（另一次 ${Math.round(other.g.draws)} 次）`
      : `下注紀錄每一幀畫 ${Math.round(top.g.draws)} 次，是待機的 ${round(ratio, 1)} 倍`;
    rows.push({ rule: "panel-history", level: ratio >= 2 ? "orange" : "yellow", title, area: "draw call", fix: panelFix(top.f.stage), stage: top.f.stage, t: null });
  }
  rest.forEach((f) => {
    const x = grp(f.stage);
    const ratio = x.draws / idle.draws;
    rows.push({ rule: `panel-${f.stage}`, level: ratio >= 2 ? "orange" : "yellow", title: `${stageName(f.stage)}每一幀畫 ${Math.round(x.draws)} 次，是待機的 ${round(ratio, 1)} 倍`, area: "draw call", fix: panelFix(f.stage), stage: f.stage, t: null });
  });
  if (found.some((f) => f.id === "panel-left-open")) rows.push({ rule: "panel-left-open", level: "orange", title: "關掉面板後，畫面工作量沒回到待機", area: "draw call", fix: "關面板時把節點設成不啟用或銷毀，不要只是移出畫面。", stage: "idle-after-rules", t: null });

  const fill = found.find((f) => f.id === "gpu-fill");
  if (fill) {
    const budget = thresholds.frameBudgetMs || 16.7;
    const cover = fill.contrast;
    rows.push({
      rule: "gpu-fill",
      level: fill.gpuP95 >= budget * 0.8 ? "orange" : "yellow",
      title: `${stageName(fill.stage)} 的 GPU p95 是 ${fill.gpuP95} ms，CPU ${fill.cpuP95} ms，大約 ${Math.round(fill.draws)} 次 draw call`,
      area: "GPU",
      fix: cover
        ? `${stageName(cover.stage)}蓋住轉輪時 GPU 降到 ${cover.gpuP95} ms，draw call 升到 ${Math.round(cover.draws)}。時間花在轉輪和全螢幕大圖的填色，先縮小那幾張。`
        : `一幀預算 ${budget} ms，GPU 佔掉大部分。先縮小畫面上最大的貼圖。`,
      stage: fill.stage,
      t: null,
    });
  }

  const blocked = found.find((f) => f.id === "network-blocked");
  if (blocked) {
    const h = blocked.hosts[0];
    const proto = h.protocol ? `，協定 ${h.protocol}` : "";
    rows.push({
      rule: "network-blocked",
      level: "orange",
      title: `${h.host} 有 ${h.count} 個請求，其中 ${h.queued} 個排隊超過 80 ms${proto}`,
      area: "網路",
      fix: "同一個網域同時太多連線，後面的請求會被堵住。合併小檔、改走 HTTP/2，不急的圖延後再載。",
      stage: "loading",
      t: null,
    });
  }
  const dups = found.find((f) => f.id === "network-duplicate");
  if (dups) {
    const list = dups.files.map((d) => `${d.path} ×${d.count}`).join("、");
    rows.push({ rule: "network-duplicate", level: "yellow", title: `有檔案重複下載：${list}`, area: "網路", fix: "同一個資源只請求一次。快取鍵不要帶每次都變的 query。", stage: "loading", t: null });
  }

  const flags = found.find((f) => f.id === "context-flags");
  if (flags) {
    const bits = [flags.antialias ? "antialias" : "", flags.preserveDrawingBuffer ? "preserveDrawingBuffer" : "", flags.alpha ? "alpha" : ""].filter(Boolean).join("、");
    rows.push({
      rule: "context-flags",
      level: flags.preserveDrawingBuffer ? "orange" : "yellow",
      title: `WebGL context 開了 ${bits}`,
      area: "GPU",
      fix: flags.preserveDrawingBuffer ? "preserveDrawingBuffer 會讓每一幀多拷一次畫面，關掉。2D 老虎機通常也不需要 antialias。" : "整張畫布的 antialias 是全畫面的多重採樣。2D 介面關掉它。",
      stage: null,
      t: null,
    });
  }
  const bigCanvas = found.find((f) => f.id === "canvas-large");
  if (bigCanvas) rows.push({ rule: "canvas-large", level: "yellow", title: `畫布是 ${bigCanvas.w}×${bigCanvas.h} 像素${bigCanvas.dpr ? `，裝置像素比 ${bigCanvas.dpr}` : ""}`, area: "GPU", fix: "填色跟像素數成正比。手機上把解析度上限壓到高 720 或 1280 寬。", stage: null, t: null });

  const shader = found.find((f) => f.id === "shader-stall");
  if (shader) rows.push({ rule: "shader-stall", level: shader.value >= 100 ? "orange" : "yellow", title: `shader ${shader.kind === "linkProgram" ? "連結" : "編譯"}停了 ${shader.count} 次，最長 ${Math.round(shader.value)} ms`, area: "卡頓", fix: "第一次編譯會卡主執行緒。進遊戲前先暖機常用的 shader，或把材質種類收斂。", stage: "loading", t: shader.t });
  const audio = found.find((f) => f.id === "audio-decode");
  if (audio) rows.push({ rule: "audio-decode", level: audio.pcmMb >= (thresholds.audioMb || 16) ? "orange" : "yellow", title: `音效解碼後約 ${audio.pcmMb} MB${audio.maxMs ? `，最長一次 ${Math.round(audio.maxMs)} ms` : ""}`, area: "記憶體", fix: "這塊不在 JS heap，也不在 GPU。進遊戲時不要一次 decode 整包，用到再解，或改串流。", stage: "loading", t: null });
  const rt = found.find((f) => f.id === "render-target");
  if (rt) rows.push({ rule: "render-target", level: "orange", title: `離屏 renderbuffer 約 ${Math.round(rt.mb)} MB`, area: "GPU", fix: "整屏的 RenderTexture 會讓填色再畫一次。能直接畫上畫布就不要先畫到另一張。", stage: null, t: null });

  return rows;
}

// One list for the report: the agent's issues, finding rows, then Cocos advice, worst first.
// An issue whose `rule` names a finding row or Cocos rule replaces that generic row.
function todo() {
  const rank = { red: 0, orange: 1, yellow: 2, green: 3 };
  const issues = ev.issues || [];
  const covered = new Set(issues.map((i) => i.rule).filter(Boolean));
  const rows = issues
    .map((i) => ({ level: i.level || "red", title: i.title, area: i.area || stageName(i.stage) || "", fix: i.next, stage: i.stage || null, t: i.t == null ? null : i.t }))
    .concat(ev.findingRows.filter((r) => !covered.has(r.rule)))
    .concat(ev.cocosAdvice.items.filter((c) => !covered.has(c.id)).map((c) => ({ level: c.level, title: c.title, area: c.area, fix: c.fix, stage: null, t: null, rule: c.id })));
  // A panel row already names the uncached labels on that page, so the global label row would repeat it.
  const toldLabels = rows.some((r) => r.fix && r.fix.includes("沒開快取"));
  const shown = toldLabels ? rows.filter((r) => r.rule !== "cocos-label-no-cache") : rows;
  return shown.map((r, i) => Object.assign(r, { order: i })).sort((a, b) => rank[a.level] - rank[b.level] || a.order - b.order).map(({ order, ...r }, i) => Object.assign({ n: i + 1 }, r));
}

function cocosAdvice() {
  const snaps = (ev.cocos && ev.cocos.snapshots) || [];
  const C = thresholds.cocos;
  const tex = ev.memory && ev.memory.textures && ev.memory.textures.status === "ok" ? ev.memory.textures : null;
  const out = [];
  if (!snaps.length && !tex) return { status: "unavailable", items: out };

  // Counts are the most seen in any snapshot; peakAt names the stage that snapshot was taken in,
  // so the title says where the number comes from instead of mixing it with the last snapshot.
  const pick = (f, s) => {
    try {
      const v = f(s);
      return typeof v === "number" ? v : null;
    } catch (e) {
      return null;
    }
  };
  const peakOf = (f) => snaps.reduce((best, s) => {
    const v = pick(f, s);
    return v != null && (!best || v > best.value) ? { value: v, snap: s } : best;
  }, null);
  const max = (f) => {
    const p = peakOf(f);
    return p ? p.value : null;
  };
  const peakAt = (f) => {
    const p = peakOf(f);
    const at = p && p.snap.at;
    return snaps.length > 1 && at ? `（最多時在${stageName(String(at).replace(/^cocos[:-]?/, ""))}）` : "";
  };
  const last = snaps[snaps.length - 1] || {};
  const settings = last.settings || {};
  const add = (id, area, title, fix) => out.push({ id, level: COCOS_LEVEL[id] || "yellow", area, title, fix });
  const list = (xs) => (xs && xs.length ? `例如 ${xs.slice(0, 3).join("、")}。` : "");

  // Advice differs by engine line. 2.0–2.3, 2.4 and 3.x have different compression and WebGL options.
  const ver = String(last.engine || "").match(/(\d+)\.(\d+)/);
  const major = ver ? Number(ver[1]) : null;
  const minor = ver ? Number(ver[2]) : null;
  const line = major == null ? null : major >= 3 ? "3" : minor >= 4 ? "2.4" : "2.0";
  const engineName = last.engine ? `Cocos ${last.engine}` : "這個版本";

  const realtime = max((s) => s.spine.realtime);
  const spineActive = max((s) => s.spine.active);
  const bones = max((s) => s.spine.activeRealtimeBones);
  const snapAt = (name) => snaps.find((s) => s.at === name);
  const idleSnap = snapAt("idle");
  const endSnap = snaps.length ? snaps[snaps.length - 1] : null;
  const spineGroups = (s) => {
    const by = (s && s.spine && s.spine.realtimeBy) || {};
    return Object.keys(by).map((k) => `${k} ×${by[k]}`);
  };
  let spineRetained = false;
  if (idleSnap && endSnap && idleSnap !== endSnap && idleSnap.spine && endSnap.spine) {
    const grewBones = (endSnap.spine.activeRealtimeBones || 0) >= (idleSnap.spine.activeRealtimeBones || 0) + (C.spineBonesRetained || 100);
    const grewCopies = (endSnap.spine.realtime || 0) >= (idleSnap.spine.realtime || 0) + (C.spineCopiesRetained || 3);
    if (grewBones || grewCopies) {
      spineRetained = true;
      const groups = spineGroups(endSnap);
      const batched = endSnap.spine.batched != null ? endSnap.spine.batched : 0;
      add(
        "cocos-spine-retained",
        "CPU",
        `關下面板後，即時 Spine 從 ${idleSnap.spine.realtime || 0} 個、${idleSnap.spine.activeRealtimeBones || 0} 根留在 ${endSnap.spine.realtime || 0} 個、${endSnap.spine.activeRealtimeBones || 0} 根`,
        `同一份 skeleton 不要每顆符號各算一次。不需要即時混合的改 SHARED_CACHE，同圖集開 enableBatch（目前 ${batched}）。${groups.length ? `留下最多的是 ${groups.slice(0, 3).join("、")}。` : ""}`
      );
    }
  }
  if (!spineRetained && realtime != null && realtime > C.spineRealtimeActive) {
    const peak = peakOf((s) => s.spine.realtime);
    const groups = spineGroups(peak && peak.snap);
    add("cocos-spine-realtime", "CPU", `畫面上有 ${realtime} 個即時運算的 Spine${spineActive != null ? `（共 ${spineActive} 個在畫）` : ""}${bones ? `，合計 ${bones} 根骨頭` : ""}${peakAt((s) => s.spine.realtime)}`, `不需要即時混合的動畫改成 SHARED_CACHE，看不到的骨架關掉 active，同圖集的開 enableBatch。${groups.length ? `最多的是 ${groups.slice(0, 3).join("、")}。` : ""}`);
  }

  const consoleGroups = last.console || [];
  const cacheWarn = consoleGroups.filter((g) => /clearTrack|cache mode|cacheMode/i.test(g.text));
  if (cacheWarn.length) {
    const n = cacheWarn.reduce((a, g) => a + g.count, 0);
    add("cocos-spine-cache-warning", "穩定性", `快取模式的 Spine 被呼叫了不支援的方法 ${n} 次`, "快取模式不支援 clearTrack 這類呼叫。改用 setAnimation 覆蓋，或這幾個骨架改回 REALTIME。");
  }

  const texSource = (last.textures && last.textures.status === "ok" && last.textures) || tex;
  if (texSource) {
    const uncompressed = texSource.count - (texSource.compressed || 0);
    const share = texSource.count ? uncompressed / texSource.count : 0;
    let toldUncompressed = false;
    if (texSource.mb > C.uncompressedMinMb && share > C.uncompressedShare) {
      toldUncompressed = true;
      const canvas = ev.conditions && ev.conditions.canvas;
      const over = canvas ? (texSource.largest || []).filter((t) => t.w > canvas.w * 1.05 || t.h > canvas.h * 1.05).slice(0, 3) : [];
      const overText = over.length ? `其中 ${over.map((t) => `${t.w}×${t.h}${t.file ? " " + t.file : ""}`).join("、")} 比畫布 ${canvas.w}×${canvas.h} 還大，先縮到畫面尺寸。` : "先縮小最大的幾張。";
      const how = {
        "2.0": `${overText}網頁上 JPG、PNG 進 WebGL 仍是每像素 4 byte。原生包才加 ETC1（Android）與 PVRTC（iOS，要正方形而且邊長是 2 的冪），沒壓縮的留作備援。邊長不是 2 的冪不要為了壓縮去補齊。`,
        "2.4": `${overText}網頁上仍會解成 RGBA8888。原生包加 ETC1（Android）或 ASTC，PVRTC 才需要正方形 2 的冪，其餘不要把圖墊成 POT。`,
        "3": `${overText}${engineName} 以 ASTC 為主，ETC2 備援。ETC 和 ASTC 不需要把邊長補成 2 的冪。`,
      }[line] || `${overText}壓縮格式用目標裝置支援的 ETC、ASTC 或 PVRTC，只有 PVRTC 和 mipmap 才需要 2 的冪。`;
      const files = over.length ? [] : (texSource.largest || []).map((t) => t.file).filter(Boolean);
      add("cocos-texture-uncompressed", "記憶體", `${texSource.count} 張貼圖裡 ${uncompressed} 張沒壓縮，約 ${Math.round(texSource.mb)} MB`, `${how}${list(files)}`);
    }
    if (!toldUncompressed && texSource.count && texSource.npot / texSource.count > C.npotShare) {
      add("cocos-texture-npot", "記憶體", `${texSource.npot} 張貼圖的邊長不是 2 的冪`, "ETC 和 ASTC 不需要 POT，把圖墊成 POT 只會更佔記憶體；只有用 PVRTC（要正方形 POT）或要 mipmap 的圖才需要。");
    }
  }

  // Probes that tell BMFont apart count only TTF and system-font labels; older ones count every NONE label.
  const ttfKnown = snaps.some((s) => s.labels && s.labels.noCacheTtf != null);
  const labelPick = ttfKnown ? (s) => s.labels.noCacheTtf : (s) => s.labels.noCache;
  const noCache = max(labelPick);
  if (noCache != null && noCache > C.labelNoCacheActive) {
    const peak = peakOf(labelPick);
    const samples = (peak && peak.snap.labels && peak.snap.labels.samples) || [];
    const kind = ttfKnown ? "TTF 或系統字的 Label 沒開快取" : "Label 沒開快取（這次沒分出 BMFont，可能高估）";
    add("cocos-label-no-cache", "draw call", `${noCache} 個 ${kind}${peakAt(labelPick)}`, `沒開快取的 TTF 與系統字每個都自己一張貼圖，不能跟圖集合批。固定文字改 BitmapFont 或 BITMAP 模式，常變的數字用 CHAR。${list(samples)}`);
  }
  const masks = max((s) => s.masks.active);
  const stencilOf = (s) => (s.masks && s.masks.byType && s.masks.byType.IMAGE_STENCIL) || 0;
  const stencil = max(stencilOf);
  if (stencil != null && stencil >= (C.imageStencil || 1)) {
    const peak = peakOf(stencilOf);
    const samples = (peak && peak.snap.masks && peak.snap.masks.stencilSamples) || [];
    add("cocos-mask-stencil", "draw call", `畫面上有 ${stencil} 個圖片遮罩${peakAt(stencilOf)}`, `IMAGE_STENCIL 比矩形遮罩多畫一次，而且會打斷合批。轉輪這種固定窗口改用預先裁好的圖。${list(samples)}`);
  }
  if (masks != null && masks > C.masksActive) {
    const peak = peakOf((s) => s.masks.active);
    const samples = (peak && peak.snap.masks && peak.snap.masks.samples) || [];
    add("cocos-mask-many", "draw call", `畫面上同時有 ${masks} 個 Mask${peakAt((s) => s.masks.active)}`, `每個 Mask 都要寫 stencil，前後都會打斷合批，矩形 Mask 也一樣。固定形狀的裁切改用預先裁好的圖；只留捲動列表這類真的要動態裁切的。${list(samples)}`);
  }
  const particles = max((s) => s.particles.maxParticles);
  if (particles != null && particles > C.particlesMax) {
    add("cocos-particles-many", "CPU", `粒子上限加總 ${particles}`, "降低 totalParticles，或在不在畫面時停掉發射器。");
  }
  const nodes = max((s) => s.nodes.total);
  if (nodes != null && nodes > C.nodesTotal) {
    const active = max((s) => s.nodes.active);
    add("cocos-nodes-many", "CPU", `場景有 ${nodes} 個節點${active != null ? `，${active} 個在顯示` : ""}${peakAt((s) => s.nodes.total)}`, "不在畫面的面板與特效改成用時再生，或放進物件池。");
  }
  if (settings.cleanupImageCache === false && settings.dynamicAtlas === false) {
    add("cocos-image-cache-kept", "記憶體", "貼圖上傳後，原圖還留在 JS 記憶體", "動態合圖是關的，可以把 cc.macro.CLEANUP_IMAGE_CACHE 設成 true。");
  }
  if (settings.dynamicAtlas === false) {
    add("cocos-dynamic-atlas-off", "draw call", "動態合圖是關的", "小圖多的介面打開 cc.dynamicAtlasManager.enabled。");
  }
  const cams = max((s) => s.cameras && s.cameras.active);
  if (cams != null && cams > (C.camerasActive || 1)) add("cocos-extra-camera", "GPU", `同時有 ${cams} 個相機在畫`, "多一台相機就多清一次畫面。老虎機通常一台相機就夠。");
  const rtMb = max((s) => s.renderTextures && s.renderTextures.mb);
  const rtCount = max((s) => s.renderTextures && s.renderTextures.count);
  if (rtMb != null && rtMb >= (C.renderTextureMb || 8)) {
    const peak = peakOf((s) => s.renderTextures && s.renderTextures.mb);
    const big = peak && peak.snap.renderTextures && peak.snap.renderTextures.largest;
    add("cocos-render-texture", "GPU", `RenderTexture ${rtCount} 張，約 ${Math.round(rtMb)} MB${big ? `，最大 ${big.w}×${big.h}` : ""}`, "整屏的 RenderTexture 會讓填色再畫一次。能直接畫上畫布就不要先畫到另一張。");
  }
  if (settings.webglVersion === 1 && settings.webgl2Available && line === "3") {
    add("cocos-webgl1", "draw call", `用的是 WebGL 1${last.engine ? `（Cocos ${last.engine}）` : ""}，瀏覽器有 WebGL 2`, `${engineName} 支援 WebGL 2，檢查專案設定或啟動參數是否把它關掉了。`);
  }
  const cap = settings.frameRate;
  const hz = gf ? gf.hz : 60;
  if (cap != null && cap < hz && Math.abs(hz / cap - Math.round(hz / cap)) > 0.05) {
    frameRateLevel = "orange";
    add("cocos-frame-rate", "節奏", `幀率上限 ${cap} 不能整除螢幕 ${hz} Hz，畫面一幀快一幀慢`, `cc.game.frameRate 設成 ${Math.round(hz / 2)} 或 ${hz}。`);
  } else if (cap != null && cap > hz) {
    frameRateLevel = "yellow";
    add("cocos-frame-rate", "節奏", `幀率上限 ${cap} 高於螢幕 ${hz} Hz，多算的幀不會上螢幕`, `cc.game.frameRate 設成 ${hz}，省下多算的 CPU。`);
  } else if (cap != null && cap < 60 * 0.95) {
    frameRateLevel = "yellow";
    add("cocos-frame-rate", "節奏", `幀率上限 ${cap}，目標是 60`, "cc.game.frameRate 設成 60。");
  }
  const errors = consoleGroups.filter((g) => g.level === "error" || (g.count > C.consoleRepeat && !cacheWarn.includes(g)));
  if (errors.length) {
    add("cocos-console-errors", "穩定性", `主控台有 ${errors.length} 種引擎錯誤或重複警告`, errors.slice(0, 3).map((g) => `${g.text.slice(0, 60)}（${g.count} 次）`).join("；"));
  }

  const first = snaps[0];
  return {
    status: snaps.length ? "ok" : "textures-only",
    items: out,
    scene: first
      ? {
          nodes: max((s) => s.nodes.total),
          activeNodes: max((s) => s.nodes.active),
          spine: max((s) => s.spine.total),
          spineActive,
          spineRealtime: realtime,
          labels: max((s) => s.labels.active),
          masks,
          particles: max((s) => s.particles.active),
        }
      : null,
  };
}

fs.writeFileSync(evidencePath, JSON.stringify(ev, null, 2) + "\n");
const fmt = (p) => (p.score == null ? "未評分" : `${p.score}${p.provisional ? `（暫定，覆蓋 ${p.coverage}%）` : ""}`);
console.log(`載入階段 ${fmt(ev.score.loading)}　幀率穩定度 ${fmt(ev.score.smooth)}　資源占用 ${fmt(ev.score.memory)}　要處理 ${ev.todo.length} 條（Cocos ${ev.cocosAdvice.items.length}）`);
