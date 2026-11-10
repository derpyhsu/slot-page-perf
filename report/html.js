#!/usr/bin/env node
// Usage: node report/html.js runs/<run>/evidence.json [out.html]
// Run report/analyze.js first. Writes report.html next to the evidence: one self-contained page with
// the evidence inlined, a timeline that zooms per stage, and collapsible details. No network needed.
"use strict";

const fs = require("fs");
const path = require("path");
const { metaLine, readoutHtml } = require("./readout");

const evidencePath = process.argv[2];
if (!evidencePath) {
  console.error("usage: node report/html.js <evidence.json> [out.html]");
  process.exit(1);
}
const outPath = process.argv[3] || path.join(path.dirname(evidencePath), "report.html");
const ev = JSON.parse(fs.readFileSync(evidencePath, "utf8"));
if (!ev.score) {
  console.error("evidence has no score. Run report/analyze.js first.");
  process.exit(1);
}
const timelineSrc = fs.readFileSync(path.join(__dirname, "timeline.js"), "utf8");
const data = JSON.stringify(ev).replace(/</g, "\\u003c");
const title = (ev.game.displayName || ev.game.title || "slot").replace(/</g, "&lt;");

const css = `
:root { --ink:#202124; --sub:#5f6368; --faint:#80868b; --line:#e8eaed; --soft:#f8f9fa;
  --red:#d93025; --orange:#e37400; --yellow:#e2a336; --green:#188038; --blue:#1a73e8; --purple:#8430ce; }
* { box-sizing: border-box; }
body { margin: 0; background: #f6f7f9; color: var(--ink); font: 14px/1.5 "Segoe UI","Microsoft JhengHei","PingFang TC",system-ui,sans-serif; }
main { max-width: 1080px; margin: 0 auto; padding: 28px 20px 72px; }
h1 { font-size: 28px; font-weight: 500; letter-spacing: -0.02em; margin: 0; }
h2 { font-size: 16px; font-weight: 500; margin: 0 0 14px; }
.meta { color: var(--faint); font-size: 12px; margin-top: 6px; }
.card { background: #fff; border-radius: 12px; box-shadow: 0 1px 2px rgba(60,64,67,.12), 0 0 0 1px rgba(60,64,67,.06); padding: 20px 22px 18px; margin-top: 16px; }
.hero { padding-top: 8px; }
.gauges { display: flex; justify-content: center; gap: 48px; padding: 12px 0 4px; }
.gauge { width: 240px; text-align: center; }
.gauge svg { display: block; margin: 0 auto; }
.gauge-name { font-size: 18px; font-weight: 500; margin-top: -4px; }
.gauge-hint { color: var(--faint); font-size: 12px; margin-top: 2px; }
.gauge-bits { list-style: none; margin: 14px 0 0; padding: 0; text-align: left; }
.gauge-bits li { display: flex; justify-content: space-between; gap: 12px; padding: 6px 0; border-top: 1px solid var(--line); font-size: 13px; }
.gauge-bits span { color: var(--sub); }
.gauge-bits b { font-weight: 500; }
.metrics { display: grid; grid-template-columns: repeat(6, 1fr); gap: 12px; margin-top: 22px; padding-top: 18px; border-top: 1px solid var(--line); }
.metric { border-top: 3px solid var(--line); padding-top: 8px; min-width: 0; }
.mv { font-size: 22px; font-weight: 500; letter-spacing: -0.02em; font-variant-numeric: tabular-nums; }
.mk { color: var(--sub); font-size: 12px; margin-top: 2px; }
.ms { color: var(--faint); font-size: 11px; margin-top: 2px; }
.small { font-size: 12px; color: var(--sub); }
.chips { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 10px; }
.chip { border: 0; background: var(--soft); border-radius: 999px; padding: 4px 12px; cursor: pointer; font: inherit; font-size: 12px; color: var(--sub); }
.chip.on { background: var(--ink); color: #fff; }
#timeline { margin: 0 -6px; }
#timeline svg { width: 100%; height: auto; display: block; }
#timeline .stage { cursor: zoom-in; }
.scroll { overflow-x: auto; }
table { border-collapse: collapse; width: 100%; font-variant-numeric: tabular-nums; }
th, td { text-align: left; padding: 9px 10px; border-bottom: 1px solid var(--line); vertical-align: top; }
th { font-size: 11px; color: var(--faint); font-weight: 500; letter-spacing: .03em; }
td.num, th.num { text-align: right; white-space: nowrap; }
tr.go { cursor: pointer; }
tr.go:hover td { background: var(--soft); }
.dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; margin-right: 8px; vertical-align: 1px; }
.n { white-space: nowrap; font-weight: 500; }
.bars { display: grid; grid-template-columns: 1fr 1fr; gap: 28px; }
.bar { display: flex; height: 8px; background: var(--soft); border-radius: 99px; overflow: hidden; margin: 8px 0; position: relative; }
.bar .mark { position: absolute; top: -3px; bottom: -3px; width: 2px; background: var(--red); }
ul.facts { margin: 14px 0 0; padding-left: 18px; color: var(--sub); }
details.card summary { cursor: pointer; font-weight: 500; }
details.card[open] summary { margin-bottom: 12px; }
.missing { margin-top: 14px; color: var(--faint); font-size: 12px; }
@media (max-width: 860px) {
  .gauges { flex-direction: column; align-items: center; gap: 28px; }
  .metrics, .bars { grid-template-columns: 1fr 1fr; }
}
`;

const app = `
const ev = JSON.parse(document.getElementById("ev").textContent);
const COLOR = { red: "#e5484d", orange: "#f76b15", yellow: "#e2a336", green: "#30a46c" };
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const dot = (level) => '<span class="dot" style="background:' + (COLOR[level] || COLOR.red) + '"></span>';
const scoreLevel = (s) => (s == null ? "yellow" : s >= 90 ? "green" : s >= 70 ? "yellow" : s >= 50 ? "orange" : "red");
const pct = (v) => (v == null ? "—" : Math.round(v * 1000) / 10 + "%");
const S = ev.score;

// Timeline with per-stage zoom.
const groups = timelineGroups(ev);
let zoom = null;
function drawTimeline() {
  const range = zoom == null ? null : [groups[zoom].start, groups[zoom].end];
  $("timeline").innerHTML = timelineSvg(ev, range) || "";
  [...document.querySelectorAll("#chips .chip")].forEach((b) => b.classList.toggle("on", String(zoom) === b.dataset.i || (zoom == null && b.dataset.i === "all")));
}
$("chips").innerHTML = '<button class="chip" data-i="all">全程</button>' + groups.map((g, i) => '<button class="chip" data-i="' + i + '">' + esc(g.name) + "</button>").join("");
$("chips").addEventListener("click", (e) => {
  const b = e.target.closest(".chip");
  if (!b) return;
  zoom = b.dataset.i === "all" ? null : Number(b.dataset.i);
  drawTimeline();
});
$("timeline").addEventListener("click", (e) => {
  const r = e.target.closest(".stage");
  if (!r) return;
  zoom = zoom === Number(r.dataset.i) ? null : Number(r.dataset.i);
  drawTimeline();
});
drawTimeline();

function stageStart(name) {
  let t = 0, hit = null;
  (ev.stages || []).filter((s) => s.name !== "gap").forEach((s) => {
    const start = s.startMs != null ? s.startMs : t;
    t = start + s.wallMs;
    if (s.name === name && hit == null) hit = start;
  });
  return hit;
}
function zoomTo(row) {
  const at = row.t != null ? row.t : row.stage ? stageStart(row.stage) : null;
  if (at == null) return;
  const i = groups.findIndex((g) => at >= g.start && at <= g.end);
  if (i < 0) return;
  zoom = i;
  drawTimeline();
  $("timeline-h").scrollIntoView({ behavior: "smooth" });
}

// Todo.
const todo = ev.todo || [];
if (todo.length) {
  $("todo").innerHTML = "<table><tr><th>#</th><th>問題</th><th>類別</th><th>怎麼改</th></tr>" +
    todo.map((r, i) => '<tr data-i="' + i + '"' + (r.stage || r.t != null ? ' class="go" title="點一下看時間軸上的位置"' : "") + '><td class="n">' + dot(r.level) + r.n + "</td><td>" + esc(r.title) + "</td><td>" + esc(r.area) + "</td><td>" + esc(r.fix) + "</td></tr>").join("") + "</table>";
  $("todo").addEventListener("click", (e) => {
    const tr = e.target.closest("tr.go");
    if (tr) zoomTo(todo[Number(tr.dataset.i)]);
  });
} else {
  $("todo").innerHTML = '<p class="small">沒有要處理的地方。</p>';
}

// Current state.
const soft = /swiftshader|basic render driver|llvmpipe|softpipe|warp/i.test((ev.conditions && ev.conditions.gpu) || "");
let html = "";
if (soft) html += '<p class="small">這台電腦是軟體繪製，FPS 和 CPU 是這台電腦的數字，不代表手機 GPU。</p>';
const cpu = S.smooth.items.find((i) => i.id === "cpu");
const est = S.memory.estimateMb;
const growth = S.memory.items.find((i) => i.id === "growth");
const budget = S.memory.budgetMb || 300;
const bar = (parts, max, mark) => '<div class="bar">' + parts.map(([v, c]) => '<div style="width:' + Math.min(100, (100 * v) / max) + "%;background:" + c + '"></div>').join("") + (mark ? '<div class="mark" style="left:' + Math.min(100, (100 * mark) / max) + '%"></div>' : "") + "</div>";
html += '<div class="bars"><div><b>一幀裡主執行緒花多久</b>' +
  (cpu && cpu.value != null ? bar([[cpu.value, COLOR.yellow]], 16.7) + '<div class="small">最忙的一段' + (/^spin-\\d+$/.test(cpu.stage || "") ? "（第 " + cpu.stage.slice(5) + " 轉）" : "") + "，95% 的幀在 " + cpu.value + " ms 內跑完。一幀的預算是 16.7 ms。其餘 spin 多半低很多。</div>" : '<div class="small">這次沒量到。</div>') +
  "</div><div><b>推估怎麼組成</b>" +
  (est ? bar([[est.heap, "#0090ff"], [est.texture, "#8e4ec6"], [est.framebuffer, "#60646c"]], Math.max(budget, est.total) * 1.05, budget) +
    '<div class="small">推估最高 ' + Math.round(est.total) + " MB，紅線是預算 " + budget + " MB。JS " + Math.round(est.heap) + "、" + (est.gpuSource === "gpu" ? "GPU" : "貼圖") + " " + Math.round(est.texture) + "、畫面 " + Math.round(est.framebuffer) + "。" + (growth && growth.value != null ? "每轉多留 " + growth.value + " MB。" : "") + "</div>" : '<div class="small">這次沒量到。</div>') +
  "</div></div>";
const facts = [];
const entry = ev.entry;
if (entry && entry.result) {
  const steps = (entry.steps || []).map((s) => s.text || s.kind).join(" → ");
  facts.push("<b>進遊戲</b>：" + esc({ direct: "載入完直接能轉", pressed: "按了 " + (entry.steps || []).length + " 次才能轉（" + steps + "）", stuck: "卡住，沒進到能轉的畫面" }[entry.result] || ""));
}
const sc = ev.cocosAdvice && ev.cocosAdvice.scene;
if (sc) facts.push("<b>Cocos 場景</b>：" + [["節點", sc.nodes], ["顯示中的節點", sc.activeNodes], ["在畫的 Spine", sc.spineActive], ["其中即時運算", sc.spineRealtime], ["Label", sc.labels], ["Mask", sc.masks], ["粒子系統", sc.particles]].filter(([, v]) => v != null).map(([k, v]) => k + " " + v).join(" · "));
if (facts.length) html += '<ul class="facts">' + facts.map((f) => "<li>" + f + "</li>").join("") + "</ul>";
$("state").innerHTML = html;

// Collapsed details.
const crit = (S.loading ? [["載入", S.loading]] : []).concat([["幀率", S.smooth], ["占用", S.memory]]).flatMap(([g, p]) => p.items.map((i) => [g, i]));
$("criteria").innerHTML = '<p class="small">每項在滿分與零分之間內插。沒量到的項目不計入，分數標暫定。有致命漏洞時該分數最高 49。90 以上綠、70 以上黃、50 以上橘、其餘紅。</p>' +
  "<table><tr><th></th><th>看什麼</th><th class=num>權重</th><th class=num>這次</th><th class=num>滿分</th><th class=num>零分</th><th class=num>得分</th></tr>" +
  crit.map(([g, i]) => "<tr><td>" + g + "</td><td>" + esc(i.label) + "</td><td class=num>" + i.weight + "</td><td class=num>" + (i.value == null ? "沒量到" : (i.approx ? "約 " : "") + i.value + " " + i.unit) + "</td><td class=num>" + esc(i.full) + "</td><td class=num>" + esc(i.zero) + '</td><td class=num style="color:' + COLOR[scoreLevel(i.score)] + ';font-weight:600">' + (i.score == null ? "不計" : i.score) + "</td></tr>").join("") + "</table>";
const NAMES = { loading: "載入", splash: "開始畫面", enter: "進遊戲", idle: "待機", menu: "功能列表", "history-before": "下注紀錄", rules: "遊戲規則", "idle-after-rules": "規則後待機", "history-after": "轉後下注紀錄", "idle-end": "最後待機", "game-ready": "進到遊戲", boot: "開機" };
const gname = (n) => /^spin-\\d+$/.test(n) ? "spin " + n.slice(5) : /^turbo-\\d+$/.test(n) ? "加速 spin " + n.slice(6) : (NAMES[n.replace(/-spike$/, "")] || n) + (n.endsWith("-spike") ? "（剛打開）" : "");
const clock = (ms) => { const s = Math.max(0, Math.round(ms / 1000)); return Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0"); };
$("stages").innerHTML = "<table><tr><th>階段</th><th class=num>開始</th><th class=num>FPS</th><th class=num>CPU p95</th><th class=num>每幀畫的次數</th><th class=num>GPU 記憶體</th><th class=num>JS heap</th><th class=num>最長停頓</th></tr>" +
  (ev.stages || []).filter((s) => s.name !== "gap" && s.frames > 0).map((s) => {
    const worst = Math.max(0, ...(s.hitches || []).map((h) => h.dt));
    return "<tr><td>" + esc(gname(s.name)) + "</td><td class=num>" + (s.startMs != null ? clock(s.startMs) : "") + "</td><td class=num>" + (s.fps == null ? "—" : Math.round(s.fps)) + "</td><td class=num>" + (ev.channels && ev.channels.engineCpu && s.cpuMs ? s.cpuMs.p95 + " ms" : "—") + "</td><td class=num>" + (s.draws ? Math.round(s.draws.avg) : "—") + "</td><td class=num>" + (s.gpuMemMb ? Math.round(s.gpuMemMb.peak) + " MB" : "—") + "</td><td class=num>" + (s.heapEndMb != null ? Math.round(s.heapEndMb) + " MB" : "—") + "</td><td class=num>" + (worst ? Math.round(worst) + " ms" : "") + "</td></tr>";
  }).join("") + "</table>";
if ((ev.missing || []).length) $("missing").textContent = "這次沒量到：" + ev.missing.join("、") + "。";
`;

const meta = metaLine(ev);

const page = `<!doctype html>
<html lang="zh-Hant">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title} 效能報告</title>
<style>${css}</style>
</head>
<body>
<main>
<h1>${title}</h1>
<div class="meta">${meta.replace(/</g, "&lt;")}</div>
${readoutHtml(ev)}

<section class="card" id="timeline-h">
<h2>時間軸</h2>
<div class="chips" id="chips"></div>
<div id="timeline"></div>
<p class="small">點階段可以放大，再點一次回到全程。色塊上停一下會看到數字。</p>
</section>

<section class="card">
<h2>要處理的地方</h2>
<div id="todo"></div>
</section>

<section class="card">
<h2>組成</h2>
<div id="state"></div>
</section>

<details class="card"><summary>分數怎麼算</summary><div id="criteria"></div></details>
<details class="card"><summary>每一段的數字</summary><div class="scroll" id="stages"></div></details>
<div class="missing" id="missing"></div>
</main>
<script type="application/json" id="ev">${data}</script>
<script>${timelineSrc}</script>
<script>${app}</script>
</body>
</html>
`;
fs.writeFileSync(outPath, page);
console.log(`wrote ${outPath}`);
