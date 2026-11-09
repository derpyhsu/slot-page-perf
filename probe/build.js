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
const dist = path.join(__dirname, "dist");
fs.mkdirSync(dist, { recursive: true });
fs.writeFileSync(path.join(dist, "bundle.js"), bundle);
fs.writeFileSync(path.join(dist, "stash.js"), `() => { sessionStorage.setItem(${JSON.stringify(KEY)}, ${JSON.stringify(bundle)}); return location.origin + " " + sessionStorage.getItem(${JSON.stringify(KEY)}).length; }\n`);
fs.writeFileSync(path.join(dist, "loader.txt"), LOADER + "\n");
console.log(`stash   ${path.join(dist, "stash.js")}`);
console.log(`loader  ${LOADER}`);
