// Node smoke test for report/cpu-trace.js with a synthetic trace whose busy shares are known.
"use strict";
const assert = require("assert");
const { analyze } = require("../report/cpu-trace");

const M = (name, ts, tid) => ({ ph: "R", cat: "blink.user_timing", name: "slot-perf:" + name, pid: 1, tid, ts });
const X = (ts, dur, tid, name) => ({ ph: "X", name: name || "RunTask", pid: 1, tid, ts, dur });
const thread = (tid, name) => ({ ph: "M", name: "thread_name", pid: 1, tid, args: { name } });

const events = [
  thread(2, "CrRendererMain"),
  thread(3, "CrGpuMain"),
  // Probe stages on the renderer: boot 0-1 s, spin-1 1-3 s, end at 3 s.
  M("boot@1", 0, 2),
  M("spin-1@2", 1000000, 2),
  M("end", 3000000, 2),
  // Boot: one 200 ms task = 20 %.
  X(0, 200000, 2),
  // spin-1: 400 ms of tasks, one nested inside another (merged, counts 400 ms) = 20 % of 2 s.
  X(1000000, 400000, 2),
  X(1100000, 100000, 2),
  // Another thread's work must not count.
  X(1000000, 900000, 3),
  // A task that is not RunTask is not main-thread busy in this count.
  X(1500000, 500000, 2, "FunctionCall"),
];

const out = analyze(events);
assert.strictEqual(out.thread, "CrRendererMain");
assert.strictEqual(out.closed, true);
assert.deepStrictEqual(out.stages.map((s) => s.id), ["boot@1", "spin-1@2"]);
assert.deepStrictEqual(out.stages.map((s) => s.name), ["boot", "spin-1"]);
assert.strictEqual(out.stages[0].cpuPct, 20);
assert.strictEqual(out.stages[0].wallMs, 1000);
assert.strictEqual(out.stages[1].busyMs, 400);
assert.strictEqual(out.stages[1].cpuPct, 20);
assert.strictEqual(out.total.wallMs, 3000);
assert.strictEqual(out.total.cpuPct, 20);

// No end mark: the open last stage is left out and the total runs to the last mark.
const open = analyze(events.filter((e) => e.name !== "slot-perf:end"));
assert.strictEqual(open.closed, false);
assert.deepStrictEqual(open.stages.map((s) => s.id), ["boot@1"]);

// A trace without probe marks fails loudly instead of reporting zero.
assert.throws(() => analyze([thread(2, "CrRendererMain"), X(0, 1000, 2)]), /no slot-perf marks/);

console.log("cpu-trace-smoke ok");
