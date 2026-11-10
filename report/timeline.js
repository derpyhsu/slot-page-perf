// Draws the run as one SVG: stages, where each suggestion happened, FPS, CPU, memory.
// Runs in Node (report.md's timeline.svg) and inlined in report.html, where range zooms in.
// Time spent in `gap` (the driver waiting on the agent or a forced GC) is not play, so it is cut out
// of the x axis and shown as a break. eventSvg draws the two seconds around one stall.
(function (root) {
"use strict";

const C = {
  red: "#e5484d",
  orange: "#f76b15",
  cpu: "#f2c94c",
  cpuEdge: "#d9a925",
  blue: "#0090ff",
  purple: "#8e4ec6",
  ink: "#1c2024",
  sub: "#60646c",
  faint: "#8b8d98",
  band1: "#eceef0",
  band2: "#e0e1e6",
  lane: "#f5f6f7",
  bg: "#ffffff",
};
const FONT = "'Microsoft JhengHei','PingFang TC','Noto Sans TC',sans-serif";
const SOFTWARE_GPU = /swiftshader|basic render driver|llvmpipe|softpipe|warp/i;

const NAMES = {
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
};
function groupName(name) {
  if (/^spin-\d+$/.test(name)) return "spin";
  if (/^turbo-\d+$/.test(name)) return "加速 spin";
  const base = name.replace(/-spike$/, "");
  return NAMES[base] || base;
}
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
// Only slow is colored. 55 and up is the neutral band.
const fpsColor = (f) => (f >= 55 ? C.band1 : f >= 45 ? "#fcd9b8" : f >= 30 ? "#f79a5b" : C.red);
const clock = (ms) => {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};
const field = (tl, name, fallback) => {
  const i = (tl.bucketFields || []).indexOf(name);
  return i >= 0 ? i : fallback;
};

function placed(ev) {
  let t = 0;
  return (ev.stages || [])
    .filter((s) => s.name !== "gap")
    .map((s) => {
      const start = s.startMs != null ? s.startMs : t;
      t = start + s.wallMs;
      return Object.assign({}, s, { start, end: start + s.wallMs });
    });
}
function gapsOf(ev) {
  return (ev.stages || [])
    .filter((s) => s.name === "gap" && s.startMs != null && s.wallMs > 0)
    .map((s) => [s.startMs, s.startMs + s.wallMs])
    .sort((a, b) => a[0] - b[0]);
}
// Wall time to play time: everything spent in gaps before t is removed.
function playClock(gaps) {
  const play = (t) => t - gaps.reduce((a, g) => a + Math.max(0, Math.min(t, g[1]) - g[0]), 0);
  const inGap = (t) => gaps.some((g) => t >= g[0] && t < g[1]);
  return { play, inGap };
}

// Stages, merged when consecutive stages share a name (spins).
function timelineGroups(ev) {
  const groups = [];
  placed(ev).forEach((s) => {
    if (s.name === "boot" || s.name === "game-ready") return;
    const name = groupName(s.name);
    const last = groups[groups.length - 1];
    if (last && last.name === name) last.end = s.end;
    else groups.push({ name, start: s.start, end: s.end });
  });
  return groups;
}

// mark pins a todo row after a click. { t } is one instant; { group } is a stage band with no single frame.
function timelineSvg(ev, range, mark) {
  const st = placed(ev);
  if (!st.length) return null;
  const tl = ev.timeline && ev.timeline.buckets && ev.timeline.buckets.length ? ev.timeline : null;
  const gaps = gapsOf(ev);
  const { play, inGap } = playClock(gaps);
  const soft = SOFTWARE_GPU.test((ev.conditions && ev.conditions.gpu) || "");
  const full = Math.max(...st.map((s) => s.end));
  const from = range ? range[0] : 0;
  const to = range ? range[1] : full;
  const pf = play(from);
  const span = Math.max(1, play(to) - pf);
  const W = 1000;
  const L = 78;
  const R = 10;
  const X = (ms) => L + ((W - L - R) * (Math.max(pf, Math.min(pf + span, play(ms))) - pf)) / span;
  const inView = (a, b) => b >= from && a <= to;
  const out = [];
  const label = (y, text) => out.push(`<text x="4" y="${y}" font-size="12" fill="${C.sub}">${esc(text)}</text>`);

  // Stages. Each spin gets its own cell so long feature spins stand out; a click zooms to the group.
  const groups = timelineGroups(ev);
  label(24, "階段");
  groups.forEach((g, i) => {
    if (!inView(g.start, g.end)) return;
    const w = Math.max(1, X(g.end) - X(g.start));
    const x0 = X(g.start).toFixed(1);
    out.push(`<rect class="stage" data-i="${i}" x="${x0}" y="8" width="${w.toFixed(1)}" height="24" fill="${i % 2 ? C.band2 : C.band1}"><title>${esc(g.name)} ${clock(g.start)}–${clock(g.end)}</title></rect>`);
    if (mark && mark.group === i) out.push(`<g class="pin" pointer-events="none"><rect x="${x0}" y="8" width="${w.toFixed(1)}" height="24" fill="${C.blue}" fill-opacity="0.4" stroke="${C.blue}" stroke-width="2"/></g>`);
    if (w > g.name.length * 12 + 6) out.push(`<text x="${(X(g.start) + 4).toFixed(1)}" y="24" font-size="11" fill="${C.ink}" pointer-events="none">${esc(g.name)}</text>`);
  });
  st.filter((s) => /^(spin|turbo)-\d+$/.test(s.name) && inView(s.start, s.start)).forEach((s) => {
    const x = X(s.start);
    if (x > L + 1) out.push(`<line x1="${x.toFixed(1)}" x2="${x.toFixed(1)}" y1="8" y2="32" stroke="${C.bg}" stroke-width="1" pointer-events="none"/>`);
  });

  // Where each suggestion happened, by its number. Close ones share one marker.
  label(51, "建議");
  const rows = (ev.todo || []).filter((r) => !r.note).map((r) => {
    const s = st.find((x) => x.name === r.stage);
    return { n: r.n, title: r.title, at: r.t != null ? r.t : s ? (s.start + s.end) / 2 : null };
  }).filter((r) => r.at != null && inView(r.at, r.at)).map((r) => Object.assign(r, { x: X(r.at) })).sort((a, b) => a.x - b.x);
  const marks = [];
  rows.forEach((r) => {
    const last = marks[marks.length - 1];
    if (last && r.x - last.x < 16) last.rows.push(r);
    else marks.push({ x: r.x, rows: [r] });
  });
  marks.forEach((m) => {
    const text = m.rows.length > 1 ? `${m.rows[0].n}+` : String(m.rows[0].n);
    const tip = m.rows.map((r) => `${r.n}. ${r.title}`).join("\n");
    out.push(`<g><title>${esc(tip)}</title><circle cx="${m.x.toFixed(1)}" cy="47" r="8" fill="${C.ink}"/><text x="${m.x.toFixed(1)}" y="51" font-size="10" font-weight="600" text-anchor="middle" fill="${C.bg}">${text}</text></g>`);
  });

  // FPS as a heat band: neutral at 55 and up, warmer as it drops. Equal neighbours share one rect.
  const FY = 64;
  const FH = 18;
  label(FY + 13, "FPS");
  out.push(`<rect x="${L}" y="${FY}" width="${W - L - R}" height="${FH}" fill="${C.lane}"/>`);
  const band = [];
  if (tl) {
    const bm = tl.bucketMs;
    const shown = field(tl, "presentedFrames", -1);
    const fi = shown >= 0 && tl.buckets.some((b) => b[shown] > 0) ? shown : 1;
    tl.buckets.forEach((b) => {
      const frames = b[fi];
      const maxDt = b[2];
      if (!b[1] || inGap(b[0]) || !inView(b[0], b[0] + bm)) return;
      if (b[1] * maxDt < bm * 0.6 && maxDt < 50) return;
      const fps = (frames * 1000) / bm;
      const color = fpsColor(fps);
      const last = band[band.length - 1];
      if (last && last.color === color && b[0] - last.end < bm * 1.5) {
        last.end = b[0] + bm;
        last.min = Math.min(last.min, fps);
      } else band.push({ start: b[0], end: b[0] + bm, color, min: fps });
    });
  } else {
    st.forEach((s) => {
      if (s.fps != null && inView(s.start, s.end)) band.push({ start: s.start, end: s.end, color: fpsColor(s.fps), min: s.fps });
    });
  }
  const dim = soft ? ' opacity="0.35"' : "";
  band.forEach((r) => out.push(`<rect x="${X(r.start).toFixed(1)}" y="${FY}" width="${Math.max(1, X(r.end) - X(r.start)).toFixed(1)}" height="${FH}" fill="${r.color}"${dim}><title>${clock(r.start)}–${clock(r.end)} 最低 ${Math.round(r.min)} FPS</title></rect>`));

  // CPU, drawn like the DevTools overview: main-thread busy share per bucket as a yellow step
  // area (engine frame time plus long tasks), and long tasks as red marks along the top.
  const CY0 = 132;
  const CH = 38;
  label(CY0 - 14, "CPU");
  out.push(`<rect x="${L}" y="${CY0 - CH}" width="${W - L - R}" height="${CH}" fill="${C.lane}"/>`);
  const longs = (tl && tl.longTasks) || [];
  const engineCpu = tl && ev.channels && ev.channels.engineCpu;
  if (tl && (engineCpu || longs.length)) {
    const bm = tl.bucketMs;
    const overlap = (t0, t1) => longs.reduce((a, l) => a + Math.max(0, Math.min(t1, l[0] + l[1]) - Math.max(t0, l[0])), 0);
    let d = "";
    let lastX = null;
    tl.buckets.forEach((b) => {
      if (inGap(b[0]) || !inView(b[0], b[0] + bm)) return;
      const busy = Math.min(1, Math.max(engineCpu && b[3] != null ? b[3] : 0, overlap(b[0], b[0] + bm)) / bm);
      const x0 = X(b[0]).toFixed(1);
      const x1 = X(b[0] + bm).toFixed(1);
      const y = (CY0 - busy * CH).toFixed(1);
      d += lastX != null ? ` L${x0},${y} L${x1},${y}` : `M${x0},${CY0} L${x0},${y} L${x1},${y}`;
      lastX = x1;
    });
    if (d) out.push(`<path d="${d} L${lastX},${CY0} Z" fill="${C.cpu}" stroke="${C.cpuEdge}" stroke-width="0.6"${dim}/>`);
    longs.filter((l) => !inGap(l[0]) && inView(l[0], l[0] + l[1])).forEach((l) => {
      const x = X(l[0]);
      const w = Math.max(2, X(l[0] + l[1]) - x);
      out.push(`<rect x="${x.toFixed(1)}" y="${CY0 - CH}" width="${w.toFixed(1)}" height="4" fill="${C.red}"${dim}><title>${clock(l[0])} long task ${Math.round(l[1])} ms</title></rect>`);
    });
    out.push(`<text x="${L - 4}" y="${(CY0 - CH + 8).toFixed(1)}" font-size="10" text-anchor="end" fill="${C.faint}">100%</text>`);
    if (!engineCpu) out.push(`<text x="${(L + W) / 2}" y="${CY0 - 15}" font-size="11" text-anchor="middle" fill="${C.sub}">沒有每幀 CPU，只畫 long task</text>`);
  } else {
    out.push(`<text x="${(L + W) / 2}" y="${CY0 - 15}" font-size="12" text-anchor="middle" fill="${C.sub}">這次沒量到 CPU</text>`);
  }
  if (soft) out.push(`<text x="${(L + W) / 2}" y="${FY + 13}" font-size="11" text-anchor="middle" fill="${C.ink}">軟體繪製：FPS 和 CPU 是這台電腦的，不代表玩家裝置</text>`);

  // Memory: GPU plus JS heap at each moment, JS heap alone, and the budget.
  const MY0 = 222;
  const MH = 76;
  label(MY0 - MH / 2 + 4, "記憶體");
  const heap = tl && tl.heap && tl.heap.length ? tl.heap.map((p) => [p[0], p[1]]) : st.filter((s) => s.heapEndMb != null).map((s) => [s.end, s.heapEndMb]);
  const gpu = tl && tl.gpu && tl.gpu.length ? tl.gpu.map((p) => [p[0], p[1]]) : [];
  const at = (series, t) => {
    let v = null;
    for (const p of series) {
      if (p[0] > t) break;
      v = p[1];
    }
    return v == null ? 0 : v;
  };
  const times = [...new Set(heap.map((p) => p[0]).concat(gpu.map((p) => p[0])))].sort((a, b) => a - b);
  const total = times.map((t) => [t, at(heap, t) + at(gpu, t)]);
  const budget = (ev.score && ev.score.memory && ev.score.memory.budgetMb) || 300;
  const top = Math.max(budget, ...total.map((p) => p[1]), ...heap.map((p) => p[1])) * 1.1;
  const MY = (mb) => MY0 - (mb / top) * MH;
  const clip = (pts) => pts.filter((p) => !inGap(p[0]) && inView(p[0], p[0]));
  const line = (raw, color, w) => {
    const pts = clip(raw);
    if (pts.length > 1) out.push(`<path d="${pts.map((p, i) => `${i ? "L" : "M"}${X(p[0]).toFixed(1)},${MY(p[1]).toFixed(1)}`).join(" ")}" fill="none" stroke="${color}" stroke-width="${w}"/>`);
    return pts;
  };
  out.push(`<rect x="${L}" y="${MY0 - MH}" width="${W - L - R}" height="${MH}" fill="${C.lane}"/>`);
  out.push(`<line x1="${L}" x2="${W - R}" y1="${MY(budget).toFixed(1)}" y2="${MY(budget).toFixed(1)}" stroke="${C.red}" stroke-dasharray="5 4"/>`);
  out.push(`<text x="${W - R - 2}" y="${(MY(budget) - 4).toFixed(1)}" font-size="11" text-anchor="end" fill="${C.red}">預算 ${budget} MB</text>`);
  const sum = gpu.length ? line(total, C.ink, 2) : [];
  const js = line(heap, C.blue, 1.5);
  if (sum.length) {
    const peak = sum.reduce((a, p) => (p[1] > a[1] ? p : a));
    out.push(`<text x="${(X(peak[0]) + 4).toFixed(1)}" y="${(MY(peak[1]) - 4).toFixed(1)}" font-size="11" fill="${C.ink}">GPU+JS 最高 ${Math.round(peak[1])} MB</text>`);
  }
  if (js.length) {
    const last = js[js.length - 1];
    out.push(`<text x="${L + 4}" y="${Math.min(MY0 - 3, MY(js[0][1]) + 12).toFixed(1)}" font-size="11" fill="${C.blue}">JS heap ${Math.round(last[1])} MB</text>`);
  }

  // Breaks where gap time was cut out.
  const breakY1 = 8;
  const breakY2 = MY0;
  let lastLabel = -1e9;
  gaps.forEach((g) => {
    if (!inView(g[0], g[0]) || g[1] - g[0] < 1000) return;
    const x = X(g[0]);
    if (x <= L + 1 || x >= W - R - 1) return;
    out.push(`<line x1="${x.toFixed(1)}" x2="${x.toFixed(1)}" y1="${breakY1}" y2="${breakY2}" stroke="${C.bg}" stroke-width="3" pointer-events="none"/><line x1="${x.toFixed(1)}" x2="${x.toFixed(1)}" y1="${breakY1}" y2="${breakY2}" stroke="${C.faint}" stroke-width="1" stroke-dasharray="2 3" pointer-events="none"><title>略過 ${Math.round((g[1] - g[0]) / 1000)} 秒（等 agent 或強制 GC）</title></line>`);
    if (x - lastLabel > 60) {
      out.push(`<text x="${x.toFixed(1)}" y="${MY0 + 13}" font-size="10" text-anchor="middle" fill="${C.faint}">略過 ${Math.round((g[1] - g[0]) / 1000)}s</text>`);
      lastLabel = x;
    }
  });

  // Axis in wall-clock time, placed on the cut axis.
  const axisY = MY0 + 28;
  const tick = [1000, 2000, 5000, 10000, 30000, 60000, 120000].find((t) => span / t <= 8) || 300000;
  let lastTick = -1e9;
  for (let p = Math.ceil(pf / tick) * tick; p <= pf + span; p += tick) {
    // Invert play time to wall time by walking the gaps.
    let t = p;
    gaps.forEach((g) => {
      if (g[0] <= t) t += g[1] - g[0];
    });
    const x = X(t);
    if (x - lastTick < 50) continue;
    out.push(`<text x="${x.toFixed(1)}" y="${axisY}" font-size="11" text-anchor="middle" fill="${C.faint}">${clock(t)}</text>`);
    lastTick = x;
  }
  const keyY = axisY + 18;
  const key = [
    [fpsColor(50), "FPS 45–55"],
    [fpsColor(40), "30–45"],
    [fpsColor(10), "30 以下"],
    [C.cpu, "CPU 忙碌"],
    [C.red, "long task"],
    [C.ink, "GPU+JS"],
    [C.blue, "JS heap"],
  ];
  let kx = L;
  key.forEach(([color, text]) => {
    out.push(`<rect x="${kx}" y="${keyY - 9}" width="10" height="10" fill="${color}"/><text x="${kx + 14}" y="${keyY}" font-size="11" fill="${C.sub}">${esc(text)}</text>`);
    kx += 24 + text.length * 9;
  });
  const H = keyY + 10;

  if (mark && mark.t != null && inView(mark.t, mark.t)) {
    const x = X(mark.t).toFixed(1);
    out.push(`<g class="pin" pointer-events="none"><line x1="${x}" x2="${x}" y1="8" y2="${MY0}" stroke="${C.blue}" stroke-width="7" opacity="0.28"/><line x1="${x}" x2="${x}" y1="8" y2="${MY0}" stroke="${C.blue}" stroke-width="2"/></g>`);
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" font-family="${FONT}"><rect width="${W}" height="${H}" fill="${C.bg}"/>${out.join("")}</svg>\n`;
}

// Two seconds either side of one stall: the slowest frame per bucket, long tasks, texture uploads.
function eventSvg(ev, t) {
  const tl = ev.timeline && ev.timeline.buckets && ev.timeline.buckets.length ? ev.timeline : null;
  if (!tl || t == null) return null;
  const bm = tl.bucketMs;
  const a = t - 2000;
  const b = t + 2000;
  const fi = field(tl, "maxPresentMs", 2);
  const ui = field(tl, "texUploadMb", 6);
  const bs = tl.buckets.filter((x) => x[0] + bm > a && x[0] < b);
  if (!bs.length) return null;
  const frame = (x) => (x[fi] > 0 ? x[fi] : x[2] || 0);
  const W = 560;
  const L = 44;
  const R = 8;
  const Y0 = 96;
  const H0 = 76;
  const X = (ms) => L + ((W - L - R) * (Math.max(a, Math.min(b, ms)) - a)) / (b - a);
  const top = Math.max(100, ...bs.map(frame)) * 1.1;
  const Y = (ms) => Y0 - (Math.min(ms, top) / top) * H0;
  const out = [];
  out.push(`<rect x="${L}" y="${Y0 - H0}" width="${W - L - R}" height="${H0}" fill="${C.lane}"/>`);
  out.push(`<line x1="${L}" x2="${W - R}" y1="${Y(16.7).toFixed(1)}" y2="${Y(16.7).toFixed(1)}" stroke="${C.faint}" stroke-dasharray="3 3"/><text x="${L - 4}" y="${(Y(16.7) + 4).toFixed(1)}" font-size="10" text-anchor="end" fill="${C.faint}">16.7</text>`);
  out.push(`<text x="${L - 4}" y="${(Y0 - H0 + 9).toFixed(1)}" font-size="10" text-anchor="end" fill="${C.faint}">${Math.round(top)} ms</text>`);
  let lastText = -1e9;
  bs.forEach((x) => {
    const v = frame(x);
    const hit = t >= x[0] && t < x[0] + bm;
    const x0 = X(x[0]) + 1;
    const w = Math.max(1, X(x[0] + bm) - X(x[0]) - 2);
    out.push(`<rect x="${x0.toFixed(1)}" y="${Y(v).toFixed(1)}" width="${w.toFixed(1)}" height="${(Y0 - Y(v)).toFixed(1)}" fill="${hit ? C.orange : v > 50 ? C.red : C.sub}"><title>${clock(x[0])} 最慢一幀 ${Math.round(v)} ms</title></rect>`);
    if (x[ui] >= 1) out.push(`<rect x="${x0.toFixed(1)}" y="${Y0 + 6}" width="${w.toFixed(1)}" height="6" fill="${C.purple}"><title>貼圖上傳 ${Math.round(x[ui] * 10) / 10} MB</title></rect>`);
    if (x[ui] >= 1 && x0 - lastText > 44) {
      out.push(`<text x="${(x0 + w / 2).toFixed(1)}" y="${Y0 + 24}" font-size="10" text-anchor="middle" fill="${C.purple}">${Math.round(x[ui])} MB</text>`);
      lastText = x0;
    }
  });
  ((tl.longTasks) || []).filter((l) => l[0] + l[1] > a && l[0] < b).forEach((l) => {
    out.push(`<rect x="${X(l[0]).toFixed(1)}" y="${Y0 - H0 - 6}" width="${Math.max(2, X(l[0] + l[1]) - X(l[0])).toFixed(1)}" height="4" fill="${C.red}"><title>long task ${Math.round(l[1])} ms</title></rect>`);
  });
  out.push(`<text x="${L}" y="${Y0 + 40}" font-size="10" fill="${C.faint}">−2 秒</text><text x="${X(t).toFixed(1)}" y="${Y0 + 40}" font-size="10" text-anchor="middle" fill="${C.ink}">${clock(t)}</text><text x="${W - R}" y="${Y0 + 40}" font-size="10" text-anchor="end" fill="${C.faint}">+2 秒</text>`);
  out.push(`<text x="4" y="${Y0 - H0 / 2}" font-size="10" fill="${C.sub}">最慢</text><text x="4" y="${Y0 - H0 / 2 + 12}" font-size="10" fill="${C.sub}">一幀</text>`);
  const Hh = Y0 + 46;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${Hh}" width="${W}" height="${Hh}" font-family="${FONT}"><rect width="${W}" height="${Hh}" fill="${C.bg}"/>${out.join("")}</svg>`;
}

root.timelineSvg = timelineSvg;
root.timelineGroups = timelineGroups;
root.eventSvg = eventSvg;
})(typeof module !== "undefined" ? module.exports : window);
