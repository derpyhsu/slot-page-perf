#!/usr/bin/env node
// Usage: node report/cpu-trace.js <trace.json|trace.json.gz> <runDir>
// Reads a Chrome trace recorded around a run (chrome-devtools MCP: performance_start_trace with
// reload false and autoStop false, then performance_stop_trace with filePath). The probe marks each
// stage with performance.mark("slot-perf:<stage>") and the end with "slot-perf:end", so the page's
// renderer main thread is the one that carries those marks; no thread name or URL is needed.
// Writes runDir/cpu-trace.json: main-thread busy time per stage = merged RunTask slices / wall time.
// The output has no URLs. The raw trace does (session tokens), so keep it in the scratchpad, never in runs/.
"use strict";

const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const TASKS = new Set(["RunTask", "ThreadControllerImpl::RunTask"]);
const PREFIX = "slot-perf:";
const MARK_PH = new Set(["R", "I", "i", "n"]);

function loadEvents(file) {
  const buf = fs.readFileSync(file);
  const text = (file.endsWith(".gz") ? zlib.gunzipSync(buf) : buf).toString("utf8");
  const raw = JSON.parse(text);
  return Array.isArray(raw) ? raw : raw.traceEvents || [];
}

// Total length of the union of [start, end) intervals, after clipping to [lo, hi).
function busyWithin(slices, lo, hi) {
  const iv = [];
  for (const e of slices) {
    const s = Math.max(e.ts, lo);
    const t = Math.min(e.ts + e.dur, hi);
    if (t > s) iv.push([s, t]);
  }
  iv.sort((a, b) => a[0] - b[0]);
  let total = 0, cs = null, ce = null;
  for (const [s, t] of iv) {
    if (cs === null) { cs = s; ce = t; continue; }
    if (s <= ce) { ce = Math.max(ce, t); continue; }
    total += ce - cs; cs = s; ce = t;
  }
  if (cs !== null) total += ce - cs;
  return total;
}

const pct1 = (busy, wall) => (wall > 0 ? Math.round((1000 * busy) / wall) / 10 : null);

function analyze(events) {
  const names = new Map();
  for (const e of events) {
    if (e.ph === "M" && e.name === "thread_name" && e.args) names.set(e.pid + ":" + e.tid, e.args.name);
  }

  // The renderer that ran the probe is the thread with the most slot-perf marks.
  const marksBy = new Map();
  for (const e of events) {
    if (typeof e.name !== "string" || !e.name.startsWith(PREFIX) || !MARK_PH.has(e.ph)) continue;
    const key = e.pid + ":" + e.tid;
    if (!marksBy.has(key)) marksBy.set(key, []);
    marksBy.get(key).push({ name: e.name.slice(PREFIX.length), ts: e.ts });
  }
  if (marksBy.size === 0) throw new Error("no slot-perf marks in the trace: start the trace after the probe is installed and before auto.start()");
  let key = null;
  for (const [k, list] of marksBy) if (!key || list.length > marksBy.get(key).length) key = k;
  const marks = marksBy.get(key).sort((a, b) => a.ts - b.ts);

  const slices = events.filter((e) => e.ph === "X" && TASKS.has(e.name) && e.dur != null && e.pid + ":" + e.tid === key);
  const endMark = marks.filter((m) => m.name === "end").pop();
  const first = marks[0].ts;
  const stages = [];
  for (let i = 0; i < marks.length - 1; i += 1) {
    const a = marks[i];
    const b = marks[i + 1];
    if (a.name === "end") break;
    const wall = b.ts - a.ts;
    const busy = busyWithin(slices, a.ts, b.ts);
    stages.push({ id: a.name, name: a.name.replace(/@\d+$/, ""), startMs: Math.round((a.ts - first) / 100) / 10, wallMs: Math.round(wall / 100) / 10, busyMs: Math.round(busy / 100) / 10, cpuPct: pct1(busy, wall) });
  }
  // A stage with no mark after it was still open when the trace stopped; it is left out.
  const last = marks[marks.length - 1];
  const total = endMark ? endMark.ts - first : last.ts - first;
  const busyAll = busyWithin(slices, first, endMark ? endMark.ts : last.ts);
  return {
    schemaVersion: 1,
    source: "chrome trace (RunTask on the probe's renderer thread)",
    thread: names.get(key) || key.split(":")[1],
    closed: !!endMark,
    total: { wallMs: Math.round(total / 100) / 10, busyMs: Math.round(busyAll / 100) / 10, cpuPct: pct1(busyAll, total) },
    stages,
  };
}

if (require.main === module) {
  const [tracePath, runDir] = process.argv.slice(2);
  if (!tracePath || !runDir) {
    console.error("usage: node report/cpu-trace.js <trace.json|trace.json.gz> <runDir>");
    process.exit(1);
  }
  const out = analyze(loadEvents(tracePath));
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(path.join(runDir, "cpu-trace.json"), JSON.stringify(out, null, 2) + "\n");
  console.log(`cpu-trace: ${out.stages.length} stages, total ${out.total.cpuPct}% of ${(out.total.wallMs / 1000).toFixed(1)} s on ${out.thread}${out.closed ? "" : " (no end mark: last stage left out)"}`);
}

module.exports = { analyze, busyWithin };
