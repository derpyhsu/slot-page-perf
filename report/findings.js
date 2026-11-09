// Applies protocol/rules.md to an evidence object. Used by report/build.js.
"use strict";

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
    const row = out.get(g) || { group: g, stages: 0, frames: 0, ms: 0, bad: 0, drop: 0, dropFrames: 0, lows: [], cpuP95: [], draws: 0, gpuPeak: null, heapEnd: null, hitches: [] };
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
    out.set(g, row);
  });
  return [...out.values()].map((r) => {
    const lows = r.lows.slice().sort((a, b) => a - b);
    return {
      group: r.group,
      stages: r.stages,
      frames: r.frames,
      fps: r.ms ? round((1000 * r.frames) / r.ms) : null,
      // Across many spins, the 1% low is the 10th percentile of per-spin 1% lows.
      fpsLow: lows.length ? lows[Math.floor((lows.length - 1) * (lows.length > 5 ? 0.1 : 0))] : null,
      badShare: r.frames ? round(r.bad / r.frames, 3) : null,
      dropShare: r.dropFrames ? round(r.drop / r.dropFrames, 3) : null,
      cpuP95: r.cpuP95.length ? round(Math.max(...r.cpuP95)) : null,
      draws: r.frames ? round(r.draws / r.frames) : null,
      gpuPeakMb: r.gpuPeak,
      heapEndMb: r.heapEnd,
      worstHitch: r.hitches.sort((a, b) => b.dt - a.dt)[0] || null,
      hitchCount: r.hitches.length,
    };
  });
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
  gs.filter((x) => GAME_GROUPS.has(x.group)).forEach((x) => {
    const why = [];
    if (x.fps != null && x.fps < F.stageMin) why.push("fps");
    if (x.fpsLow != null && x.fpsLow < F.lowMin) why.push("fpsLow");
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

  const spins = stages.filter((s) => /^(spin|turbo)-\d+$/.test(s.name));
  if (spins.length < T.warmupSpins + T.leakTailSpins) out.push({ id: "leak-check", status: "not-enough-spins", spins: spins.length });
  else {
    const from = spins[T.warmupSpins - 1].heapEndMb;
    const to = spins[spins.length - 1].heapEndMb;
    const tail = spins.slice(-T.leakTailSpins).map((s) => s.heapEndMb).filter((v) => v != null);
    // Floors are the local lows. A step that then sawtooths is not "still rising".
    const floors = [];
    for (let i = 1; i < tail.length - 1; i++) {
      if (tail[i] <= tail[i - 1] && tail[i] <= tail[i + 1]) floors.push(tail[i]);
    }
    const rising = floors.length >= 2 ? floors[floors.length - 1] > floors[0] + 1 : tail.length >= 3 && tail[tail.length - 1] > tail[0] + 1;
    if (from != null && to != null && to - from > T.leakMb && rising) out.push({ id: "leak-suspected", status: "suspected", from, to, delta: round(to - from) });
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

  return { findings: out, groups: gs, softwareGpu: soft };
}

module.exports = { findings, groups, groupOf, SOFTWARE_GPU };
