// Engineering readout shared by report.html and report.md.
// The report opens with two scores, 幀率 and 占用, then the numbers behind them.
"use strict";

const { groups, groupOf, SOFTWARE_GPU } = require("./findings");

const COLOR = { red: "#e5484d", orange: "#f76b15", yellow: "#e2a336", green: "#30a46c" };
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
      label: r.stages > 1 ? `${r.label} ${r.stages} 段` : r.label,
      level: r.level,
      fps: r.fps,
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
function cpuText(col) {
  if (col.cpuMax == null) return "—";
  const max = round(col.cpuMax, 1);
  const where = spinWhere(col.cpuStage);
  if (col.many && col.cpuMed != null && col.cpuMax - col.cpuMed >= 1.5) return `最高 ${max} ms${where ? `（${where}）` : ""}，中位 ${round(col.cpuMed, 1)} ms`;
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
    const big = m.top ? `最大 ${m.top.w}×${m.top.h} ${m.top.format || ""} ${m.top.mb} MB × ${m.topN}` : "";
    rows.push(["貼圖", `${m.tex.count} 張，壓縮 ${m.tex.compressed || 0}，約 ${mb(m.tex.mb)}`, [big, m.tex.npot ? `邊長不是 2 的冪 ${m.tex.npot} 張` : ""].filter(Boolean).join("；")]);
  }
  const spins = (ev.stages || []).filter((s) => /^spin-\d+$/.test(s.name) && s.heapEndMb != null);
  if (m.leak) rows.push(["JS heap", `${Math.round(m.leak.from)} MB → ${Math.round(m.leak.to)} MB`, growth && growth.value != null ? `每轉 +${growth.value} MB` : ""]);
  else if (spins.length >= 8) {
    const mid = spins.slice(4);
    const tail = spins.slice(-10).map((s) => s.heapEndMb);
    const peak = Math.max(...mid.map((s) => s.heapEndMb));
    rows.push([
      "JS heap",
      `第 5 轉 ${round(spins[4].heapEndMb, 1)} MB，之後最高 ${round(peak, 1)} MB，最後 10 轉在 ${Math.round(Math.min(...tail))}–${Math.round(Math.max(...tail))} MB，最後 ${round(spins[spins.length - 1].heapEndMb, 1)} MB`,
      growth && growth.value != null ? `第 5 轉到最後，平均每轉 +${growth.value} MB` : "",
    ]);
  } else if (growth && growth.value != null) rows.push(["JS heap", `每轉 +${growth.value} MB`, ""]);
  const sc = ev.cocosAdvice && ev.cocosAdvice.scene;
  const labels = m.snap.labels;
  const settings = m.snap.settings || {};
  if (sc) {
    const bits = [
      `節點 ${sc.nodes}（顯示中 ${sc.activeNodes}）`,
      m.snap.spine ? `Spine ${m.snap.spine.total}，在畫 ${m.snap.spine.active}，即時 ${m.snap.spine.realtime}，骨頭 ${m.snap.spine.activeRealtimeBones}，batched ${m.snap.spine.batched}` : sc.spine != null ? `Spine ${sc.spine}，在畫 ${sc.spineActive}，即時 ${sc.spineRealtime}` : "",
      labels ? `Label ${labels.active}，未開快取 ${labels.noCache}` : sc.labels != null ? `Label ${sc.labels}` : "",
      sc.masks != null ? `Mask ${sc.masks}` : "",
      sc.particles != null ? `粒子 ${sc.particles}` : "",
    ].filter(Boolean);
    rows.push(["場景", bits.join(" · "), ""]);
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
  const FATAL = { stall: "停頓超過門檻", "low-fps": "FPS 低於門檻", "over-budget": "超過記憶體預算", "leak-suspected": "JS heap 轉完沒回到轉前" };
  const part = (name, p) => {
    const bits = (p.items || []).filter((i) => i.value != null).map((i) => {
      const shown = i.unit === "%" ? `${i.value}%` : `${i.value} ${i.unit}`;
      const where = spinWhere(i.stage);
      return `${i.label}：${shown}${where ? `，${where}` : ""} 得 ${i.score == null ? "不計" : i.score}（權重 ${i.weight}）`;
    });
    const cov = p.provisional ? `，暫定，量到 ${p.coverage}%` : "";
    return `${name} ${p.score == null ? "未評分" : p.score}${cov}（${bits.join("；")}）`;
  };
  const fatals = S.smooth.fatal.concat(S.memory.fatal).map((f) => FATAL[f.id] || f.id);
  return `${part("幀率", S.smooth)}。${part("占用", S.memory)}。` + (fatals.length ? `同時成立：${fatals.join("、")}。` : "");
}

function readoutMarkdown(ev) {
  const S = ev.score;
  const m = model(ev);
  const lines = [];
  lines.push(`| | 分數 |`);
  lines.push(`| --- | --- |`);
  lines.push(`| 幀率 | ${DOT[levelOf(S.smooth.score)] || ""} ${S.smooth.score == null ? "未評分" : S.smooth.score} |`);
  lines.push(`| 占用 | ${DOT[levelOf(S.memory.score)] || ""} ${S.memory.score == null ? "未評分" : S.memory.score} |`);
  lines.push("");
  lines.push(scoreLine(ev));
  lines.push("");
  if (m.cols.length) {
    const head = ["讀數"].concat(m.cols.map((c) => c.label));
    lines.push(`| ${head.join(" | ")} |`);
    lines.push(`| ${head.map(() => "---").join(" | ")} |`);
    const row = (name, pick) => `| ${name} | ${m.cols.map(pick).join(" | ")} |`;
    lines.push(row("平均 FPS", (c) => (c.fps == null ? "—" : `${DOT[c.level] || ""} ${c.fps}`)));
    lines.push(row("掉幀", (c) => pct(c.drop)));
    lines.push(row("超過 33 ms", (c) => pct(c.bad)));
    lines.push(row("1% low", (c) => (c.low == null ? "—" : c.low)));
    if (m.cpuOn) lines.push(row("CPU p95", cpuText));
    lines.push(row("每幀 draw", (c) => (c.draws == null ? "—" : c.draws)));
    lines.push(row("GPU 峰值", (c) => mb(c.gpu)));
    if (m.cols.some((c) => c.worst >= 50)) lines.push(row("最長停頓", (c) => (c.worst >= 50 ? `${Math.round(c.worst)} ms` : "")));
    lines.push("");
    lines.push("CPU p95 是該階段 95% 的幀裡，主執行緒花的時間。一幀預算 16.7 ms。不是作業系統的 CPU。掉幀以螢幕更新率和幀率上限較低者為準。");
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

function gauge(part, name, hint) {
  const score = part.score;
  const color = COLOR[levelOf(score)];
  const r = 52;
  const c = 2 * Math.PI * r;
  const shown = score == null ? 0 : score / 100;
  const bits = (part.items || [])
    .filter((i) => i.value != null)
    .map((i) => {
      const shownValue = i.unit === "%" ? `${i.value}%` : `${i.value} ${i.unit}`;
      const where = spinWhere(i.stage);
      return `<li><span>${esc(i.label)}</span><b style="color:${COLOR[levelOf(i.score)]}">${esc(shownValue)}${where ? ` · ${esc(where)}` : ""}</b></li>`;
    })
    .join("");
  return `<div class="gauge">
    <svg width="148" height="148" viewBox="0 0 148 148" aria-hidden="true">
      <circle cx="74" cy="74" r="${r}" fill="none" stroke="#e6e8eb" stroke-width="8"/>
      ${shown > 0 ? `<circle cx="74" cy="74" r="${r}" fill="none" stroke="${color}" stroke-width="8" stroke-linecap="round" stroke-dasharray="${(c * shown).toFixed(2)} ${c.toFixed(2)}" transform="rotate(-90 74 74)"/>` : ""}
      <text x="74" y="82" text-anchor="middle" font-size="42" font-weight="500" fill="${color}">${score == null ? "—" : score}</text>
    </svg>
    <div class="gauge-name" style="color:${color}">${esc(name)}</div>
    <div class="gauge-hint">${esc(hint)}${part.provisional ? ` · 暫定 ${part.coverage}%` : ""}</div>
    <ul class="gauge-bits">${bits}</ul>
  </div>`;
}

function heroMetrics(ev, m) {
  const spin = m.cols.find((c) => c.label === "spin" || c.label.startsWith("spin ")) || m.cols[m.cols.length - 1];
  const est = ev.score.memory.estimateMb;
  const budget = (ev.score.memory && ev.score.memory.budgetMb) || 300;
  const cards = [];
  if (spin && spin.fps != null) cards.push({ k: "spin FPS", v: String(spin.fps), level: spin.level });
  if (spin) cards.push({ k: "掉幀", v: pct(spin.drop), level: spin.drop > 0.03 ? "orange" : "green" });
  if (spin && spin.cpuMed != null) cards.push({ k: "CPU p95 中位", v: `${round(spin.cpuMed, 1)} ms`, sub: spin.cpuMax != null && spin.cpuMax - spin.cpuMed >= 1.5 ? `最高 ${round(spin.cpuMax, 1)} ms${spinWhere(spin.cpuStage) ? ` · ${spinWhere(spin.cpuStage)}` : ""}` : "", level: spin.cpuMed > 12 ? "red" : spin.cpuMed > 8 ? "orange" : "green" });
  else if (spin && spin.cpuMax != null) cards.push({ k: "CPU p95", v: `${round(spin.cpuMax, 1)} ms`, level: spin.cpuMax > 12 ? "red" : "green" });
  if (est) cards.push({ k: "GPU", v: mb(est.texture), sub: `預算 ${budget} MB`, level: est.texture > budget ? "red" : est.texture > budget * 0.7 ? "orange" : "green" });
  if (est) cards.push({ k: "推估", v: mb(est.total), sub: `JS ${Math.round(est.heap)} + 畫面 ${Math.round(est.framebuffer)}`, level: est.total > budget ? "red" : "green" });
  const worst = m.cols.reduce((a, c) => (c.worst > (a ? a.worst : 0) ? c : a), null);
  if (worst && worst.worst >= 50) cards.push({ k: "最長停頓", v: `${Math.round(worst.worst)} ms`, sub: worst.label, level: worst.worst >= 200 ? "red" : worst.worst >= 100 ? "orange" : "yellow" });
  return `<div class="metrics">${cards
    .map((c) => `<div class="metric" style="border-top-color:${COLOR[c.level] || COLOR.yellow}"><div class="mv" style="color:${COLOR[c.level] || COLOR.yellow}">${esc(c.v)}</div><div class="mk">${esc(c.k)}</div>${c.sub ? `<div class="ms">${esc(c.sub)}</div>` : ""}</div>`)
    .join("")}</div>`;
}

function readoutHtml(ev) {
  const m = model(ev);
  const S = ev.score;
  const cell = (text, level) => `<td class="num"${level ? ` style="color:${COLOR[level]};font-weight:600"` : ""}>${esc(text)}</td>`;
  let html = `<section class="card hero"><div class="gauges">${gauge(S.smooth, "幀率", "100 是穩在 60")}${gauge(S.memory, "占用", "100 是遠低於裝置預算")}</div>${heroMetrics(ev, m)}</section>`;
  html += '<section class="card"><h2>各階段</h2><div class="scroll">';
  if (m.cols.length) {
    html += "<table><tr><th>讀數</th>" + m.cols.map((c) => `<th class="num">${esc(c.label)}</th>`).join("") + "</tr>";
    const tr = (name, pick, colored) =>
      "<tr><td>" + esc(name) + "</td>" + m.cols.map((c) => cell(pick(c), colored ? c.level : null)).join("") + "</tr>";
    html += tr("平均 FPS", (c) => (c.fps == null ? "—" : String(c.fps)), true);
    html += tr("掉幀", (c) => pct(c.drop));
    html += tr("超過 33 ms", (c) => pct(c.bad));
    html += tr("1% low", (c) => (c.low == null ? "—" : String(c.low)));
    if (m.cpuOn) html += tr("CPU p95", cpuText);
    html += tr("每幀 draw", (c) => (c.draws == null ? "—" : String(c.draws)));
    html += tr("GPU 峰值", (c) => mb(c.gpu));
    if (m.cols.some((c) => c.worst >= 50)) html += tr("最長停頓", (c) => (c.worst >= 50 ? `${Math.round(c.worst)} ms` : ""));
    html += "</table>";
    html += '<p class="small">CPU p95 是該階段 95% 的幀裡，主執行緒花的時間。一幀預算 16.7 ms。不是作業系統的 CPU。掉幀以螢幕更新率和幀率上限較低者為準。</p>';
  }
  html += "</div></section>";
  const facts = factRows(ev, m);
  if (facts.length) {
    html += '<section class="card"><h2>貼圖與場景</h2><table><tr><th></th><th>這次</th><th></th></tr>' + facts.map(([k, a, b]) => `<tr><td>${esc(k)}</td><td>${esc(a)}</td><td>${esc(b)}</td></tr>`).join("") + "</table></section>";
  }
  return html;
}

module.exports = { metaLine, readoutHtml, readoutMarkdown };
