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

const stages = s.stages || [];
const spins = stages
  .filter((x) => /^(spin|turbo)-\d+$/.test(x.name))
  .map((x) => Object.assign({}, x, { tags: x.wallMs > 12000 ? ["long"] : [] }));

const coverage = Object.assign({}, raw.coverage || {});
if (raw.entry && raw.entry.result) coverage.entry = raw.entry.result;
if (s.channels && !s.channels.engineCpu) coverage.cpu = coverage.cpu || `frameLoop ${s.channels.frameLoop}: per-frame CPU unavailable`;
if (s.channels && !s.channels.gpuTimer) coverage.gpuTime = "unavailable: no GPU timer extension";

const ev = {
  schemaVersion: 1,
  game: {
    title: (s.conditions && s.conditions.title) || path.basename(runDir),
    displayName: notes.displayName,
    urlPath: (s.conditions && s.conditions.urlPath) || "",
  },
  conditions: s.conditions || {},
  channels: s.channels || {},
  sceneLog: s.sceneLog || [],
  stages,
  spins,
  timeline: s.timeline,
  memory: s.memory || {},
  resources: s.resources,
  shaders: s.shaders,
  audio: s.audio,
  cocos: raw.cocos || { snapshots: [] },
  entry: raw.entry,
  coverage,
  findings: [],
  summary: notes.summary,
  issues: notes.issues,
  missing: typeof notes.missing === "string" ? [notes.missing] : notes.missing,
};
Object.keys(ev).forEach((k) => ev[k] === undefined && delete ev[k]);
Object.keys(ev.game).forEach((k) => ev.game[k] === undefined && delete ev.game[k]);

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
lines.push(`${ev.game.title} · Cocos ${c.engine || "?"} · ${c.canvas ? `${c.canvas.w}x${c.canvas.h}` : ""} · gpu ${String(c.gpu || "?").slice(0, 60)}${result.softwareGpu ? " (software)" : ""}`);
lines.push(`frameLoop ${ch.frameLoop} engineCpu ${ch.engineCpu} gpuTimer ${ch.gpuTimer} gpuMemory ${ch.gpuMemory}`);
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
