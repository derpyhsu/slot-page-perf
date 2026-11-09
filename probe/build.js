#!/usr/bin/env node
// Usage: node probe/build.js
// Bundles thresholds + probe + autopilot into probe/dist/. The agent never pastes the probe:
//   1. navigate_page to the game's origin (any page there, e.g. "/").
//   2. evaluate_script with sourcePath = probe/dist/stash.js. It saves the bundle in sessionStorage.
//   3. navigate_page to the game URL with initScript = the LOADER printed below.
// If the game redirects to another origin, sessionStorage is empty there; fall back to
// initScript = the contents of probe/dist/bundle.js.
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");

const root = path.join(__dirname, "..");
const read = (p) => fs.readFileSync(path.join(root, p), "utf8");
const thresholds = JSON.parse(read("protocol/thresholds.json"));
const bundle = [
  `window.__slotPerfThresholds = ${JSON.stringify(thresholds)};`,
  read("probe/install.js"),
  read("probe/autopilot.js"),
].join("\n");

const KEY = "__slotPerfSrc";
const LOADER = `(function(){try{var s=sessionStorage.getItem("${KEY}");if(s)(0,eval)(s)}catch(e){}})()`;
const stash = `() => { sessionStorage.setItem(${JSON.stringify(KEY)}, ${JSON.stringify(bundle)}); return location.origin + " " + sessionStorage.getItem(${JSON.stringify(KEY)}).length; }\n`;
// chrome-devtools-mcp only reads and writes files inside its workspace roots. Clients that do
// not send roots get the OS temp directory, so write a copy there too.
const dirs = [path.join(__dirname, "dist"), path.join(os.tmpdir(), "slot-page-perf")];
dirs.forEach((dir) => {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "bundle.js"), bundle);
  fs.writeFileSync(path.join(dir, "stash.js"), stash);
  fs.writeFileSync(path.join(dir, "loader.txt"), LOADER + "\n");
});
console.log(`stash   ${path.join(dirs[0], "stash.js")}`);
console.log(`        ${path.join(dirs[1], "stash.js")}  (use this one if the MCP says the path is outside its workspace roots)`);
console.log(`raw to  ${path.join(dirs[1], "<run>", "raw.json")}  when runs/ is outside the roots; then pass --raw to report/build.js`);
console.log(`loader  ${LOADER}`);
