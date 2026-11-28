#!/usr/bin/env node
// Usage: node tools/close-test-browser.js
// Closes the test Chrome that chrome-devtools MCP started (its --isolated profile lives in the temp
// directory as puppeteer_dev_chrome_profile-*, and its main process has --remote-debugging-pipe).
// It stops that browser and its child processes only. The user's own Chrome (default profile) is
// never matched. Run it after a measuring run, once the tabs it used are closed.
"use strict";

const { execFileSync } = require("child_process");

const PROFILE = /puppeteer_dev_chrome_profile/i;

function listWindows() {
  const ps = "Get-CimInstance Win32_Process -Filter \"Name='chrome.exe'\" | ForEach-Object { [PSCustomObject]@{ pid = $_.ProcessId; cmd = $_.CommandLine } } | ConvertTo-Json -Compress";
  const text = execFileSync("powershell.exe", ["-NoProfile", "-Command", ps], { encoding: "utf8" }).trim();
  if (!text) return [];
  const rows = JSON.parse(text);
  return (Array.isArray(rows) ? rows : [rows]).filter((r) => r && r.cmd);
}

function listPosix() {
  const text = execFileSync("ps", ["-eo", "pid=,args="], { encoding: "utf8" });
  return text.split("\n").map((l) => l.trim()).filter(Boolean).map((l) => {
    const i = l.indexOf(" ");
    return { pid: Number(l.slice(0, i)), cmd: l.slice(i + 1) };
  });
}

const isWin = process.platform === "win32";
const procs = isWin ? listWindows() : listPosix();
const mains = procs.filter((p) => PROFILE.test(p.cmd) && /--remote-debugging-pipe/.test(p.cmd) && !/--type=/.test(p.cmd));

if (mains.length === 0) {
  console.log("no test browser running");
  process.exit(0);
}

for (const m of mains) {
  try {
    if (isWin) execFileSync("taskkill", ["/T", "/F", "/PID", String(m.pid)], { stdio: "ignore" });
    else process.kill(m.pid, "SIGTERM");
    console.log(`closed test browser pid ${m.pid}`);
  } catch (e) {
    console.log(`could not close pid ${m.pid}: ${String(e && e.message || e).split("\n")[0]}`);
  }
}
