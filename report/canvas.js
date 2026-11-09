#!/usr/bin/env node
// Usage: node report/canvas.js runs/<run>/evidence.json <workspace>/canvases/<slug>.canvas.tsx
// Run report/analyze.js first so the canvas has scores and Cocos advice.
"use strict";

const fs = require("fs");
const path = require("path");

const [evidencePath, outPath] = process.argv.slice(2);
if (!evidencePath || !outPath) {
  console.error("usage: node report/canvas.js <evidence.json> <out.canvas.tsx>");
  process.exit(1);
}

const template = fs.readFileSync(path.join(__dirname, "template.canvas.tsx"), "utf8");
const ev = JSON.parse(fs.readFileSync(evidencePath, "utf8"));
ev.example = false;
if (!ev.score) console.warn("evidence has no score. Run report/analyze.js first.");

const begin = "/* EVIDENCE:BEGIN */";
const end = "/* EVIDENCE:END */";
const a = template.indexOf(begin);
const b = template.indexOf(end);
if (a < 0 || b < 0) throw new Error("EVIDENCE markers missing in template.canvas.tsx");

const body = `${begin}\nconst EVIDENCE = ${JSON.stringify(ev, null, 2)} as unknown as Evidence;\n`;
fs.writeFileSync(outPath, template.slice(0, a) + body + template.slice(b));
console.log(`wrote ${outPath}`);
