// Engineering readout shared by report.html and report.md.
// The report opens with three scores, 載入階段, 幀率穩定度 and 資源占用, then the numbers behind them.
"use strict";

const { groups, groupOf, SOFTWARE_GPU } = require("./findings");

const THRESHOLDS = require("../protocol/thresholds.json");
const CELLS = THRESHOLDS.cells;
const FATAL_CAP = (THRESHOLDS.scoring && THRESHOLDS.scoring.fatal && THRESHOLDS.scoring.fatal.cap) || 49;

const NAMES = { loading: "載入階段", smooth: "幀率穩定度", memory: "資源占用" };
const COLOR = { red: "#e5484d", orange: "#f76b15", yellow: "#e2a336", green: "#30a46c" };

// One cell, judged by its own row's thresholds. Only failing cells get a color.
function cellLevel(key, v, higherIsBetter) {
  const t = CELLS[key];
  if (v == null || !t) return null;
  const worse = (limit) => limit != null && (higherIsBetter ? v < limit : v > limit);
  return worse(t.red) ? "red" : worse(t.orange) ? "orange" : null;
}
function drawsLevel(col, idle) {
  if (!idle || idle === col || col.draws == null || !idle.draws) return null;
  return col.draws >= idle.draws * CELLS.drawsVsIdle.orange ? "orange" : null;
}
const DOT = { red: "🔴", orange: "🟠", yellow: "🟡", green: "🟢" };

function round(n, d) {
  const k = Math.pow(10, d);
  return Math.round(n * k) / k;
}
function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}
function median(xs) {
  if (!xs.length) return null;
  const s = xs.slice().sort((a, b) => a - b);
  return s[Math.floor((s.length - 1) / 2)];
}
function pct(v) {
  return v == null ? "—" : `${round(v * 100, 1)}%`;
}
function mb(v) {
  return v == null ? "—" : `${Math.round(v)} MB`;
}
function levelOf(score) {
  if (score == null) return "yellow";
  if (score >= 90) return "green";
  if (score >= 70) return "yellow";
  if (score >= 50) return "orange";
  return "red";
}

function model(ev) {
  const gs = groups(ev.stages || []);
  const by = new Map(gs.map((g) => [g.group, g]));
  const cols = (ev.fps || []).map((r) => {
    const list = (ev.stages || []).filter((s) => s.frames && s.name !== "gap" && !String(s.name).endsWith("-spike") && groupOf(s.name) === r.group);
    const cpus = [];
    let cpuMax = null;
    let cpuStage = null;
    list.forEach((s) => {
      if (!s.cpuMs || !s.cpuFrames || s.cpuMs.p95 == null) return;
      cpus.push(s.cpuMs.p95);
      if (cpuMax == null || s.cpuMs.p95 > cpuMax) {
        cpuMax = s.cpuMs.p95;
        cpuStage = s.name;
      }
    });
    const spikes = (ev.stages || []).filter((s) => s.name === `${r.group}-spike`);
    const hitches = list.concat(spikes).flatMap((s) => s.hitches || []);
    const worst = hitches.reduce((a, h) => (h.dt > a ? h.dt : a), 0);
    const g = by.get(r.group);
    return {
      group: r.group,
      label: r.stages > 1 ? `${r.label} ${r.stages} 段` : r.label,
      level: r.level,
      fps: r.fps,
      expFps: r.expectedFps || 60,
      pace: r.offShare,
      drop: r.dropShare,
      bad: r.badShare,
      low: r.fpsLow,
      gpu: r.gpuPeakMb,
      draws: g && g.draws != null ? Math.round(g.draws) : null,
      cpuMax,
      cpuMed: median(cpus),
      cpuStage,
      many: list.length > 1,
      worst,
    };
  });
  const snap = ((ev.cocos && ev.cocos.snapshots) || []).slice(-1)[0] || {};
  const tex = snap.textures && snap.textures.status === "ok" ? snap.textures : ev.memory && ev.memory.textures && ev.memory.textures.status === "ok" ? ev.memory.textures : null;
  const largest = (tex && tex.largest) || [];
  const top = largest[0] || null;
  const topN = top ? largest.filter((t) => t.w === top.w && t.h === top.h).length : 0;
  const leak = (ev.findings || []).find((f) => f.id === "leak-suspected");
  return {
    cols,
    snap,
    tex,
    top,
    topN,
    leak,
    soft: SOFTWARE_GPU.test((ev.conditions && ev.conditions.gpu) || ""),
    cpuOn: !!(ev.channels && ev.channels.engineCpu),
  };
}

function spinWhere(name) {
  const spin = /^(spin|turbo)-(\d+)$/.exec(name || "");
  if (spin) return spin[1] === "turbo" ? `加速第 ${spin[2]} 轉` : `第 ${spin[2]} 轉`;
  return "";
}
const STAGE = {
  menu: "功能列表",
  "history-before": "下注紀錄",
  "history-after": "轉後下注紀錄",
  rules: "遊戲規則",
  idle: "待機",
  "idle-after-rules": "規則後待機",
  "idle-end": "最後待機",
  loading: "載入",
  enter: "進遊戲",
};
function whereLabel(stage) {
  const spin = spinWhere(stage);
  if (spin) return spin;
  if (!stage) return "";
  const spike = String(stage).endsWith("-spike");
  const name = STAGE[String(stage).replace(/-spike$/, "")];
  if (!name) return "";
  return spike ? `${name}剛打開` : name;
}
function cellLevels(m) {
  const idle = m.cols.find((c) => c.group === "idle");
  return {
    // FPS and 1% low are judged against the 60 target; bad frames and cadence against the cap.
    fps: (c) => cellLevel("fps", c.fps, true),
    pace: (c) => cellLevel("pace", c.pace),
    drop: (c) => cellLevel("drop", c.drop),
    bad: (c) => cellLevel("bad", c.bad),
    low: (c) => cellLevel("low", c.low, true),
    cpu: (c) => cellLevel("cpuP95Ms", c.cpuMax),
    draws: (c) => drawsLevel(c, idle),
    gpu: (c) => cellLevel("gpuMb", c.gpu),
    stall: (c) => (c.worst >= 50 ? cellLevel("stallMs", c.worst) : null),
  };
}
function cpuText(col) {
  if (col.cpuMax == null) return "—";
  const max = round(col.cpuMax, 1);
  const where = spinWhere(col.cpuStage);
  if (col.many && col.cpuMed != null && col.cpuMax - col.cpuMed >= 1.5) return `${max} ms（中位 ${round(col.cpuMed, 1)}${where ? `，${where}` : ""}）`;
  return `${max} ms`;
}
// Same reading for the page: the worst value up front, the median and where on a small second line.
function cpuHtml(col) {
  if (col.cpuMax == null) return "—";
  const max = round(col.cpuMax, 1);
  const where = spinWhere(col.cpuStage);
  if (col.many && col.cpuMed != null && col.cpuMax - col.cpuMed >= 1.5) return `${max} ms<div class="sub">中位 ${round(col.cpuMed, 1)}${where ? ` · ${esc(where)}` : ""}</div>`;
  return `${max} ms`;
}

function metaLine(ev) {
  const c = ev.conditions || {};
  const m = model(ev);
  const settings = m.snap.settings || {};
  const gpu = String(c.gpu || "");
  const named = (gpu.match(/,\s*([^,(]+)/) || [])[1] || gpu;
  const webgl = settings.webglVersion ? `WebGL ${settings.webglVersion}${settings.webgl2Available ? "（瀏覽器有 WebGL 2）" : ""}` : c.webgl || "";
  const spins = (ev.fps || []).find((r) => r.group === "spin");
  const parts = [
    c.viewport ? `${c.viewport.w}×${c.viewport.h}` : "",
    c.viewport && c.viewport.dpr ? `dpr ${c.viewport.dpr}` : "",
    `Cocos ${c.engine || "?"}`,
    webgl,
    settings.frameRate != null ? `幀率上限 ${settings.frameRate}` : "",
    named ? named.trim() + (m.soft ? "（軟體繪製，數字是這台電腦）" : "") : "",
    spins ? `spin ${spins.stages} 段` : "",
    (c.capturedAt || "").slice(0, 10),
  ];
  return parts.filter(Boolean).join(" · ");
}

function factRows(ev, m) {
  const S = ev.score;
  const est = S.memory.estimateMb;
  const budget = S.memory.budgetMb || 300;
  const growth = (S.memory.items || []).find((i) => i.id === "growth");
  const rows = [];
  if (est) {
    rows.push(["推估", `${mb(est.total)} = JS ${mb(est.heap)} + ${est.gpuSource === "gpu" ? "GPU" : "貼圖"} ${mb(est.texture)} + 畫面 ${mb(est.framebuffer)}`, `預算 ${budget} MB，${Math.round((est.total / budget) * 100)}%`]);
  }
  if (m.tex) {
    const big = m.top ? `最大 ${m.top.w}×${m.top.h} ${m.top.format || ""} ${m.top.mb} MB × ${m.topN}${m.top.file ? `（${m.top.file}）` : ""}` : "";
    rows.push(["貼圖", `${m.tex.count} 張，壓縮 ${m.tex.compressed || 0}，約 ${mb(m.tex.mb)}`, [big, m.tex.npot ? `邊長不是 2 的冪 ${m.tex.npot} 張` : ""].filter(Boolean).join("；")]);
  }
  // Heap floors from findings.js heapFit: the same numbers the growth score and leak rule use.
  const fit = ev.heapFit;
  if (fit && fit.status === "ok") {
    const notes = [];
    if (fit.featureSpins && fit.featureSpins.length) notes.push(`Feature 轉 ${fit.featureSpins.map(spinWhere).join("、")} 不算`);
    if (fit.majorGcs && fit.majorGcs.length) notes.push(`大 GC ${fit.majorGcs.length} 次，GC 後留下 ${fit.retainedMb} MB`);
    else notes.push("這輪沒看到大 GC");
    rows.push(["JS heap", `地板 ${Math.round(fit.from)} MB → ${Math.round(fit.to)} MB，每轉 ${fit.slopeMb >= 0 ? "+" : ""}${fit.slopeMb} MB`, notes.join("；")]);
  } else if (growth && growth.value != null) rows.push(["JS heap", `每轉 +${growth.value} MB`, ""]);
  const sc = ev.cocosAdvice && ev.cocosAdvice.scene;
  const labels = m.snap.labels;
  const settings = m.snap.settings || {};
  if (sc) {
    const bits = [
      `節點 ${sc.nodes}（顯示中 ${sc.activeNodes}）`,
      m.snap.spine ? `Spine ${m.snap.spine.total}，在畫 ${m.snap.spine.active}，即時 ${m.snap.spine.realtime}，骨頭 ${m.snap.spine.activeRealtimeBones}，batched ${m.snap.spine.batched}` : sc.spine != null ? `Spine ${sc.spine}，在畫 ${sc.spineActive}，即時 ${sc.spineRealtime}` : "",
      labels ? `Label ${labels.active}，未開快取 ${labels.noCacheTtf != null ? `${labels.noCacheTtf}（不含 BMFont ${labels.bmfont}）` : labels.noCache}` : sc.labels != null ? `Label ${sc.labels}` : "",
      sc.masks != null ? `Mask ${sc.masks}` : "",
      sc.particles != null ? `粒子 ${sc.particles}` : "",
    ].filter(Boolean);
    rows.push(["場景", bits.join(" · "), m.snap.at ? `最後一次快照（${((ev.fps || []).find((r) => r.group === m.snap.at) || {}).label || m.snap.at}）；要處理的地方用各次快照的最大值` : ""]);
  }
  const flags = [];
  if (settings.cleanupImageCache != null) flags.push(`CLEANUP_IMAGE_CACHE ${settings.cleanupImageCache}`);
  if (settings.dynamicAtlas != null) flags.push(`dynamic atlas ${settings.dynamicAtlas}`);
  if (settings.frameRate != null) flags.push(`cc.game.frameRate ${settings.frameRate}`);
  if (flags.length) rows.push(["引擎", flags.join(" · "), ""]);
  return rows;
}

function scoreLine(ev) {
  const S = ev.score;
  const FATAL = { stall: "停頓超過門檻", "low-fps": "FPS 低於門檻", "over-budget": "超過記憶體預算兩倍", "leak-suspected": "JS heap 轉完沒回到轉前" };
  const part = (name, p) => {
    const bits = (p.items || []).filter((i) => i.value != null).map((i) => {
      const shown = i.unit === "%" ? `${i.value}%` : `${i.value} ${i.unit}`;
      const where = spinWhere(i.stage);
      return `${i.label}：${shown}${where ? `，${where}` : ""} 得 ${i.score == null ? "不計" : i.score}（權重 ${i.weight}）`;
    });
    const cov = p.provisional ? `，暫定，量到 ${p.coverage}%` : "";
    return `${name} ${p.score == null ? "未評分" : p.score}${cov}（${bits.join("；")}）`;
  };
  const load = S.loading || { fatal: [] };
  const fatals = load.fatal.map((f) => `${NAMES.loading}${FATAL[f.id] || f.id}`).concat(S.smooth.fatal.concat(S.memory.fatal).map((f) => FATAL[f.id] || f.id));
  return `${S.loading ? `${part(NAMES.loading, S.loading)}。` : ""}${part(NAMES.smooth, S.smooth)}。${part(NAMES.memory, S.memory)}。` + (fatals.length ? `同時成立：${fatals.join("、")}。` : "");
}

function readoutMarkdown(ev) {
  const S = ev.score;
  const m = model(ev);
  const lines = [];
  lines.push(`| | 分數 |`);
  lines.push(`| --- | --- |`);
  if (S.loading) lines.push(`| ${NAMES.loading} | ${DOT[levelOf(S.loading.score)] || ""} ${S.loading.score == null ? "未評分" : S.loading.score} |`);
  lines.push(`| ${NAMES.smooth} | ${DOT[levelOf(S.smooth.score)] || ""} ${S.smooth.score == null ? "未評分" : S.smooth.score} |`);
  lines.push(`| ${NAMES.memory} | ${DOT[levelOf(S.memory.score)] || ""} ${S.memory.score == null ? "未評分" : S.memory.score} |`);
  lines.push("");
  lines.push(scoreLine(ev));
  lines.push("");
  if (m.cols.length) {
    const head = ["讀數"].concat(m.cols.map((c) => c.label));
    lines.push(`| ${head.join(" | ")} |`);
    lines.push(`| ${head.map(() => "---").join(" | ")} |`);
    const row = (name, pick, level) => `| ${name} | ${m.cols.map((c) => { const l = level && level(c); return l ? `${DOT[l]} ${pick(c)}` : pick(c); }).join(" | ")} |`;
    const L = cellLevels(m);
    lines.push(row("平均 FPS", (c) => (c.fps == null ? "—" : c.fps), L.fps));
    lines.push(row("掉幀", (c) => pct(c.drop), L.drop));
    lines.push(row("壞幀", (c) => pct(c.bad), L.bad));
    if (m.cols.some((c) => c.pace != null)) lines.push(row("節奏不齊", (c) => pct(c.pace), L.pace));
    lines.push(row("1% low", (c) => (c.low == null ? "—" : c.low), L.low));
    if (m.cpuOn) lines.push(row("CPU p95", cpuText, L.cpu));
    lines.push(row("每幀 draw", (c) => (c.draws == null ? "—" : c.draws), L.draws));
    lines.push(row("GPU 峰值", (c) => mb(c.gpu), L.gpu));
    if (m.cols.some((c) => c.worst >= 50)) lines.push(row("最長停頓", (c) => (c.worst >= 50 ? `${Math.round(c.worst)} ms` : ""), L.stall));
    lines.push("");
    lines.push("FPS、壞幀、節奏看的是實際上螢幕的幀。應有幀長取螢幕更新間隔與 1000 / 幀率上限較長者；壞幀是超過應有幀長 1.5 倍的幀，節奏不齊是離應有幀長超過 25% 的幀。FPS 與 1% low 以 60 為目標上色；壞幀與節奏依幀率上限判。CPU p95 是引擎主迴圈在該階段 95% 的幀裡花的時間，不是作業系統的 CPU。");
    lines.push("");
  }
  const facts = factRows(ev, m);
  if (facts.length) {
    lines.push("| 讀數 | 這次 | |");
    lines.push("| --- | --- | --- |");
    facts.forEach(([k, a, b]) => lines.push(`| ${k} | ${a} | ${b} |`));
    lines.push("");
  }
  return lines.join("\n");
}

function scoreMark(score) {
  if (score == null) return '<span class="lm dash"></span>';
  const level = levelOf(score);
  const shape = level === "red" ? "tri" : level === "green" ? "circ" : "sq";
  return `<span class="lm ${shape}" style="color:${COLOR[level]}"></span>`;
}

function itemText(i) {
  if (i.value == null) return "沒量到";
  const shown = i.unit === "%" ? `${i.value}%` : `${i.value} ${i.unit}`;
  return `${i.approx ? "約 " : ""}${shown}`;
}

// The cap only changes the number when the weighted score would have been higher.
function fatalNote(part) {
  const list = part.fatal || [];
  if (!list.length || part.score == null || part.score < FATAL_CAP) return "";
  const bits = [];
  const stall = list.filter((f) => f.id === "stall" && f.value != null).sort((a, b) => b.value - a.value)[0];
  if (stall) bits.push(`最長停頓 ${Math.round(stall.value)} ms`);
  const lows = list.filter((f) => f.id === "low-fps" && f.value != null);
  if (lows.length) bits.push(`平均 FPS 最低 ${lows.reduce((a, b) => (b.value < a.value ? b : a)).value}`);
  const over = list.find((f) => f.id === "over-budget");
  if (over && over.value != null) bits.push(`推估 ${Math.round(over.value)} MB，超過預算兩倍`);
  if (list.some((f) => f.id === "leak-suspected")) bits.push("JS heap 轉完沒回到轉前");
  return `<p class="gauge-fatal">分數最高 ${FATAL_CAP}：${esc(bits.join("，"))}。</p>`;
}

// Red scores already state what was measured. This is the player-facing problem that can follow.
function riskText(key, part) {
  if (levelOf(part.score) !== "red") return "";
  const ids = new Set((part.fatal || []).map((f) => f.id));
  if (key === "memory") {
    if (ids.has("over-budget") && ids.has("leak-suspected")) return "在部分裝置有 OOM 閃退風險，玩越久更容易發生";
    if (ids.has("over-budget")) return "在部分裝置有 OOM 閃退風險";
    if (ids.has("leak-suspected")) return "玩越久越容易因記憶體不足閃退";
  }
  if (key === "smooth") {
    if (ids.has("low-fps")) return "整段遊玩會覺得不順";
  }
  if (key === "loading") {
    if (ids.has("stall")) return "進遊戲前會卡一下";
    if (ids.has("low-fps")) return "載入過程畫面會一頓一頓";
  }
  return "";
}

function legend() {
  return `<div class="legend">${[
    ["red", "0–49"],
    ["orange", "50–69"],
    ["yellow", "70–89"],
    ["green", "90–100"],
  ].map(([level, text]) => `<span>${scoreMark(level === "red" ? 0 : level === "orange" ? 50 : level === "yellow" ? 70 : 90)} ${text}</span>`).join("")}</div>`;
}

const DIMS = [
  ["loading", NAMES.loading],
  ["smooth", NAMES.smooth],
  ["memory", NAMES.memory],
];
const PRIORITY = { red: "P0", orange: "P1", yellow: "P2" };
const FATAL_TEXT = { stall: "停頓超過門檻", "low-fps": "FPS 低於門檻", "over-budget": "超過記憶體預算兩倍", "leak-suspected": "JS heap 轉完沒回到轉前" };

function loss(i) {
  return i.score == null ? 0 : (i.weight * (100 - i.score)) / 100;
}
function worstItem(part) {
  return (part.items || []).filter((i) => i.score != null && i.score < 100).sort((a, b) => loss(b) - loss(a))[0] || null;
}
// What the line under a gauge says: the cap reason, else the item that cost the most.
function gaugeNote(part, key) {
  const risk = riskText(key, part);
  const riskHtml = risk ? `<p class="gauge-risk">${esc(risk)}</p>` : "";
  const fatal = fatalNote(part);
  if (fatal) return fatal + riskHtml;
  const w = worstItem(part);
  if (!w) return '<p class="gauge-hint">每一項都滿分</p>' + riskHtml;
  const where = whereLabel(w.stage);
  return `<p class="gauge-hint">扣分最多：${esc(w.label)} ${esc(itemText(w))}${where ? `，${esc(where)}` : ""}</p>` + riskHtml;
}

function ring(part) {
  const score = part.score;
  const color = COLOR[levelOf(score)];
  const r = 46;
  const c = 2 * Math.PI * r;
  const shown = score == null ? 0 : Math.max(score, 1) / 100;
  const dash = part.provisional ? ' stroke-dasharray="5 4"' : "";
  return `<svg width="112" height="112" viewBox="0 0 112 112" aria-hidden="true">
      <circle cx="56" cy="56" r="${r}" fill="none" stroke="#e6e8eb" stroke-width="7"/>
      ${shown > 0 ? `<circle cx="56" cy="56" r="${r}" fill="none" stroke="${color}" stroke-width="7" stroke-linecap="round" stroke-dasharray="${(c * shown).toFixed(2)} ${c.toFixed(2)}" transform="rotate(-90 56 56)"/>` : ""}
      ${part.provisional && shown > 0 ? `<circle cx="56" cy="56" r="${r + 6}" fill="none" stroke="${color}" stroke-width="1"${dash} opacity="0.5"/>` : ""}
      <text x="56" y="57" text-anchor="middle" dominant-baseline="central" font-size="34" font-weight="500" fill="${color}">${score == null ? "—" : score}</text>
    </svg>`;
}

function gaugeTab(key, part, name, selected) {
  const color = COLOR[levelOf(part.score)];
  return `<button type="button" class="gtab" role="tab" id="tab-${key}" data-k="${key}" aria-controls="panel-${key}" aria-selected="${selected}" tabindex="${selected ? 0 : -1}">
    ${ring(part)}
    <span class="gauge-name" style="color:${color}">${esc(name)}${part.provisional ? `<span class="prov">暫定 · 量到 ${part.coverage}%</span>` : ""}</span>
    ${gaugeNote(part, key)}
  </button>`;
}

function itemRow(i) {
  if (i.value == null) return `<li class="off"><span class="il">${esc(i.label)}</span><span class="iv">沒量到，不計分</span></li>`;
  const level = levelOf(i.score);
  const where = spinWhere(i.stage);
  const lost = loss(i);
  const pos = i.score == null ? null : Math.min(100, Math.max(0, 100 - i.score));
  return `<li><span class="il">${scoreMark(i.score)}${esc(i.label)}${where ? `<small>${esc(where)}</small>` : ""}</span><span class="iv"${level !== "green" ? ` style="color:${COLOR[level]}"` : ""}>${esc(itemText(i))}</span>` +
    (pos == null ? "" : `<span class="scale" aria-hidden="true"><i style="left:calc(${pos}% - 1px)"></i></span><span class="scap"><span>滿分 ${esc(i.full)}</span><span>${lost >= 0.05 ? `扣 ${round(lost, 1)} 分 · ` : ""}零分 ${esc(i.zero)}</span></span>`) +
    "</li>";
}

function itemList(part) {
  const items = part.items || [];
  const lost = items.filter((i) => i.value != null && i.score != null && i.score < 100).sort((a, b) => loss(b) - loss(a));
  const full = items.filter((i) => i.value != null && (i.score == null || i.score >= 100));
  const off = items.filter((i) => i.value == null);
  let html = `<h3>計分子項 · 扣分多的在前</h3><ul class="items">${lost.map(itemRow).join("")}${off.map(itemRow).join("")}</ul>`;
  if (!lost.length && !off.length) html = `<h3>計分子項</h3><p class="small">${items.length} 項都滿分。</p><ul class="items">${full.map(itemRow).join("")}</ul>`;
  else if (full.length) html += `<details class="more"><summary>另外 ${full.length} 項滿分</summary><ul class="items">${full.map(itemRow).join("")}</ul></details>`;
  return html;
}

function ctxList(rows) {
  const xs = rows.filter(([, v]) => v != null && v !== "");
  return xs.length ? `<ul class="ctx">${xs.map(([k, v]) => `<li><span>${esc(k)}</span><span>${esc(v)}</span></li>`).join("")}</ul>` : "";
}

// Numbers that explain a score without being part of it.
function loadingContext(ev) {
  const st = ev.stages || [];
  const wall = (n) => st.filter((s) => s.name === n).reduce((a, s) => a + (s.wallMs || 0), 0);
  const sec = (ms) => (ms ? `${round(ms / 1000, 1)} 秒` : null);
  const total = ["boot", "loading", "splash", "enter"].reduce((a, n) => a + wall(n), 0);
  const res = ev.resources && ev.resources.status === "ok" ? ev.resources : null;
  const sh = ev.shaders && ev.shaders.status === "ok" ? ev.shaders : null;
  const entry = ev.entry && ev.entry.result ? { direct: "載入完直接能轉", pressed: `按了 ${(ev.entry.steps || []).length} 次才能轉`, stuck: "卡住，沒進到能轉的畫面" }[ev.entry.result] : null;
  return `<h3>背景數字 · 不計分</h3>` + ctxList([
    ["打開到能轉", sec(total)],
    ["其中載入", sec(wall("loading"))],
    ["其中進遊戲", sec(wall("enter"))],
    ["進遊戲", entry],
    ["資源請求", res ? `${res.count} 個${res.decodedMb != null ? ` · 解碼後 ${round(res.decodedMb, 1)} MB` : ""}` : null],
    ["shader", sh ? `${sh.count} 個 · 共 ${round(sh.ms, 1)} ms${sh.maxMs != null ? ` · 最長 ${round(sh.maxMs, 1)} ms` : ""}` : null],
  ]);
}

function stageTable(m) {
  if (!m.cols.length) return "";
  const cell = (text, level, raw) => `<td class="num"${level ? ` style="color:${COLOR[level]};font-weight:600"` : ""}>${raw ? text : esc(text)}</td>`;
  const tr = (name, pick, level, raw) => '<tr><td class="lab">' + esc(name) + "</td>" + m.cols.map((c) => cell(pick(c), level && level(c), raw)).join("") + "</tr>";
  const L = cellLevels(m);
  let html = `<h3>各階段</h3><div class="scroll"><table><tr><th>讀數</th>${m.cols.map((c) => `<th class="num">${esc(c.label)}</th>`).join("")}</tr>`;
  html += tr("平均 FPS", (c) => (c.fps == null ? "—" : String(c.fps)), L.fps);
  html += tr("掉幀", (c) => pct(c.drop), L.drop);
  html += tr("壞幀", (c) => pct(c.bad), L.bad);
  if (m.cols.some((c) => c.pace != null)) html += tr("節奏不齊", (c) => pct(c.pace), L.pace);
  html += tr("1% low", (c) => (c.low == null ? "—" : String(c.low)), L.low);
  if (m.cpuOn) html += tr("CPU p95", cpuHtml, L.cpu, true);
  html += tr("每幀 draw", (c) => (c.draws == null ? "—" : String(c.draws)), L.draws);
  html += tr("GPU 峰值", (c) => mb(c.gpu), L.gpu);
  if (m.cols.some((c) => c.worst >= 50)) html += tr("最長停頓", (c) => (c.worst >= 50 ? `${Math.round(c.worst)} ms` : ""), L.stall);
  html += "</table></div>";
  html += '<p class="small">FPS、壞幀、節奏看的是實際上螢幕的幀。壞幀是超過應有幀長 1.5 倍的幀，節奏不齊是離應有幀長超過 25% 的幀。CPU p95 是引擎主迴圈在該階段 95% 的幀裡花的時間，不是作業系統的 CPU。</p>';
  return html;
}

function memoryContext(ev, m) {
  const S = ev.score;
  const est = S.memory.estimateMb;
  const budget = S.memory.budgetMb || 300;
  let html = "<h3>推估組成</h3>";
  if (est) {
    const max = Math.max(budget, est.total) * 1.05;
    const w = (v) => `${Math.min(100, (100 * v) / max).toFixed(1)}%`;
    html += `<div class="stack"><span style="width:${w(est.heap)};background:#0090ff"></span><span style="width:${w(est.texture)};background:#8e4ec6"></span><span style="width:${w(est.framebuffer)};background:#80868b"></span><i style="left:${w(budget)}"></i></div>`;
    html += `<p class="small">JS ${mb(est.heap)} · ${est.gpuSource === "gpu" ? "GPU" : "貼圖"} ${mb(est.texture)} · 畫面 ${mb(est.framebuffer)}，合計 ${mb(est.total)}。紅線是預算 ${budget} MB（${Math.round((est.total / budget) * 100)}%）。</p>`;
  } else html += '<p class="small">這次沒量到。</p>';
  return html;
}

function factTable(ev, m) {
  const facts = factRows(ev, m).filter(([k]) => k !== "推估");
  if (!facts.length) return "";
  return `<h3>貼圖與場景</h3><div class="scroll"><table class="facts">${facts.map(([k, a, b]) => `<tr><td class="lab">${esc(k)}</td><td>${esc(a)}${b ? `<div class="sub">${esc(b)}</div>` : ""}</td></tr>`).join("")}</table></div>`;
}

function panel(ev, m, key, selected) {
  const part = ev.score[key];
  let side = "";
  let wide = "";
  if (key === "loading") side = loadingContext(ev);
  if (key === "smooth") wide = stageTable(m);
  if (key === "memory") {
    side = memoryContext(ev, m);
    wide = factTable(ev, m);
  }
  return `<div class="panel" role="tabpanel" id="panel-${key}" aria-labelledby="tab-${key}"${selected ? "" : " hidden"}>
    ${side ? `<div class="panel-cols"><div>${itemList(part)}</div><div>${side}</div></div>` : `<div class="panel-one">${itemList(part)}</div>`}${wide}
  </div>`;
}

function readoutHtml(ev) {
  const m = model(ev);
  const S = ev.score;
  const dims = DIMS.filter(([k]) => S[k]);
  const rank = (p) => (p.score == null ? 999 : p.score);
  const pick = dims.slice().sort((a, b) => rank(S[a[0]]) - rank(S[b[0]]))[0][0];
  const sum = ev.summary || {};
  const said = [sum.smooth, sum.memory].filter(Boolean).map(esc).join(" · ");
  let html = `<section class="hero">${said ? `<p class="verdict">${said}</p>` : ""}`;
  html += `<div class="gauges" role="tablist" aria-label="三個分數">${dims.map(([k, name]) => gaugeTab(k, S[k], name, k === pick)).join("")}</div>${legend()}</section>`;
  html += `<section class="sec" id="detail"><div class="sec-h"><h2 id="detail-h">${esc(NAMES[pick])}細項</h2><span class="small">點上面的分數切換</span></div>${dims.map(([k]) => panel(ev, m, k, k === pick)).join("")}</section>`;
  return html;
}

module.exports = { metaLine, readoutHtml, readoutMarkdown, NAMES };
