#!/usr/bin/env node
// Usage: node report/markdown.js runs/<run>/evidence.json [out.md]
// Run report/analyze.js first. Writes report.md next to the evidence unless out.md is given.
"use strict";

const fs = require("fs");
const path = require("path");

const evidencePath = process.argv[2];
if (!evidencePath) {
  console.error("usage: node report/markdown.js <evidence.json> [out.md]");
  process.exit(1);
}
const outPath = process.argv[3] || path.join(path.dirname(evidencePath), "report.md");
const ev = JSON.parse(fs.readFileSync(evidencePath, "utf8"));
const score = ev.score;
if (!score) {
  console.error("evidence has no score. Run report/analyze.js first.");
  process.exit(1);
}

const dot = { green: "🟢", yellow: "🟡", orange: "🟠", red: "🔴" };
const scoreDot = (s) => (s == null ? "⚪" : s >= 90 ? dot.green : s >= 70 ? dot.yellow : s >= 50 ? dot.orange : dot.red);
const fmtScore = (p) => (p.score == null ? "未評分" : `${p.score}${p.provisional ? `（暫定，量到 ${p.coverage}%）` : ""}`);

const lines = [];
const c = ev.conditions || {};
lines.push(`# ${ev.game.displayName || ev.game.title} 效能報告`);
lines.push("");
lines.push(`${c.viewport ? `${c.viewport.w}×${c.viewport.h}` : ""} · Cocos ${c.engine || "?"} · ${(c.capturedAt || "").slice(0, 10)} · 目標：穩定 60 FPS，低階裝置不爆記憶體`);
lines.push("");
lines.push("| | 分數 | 一句話 |");
lines.push("| --- | --- | --- |");
lines.push(`| 順暢 | ${scoreDot(score.smooth.score)} ${fmtScore(score.smooth)} | ${(ev.summary && ev.summary.smooth) || ""} |`);
lines.push(`| 記憶體 | ${scoreDot(score.memory.score)} ${fmtScore(score.memory)} | ${(ev.summary && ev.summary.memory) || ""} |`);
lines.push("");
const fatal = score.smooth.fatal.length + score.memory.fatal.length;
lines.push(fatal ? `**致命漏洞 ${fatal} 個**` : "沒有找到致命漏洞。");
lines.push("");
lines.push("全程時間軸在 Cursor 畫布裡（`report/canvas.js`）。");

const cell = (s) => String(s == null ? "" : s).replace(/\|/g, "\\|").replace(/\n/g, " ");
const todo = ev.todo || [];
if (todo.length) {
  lines.push("");
  lines.push("## 要處理的地方");
  lines.push("");
  lines.push("| # | | 問題 | 類別 | 怎麼改 |");
  lines.push("| --- | --- | --- | --- | --- |");
  todo.forEach((r) => lines.push(`| ${r.n} | ${dot[r.level] || dot.red} | ${cell(r.title)} | ${cell(r.area)} | ${cell(r.fix)} |`));
}

lines.push("");
lines.push("## 目前狀況");
lines.push("");
const cpu = score.smooth.items.find((i) => i.id === "cpu");
lines.push(`- **CPU**：${cpu && cpu.value != null ? `最忙的階段，95% 的幀在 ${cpu.value} ms 內跑完，一幀預算 16.7 ms。` : "這次沒量到每幀 CPU。卡頓仍來自瀏覽器的長任務紀錄。"}`);
const est = score.memory.estimateMb;
const growth = score.memory.items.find((i) => i.id === "growth");
lines.push(`- **記憶體**：${est ? `推估最高 ${Math.round(est.total)} MB，預算 ${score.memory.budgetMb} MB（JS ${Math.round(est.heap)}、貼圖 ${Math.round(est.texture)}、畫面 ${Math.round(est.framebuffer)}）。` : "這次沒量到。"}${growth && growth.value != null ? `每轉多留 ${growth.value} MB。` : ""}`);

const entry = ev.entry;
if (entry && entry.result) {
  const steps = (entry.steps || []).map((s) => s.text || s.kind).join(" → ");
  lines.push(`- **進遊戲**：${{ direct: "載入完直接能轉", pressed: `按了 ${(entry.steps || []).length} 次才能轉（${steps}）`, stuck: `卡住，沒進到能轉的畫面${steps ? `（按過 ${steps}）` : ""}` }[entry.result]}`);
}
const advice = ev.cocosAdvice;
if (advice) {
  const sc = advice.scene;
  const facts = sc ? [["節點", sc.nodes], ["在畫的 Spine", sc.spineActive], ["其中即時運算", sc.spineRealtime], ["Label", sc.labels], ["Mask", sc.masks], ["粒子系統", sc.particles]].filter(([, v]) => v != null) : [];
  const note = { "textures-only": "這次只讀到貼圖，沒有走場景。", unavailable: "這次沒有讀場景。" }[advice.status];
  lines.push(`- **Cocos 場景**：${facts.length ? facts.map(([k, v]) => `${k} ${v}`).join(" · ") : note || ""}${advice.status === "ok" && !advice.items.length ? "。組成和引擎設定都在門檻內。" : ""}`);
}

lines.push("");
lines.push("<details><summary>分數怎麼算</summary>");
lines.push("");
lines.push("每項在滿分與零分之間內插。沒量到的項目不計入，分數標暫定。有致命漏洞時該分數最高 49。90 以上綠、70 以上黃、50 以上橘、其餘紅。完整規則在 `protocol/scoring.md`。");
lines.push("");
lines.push("| | 看什麼 | 權重 | 這次 | 滿分 | 零分 | 得分 |");
lines.push("| --- | --- | --- | --- | --- | --- | --- |");
[["順暢", score.smooth], ["記憶體", score.memory]].forEach(([g, part]) =>
  part.items.forEach((i) =>
    lines.push(`| ${g} | ${i.label} | ${i.weight} | ${i.value == null ? "沒量到" : `${i.approx ? "約 " : ""}${i.value} ${i.unit}`} | ${i.full} | ${i.zero} | ${i.score == null ? "不計" : i.score} |`),
  ),
);
lines.push("");
lines.push("</details>");

if ((ev.missing || []).length) {
  lines.push("");
  lines.push(`這次沒量到：${ev.missing.join("、")}。`);
}

fs.writeFileSync(outPath, lines.join("\n") + "\n");
console.log(`wrote ${outPath}`);
