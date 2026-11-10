// What reached the screen, judged against the frame length the game asked for.
// Expected frame length E = max(vsync, 1000 / cc.game frame cap). A presented gap longer than
// badFactor × E is a bad frame; a gap more than paceTolerance × E away from E is off cadence.
// Stages from probes without presented data return null, and callers fall back to engine numbers.
"use strict";

const T = require("../protocol/thresholds.json");
const F = T.frames;

function round(n, d = 1) {
  const k = Math.pow(10, d);
  return Math.round(n * k) / k;
}

function stageFrames(s) {
  const p = s && s.presented;
  if (!p || !p.frames || !p.vsyncMs || !p.hist) return null;
  const vsync = p.vsyncMs;
  const cap = p.capFps || 60;
  const expectedMs = Math.max(vsync, 1000 / cap);
  let time = 0;
  let bad = 0;
  let off = 0;
  const gaps = [];
  p.hist.forEach((n, k) => {
    if (!n || !k) return;
    const gap = k * vsync;
    time += n * gap;
    if (gap > F.badFactor * expectedMs) bad += n;
    if (Math.abs(gap - expectedMs) > F.paceTolerance * expectedMs) off += n;
    gaps.push([gap, n]);
  });
  if (!time) return null;
  // 1% low from the gap histogram: the gap at the 99th percentile of presented frames.
  gaps.sort((a, b) => a[0] - b[0]);
  let seen = 0;
  let p99 = gaps.length ? gaps[gaps.length - 1][0] : null;
  for (const [gap, n] of gaps) {
    seen += n;
    if (seen >= 0.99 * p.frames) {
      p99 = gap;
      break;
    }
  }
  const fps = (1000 * p.frames) / time;
  const expectedFps = 1000 / expectedMs;
  return {
    frames: p.frames,
    vsyncMs: vsync,
    hz: round(1000 / vsync, 0),
    cap,
    expectedMs,
    expectedFps: round(expectedFps),
    fps: round(fps),
    fpsLow: p99 ? round(1000 / p99) : null,
    badShare: round(bad / p.frames, 3),
    offShare: round(off / p.frames, 3),
    dropShare: round(Math.max(0, 1 - fps / expectedFps), 3),
    wasted: p.wasted || 0,
  };
}

module.exports = { stageFrames };
