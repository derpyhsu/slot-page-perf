#!/usr/bin/env node
// Usage: node report/html.js runs/<run>/evidence.json [out.html]
// Run report/analyze.js first. Writes report.html next to the evidence: one self-contained page with
// the evidence inlined, a timeline that zooms per stage, and collapsible details. No network needed.
"use strict";

const fs = require("fs");
const path = require("path");
const { metaLine, readoutHtml } = require("./readout");
const { eventSvg } = require("./timeline");
const { SOFTWARE_GPU } = require("./findings");

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
const esc = (s) => String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

const STAGE_NAMES = { loading: "載入", splash: "開始畫面", enter: "進遊戲", idle: "待機", menu: "功能列表", "history-before": "下注紀錄", rules: "遊戲規則", "idle-after-rules": "規則後待機", "history-after": "轉後下注紀錄", "idle-end": "最後待機", "game-ready": "進到遊戲", boot: "開機" };
const stageLabel = (n) => (!n ? "" : /^spin-\d+$/.test(n) ? `第 ${n.slice(5)} 轉` : /^turbo-\d+$/.test(n) ? `加速第 ${n.slice(6)} 轉` : STAGE_NAMES[n.replace(/-spike$/, "")] || n);
const clock = (ms) => {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};
const PRIORITY = { red: "P0", orange: "P1", yellow: "P2" };
const where = (r) => [stageLabel(r.stage), r.t != null ? clock(r.t) : ""].filter(Boolean).join(" ");

// The stall a row points at, read from findings: what was measured, and what happened at the same
// time without being proven as the cause.
const soft = SOFTWARE_GPU.test((ev.conditions && ev.conditions.gpu) || "");
function stallFacts(r) {
  const h = (ev.findings || []).find((f) => /^hitch-/.test(f.id) && f.t === r.t);
  if (!h) return null;
  const file = (u) => String(u || "").split("?")[0].split("/").filter(Boolean).slice(-1)[0] || "";
  const kind = { "hitch-main-thread": "主執行緒在忙", "hitch-network": "在等下載", "hitch-other": "原因不明（主執行緒和網路都不是）" }[h.id] || h.id;
  const seen = [`${stageLabel(h.stage)} ${clock(h.t)} 停 ${Math.round(h.value)} ms`, h.cpu != null ? `主執行緒 ${h.cpu} ms` : "", h.inFlight != null ? `下載中 ${h.inFlight} 個` : "", (h.urls || []).length ? `請求 ${h.urls.slice(0, 2).map(file).join("、")}` : "", `規則判定：${kind}`].filter(Boolean).join(" · ");
  const tl = ev.timeline;
  let upload = 0;
  if (tl && tl.buckets) {
    const ui = (tl.bucketFields || []).indexOf("texUploadMb");
    const w = tl.bucketMs || 250;
    if (ui >= 0) tl.buckets.forEach((b) => { if (b[0] + w >= h.t && b[0] <= h.t + h.value) upload += b[ui] || 0; });
  }
  return { seen, also: upload >= 1 ? `貼圖上傳 ${Math.round(upload * 10) / 10} MB（時間吻合，未證實是原因）` : "" };
}
// Event cards only for stalls with one moment, at most three, and not on a software renderer.
const carded = new Set((ev.todo || []).filter((r) => !soft && !r.note && /^stall-/.test(r.rule || "") && r.t != null).slice(0, 3).map((r) => r.n));

// Each row opens to what was measured, the rows it merged, the advice, and a link to the timeline.
function todoRow(r, open) {
  const parts = (r.parts || []).map((p) => `<li>${esc(p.title)}</li>`).join("");
  const at = where(r);
  const facts = carded.has(r.n) ? stallFacts(r) : null;
  const card = carded.has(r.n) ? eventSvg(ev, r.t) : null;
  return `<details class="acc" id="todo-${r.n}"${open ? " open" : ""}>
<summary><span class="pb ${r.level}">${PRIORITY[r.level] || "P2"}</span><span class="tt">${esc(r.title)}${r.parts && r.parts.length ? ` <span class="times">${r.env ? "含" : "另含"} ${r.parts.length} 條</span>` : ""}</span><span class="at">${esc(at)}</span><span class="chev" aria-hidden="true">›</span></summary>
<div class="body">
${facts ? `<div class="k">量到</div><p>${esc(facts.seen)}</p>${facts.also ? `<div class="k">同時發生</div><p>${esc(facts.also)}</p>` : ""}` : ""}
${card ? `<div class="evcard">${card}</div>` : ""}
${parts ? `<div class="k">包含</div><ul class="parts">${parts}</ul>` : ""}
<div class="k">建議</div><p>${esc(r.fix)}</p>
<div class="acts">${r.t != null || r.stage ? `<button type="button" class="jump" data-n="${r.n}">在時間軸看</button>` : ""}<span class="rule">${esc(r.area)}${r.rule ? ` · 規則 ${esc(r.rule)}` : ""}</span></div>
</div>
</details>`;
}
function todoHtml() {
  const rows = (ev.todo || []).filter((r) => !r.note);
  if (!rows.length) return '<p class="small">沒有要處理的地方。</p>';
  return rows.map((r, i) => todoRow(r, i === 0)).join("");
}

const css = `
:root { --ink:#202124; --sub:#5f6368; --faint:#80868b; --line:#e3e6ea; --soft:#f3f4f6; --paper:#fff;
  --red:#d93025; --orange:#e8710a; --yellow:#c98a12; --green:#188038; --blue:#1a73e8; }
* { box-sizing: border-box; }
body { margin: 0; background: #f6f7f9; color: var(--ink); font: 14px/1.6 "Segoe UI","Microsoft JhengHei","PingFang TC",system-ui,sans-serif; }
main { max-width: 1040px; margin: 0 auto; padding: 28px 16px 72px; }
.sheet { background: var(--paper); border: 1px solid var(--line); border-radius: 10px; padding: 24px 28px 20px; }
h1 { font-size: 26px; font-weight: 600; letter-spacing: -0.01em; margin: 0; }
h2 { font-size: 17px; font-weight: 600; margin: 0; }
h3 { font-size: 11.5px; font-weight: 600; color: var(--faint); letter-spacing: .05em; margin: 18px 0 8px; }
.meta { color: var(--faint); font-size: 12px; margin-top: 4px; font-variant-numeric: tabular-nums; }
.small { font-size: 12px; color: var(--sub); }
.num, td.num, th.num { font-variant-numeric: tabular-nums; }
.hero { margin-top: 14px; }
.verdict { margin: 0 0 8px; font-size: 14px; }
.gauges { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); border-bottom: 1px solid var(--line); }
.gtab { position: relative; display: flex; flex-direction: column; align-items: center; gap: 2px; background: none; border: 0; border-radius: 8px 8px 0 0; padding: 10px 8px 14px; cursor: pointer; font: inherit; color: inherit; min-width: 0; }
.gtab:hover, .gtab[aria-selected="true"] { background: var(--soft); }
.gtab[aria-selected="true"]::after { content: ""; position: absolute; left: 20%; right: 20%; bottom: -1px; height: 3px; border-radius: 3px 3px 0 0; background: var(--ink); }
.gtab:focus-visible, .acc summary:focus-visible, button:focus-visible, a:focus-visible { outline: 2px solid var(--blue); outline-offset: 2px; }
.gtab svg { display: block; }
.gauge-name { font-size: 16px; font-weight: 600; }
.gauge-name .prov { display: block; font-size: 11px; font-weight: 400; color: var(--faint); }
.gauge-hint, .gauge-fatal, .gauge-risk { margin: 0; font-size: 12px; color: var(--sub); text-align: center; }
.gauge-fatal { color: var(--red); }
.gauge-risk { margin-top: 2px; color: var(--ink); }
.legend { display: flex; justify-content: center; flex-wrap: wrap; gap: 4px 18px; color: var(--faint); font-size: 11.5px; margin: 8px 0 0; }
.legend span { display: inline-flex; align-items: center; gap: 6px; }
.lm { display: inline-block; width: 9px; height: 9px; flex: none; }
.lm.circ { border-radius: 50%; background: currentColor; }
.lm.sq { background: currentColor; }
.lm.tri { width: 0; height: 0; background: none; border-left: 5px solid transparent; border-right: 5px solid transparent; border-bottom: 9px solid currentColor; }
.lm.dash { width: 9px; height: 2px; background: var(--faint); }
.sec { border-top: 1px solid var(--line); margin-top: 22px; padding-top: 16px; }
.sec-h { display: flex; justify-content: space-between; align-items: baseline; flex-wrap: wrap; gap: 4px 12px; margin-bottom: 6px; }
.pb { display: inline-block; flex: none; font: 600 11px/18px Consolas,"Cascadia Mono",monospace; padding: 0 6px; border-radius: 4px; color: #fff; margin-right: 10px; }
.pb.red { background: var(--red); } .pb.orange { background: var(--orange); } .pb.yellow { background: var(--yellow); }
ul.rel a { display: flex; align-items: baseline; gap: 4px; padding: 8px 0; border-bottom: 1px solid var(--line); color: inherit; text-decoration: none; }
ul.rel a:hover { text-decoration: underline; }
.times { font-size: 11.5px; color: var(--faint); }
.panel-cols { display: grid; grid-template-columns: minmax(0, 1.3fr) minmax(0, 1fr); gap: 32px; }
.panel-one { max-width: 640px; }
ul.items, ul.ctx, ul.rel, ul.parts { list-style: none; margin: 0; padding: 0; }
ul.items li { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 2px 12px; padding: 8px 0; border-bottom: 1px solid var(--line); }
ul.items .il { display: flex; align-items: center; gap: 8px; }
.tip { position: relative; cursor: help; border-bottom: 1px dotted var(--faint); }
.tip:focus { outline: none; }
.tiptext { visibility: hidden; opacity: 0; position: absolute; left: 0; top: calc(100% + 6px); z-index: 5; width: min(340px, 80vw); padding: 8px 10px; border-radius: 6px; background: var(--ink); color: #fff; font-size: 12px; font-weight: 400; line-height: 1.6; box-shadow: 0 4px 14px rgba(0,0,0,.18); transition: opacity .12s; pointer-events: none; }
.tip:hover .tiptext, .tip:focus .tiptext { visibility: visible; opacity: 1; }
ul.items .il small { color: var(--faint); font-size: 11.5px; }
ul.items .iv { font-weight: 600; font-variant-numeric: tabular-nums; text-align: right; }
ul.items li.off { color: var(--faint); }
ul.items li.off .iv { font-weight: 400; font-size: 12px; }
.scale { grid-column: 1 / -1; position: relative; height: 5px; border-radius: 3px; background: linear-gradient(90deg, #e3f1e8, #fbf1dc 50%, #fbe4e2); }
.scale i { position: absolute; top: -3px; width: 3px; height: 11px; border-radius: 2px; background: var(--ink); }
.scap { grid-column: 1 / -1; display: flex; justify-content: space-between; gap: 8px; font-size: 11px; color: var(--faint); font-variant-numeric: tabular-nums; }
details.more summary { cursor: pointer; font-size: 12px; color: var(--sub); padding: 8px 0; }
ul.ctx li { display: flex; justify-content: space-between; gap: 12px; padding: 6px 0; border-bottom: 1px dashed var(--line); font-size: 13px; }
ul.ctx li span:last-child { text-align: right; font-variant-numeric: tabular-nums; }
ul.rel a { font-size: 13px; }
.stack { position: relative; display: flex; height: 12px; border-radius: 3px; background: var(--soft); margin: 4px 0 6px; }
.stack span:first-child { border-radius: 3px 0 0 3px; }
.stack i { position: absolute; top: -4px; bottom: -4px; width: 2px; background: var(--red); }
.scroll { overflow-x: auto; }
table { border-collapse: collapse; width: 100%; font-variant-numeric: tabular-nums; font-size: 13px; }
th, td { text-align: left; padding: 7px 10px 7px 0; border-bottom: 1px solid var(--line); vertical-align: top; }
th { font-size: 11px; color: var(--faint); font-weight: 600; letter-spacing: .03em; }
td.num, th.num { text-align: right; white-space: nowrap; padding-left: 10px; padding-right: 0; }
td.lab { white-space: nowrap; color: var(--sub); }
td .sub, .facts .sub { font-size: 11.5px; color: var(--faint); }
.acc { border-bottom: 1px solid var(--line); }
.acc summary { list-style: none; cursor: pointer; display: flex; align-items: baseline; gap: 4px; padding: 10px 0; }
.acc summary::-webkit-details-marker { display: none; }
.acc .tt { flex: 1; min-width: 0; }
.acc .at { font-size: 12px; color: var(--faint); white-space: nowrap; }
.acc .chev { color: var(--faint); margin-left: 8px; transition: transform .15s; }
.acc[open] .chev { transform: rotate(90deg); }
.acc .body { padding: 0 0 14px 44px; font-size: 13.5px; }
.acc .body p { margin: 0 0 8px; }
.acc .k { font-size: 11px; font-weight: 600; color: var(--faint); letter-spacing: .04em; margin: 4px 0 2px; }
ul.parts li { padding: 2px 0; color: var(--sub); }
ul.parts li::before { content: "· "; }
.acts { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin-top: 6px; }
.acts button, .zoom-out { font: inherit; font-size: 12px; border: 1px solid var(--line); background: var(--paper); color: var(--blue); border-radius: 4px; padding: 3px 9px; cursor: pointer; }
.acts .rule { font-size: 11.5px; color: var(--faint); margin-left: auto; }
.acc.flash { animation: flash 1.2s ease-out; }
@keyframes flash { 0% { background: #e8f0fe; } 100% { background: transparent; } }
.evcard { max-width: 560px; margin: 4px 0 10px; }
.evcard svg { width: 100%; height: auto; display: block; }
#timeline { margin: 6px -4px 0; }
#timeline svg { width: 100%; height: auto; display: block; }
#timeline .stage { cursor: zoom-in; }
@keyframes pin-blink { 0% { opacity: 0; } 16% { opacity: 1; } 34% { opacity: .12; } 52% { opacity: 1; } 70% { opacity: .12; } 86%, 100% { opacity: 1; } }
#timeline .pin { animation: pin-blink .9s ease-out both; }
@media (prefers-reduced-motion: reduce) { #timeline .pin, .acc.flash { animation: none; } .acc .chev { transition: none; } }
details.fold { border-top: 1px solid var(--line); margin-top: 22px; padding-top: 12px; }
details.fold > summary { cursor: pointer; font-weight: 600; }
details.fold[open] > summary { margin-bottom: 10px; }
.missing { margin-top: 18px; color: var(--faint); font-size: 12px; }
@media (max-width: 760px) {
  .sheet { padding: 18px 16px; }
  .panel-cols { grid-template-columns: minmax(0, 1fr); gap: 8px; }
  .gtab svg { width: 84px; height: 84px; }
  .gauge-name { font-size: 13px; }
  .acc .body { padding-left: 0; }
  .acc .at { display: none; }
}
`;

const app = `
const ev = JSON.parse(document.getElementById("ev").textContent);
const COLOR = { red: "#e5484d", orange: "#f76b15", yellow: "#e2a336", green: "#30a46c" };
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const scoreLevel = (s) => (s == null ? "yellow" : s >= 90 ? "green" : s >= 70 ? "yellow" : s >= 50 ? "orange" : "red");
const S = ev.score;
const NAMES = { loading: "載入階段", smooth: "幀率穩定度", memory: "資源占用" };

// The three gauges are tabs over the detail panels. The hash keeps the choice in a shared link.
const tabs = [...document.querySelectorAll(".gtab")];
function select(key, focus) {
  tabs.forEach((t) => {
    const on = t.dataset.k === key;
    t.setAttribute("aria-selected", on);
    t.tabIndex = on ? 0 : -1;
    $("panel-" + t.dataset.k).hidden = !on;
    if (on && focus) t.focus();
  });
  $("detail-h").textContent = NAMES[key] + "細項";
  try { history.replaceState(null, "", "#" + key); } catch (e) {}
}
tabs.forEach((t, i) => {
  t.addEventListener("click", () => select(t.dataset.k));
  t.addEventListener("keydown", (e) => {
    const k = { ArrowRight: i + 1, ArrowLeft: i - 1, Home: 0, End: tabs.length - 1 }[e.key];
    if (k == null) return;
    e.preventDefault();
    select(tabs[(k + tabs.length) % tabs.length].dataset.k, true);
  });
});
const start = location.hash.slice(1);
if (tabs.some((t) => t.dataset.k === start)) select(start);

// Links to a suggestion open it.
document.addEventListener("click", (e) => {
  const a = e.target.closest("a.go");
  if (!a) return;
  e.preventDefault();
  const d = $("todo-" + a.dataset.n);
  if (!d) return;
  d.open = true;
  d.scrollIntoView({ behavior: "smooth", block: "center" });
  d.classList.remove("flash");
  void d.offsetWidth;
  d.classList.add("flash");
});

// Timeline with per-stage zoom.
const groups = timelineGroups(ev);
let zoom = null;
let pin = null;
function drawTimeline() {
  const range = zoom == null ? null : [groups[zoom].start, groups[zoom].end];
  $("timeline").innerHTML = timelineSvg(ev, range, pin) || "";
  $("zoom-out").hidden = zoom == null;
  $("zoom-name").textContent = zoom == null ? "全程" : groups[zoom].name;
}
$("zoom-out").addEventListener("click", () => {
  zoom = null;
  pin = null;
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
  pin = row.t != null ? { t: row.t } : { group: i };
  drawTimeline();
  $("timeline-h").scrollIntoView({ behavior: "smooth" });
}

const rowOf = (n) => (ev.todo || []).find((r) => String(r.n) === String(n));
document.addEventListener("click", (e) => {
  const j = e.target.closest("button.jump");
  if (j) zoomTo(rowOf(j.dataset.n));
});

// Collapsed details.
const crit = (S.loading ? [["載入階段", S.loading]] : []).concat([["幀率穩定度", S.smooth], ["資源占用", S.memory]]).flatMap(([g, p]) => p.items.map((i) => [g, i]));
$("criteria").innerHTML = '<p class="small">每項在滿分與零分之間內插。沒量到的項目不計入，分數標暫定。有致命漏洞時該分數最高 49。90 以上綠、70 以上黃、50 以上橘、其餘紅。</p>' +
  '<div class="scroll"><table><tr><th></th><th>看什麼</th><th class=num>權重</th><th class=num>這次</th><th class=num>滿分</th><th class=num>零分</th><th class=num>得分</th></tr>' +
  crit.map(([g, i]) => "<tr><td>" + g + "</td><td>" + esc(i.label) + "</td><td class=num>" + i.weight + "</td><td class=num>" + (i.value == null ? "沒量到" : (i.approx ? "約 " : "") + i.value + " " + i.unit) + "</td><td class=num>" + esc(i.full) + "</td><td class=num>" + esc(i.zero) + '</td><td class=num style="color:' + COLOR[scoreLevel(i.score)] + ';font-weight:600">' + (i.score == null ? "不計" : i.score) + "</td></tr>").join("") + "</table></div>";
const SN = { loading: "載入", splash: "開始畫面", enter: "進遊戲", idle: "待機", menu: "功能列表", "history-before": "下注紀錄", rules: "遊戲規則", "idle-after-rules": "規則後待機", "history-after": "轉後下注紀錄", "idle-end": "最後待機", "game-ready": "進到遊戲", boot: "開機" };
const gname = (n) => /^spin-\\d+$/.test(n) ? "spin " + n.slice(5) : /^turbo-\\d+$/.test(n) ? "加速 spin " + n.slice(6) : (SN[n.replace(/-spike$/, "")] || n) + (n.endsWith("-spike") ? "（剛打開）" : "");
const clock = (ms) => { const s = Math.max(0, Math.round(ms / 1000)); return Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0"); };
$("stages").innerHTML = "<table><tr><th>階段</th><th class=num>開始</th><th class=num>FPS</th><th class=num>CPU p95</th><th class=num>每幀畫的次數</th><th class=num>GPU 記憶體</th><th class=num>JS heap</th><th class=num>最長停頓</th></tr>" +
  (ev.stages || []).filter((s) => s.name !== "gap" && s.frames > 0).map((s) => {
    const worst = Math.max(0, ...(s.hitches || []).map((h) => h.dt));
    return "<tr><td>" + esc(gname(s.name)) + "</td><td class=num>" + (s.startMs != null ? clock(s.startMs) : "") + "</td><td class=num>" + (s.fps == null ? "—" : Math.round(s.fps)) + "</td><td class=num>" + (ev.channels && ev.channels.engineCpu && s.cpuMs ? s.cpuMs.p95 + " ms" : "—") + "</td><td class=num>" + (s.draws ? Math.round(s.draws.avg) : "—") + "</td><td class=num>" + (s.gpuMemMb ? Math.round(s.gpuMemMb.peak) + " MB" : "—") + "</td><td class=num>" + (s.heapEndMb != null ? Math.round(s.heapEndMb) + " MB" : "—") + "</td><td class=num>" + (worst ? Math.round(worst) + " ms" : "") + "</td></tr>";
  }).join("") + "</table>";
const notes = (ev.todo || []).filter((r) => r.note).map((r) => r.title + (r.fix ? "：" + r.fix : ""));
$("missing").textContent = [(ev.missing || []).length ? "這次沒量到：" + ev.missing.join("、") + "。" : "", notes.length ? "量測說明：" + notes.join("；") : ""].filter(Boolean).join(" ");
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
<main><div class="sheet">
<h1>${title}</h1>
<div class="meta" id="meta">${esc(meta)}</div>
${readoutHtml(ev)}

<section class="sec" id="todo-sec">
<div class="sec-h"><h2>可優化項目</h2></div>
${todoHtml()}
</section>

<section class="sec" id="timeline-h">
<div class="sec-h"><h2>時間軸 · <span id="zoom-name">全程</span></h2><button type="button" class="zoom-out" id="zoom-out" hidden>回到全程</button></div>
<div id="timeline"></div>
<p class="small">點階段可以放大。色塊上停一下會看到數字。從建議點「在時間軸看」時，落點會閃兩下然後留著。</p>
</section>

<details class="fold"><summary>全部依據（分數怎麼算）</summary><div id="criteria"></div></details>
<details class="fold"><summary>每一段的數字</summary><div class="scroll" id="stages"></div></details>
<div class="missing" id="missing"></div>
</div></main>
<script type="application/json" id="ev">${data}</script>
<script>${timelineSrc}</script>
<script>${app}</script>
</body>
</html>
`;
fs.writeFileSync(outPath, page);
console.log(`wrote ${outPath}`);
