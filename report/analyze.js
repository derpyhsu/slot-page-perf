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

const NOT_GAME = new Set(["boot", "loading", "splash", "enter", "game-ready", "gap"]);
const stages = ev.stages || [];
const gameStages = stages.filter((s) => !NOT_GAME.has(s.name) && s.frames > 0);
const spinStages = stages.filter((s) => /^(spin|turbo)-\d+$/.test(s.name));

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

function stableShare() {
  const buckets = ev.timeline && ev.timeline.buckets;
  const ready = gameReadyMs();
  if (buckets && buckets.length && ready != null) {
    const game = buckets.filter((b) => b[0] >= ready && b[1] > 0);
    if (!game.length) return null;
    const good = game.filter((b) => b[4] === 0).length;
    return { share: good / game.length, approx: false };
  }
  // Coarse fallback from stage summaries: each frame hitch spoils the buckets it spans.
  const bucketMs = (thresholds.timeline && thresholds.timeline.bucketMs) || 250;
  let total = 0;
  let bad = 0;
  gameStages.forEach((s) => {
    total += Math.max(1, Math.round(s.wallMs / bucketMs));
    (s.hitches || []).forEach((h) => {
      if (h.source !== "longtask" && h.dt > cfg.smooth.stable.badFrameMs) bad += Math.ceil(h.dt / bucketMs);
    });
  });
  if (!total) return null;
  return { share: Math.max(0, (total - bad) / total), approx: true };
}

function worstStall() {
  let worst = { dt: 0, stage: null, t: null };
  gameStages.forEach((s) => {
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

function growthPerSpin() {
  const warm = thresholds.warmupSpins;
  if (spinStages.length < warm + 5) return null;
  const from = spinStages[warm - 1];
  const to = spinStages[spinStages.length - 1];
  if (from.heapEndMb == null || to.heapEndMb == null) return null;
  return Math.max(0, (to.heapEndMb - from.heapEndMb) / (spinStages.length - warm));
}

function bigTextureCount() {
  const tex = ev.memory && ev.memory.textures;
  if (!tex || tex.status !== "ok" || !tex.largest) return null;
  return tex.largest.filter((t) => t.mb >= cfg.memory.bigTextures.mb).length;
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
const cpuStat = cpuP95();
const cpu = cpuStat && cpuStat.value;
const smoothItems = [
  {
    id: "stable",
    label: "穩定 60",
    weight: S.stable.weight,
    value: stable ? round(stable.share * 100, 1) : null,
    unit: "%",
    approx: stable ? stable.approx : false,
    full: `${S.stable.full * 100}%`,
    zero: `${S.stable.zero * 100}%`,
    score: stable ? curve(stable.share, S.stable.full, S.stable.zero, { higherIsBetter: true }) : null,
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
];

const M = cfg.memory;
const heap = heapPeak();
const texture = texturePeak();
const fb = framebufferMb();
const estimate = heap != null && texture != null ? heap + texture + fb : null;
const ratio = estimate == null ? null : estimate / cfg.memoryBudgetMb;
const growth = growthPerSpin();
const big = bigTextureCount();
const memoryItems = [
  {
    id: "budget",
    label: "預算",
    weight: M.budget.weight,
    value: ratio == null ? null : round(ratio * 100, 0),
    unit: "%",
    full: `${M.budget.full * 100}%`,
    zero: `${M.budget.zero * 100}%`,
    score: ratio == null ? null : curve(ratio, M.budget.full, M.budget.zero),
  },
  {
    id: "growth",
    label: "增長",
    weight: M.growth.weight,
    value: growth == null ? null : round(growth, 2),
    unit: "MB/轉",
    full: `${M.growth.full} MB/轉`,
    zero: `${M.growth.zero} MB/轉`,
    score: growth == null ? null : growth <= M.growth.full ? 1 : curve(growth, M.growth.full, M.growth.zero, { log: true }),
  },
  {
    id: "bigTextures",
    label: "大貼圖",
    weight: M.bigTextures.weight,
    value: big,
    unit: "張",
    full: `${M.bigTextures.full} 張`,
    zero: `${M.bigTextures.zero} 張`,
    score: big == null ? null : curve(big, M.bigTextures.full, M.bigTextures.zero),
  },
];

const F = cfg.fatal;
const smoothFatal = [];
const memoryFatal = [];
if (stall.dt > F.stallMs) smoothFatal.push({ id: "stall", stage: stall.stage, t: stall.t, value: round(stall.dt, 0) });
gameStages.forEach((s) => {
  if (s.fps != null && s.fps < F.minFps) smoothFatal.push({ id: "low-fps", stage: s.name, value: s.fps });
});
if (ratio != null && ratio > 1) memoryFatal.push({ id: "over-budget", value: round(estimate, 0) });
if ((ev.findings || []).some((f) => f.id === "leak-suspected")) memoryFatal.push({ id: "leak-suspected" });

ev.score = {
  version: 1,
  smooth: Object.assign(total(smoothItems, smoothFatal.length ? F.cap : null), { items: smoothItems, fatal: smoothFatal }),
  memory: Object.assign(total(memoryItems, memoryFatal.length ? F.cap : null), {
    items: memoryItems,
    fatal: memoryFatal,
    budgetMb: cfg.memoryBudgetMb,
    estimateMb: estimate == null ? null : { heap: round(heap), texture: round(texture), framebuffer: round(fb), total: round(estimate), gpuSource: gpuSource() },
  }),
};
smoothItems.concat(memoryItems).forEach((i) => {
  if (i.score != null) i.score = Math.round(i.score * 100);
});

const COCOS_LEVEL = {
  "cocos-spine-realtime": "orange",
  "cocos-spine-cache-warning": "orange",
  "cocos-texture-uncompressed": memoryFatal.length ? "red" : "orange",
  "cocos-texture-npot": "yellow",
  "cocos-label-no-cache": "yellow",
  "cocos-mask-many": "yellow",
  "cocos-particles-many": "orange",
  "cocos-nodes-many": "yellow",
  "cocos-image-cache-kept": "orange",
  "cocos-dynamic-atlas-off": "yellow",
  "cocos-webgl1": "yellow",
  "cocos-frame-rate": "red",
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
      const fails =
        (g.fps != null && g.fps < F.stageMin) ||
        (g.dropShare != null && g.dropShare > F.dropShareMax) ||
        (g.badShare != null && g.badShare > F.badShareMax) ||
        (g.fpsLow != null && g.fpsLow < F.lowMin);
      const bad = (g.fps != null && g.fps < 45) || (g.dropShare != null && g.dropShare > 0.1);
      const loading = g.group === "loading" || g.group === "enter";
      const level = bad && !loading ? "red" : fails ? (loading ? "yellow" : "orange") : g.dropShare > F.dropShareMax / 2 ? "yellow" : "green";
      return { group: g.group, label: stageName(g.group), stages: g.stages, fps: g.fps, fpsLow: g.fpsLow, dropShare: g.dropShare, badShare: g.badShare, gpuPeakMb: g.gpuPeakMb, level };
    });
}

// Rows written from findings, so the table does not depend on the agent writing issues.
// rule ids: stall-<group>, fps-<group>, memory-budget, leak-suspected, panel-<stage>, panel-left-open.
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

  const hitches = found.filter((f) => /^hitch-/.test(f.id) && f.value >= thresholds.hitchMs);
  const byGroup = new Map();
  hitches.forEach((h) => {
    const g = /^(spin|turbo)-\d+$/.test(h.stage) ? h.stage.replace(/-\d+$/, "") : h.stage.replace(/-spike$/, "");
    byGroup.set(g, (byGroup.get(g) || []).concat(h));
  });
  byGroup.forEach((hs, g) => {
    const worst = hs.reduce((a, b) => (b.value > a.value ? b : a));
    const net = hs.filter((h) => h.id === "hitch-network").length;
    const loading = g === "loading" || g === "enter";
    const name = stageName(g);
    const title = loading
      ? `${name}時頓了 ${hs.length} 次，最長 ${sec(worst.value)}`
      : hs.length > 1 ? `${name}時畫面停了 ${hs.length} 次，最長 ${sec(worst.value)}` : `${name}時畫面停 ${sec(worst.value)}`;
    const level = loading ? (worst.value >= 500 ? "orange" : "yellow") : worst.value >= 250 ? "red" : worst.value >= 100 ? "orange" : "yellow";
    const fix = loading
      ? net >= hs.length / 2
        ? "停頓時還有資源在下載；把大檔移到前段預載，下載完的初始化拆成幾幀做。"
        : "主執行緒一次做太多；把初始化拆成幾幀做，不要一次建完。"
      : "在這一刻錄一次 DevTools Performance，看這段時間在做什麼；常見是一次建好整頁節點或同步上傳貼圖。";
    rows.push({ rule: `stall-${g}`, level, title, area: "卡頓", fix, stage: worst.stage, t: worst.t });
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
    rows.push({ rule: "fps-bad", level: "orange", title: `${names(kinds.bad)}有 ${round((w.badShare || 0) * 100, 1)}% 的幀超過 33 ms`, area: "FPS", fix: fpsHint(w), stage: w.stage, t: null });
  }

  if (ratio != null && ratio > 0.5) {
    const est = ev.score.memory.estimateMb;
    const big = [...new Set((tex && tex.largest ? tex.largest : []).map((x) => `${x.w}×${x.h}`))].slice(0, 2).join("、");
    rows.push({
      rule: "memory-budget",
      level: ratio > 1 ? "red" : ratio > 0.7 ? "orange" : "yellow",
      title: `記憶體推估 ${Math.round(est.total)} MB，佔 ${cfg.memoryBudgetMb} MB 預算 ${Math.round(ratio * 100)}%`,
      area: "記憶體",
      fix: `GPU ${Math.round(est.texture)} MB 是大頭${big ? `，最大的是 ${big}` : ""}。待機時這些貼圖就在卡上，不是切場景會放掉的。格式見下面的未壓縮那條。`,
      stage: null,
      t: null,
    });
  }

  const leak = found.find((f) => f.id === "leak-suspected");
  if (leak) rows.push({ rule: "leak-suspected", level: "red", title: `轉了之後 JS 記憶體從 ${Math.round(leak.from)} 漲到 ${Math.round(leak.to)} MB`, area: "記憶體", fix: "轉前、轉後各拍一次 heap snapshot 比對，看哪一類物件越來越多；常見是事件沒解除或動畫節點沒回收。", stage: null, t: null });

  const idle = grp("idle");
  found.filter((f) => f.id === "panel-heavier").forEach((f) => {
    const x = grp(f.stage);
    if (!x || !idle || f.drawRatio == null || f.drawRatio <= 0.3) return;
    rows.push({ rule: `panel-${f.stage}`, level: f.drawRatio >= 2 ? "orange" : "yellow", title: `${stageName(f.stage)}每一幀畫 ${Math.round(x.draws)} 次，是待機的 ${round(x.draws / idle.draws, 1)} 倍`, area: "draw call", fix: "這頁的圖合成圖集，被面板蓋住的層關掉。", stage: f.stage, t: null });
  });
  if (found.some((f) => f.id === "panel-left-open")) rows.push({ rule: "panel-left-open", level: "orange", title: "關掉面板後，畫面工作量沒回到待機", area: "draw call", fix: "關面板時把節點設成不啟用或銷毀，不要只是移出畫面。", stage: "idle-after-rules", t: null });

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
  return rows.map((r, i) => Object.assign(r, { order: i })).sort((a, b) => rank[a.level] - rank[b.level] || a.order - b.order).map(({ order, ...r }, i) => Object.assign({ n: i + 1 }, r));
}

function cocosAdvice() {
  const snaps = (ev.cocos && ev.cocos.snapshots) || [];
  const C = thresholds.cocos;
  const tex = ev.memory && ev.memory.textures && ev.memory.textures.status === "ok" ? ev.memory.textures : null;
  const out = [];
  if (!snaps.length && !tex) return { status: "unavailable", items: out };

  const max = (pick) => {
    const xs = snaps.map((s) => {
      try {
        return pick(s);
      } catch (e) {
        return null;
      }
    }).filter((x) => typeof x === "number");
    return xs.length ? Math.max(...xs) : null;
  };
  const last = snaps[snaps.length - 1] || {};
  const settings = last.settings || {};
  const add = (id, area, title, fix) => out.push({ id, level: COCOS_LEVEL[id] || "yellow", area, title, fix });

  const realtime = max((s) => s.spine.realtime);
  const spineActive = max((s) => s.spine.active);
  const bones = max((s) => s.spine.activeRealtimeBones);
  if (realtime != null && realtime > C.spineRealtimeActive) {
    add("cocos-spine-realtime", "CPU", `畫面上有 ${realtime} 個即時運算的 Spine${spineActive != null ? `（共 ${spineActive} 個在畫）` : ""}${bones ? `，合計 ${bones} 根骨頭` : ""}`, "不需要即時混合的動畫改成 SHARED_CACHE，看不到的骨架關掉 active，同圖集的開 enableBatch。");
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
    if (texSource.mb > C.uncompressedMinMb && share > C.uncompressedShare) {
      add("cocos-texture-uncompressed", "記憶體", `${texSource.count} 張貼圖裡 ${uncompressed} 張沒壓縮，約 ${Math.round(texSource.mb)} MB`, "Cocos 2.4 的 web-mobile 用 ETC1。裝置支援 ASTC 再用 ASTC。WebGL 1 沒有 ETC2／PVRTC 這個預設。");
    }
    if (texSource.count && texSource.npot / texSource.count > C.npotShare) {
      add("cocos-texture-npot", "記憶體", `${texSource.npot} 張貼圖的邊長不是 2 的冪`, "ETC1 和 ASTC 不需要 POT。把圖墊成 POT 會更佔記憶體；只有 PVRTC 或 mipmap 才勾。");
    }
  }

  const noCache = max((s) => s.labels.noCache);
  if (noCache != null && noCache > C.labelNoCacheActive) {
    const system = last.labels && last.labels.systemFont;
    add("cocos-label-no-cache", "draw call", `${noCache} 個 Label 沒開快取${system ? `，其中 ${system} 個是系統字` : ""}`, "系統字不會跟圖集合批。固定文字改 BitmapFont，常變的數字用 CHAR。");
  }
  const masks = max((s) => s.masks.active);
  if (masks != null && masks > C.masksActive) {
    add("cocos-mask-many", "draw call", `畫面上同時有 ${masks} 個 Mask`, "每個 Mask 都會打斷合批。能用矩形裁切或預先裁好的圖就不要用 Mask。");
  }
  const particles = max((s) => s.particles.maxParticles);
  if (particles != null && particles > C.particlesMax) {
    add("cocos-particles-many", "CPU", `粒子上限加總 ${particles}`, "降低 totalParticles，或在不在畫面時停掉發射器。");
  }
  const nodes = max((s) => s.nodes.total);
  if (nodes != null && nodes > C.nodesTotal) {
    const active = max((s) => s.nodes.active);
    add("cocos-nodes-many", "CPU", `場景有 ${nodes} 個節點${active != null ? `，${active} 個在顯示` : ""}`, "不在畫面的面板與特效改成用時再生，或放進物件池。");
  }
  if (settings.cleanupImageCache === false) {
    add(
      "cocos-image-cache-kept",
      "記憶體",
      "貼圖上傳後，原圖還留在 JS 記憶體",
      settings.dynamicAtlas ? "動態合圖是開的。CLEANUP_IMAGE_CACHE 設成 true 會讓合圖失效，兩件事不能同時開。" : "把 cc.macro.CLEANUP_IMAGE_CACHE 設成 true。"
    );
  }
  if (settings.dynamicAtlas === false) {
    add("cocos-dynamic-atlas-off", "draw call", "動態合圖是關的", "小圖多的介面打開 cc.dynamicAtlasManager.enabled。");
  }
  if (settings.webglVersion === 1 && settings.webgl2Available) {
    add("cocos-webgl1", "draw call", `用的是 WebGL 1${last.engine ? `（Cocos ${last.engine}）` : ""}，瀏覽器有 WebGL 2`, "Cocos 2.4 只有 WebGL 1，沒有開關。WebGL 2 要換 3.x。這次先降 draw call。");
  }
  if (settings.frameRate != null && settings.frameRate < 60) {
    add("cocos-frame-rate", "穩定性", `幀率上限設成 ${settings.frameRate}`, "目標是穩定 60，確認 cc.game.frameRate 是 60。");
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
console.log(`順暢 ${fmt(ev.score.smooth)}　記憶體 ${fmt(ev.score.memory)}　要處理 ${ev.todo.length} 條（Cocos ${ev.cocosAdvice.items.length}）`);
