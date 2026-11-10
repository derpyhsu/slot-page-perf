// Draws the run as one SVG: stages, FPS, CPU, stalls with todo numbers, memory.
// Runs in Node (report.md's timeline.svg) and inlined in report.html, where range zooms in.
(function (root) {
"use strict";

const C = {
  red: "#e5484d",
  orange: "#f76b15",
  yellow: "#e2a336",
  green: "#30a46c",
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
const stallColor = (ms) => (ms <= 100 ? C.yellow : ms <= 200 ? C.orange : C.red);
const fpsColor = (f) => (f >= 55 ? C.green : f >= 45 ? C.yellow : f >= 30 ? C.orange : C.red);
const clock = (ms) => {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
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
  const full = Math.max(...st.map((s) => s.end));
  const from = range ? range[0] : 0;
  const to = range ? range[1] : full;
  const span = Math.max(1, to - from);
  const W = 1000;
  const L = 78;
  const R = 10;
  const X = (ms) => L + ((W - L - R) * (Math.max(from, Math.min(to, ms)) - from)) / span;
  const inView = (a, b) => b >= from && a <= to;
  const out = [];
  const label = (y, text) => out.push(`<text x="4" y="${y}" font-size="12" fill="${C.sub}">${esc(text)}</text>`);

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

  // FPS: one bar per bucket, colored by level, with the 60 line.
  const FY0 = 98;
  const FH = 52;
  const FY = (f) => FY0 - (Math.min(70, f) / 70) * FH;
  label(76, "FPS");
  out.push(`<rect x="${L}" y="${FY0 - FH}" width="${W - L - R}" height="${FH}" fill="${C.lane}"/>`);
  if (tl) {
    const bm = tl.bucketMs;
    const bw = Math.max(1, ((W - L - R) * bm) / span);
    tl.buckets.forEach((b) => {
      const frames = b[1];
      const maxDt = b[2];
      if (!frames || !inView(b[0], b[0] + bm)) return;
      if (frames * maxDt < bm * 0.6 && maxDt < 50) return;
      const fps = (frames * 1000) / bm;
      out.push(`<rect x="${X(b[0]).toFixed(1)}" y="${FY(fps).toFixed(1)}" width="${bw.toFixed(2)}" height="${(FY0 - FY(fps)).toFixed(1)}" fill="${fpsColor(fps)}"><title>${clock(b[0])} ${Math.round(fps)} FPS</title></rect>`);
    });
  } else {
    st.forEach((s) => {
      if (s.fps == null || !inView(s.start, s.end)) return;
      out.push(`<rect x="${X(s.start).toFixed(1)}" y="${FY(s.fps).toFixed(1)}" width="${Math.max(1, X(s.end) - X(s.start)).toFixed(1)}" height="${(FY0 - FY(s.fps)).toFixed(1)}" fill="${fpsColor(s.fps)}"/>`);
    });
  }
  out.push(`<line x1="${L}" x2="${W - R}" y1="${FY(60).toFixed(1)}" y2="${FY(60).toFixed(1)}" stroke="${C.ink}" stroke-width="1" stroke-dasharray="4 3" opacity="0.6"/>`);
  out.push(`<text x="${L - 4}" y="${(FY(60) + 4).toFixed(1)}" font-size="10" text-anchor="end" fill="${C.faint}">60</text>`);

  // CPU: main-thread busy share per bucket from the engine loop.
  const CY0 = 150;
  const CH = 40;
  label(134, "CPU");
  out.push(`<rect x="${L}" y="${CY0 - CH}" width="${W - L - R}" height="${CH}" fill="${C.lane}"/>`);
  if (tl && ev.channels && ev.channels.engineCpu) {
    const bm = tl.bucketMs;
    const budget = 16.7;
    const pts = tl.buckets
      .filter((b) => inView(b[0], b[0] + bm) && b[1] && b[3] != null)
      .map((b) => `L${X(b[0] + bm / 2).toFixed(1)},${(CY0 - Math.min(1, b[3] / b[1] / budget) * CH).toFixed(1)}`)
      .join(" ");
    if (pts) out.push(`<path d="M${L},${CY0} ${pts} L${W - R},${CY0} Z" fill="${C.yellow}" opacity="0.85"/>`);
    out.push(`<text x="${L - 4}" y="${(CY0 - CH + 4).toFixed(1)}" font-size="10" text-anchor="end" fill="${C.faint}">16.7</text>`);
  } else {
    out.push(`<text x="${(L + W) / 2}" y="${CY0 - 15}" font-size="12" text-anchor="middle" fill="${C.sub}">這次沒量到每幀 CPU</text>`);
  }

  // Stalls over 50 ms, plus todo numbers above where they happen.
  const SY = 172;
  const SH = 26;
  label(190, "卡頓");
  out.push(`<rect x="${L}" y="${SY}" width="${W - L - R}" height="${SH}" fill="${C.lane}"/>`);
  const stalls = [];
  if (tl) {
    (tl.longTasks || []).forEach((t) => stalls.push([t[0], t[1], t[1]]));
    tl.buckets.forEach((b) => {
      if (b[2] > 50) stalls.push([b[0], tl.bucketMs, b[2]]);
    });
  } else {
    st.forEach((s) => (s.hitches || []).forEach((h) => stalls.push([h.t != null ? h.t : s.start, h.dt, h.dt])));
  }
  stalls.filter(([t, d]) => inView(t, t + d)).forEach(([t, d, dt]) => out.push(`<rect x="${X(t).toFixed(1)}" y="${SY}" width="${Math.max(3, X(t + d) - X(t)).toFixed(1)}" height="${SH}" fill="${stallColor(dt)}"><title>${clock(t)} 停 ${Math.round(dt)} ms</title></rect>`));
  (ev.todo || []).forEach((row) => {
    if (!String(row.rule || "").startsWith("stall-")) return;
    const s = st.find((x) => x.name === row.stage);
    const at = row.t != null ? row.t : s ? (s.start + s.end) / 2 : null;
    if (at == null) return;
    out.push(`<circle cx="${X(at).toFixed(1)}" cy="${SY - 2}" r="8" fill="${C.ink}"/><text x="${X(at).toFixed(1)}" y="${SY + 2}" font-size="10" font-weight="600" text-anchor="middle" fill="${C.bg}">${row.n}</text>`);
  });

  // Memory: JS heap, GPU, their sum, and the budget.
  const MY0 = 290;
  const MH = 70;
  label(258, "記憶體");
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
  const top = Math.max(budget, ...total.map((p) => p[1]), ...heap.map((p) => p[1])) * 1.08;
  const MY = (mb) => MY0 - (mb / top) * MH;
  const clip = (pts) => pts.filter((p, i) => inView(p[0], (pts[i + 1] || p)[0]) || (pts[i - 1] && inView(pts[i - 1][0], p[0])));
  const line = (raw, color, w, Y) => { const pts = clip(raw); return pts.length > 1 ? out.push(`<path d="${pts.map((p, i) => `${i ? "L" : "M"}${X(p[0]).toFixed(1)},${Y(p[1]).toFixed(1)}`).join(" ")}" fill="none" stroke="${color}" stroke-width="${w}"/>`) : null; };
  out.push(`<rect x="${L}" y="${MY0 - MH}" width="${W - L - R}" height="${MH}" fill="${C.lane}"/>`);
  out.push(`<line x1="${L}" x2="${W - R}" y1="${MY(budget).toFixed(1)}" y2="${MY(budget).toFixed(1)}" stroke="${C.red}" stroke-dasharray="5 4"/>`);
  out.push(`<text x="${W - R - 2}" y="${(MY(budget) - 4).toFixed(1)}" font-size="11" text-anchor="end" fill="${C.red}">預算 ${budget} MB</text>`);
  if (gpu.length) line(total, C.ink, 2, MY);
  line(gpu, C.purple, 2, MY);
  const shown = clip(total.length ? total : heap);
  const peak = shown.length ? Math.max(...shown.map((p) => p[1])) : null;
  if (peak) out.push(`<text x="${L + 4}" y="${(MY(peak) - 4).toFixed(1)}" font-size="11" fill="${C.ink}">同時刻 ${Math.round(peak)} MB</text>`);

  // JS heap on its own scale. On the GPU axis a 50 MB sawtooth disappears.
  const JY0 = MY0 + 36;
  const JH = 28;
  const jTop = Math.max(1, ...heap.map((p) => p[1]), 1) * 1.25;
  const JY = (mb) => JY0 - (mb / jTop) * JH;
  label(JY0 - 10, "JS");
  out.push(`<rect x="${L}" y="${JY0 - JH}" width="${W - L - R}" height="${JH}" fill="${C.lane}"/>`);
  line(heap, C.blue, 2, JY);
  if (heap.length) {
    const seen = clip(heap);
    const jPeak = seen.length ? Math.max(...seen.map((p) => p[1])) : 0;
    if (jPeak) out.push(`<text x="${L + 4}" y="${(JY(jPeak) - 3).toFixed(1)}" font-size="11" fill="${C.blue}">JS ${Math.round(jPeak)} MB</text>`);
  }

  const axisY = JY0 + 16;
  const tick = [1000, 2000, 5000, 10000, 30000, 60000, 120000].find((t) => span / t <= 8) || 300000;
  for (let m = Math.ceil(from / tick) * tick; m <= to; m += tick) out.push(`<text x="${X(m).toFixed(1)}" y="${axisY}" font-size="11" text-anchor="middle" fill="${C.faint}">${clock(m)}</text>`);

  const legend = [
    [C.green, "FPS 55+"],
    [C.yellow, "45–55"],
    [C.orange, "30–45"],
    [C.red, "30 以下"],
    [C.yellow, "卡 50–100"],
    [C.orange, "卡 100–200"],
    [C.red, "卡 200+"],
    [C.blue, "JS heap"],
    [C.purple, "GPU"],
    [C.ink, "同時刻合計"],
  ];
  let lx = L;
  let ly = axisY + 14;
  legend.forEach(([color, text]) => {
    const w = 22 + text.length * 11;
    if (lx + w > W - 4) {
      lx = L;
      ly += 16;
    }
    out.push(`<rect x="${lx}" y="${ly}" width="10" height="10" fill="${color}"/><text x="${lx + 14}" y="${ly + 9}" font-size="11" fill="${C.sub}">${esc(text)}</text>`);
    lx += w;
  });
  const H = ly + 18;

  // One instant: a line through FPS, CPU, stalls, memory and the JS lane. Drawn last so lanes do not cover it.
  if (mark && mark.t != null && inView(mark.t, mark.t)) {
    const x = X(mark.t).toFixed(1);
    const y1 = FY0 - FH;
    const y2 = JY0;
    out.push(`<g class="pin" pointer-events="none"><line x1="${x}" x2="${x}" y1="${y1}" y2="${y2}" stroke="${C.blue}" stroke-width="7" opacity="0.28"/><line x1="${x}" x2="${x}" y1="${y1}" y2="${y2}" stroke="${C.blue}" stroke-width="2"/></g>`);
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" font-family="${FONT}"><rect width="${W}" height="${H}" fill="${C.bg}"/>${out.join("")}</svg>\n`;
}

root.timelineSvg = timelineSvg;
root.timelineGroups = timelineGroups;
})(typeof module !== "undefined" ? module.exports : window);
