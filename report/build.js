#!/usr/bin/env node
// Usage: node report/build.js runs/<run> [--raw <saved raw.json>]
// --raw copies a result saved elsewhere (the MCP's temp directory) into runs/<run>/raw.json first.
// Reads runs/<run>/raw.json (auto.result() saved by evaluate_script filePath) and the optional
// notes.json the agent writes (displayName, summary, issues, missing). Writes evidence.json,
// findings, scores, the interactive report.html (plus report.md and timeline.svg for GitHub), then prints a short digest for the agent.
"use strict";

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const { findings } = require("./findings");

const args = process.argv.slice(2);
const runDir = args[0];
if (!runDir) {
  console.error("usage: node report/build.js <runDir> [--raw <saved raw.json>]");
  process.exit(1);
}
const T = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "protocol", "thresholds.json"), "utf8"));

function readJsonLoose(file) {
  const text = fs.readFileSync(file, "utf8");
  try {
    return JSON.parse(text);
  } catch (e) {
    const a = text.indexOf("{");
    const b = text.lastIndexOf("}");
    if (a < 0 || b < a) throw new Error(`no JSON object in ${file}`);
    return JSON.parse(text.slice(a, b + 1));
  }
}

// Never let a query string or session token reach evidence or the report.
function scrub(obj) {
  const text = JSON.stringify(obj)
    .replace(/(https?:\/\/[^\s"?#]*)[?#][^\s"]*/gi, "$1")
    .replace(/([?&](session|token|sid|auth|key)=)[^\s"&]*/gi, "$1<removed>");
  return JSON.parse(text);
}

fs.mkdirSync(runDir, { recursive: true });
const rawAt = args.indexOf("--raw");
const rawPath = path.join(runDir, "raw.json");
if (rawAt >= 0) fs.copyFileSync(args[rawAt + 1], rawPath);
const raw = scrub(readJsonLoose(rawPath));
const notesPath = path.join(runDir, "notes.json");
const notes = fs.existsSync(notesPath) ? JSON.parse(fs.readFileSync(notesPath, "utf8")) : {};
const notesWarn = [];
if (fs.existsSync(notesPath)) {
  if (!notes.summary || typeof notes.summary !== "object" || !notes.summary.smooth || !notes.summary.memory) notesWarn.push("notes.summary must be { smooth, memory }, one sentence each");
  if (!notes.displayName) notesWarn.push("notes.displayName is missing");
}
const s = raw.summary || raw;

// Main-thread busy time from a Chrome trace recorded around part of the run (report/cpu-trace.js
// writes cpu-trace.json; the raw trace stays in the scratchpad). Each probe stage carries traceId,
// and the trace has the same id for the same stage, so stages[].cpuTracePct is matched exactly.
// Stages that were not open while the trace ran get no value.
const cpuTracePath = path.join(runDir, "cpu-trace.json");
const cpuTrace = fs.existsSync(cpuTracePath) ? JSON.parse(fs.readFileSync(cpuTracePath, "utf8")) : null;
if (cpuTrace) {
  const byId = new Map(cpuTrace.stages.map((t) => [t.id, t]));
  (s.stages || []).forEach((x) => {
    const t = x.traceId && byId.get(x.traceId);
    if (t && t.cpuPct != null) x.cpuTracePct = t.cpuPct;
  });
}

// Spins the autopilot saw not start (nothing on screen changed from the press until it settled)
// are not spins: they become gap, and the report says which.
const notStarted = new Set(raw.notStarted || []);
const stages = (s.stages || []).map((x) => (notStarted.has(x.name) ? Object.assign({}, x, { name: "gap", notStarted: x.name }) : x));
const spinWord = (n) => (/^turbo-/.test(n) ? `加速第 ${n.slice(6)} 轉` : `第 ${n.replace(/^spin-/, "")} 轉`);
const notStartedNote = notStarted.size ? [`${[...notStarted].map(spinWord).join("、")}按下後畫面沒變，沒轉起來，沒算進 spin`] : [];
// A WebSocket that closed or failed after the game was ready: what follows may not be the game.
const wsAfter = (s.ws || []).filter((e) => e.afterReady);
const wsWhere = (n) => (/^(spin|turbo)-\d+$/.test(n || "") ? spinWord(n) : n || "?");
const wsNote = wsAfter.length ? [`WebSocket 在${wsWhere(wsAfter[0].stage)}${wsAfter[0].kind === "close" ? `斷線（code ${wsAfter[0].code}）` : "出錯"}${wsAfter.length > 1 ? `，共 ${wsAfter.length} 次` : ""}，之後的數字可能不是遊戲本身的表現`] : [];
const extraNotes = notStartedNote.concat(wsNote);
const spins = stages
  .filter((x) => /^(spin|turbo)-\d+$/.test(x.name))
  .map((x) => Object.assign({}, x, { tags: x.wallMs > 12000 ? ["long"] : [] }));

const coverage = Object.assign({}, raw.coverage || {});
if (raw.entry && raw.entry.result) coverage.entry = raw.entry.result;
if (s.channels && !s.channels.engineCpu) {
  coverage.cpu = cpuTrace
    ? `frameLoop ${s.channels.frameLoop}: no per-frame engine CPU; main-thread busy % from the Chrome trace (cpuTracePct)`
    : coverage.cpu || `frameLoop ${s.channels.frameLoop}: per-frame CPU unavailable`;
}
if (s.channels && !s.channels.gpuTimer) coverage.gpuTime = "unavailable: no GPU timer extension";
if (notStarted.size) coverage.notStarted = [...notStarted].join(", ");

const ev = {
  schemaVersion: 1,
  game: {
    title: (s.conditions && s.conditions.title) || path.basename(runDir),
    displayName: notes.displayName,
    urlPath: (s.conditions && s.conditions.urlPath) || "",
  },
  conditions: Object.assign({}, s.conditions || {}, notes.network ? { network: notes.network } : {}),
  channels: s.channels || {},
  sceneLog: s.sceneLog || [],
  stages,
  spins,
  timeline: s.timeline,
  memory: s.memory || {},
  resources: s.resources,
  progress: s.progress,
  paint: s.paint,
  shaders: s.shaders,
  audio: s.audio,
  cocos: raw.cocos || { snapshots: [] },
  entry: raw.entry,
  gc: raw.gc || [],
  census: raw.census || undefined,
  spinNodes: raw.spinNodes && raw.spinNodes.length ? raw.spinNodes : undefined,
  settle: raw.settle || undefined,
  points: raw.points || undefined,
  panels: raw.panels || undefined,
  ws: s.ws || undefined,
  feature: raw.feature || undefined,
  coverage,
  findings: [],
  summary: notes.summary,
  issues: notes.issues,
  missing: extraNotes.length ? [].concat(typeof notes.missing === "string" ? [notes.missing] : notes.missing || [], extraNotes) : typeof notes.missing === "string" ? [notes.missing] : notes.missing,
};
Object.keys(ev).forEach((k) => ev[k] === undefined && delete ev[k]);
Object.keys(ev.game).forEach((k) => ev.game[k] === undefined && delete ev.game[k]);

if (cpuTrace) ev.channels.cpuTrace = { thread: cpuTrace.thread, closed: cpuTrace.closed, wallMs: cpuTrace.total.wallMs, cpuPct: cpuTrace.total.cpuPct };

const result = findings(ev, T);
ev.findings = result.findings;

const evidencePath = path.join(runDir, "evidence.json");
fs.writeFileSync(evidencePath, JSON.stringify(ev, null, 2) + "\n");
const node = process.execPath;
const quiet = (script, extra) => execFileSync(node, [path.join(__dirname, script), evidencePath].concat(extra || []), { encoding: "utf8" }).trim();
const scoreLine = quiet("analyze.js");
quiet("markdown.js");
quiet("html.js");
// Digest: what the agent needs to write summary, issues and missing. Keep it short.
const done = JSON.parse(fs.readFileSync(evidencePath, "utf8"));
const c = ev.conditions;
const ch = ev.channels;
const lines = [];
lines.push(`${ev.game.title} · ${c.engine ? `Cocos ${c.engine}` : "not Cocos or engine unreadable"} · ${c.canvas ? `${c.canvas.w}x${c.canvas.h}` : ""} · gpu ${String(c.gpu || "?").slice(0, 60)}${result.softwareGpu ? " (software)" : ""}`);
lines.push(`frameLoop ${ch.frameLoop} engineCpu ${ch.engineCpu} gpuTimer ${ch.gpuTimer} gpuMemory ${ch.gpuMemory}`);
if (ch.cpuTrace) lines.push(`cpu trace ${ch.cpuTrace.thread}: main thread ${ch.cpuTrace.cpuPct}% of ${(ch.cpuTrace.wallMs / 1000).toFixed(1)} s${ch.cpuTrace.closed ? "" : " (no end mark)"}`);
if (ev.entry) lines.push(`entry ${ev.entry.result}${(ev.entry.steps || []).length ? ": " + ev.entry.steps.map((x) => `${x.kind} ${x.text}`).join(" > ") : ""}`);
lines.push(`coverage ${Object.entries(coverage).map(([k, v]) => `${k}=${v}`).join("; ")}`);
lines.push("group | n | fps | drop% | bad% | 1%low | cpu95 | draws | gpuMB | heapMB | worst");
const pc = (v) => (v == null ? "-" : Math.round(v * 1000) / 10);
result.groups
  .filter((g) => g.group !== "boot")
  .forEach((g) => {
    const w = g.worstHitch;
    lines.push(`${g.group} | ${g.stages} | ${g.fps ?? "-"} | ${pc(g.dropShare)} | ${pc(g.badShare)} | ${g.fpsLow ?? "-"} | ${g.cpuP95 ?? "-"} | ${g.draws ?? "-"} | ${g.gpuPeakMb ?? "-"} | ${g.heapEndMb ?? "-"} | ${w ? `${Math.round(w.dt)}ms ${w.stage}@${w.t}` : "-"}`);
  });
const counts = {};
ev.findings.forEach((f) => {
  const k = f.id;
  counts[k] = counts[k] || { n: 0, stages: new Set(), worst: 0 };
  counts[k].n += 1;
  if (f.stage) counts[k].stages.add(/^(spin|turbo)-\d+$/.test(f.stage) ? f.stage.replace(/-\d+$/, "") : f.stage);
  if (typeof f.value === "number" && f.value > counts[k].worst) counts[k].worst = f.value;
});
lines.push(`findings ${Object.entries(counts).map(([k, v]) => `${k} x${v.n}${v.stages.size ? ` [${[...v.stages].slice(0, 4).join(",")}]` : ""}${v.worst ? ` max ${Math.round(v.worst)}` : ""}`).join("; ") || "none"}`);
const m = ev.memory;
lines.push(`memory heap ${m.heapMb ?? "-"}MB · gpu ${m.gpu ? `${m.gpu.peakMb}MB peak (tex ${m.gpu.textureMb} buf ${m.gpu.bufferMb} rb ${m.gpu.renderbufferMb})` : "-"} · cocos textures ${m.textures && m.textures.status === "ok" ? `${m.textures.mb}MB ${m.textures.count} (${m.textures.compressed || 0} compressed)` : "-"}`);
lines.push(scoreLine);
lines.push(`todo ${(done.todo || []).map((r) => `${r.level}:${r.rule || r.title.slice(0, 20)}`).join(", ") || "none"}`);
if (!fs.existsSync(notesPath)) lines.push("notes.json missing: write it (see SKILL.md) and run again");
notesWarn.forEach((w) => lines.push(`notes warning: ${w}`));
console.log(lines.join("\n"));
