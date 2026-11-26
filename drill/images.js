#!/usr/bin/env node
// Usage: node drill/images.js <folder> [--min-kb 20]
// Lists PNG, JPEG and WebP files under a folder (a build such as build/web-mobile, or the project's
// assets) that carry metadata the picture does not need, and files larger than their raw pixels.
// Prints block types, keys and sizes only; the text inside a block is never printed.
"use strict";

const fs = require("fs");
const path = require("path");
const { imageMeta } = require("./imagemeta");

const args = process.argv.slice(2);
const dir = args.find((a) => !a.startsWith("--"));
const minKb = Number((args[args.indexOf("--min-kb") + 1]) || 20) || 20;
if (!dir || !fs.existsSync(dir)) {
  console.error("usage: node drill/images.js <folder> [--min-kb 20]");
  process.exit(2);
}

const files = [];
(function walk(d) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) { if (e.name !== "node_modules" && e.name !== ".git") walk(p); }
    else if (/\.(png|jpe?g|webp)$/i.test(e.name)) files.push(p);
  }
})(dir);

const kb = (n) => Math.round(n / 102.4) / 10;
const rows = [];
let total = 0;
for (const f of files) {
  const m = imageMeta(new Uint8Array(fs.readFileSync(f)));
  const bpp = m.w && m.h ? m.bytes / (m.w * m.h) : null;
  if (m.removable >= minKb * 1024 || (bpp != null && bpp > 4 && m.bytes > 200 * 1024)) {
    total += m.removable;
    rows.push({ file: path.relative(dir, f), w: m.w, h: m.h, kb: kb(m.bytes), bpp: bpp == null ? null : Math.round(bpp * 10) / 10, removableKb: kb(m.removable), blocks: m.meta.filter((x) => x.bytes >= 1024).map((x) => `${x.kind}${x.key ? ` ${x.key}` : ""} ${kb(x.bytes)} KB${x.removable ? "" : "（保留）"}`) });
  }
}
rows.sort((a, b) => b.removableKb - a.removableKb);
console.log(`${files.length} 張圖，${rows.length} 張夾了 ${minKb} KB 以上可拿掉的資料或比像素還大，合計可拿掉 ${kb(total)} KB`);
rows.slice(0, 50).forEach((r) => console.log(`${r.file}  ${r.w}×${r.h}  ${r.kb} KB${r.bpp != null ? `（每像素 ${r.bpp} bytes）` : ""}  可拿掉 ${r.removableKb} KB  ${r.blocks.join("、")}`));
