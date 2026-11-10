#!/usr/bin/env node
// Usage: node report/markdown.js runs/<run>/evidence.json [out.md]
// Run report/analyze.js first. Writes report.md next to the evidence unless out.md is given.
"use strict";

const fs = require("fs");
const path = require("path");
const { metaLine, readoutMarkdown } = require("./readout");

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

const lines = [];
lines.push(`# ${ev.game.displayName || ev.game.title} 效能報告`);
lines.push("");
lines.push(metaLine(ev));
lines.push("");
lines.push(readoutMarkdown(ev));
const svg = require("./timeline").timelineSvg(ev);
if (svg) {
  const base = path.basename(outPath, ".md");
  const svgName = base === "report" ? "timeline.svg" : `${base}.timeline.svg`;
  fs.writeFileSync(path.join(path.dirname(outPath), svgName), svg);
  lines.push("");
  lines.push("## 全程時間軸");
  lines.push("");
  lines.push(`![全程時間軸](${svgName})`);
  lines.push("");
  lines.push("上到下：階段、建議發生的位置（黑圈數字對應下面表格）、FPS（55 以上是淺灰，越慢越紅）、主執行緒忙碌比例與 long task、記憶體。等 agent 的時間已從橫軸剪掉，虛線標出略過幾秒。");
}

const cell = (s) => String(s == null ? "" : s).replace(/\|/g, "\\|").replace(/\n/g, " ");
const todo = ev.todo || [];
if (todo.length) {
  lines.push("");
  lines.push("## 要處理的地方");
  lines.push("");
  lines.push("| # | 問題 | 類別 | 怎麼改 |");
  lines.push("| --- | --- | --- | --- |");
  todo.forEach((r) => lines.push(`| ${dot[r.level] || dot.red} ${r.n} | ${cell(r.title)}${r.parts && r.parts.length ? `（含：${cell(r.parts.map((x) => x.title).join("；"))}）` : ""} | ${cell(r.area)} | ${cell(r.fix)} |`));
}

lines.push("");
lines.push("## 目前狀況");
lines.push("");
const cpu = score.smooth.items.find((i) => i.id === "cpu");
lines.push(`- **CPU**：${cpu && cpu.value != null ? `最忙的階段，95% 的幀在 ${cpu.value} ms 內跑完，一幀預算 16.7 ms。` : "這次沒量到每幀 CPU。卡頓仍來自瀏覽器的長任務紀錄。"}`);
const est = score.memory.estimateMb;
const growth = score.memory.items.find((i) => i.id === "growth");
lines.push(`- **記憶體**：${est ? `推估最高 ${Math.round(est.total)} MB，預算 ${score.memory.budgetMb} MB（JS ${Math.round(est.heap)}、${est.gpuSource === "gpu" ? "GPU" : "貼圖"} ${Math.round(est.texture)}、畫面 ${Math.round(est.framebuffer)}）。` : "這次沒量到。"}${growth && growth.value != null ? `每轉多留 ${growth.value} MB。` : ""}`);

const fps = ev.fps || [];
if (fps.length) {
  const soft = /swiftshader|basic render driver|llvmpipe|softpipe|warp/i.test((ev.conditions && ev.conditions.gpu) || "");
  lines.push("");
  lines.push(`各階段 FPS${soft ? "（這台電腦是軟體繪製，數字代表這台電腦，不代表手機 GPU）" : ""}：`);
  lines.push("");
  const pc = (v) => (v == null ? "—" : `${Math.round(v * 1000) / 10}%`);
  lines.push("| | 階段 | 平均 FPS | 掉幀 | 超過 33 ms | 1% low | GPU 記憶體峰值 |");
  lines.push("| --- | --- | --- | --- | --- | --- | --- |");
  fps.forEach((r) => lines.push(`| ${dot[r.level]} | ${r.label}${r.stages > 1 ? `（${r.stages} 段）` : ""} | ${r.fps ?? "—"} | ${pc(r.dropShare)} | ${pc(r.badShare)} | ${r.fpsLow ?? "—"} | ${r.gpuPeakMb == null ? "—" : `${Math.round(r.gpuPeakMb)} MB`} |`));
  lines.push("");
  lines.push("掉幀：應該出現卻沒出現的幀（以螢幕更新率和遊戲幀率上限較低者為準）。");
  lines.push("");
}
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
(score.loading ? [["載入階段", score.loading]] : []).concat([["幀率穩定度", score.smooth], ["資源占用", score.memory]]).forEach(([g, part]) =>
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
