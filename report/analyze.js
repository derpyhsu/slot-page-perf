#!/usr/bin/env node
// Usage: node report/analyze.js runs/<run>/evidence.json
// Writes evidence.score (protocol/scoring.md) and evidence.cocosAdvice (Cocos rules in protocol/rules.md).
"use strict";

const fs = require("fs");
const path = require("path");

const evidencePath = process.argv[2];
if (!evidencePath) {
  console.error("usage: node report/score.js <evidence.json>");
  process.exit(1);
}

const thresholds = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "protocol", "thresholds.json"), "utf8"));
const cfg = thresholds.scoring;
const ev = JSON.parse(fs.readFileSync(evidencePath, "utf8"));

const NOT_GAME = new Set(["boot", "loading", "game-ready", "gap"]);
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
  const xs = gameStages.filter((s) => s.cpuMs && s.cpuFrames !== 0).map((s) => s.cpuMs.p95);
  return xs.length ? Math.max(...xs) : null;
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

function texturePeak() {
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
const cpu = cpuP95();
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
    estimateMb: estimate == null ? null : { heap: round(heap), texture: round(texture), framebuffer: round(fb), total: round(estimate) },
  }),
};
smoothItems.concat(memoryItems).forEach((i) => {
  if (i.score != null) i.score = Math.round(i.score * 100);
});

ev.cocosAdvice = cocosAdvice();

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
  const add = (id, area, title, fix) => out.push({ id, area, title, fix });

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
      add("cocos-texture-uncompressed", "記憶體", `${texSource.count} 張貼圖裡 ${uncompressed} 張沒壓縮，約 ${Math.round(texSource.mb)} MB`, "在構建的貼圖壓縮設定裡給大圖集加 ASTC 與 ETC2，iOS 加 PVRTC 或 ASTC。通常能省四分之三。");
    }
    if (texSource.count && texSource.npot / texSource.count > C.npotShare) {
      add("cocos-texture-npot", "記憶體", `${texSource.npot} 張貼圖的邊長不是 2 的冪`, "圖集打包時勾選 POT，才能用 PVRTC 壓縮和 mipmap。");
    }
  }

  const noCache = max((s) => s.labels.noCache);
  if (noCache != null && noCache > C.labelNoCacheActive) {
    add("cocos-label-no-cache", "draw call", `${noCache} 個 Label 沒開快取`, "常變的數字用 CHAR，固定文字用 BITMAP，才能和其他圖合批。");
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
    add("cocos-image-cache-kept", "記憶體", "貼圖上傳後，原圖還留在 JS 記憶體", "把 cc.macro.CLEANUP_IMAGE_CACHE 設成 true。");
  }
  if (settings.dynamicAtlas === false) {
    add("cocos-dynamic-atlas-off", "draw call", "動態合圖是關的", "小圖多的介面打開 cc.dynamicAtlasManager.enabled。");
  }
  if (settings.webglVersion === 1 && settings.webgl2Available) {
    add("cocos-webgl1", "draw call", `用的是 WebGL 1${last.engine ? `（Cocos ${last.engine}）` : ""}，瀏覽器有 WebGL 2`, "升級引擎版本才能用 WebGL 2 與 instancing。短期內先降 draw call。");
  }
  if (settings.frameRate != null && settings.frameRate !== 60) {
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
console.log(`順暢 ${fmt(ev.score.smooth)}　記憶體 ${fmt(ev.score.memory)}　Cocos 建議 ${ev.cocosAdvice.items.length} 條`);
