// In-page driver for the whole scenario in protocol/scenarios.md. Loaded after probe/install.js.
// The agent starts it, waits on short status replies, and saves the result to a file. Where to
// press comes from the agent's screenshots (auto.map, auto.click); node names only suggest
// candidates and block buy, bet and similar controls. Clicks are pointer and mouse events.
(function () {
  "use strict";
  if (!window.__slotPerf || window.__slotPerf.auto) return;
  var P = window.__slotPerf;
  var CFG = window.__slotPerfThresholds || {};

  var st = {
    phase: "ready",
    needs: null,
    note: null,
    spins: 0,
    plan: 0,
    bet: null,
    log: [],
    coverage: {},
    snapshots: [],
    entry: { result: null, steps: [] },
    idleDraws: null,
    map: null,
    close: {},
    menuAsked: false,
    clearRef: null,
    coverBase: null,
    spinTimes: [],
    longAsks: 0,
    resume: null,
    started: 0
  };

  function sleep(ms) {
    return new Promise(function (r) { setTimeout(r, ms); });
  }
  function now() {
    return Math.round(performance.now());
  }
  function log(text) {
    if (st.log.length < 120) st.log.push([now(), String(text).slice(0, 120)]);
  }
  function lower(xs) {
    return (xs || []).map(function (x) { return String(x).toLowerCase(); });
  }
  function hit(b, words) {
    var hay = (b.name + " " + b.text).toLowerCase();
    return lower(words).some(function (w) { return hay.indexOf(w) >= 0; });
  }
  function key(b) {
    return b.kind + ":" + b.name + ":" + b.text;
  }

  // One input family per press. Some games listen to both pointer and mouse events, and a toggle
  // such as a menu then opens and closes in the same press.
  // The element at x, y, entering same-origin iframes: HTML panels such as a bet record often live in one.
  function deepAt(x, y) {
    var doc = document;
    var el = doc.elementFromPoint(x, y);
    for (var depth = 0; el && el.tagName === "IFRAME" && depth < 3; depth += 1) {
      var inner;
      try { inner = el.contentDocument; } catch (e) { inner = null; }
      if (!inner) break;
      var r = el.getBoundingClientRect();
      x -= r.left;
      y -= r.top;
      doc = inner;
      var next = inner.elementFromPoint(x, y);
      if (!next) break;
      el = next;
    }
    return el ? { el: el, x: x, y: y } : null;
  }
  function click(x, y) {
    var hit = deepAt(x, y);
    var target = (hit && hit.el) || (window.cc && cc.game && cc.game.canvas) || document.querySelector("canvas");
    if (!target) return false;
    if (hit && hit.el.ownerDocument !== document) {
      x = hit.x;
      y = hit.y;
    }
    var o = { bubbles: true, cancelable: true, clientX: x, clientY: y, screenX: x, screenY: y, button: 0 };
    if (target.tagName !== "CANVAS") {
      var po = Object.assign({ pointerId: 1, pointerType: "mouse", isPrimary: true }, o);
      target.dispatchEvent(new PointerEvent("pointerdown", Object.assign({ buttons: 1 }, po)));
      target.dispatchEvent(new PointerEvent("pointerup", Object.assign({ buttons: 0 }, po)));
      target.dispatchEvent(new MouseEvent("click", o));
      return true;
    }
    var caps = (window.cc && cc.sys && cc.sys.capabilities) || {};
    if (caps.touches && !caps.mouse && typeof Touch === "function") {
      var t = new Touch({ identifier: 1, target: target, clientX: x, clientY: y, pageX: x, pageY: y, screenX: x, screenY: y });
      target.dispatchEvent(new TouchEvent("touchstart", { bubbles: true, cancelable: true, touches: [t], targetTouches: [t], changedTouches: [t] }));
      target.dispatchEvent(new TouchEvent("touchend", { bubbles: true, cancelable: true, touches: [], targetTouches: [], changedTouches: [t] }));
      return true;
    }
    target.dispatchEvent(new MouseEvent("mousedown", Object.assign({ buttons: 1 }, o)));
    target.dispatchEvent(new MouseEvent("mouseup", Object.assign({ buttons: 0 }, o)));
    return true;
  }
  function press(b) {
    if (!b || !b.point) return false;
    log("press " + b.kind + " " + (b.text || b.name));
    return click(b.point.x, b.point.y);
  }
  function canvasCenter() {
    var c = (window.cc && cc.game && cc.game.canvas) || document.querySelector("canvas");
    var r = c.getBoundingClientRect();
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
  }

  // The agent's screenshot shows the top page. Inside an iframe, its points are offset by where
  // the frame sits.
  function frameOffset() {
    var o = { x: 0, y: 0 };
    try {
      for (var w = window; w.frameElement; w = w.parent) {
        var r = w.frameElement.getBoundingClientRect();
        o.x += r.left;
        o.y += r.top;
      }
    } catch (e) {}
    return o;
  }
  function toLocal(p) {
    if (!p || p.x == null || p.y == null) return null;
    var o = frameOffset();
    return { x: Math.round(p.x - o.x), y: Math.round(p.y - o.y) };
  }
  function toTop(p) {
    if (!p) return null;
    var o = frameOffset();
    return { x: Math.round(p.x + o.x), y: Math.round(p.y + o.y) };
  }
  // The Cocos button whose center is nearest p, within a finger's reach.
  function nodeNear(p) {
    if (!p) return null;
    var best = null;
    var bestD = 40;
    P.buttons().buttons.forEach(function (b) {
      if (!b.point) return;
      var d = Math.sqrt(Math.pow(b.point.x - p.x, 2) + Math.pow(b.point.y - p.y, 2));
      if (d < bestD) {
        bestD = d;
        best = b;
      }
    });
    return best;
  }
  // The one name rule left: never press a buy, bet, copy or similar control, even at the
  // agent's point. Long texts are paragraphs, not labels, and are not checked.
  function unsafeAt(p) {
    if (!p) return null;
    var words = lower(CFG.neverPress);
    var b = nodeNear(p);
    if (b) {
      var hay = (b.name + " " + (b.text.length <= 30 ? b.text : "")).toLowerCase();
      if (words.some(function (w) { return hay.indexOf(w) >= 0; })) return b.name || b.text;
    }
    var h = deepAt(p.x, p.y);
    var t = h && h.el && h.el.tagName !== "CANVAS" ? ((h.el.innerText || h.el.textContent || "") + " " + (h.el.id || "")).trim().toLowerCase() : "";
    if (t && t.length <= 30 && words.some(function (w) { return t.indexOf(w) >= 0; })) return t;
    return null;
  }
  function pressAt(p, label) {
    var bad = unsafeAt(p);
    if (bad) {
      log("refused " + label + " at " + p.x + "," + p.y + ": " + bad);
      return false;
    }
    log("press " + label + " @" + p.x + "," + p.y);
    return click(p.x, p.y);
  }

  // Stop and wait for the agent. resolve() is called by auto.resume().
  function ask(needs, note, extra) {
    st.needs = needs;
    st.note = note;
    if (extra) Object.keys(extra).forEach(function (k) { st[k] = extra[k]; });
    log("needs " + needs + ": " + note);
    return new Promise(function (resolve) { st.resume = resolve; });
  }

  // Earlier words in the list are stronger, so "help" beats an extra-bet "info" tooltip.
  function find(words, opts) {
    var list = P.buttons(words).buttons;
    if (opts && opts.interactable) list = list.filter(function (b) { return b.interactable && b.point; });
    var w = lower(words);
    var rank = function (b) {
      var hay = (b.name + " " + b.text).toLowerCase();
      for (var i = 0; i < w.length; i += 1) if (hay.indexOf(w[i]) >= 0) return i;
      return w.length;
    };
    // Same word: the node with less text wins. A container's text joins its children's, so a whole
    // menu row would otherwise beat the one item in it.
    return list.map(function (b, i) { return { b: b, r: rank(b), n: (b.name + " " + b.text).length, i: i }; })
      .sort(function (a, c) { return a.r - c.r || a.n - c.n || a.i - c.i; })
      .map(function (x) { return x.b; });
  }

  // The spin button by name, only as a guess for the agent. A plain "spin" name goes first.
  function spinGuess() {
    var plain = function (b) { return /^(btn[_-]?)?spin([_-]?(btn|button))?$/i.test(b.name) ? 0 : 1; };
    return P.entry(CFG.entry).spin.filter(function (b) { return b.interactable && b.point; })
      .sort(function (a, c) { return plain(a) - plain(c); })[0] || null;
  }
  // The agent's spin point, and the node there when the engine can name one, for readiness.
  function spinState() {
    var p = st.map && st.map.spin;
    var b = nodeNear(p);
    return { point: p, ready: b ? b.interactable !== false : true, texts: (P.entry(CFG.entry).texts || []).join("|") };
  }

  async function entryLoop() {
    var E = CFG.entry || {};
    var deadline = now() + (E.maxSeconds || 90) * 1000;
    var prev = null;
    var same = 0;
    var splashMarked = false;
    var progressSince = 0;
    while (now() < deadline) {
      var e = P.entry(E);
      if (e.spinReady) {
        st.entry.result = st.entry.steps.length ? "pressed" : "direct";
        P.mark("game-ready");
        log("game-ready");
        return true;
      }
      var sig = JSON.stringify([e.start.map(key), e.dismiss.map(key), e.dom.map(key), e.tapAnywhere]);
      same = sig === prev ? same + 1 : 0;
      prev = sig;
      var settled = e.quietMs >= (E.quietMs || 1500) && same + 1 >= (E.stablePolls || 2);
      // A "45 %" label means a progress bar is still on screen, even when its text stopped updating.
      // Wait on it for at most 30 s, in case the label outlives the loading screen.
      var progress = (e.texts || []).some(function (t) { return /^\s*\d{1,3}\s*%\s*$/.test(t); });
      if (progress && !progressSince) progressSince = now();
      if (!progress) progressSince = 0;
      var loadingBar = progress && now() - progressSince < 30000;
      if (!settled || !e.scene || loadingBar) {
        await sleep(1000);
        continue;
      }
      var pick = e.start.filter(function (b) { return b.interactable && b.point; })[0];
      var kind = pick && pick.kind;
      if (!pick) pick = e.dismiss.filter(function (b) { return b.interactable && b.point; })[0];
      if (!pick) pick = e.dom.filter(function (b) { return b.interactable && b.point; })[0];
      if (!pick && e.tapAnywhere.length) pick = { kind: "tap-anywhere", name: "", text: e.tapAnywhere[0], point: canvasCenter() };
      if (!pick) {
        if (st.entry.steps.length >= (E.maxSteps || 5)) break;
        // Nothing the engine can name. The agent looks at a screenshot and calls auto.click(x, y).
        var r = await ask("screen", "loading looks done but nothing safe to press was found: auto.click(x, y) on what leads into the game, or auto.ready() if the game with its spin button is up", { texts: e.texts });
        if (r && r.ready) {
          st.entry.result = st.entry.steps.length ? "pressed" : "direct";
          P.mark("game-ready");
          log("game-ready (agent)");
          return true;
        }
        if (r && r.click) {
          if (!splashMarked) { P.mark("splash"); splashMarked = true; }
          P.mark("enter");
          st.entry.steps.push({ kind: "screenshot", text: r.text || "", afterMs: now() });
          click(r.click.x, r.click.y);
        }
        prev = null;
        await sleep(1500);
        continue;
      }
      if (st.entry.steps.length >= (E.maxSteps || 5)) break;
      if (!splashMarked) { P.mark("splash"); splashMarked = true; }
      P.mark("enter");
      st.entry.steps.push({ kind: pick.kind || kind, text: pick.text || pick.name, afterMs: now() });
      press(pick);
      prev = null;
      await sleep(1500);
    }
    st.entry.result = "stuck";
    return false;
  }

  async function idle(name, seconds, snapLabel) {
    P.mark(name);
    var draws = [];
    var end = now() + seconds * 1000;
    while (now() < end) {
      await sleep(250);
      var d = P.live().draws;
      if (d != null) draws.push(d);
    }
    if (name === "idle" && draws.length) {
      draws.sort(function (a, b) { return a - b; });
      st.idleDraws = draws[Math.floor(draws.length / 2)];
    }
    if (snapLabel) st.snapshots.push(P.cocos(snapLabel));
  }

  // Scene size plus DOM size, so panels drawn as HTML overlays or iframes also count.
  // onScreen counts pressable buttons inside the game area, which catches menus that slide in.
  function footprint() {
    var onScreen = P.buttons().buttons.filter(function (b) { return b.point; }).length;
    return { nodes: P.live(true).activeNodes, dom: document.getElementsByTagName("*").length, onScreen: onScreen, cover: cover() };
  }
  // What sits on top of the canvas center. An HTML panel that was already in the page and only
  // toggles a class adds no elements, but it covers the canvas.
  function cover() {
    try {
      var c = canvasCenter();
      var hit = deepAt(c.x, c.y);
      var el = hit && hit.el;
      var cv = (window.cc && cc.game && cc.game.canvas) || document.querySelector("canvas");
      if (!el || el === cv || (cv && cv.parentElement && cv.parentElement.contains(el))) return "";
      return el.tagName + "#" + el.id + "." + (el.className && el.className.baseVal == null ? el.className : "");
    } catch (e) { return ""; }
  }
  // Compared with what covered the canvas while idle, so a page that always has a layer there is fine.
  function covered() {
    return cover() !== (st.coverBase || "");
  }
  function differs(a, b) {
    return Math.abs(a.nodes - b.nodes) > Math.max(5, b.nodes * 0.03) || Math.abs(a.dom - b.dom) > 3 || a.onScreen !== b.onScreen || a.cover !== b.cover;
  }
  async function waitChange(before, ms) {
    var end = now() + ms;
    while (now() < end) {
      await sleep(200);
      var f = footprint();
      if (differs(f, before)) return f;
    }
    return null;
  }

  function isBack(fp, refs) {
    return refs.some(function (r) { return r && !differs(fp, r); });
  }
  async function waitBack(refs, ms) {
    var end = now() + ms;
    while (now() < end) {
      await sleep(200);
      if (isBack(footprint(), refs)) return true;
    }
    return false;
  }

  // Open the menu at the agent's point. The first time, ask what is inside it.
  async function openMenu(pre) {
    var m = st.map;
    P.mark("menu");
    pressAt(m.menu, "menu");
    await waitChange(pre, 2000);
    await sleep(600);
    if (st.menuAsked) return;
    st.menuAsked = true;
    var r = await ask("menu", "the menu should be open: screenshot it, then auto.map({history, rules, close}) with points inside it (close shuts the menu), null where absent");
    var mm = (r && r.map) || {};
    ["history", "rules"].forEach(function (k) {
      if (mm[k] && !m[k]) {
        m[k] = mm[k];
        m[k + "InMenu"] = true;
      }
    });
    if (mm.close) st.close.menu = mm.close;
  }

  // Close whatever is still over the game after a panel, usually the menu.
  async function clearScreen(pre) {
    if (await waitBack([pre, st.clearRef], 1200)) return;
    var p = st.close.menu;
    if (p) {
      pressAt(p, "menu close");
      if (await waitBack([pre, st.clearRef], 1500)) return;
    }
    var r = await ask("close", "something is still over the game (a menu?): screenshot, then auto.click(x, y) on what closes it, or auto.resume() if the game screen is clear");
    if (r && r.click) {
      st.close.menu = r.click;
      pressAt(r.click, "menu close");
      await sleep(900);
    }
    st.clearRef = footprint();
  }

  async function closePanel(kind, refs) {
    for (var attempt = 0; attempt < 3; attempt += 1) {
      var p = st.close[kind];
      var fromAgent = false;
      if (!p) {
        var r = await ask("close", "the " + kind + " panel is open: screenshot, then auto.click(x, y) on its close or back button");
        if (!r || !r.click) return false;
        p = r.click;
        fromAgent = true;
      }
      if (!pressAt(p, kind + " close")) {
        st.close[kind] = null;
        continue;
      }
      if (await waitBack(refs, 2000)) {
        st.close[kind] = p;
        return true;
      }
      // The agent saw the screen. Trust its point even when the page does not match the state
      // before the panel exactly.
      if (fromAgent) {
        st.close[kind] = p;
        return true;
      }
      st.close[kind] = null;
    }
    return false;
  }

  // Open a panel at the agent's point, record spike then steady, close it. The stage marks match
  // scenarios.md, so the report reads them unchanged.
  async function panel(kind, stage, snapLabel) {
    var m = st.map || {};
    var pre = footprint();
    var viaMenu = false;
    if ((!m[kind] || m[kind + "InMenu"]) && m.menu) {
      await openMenu(pre);
      viaMenu = true;
    }
    var target = m[kind];
    if (!target) {
      st.coverage[stage] = "not on screen";
      if (viaMenu) await clearScreen(pre);
      P.mark("gap");
      return false;
    }
    var nodes = footprint();
    P.mark(stage + "-spike");
    pressAt(target, kind);
    var changed = await waitChange(nodes, 3000);
    if (changed == null) {
      var seen = await ask("screen", "pressed " + kind + " but saw no change: screenshot, then auto.opened() if the panel is up, otherwise auto.resume()");
      if (seen && seen.opened) changed = footprint();
    }
    if (changed == null) {
      st.coverage[stage] = "pressed " + kind + " but nothing opened";
      P.mark("gap");
      await clearScreen(pre);
      return false;
    }
    await sleep((CFG.panelSpikeSeconds || 2) * 1000);
    P.mark(stage);
    await sleep((CFG.panelSteadySeconds || 5) * 1000);
    if (snapLabel) st.snapshots.push(P.cocos(snapLabel));
    st.coverage[stage] = "ok";
    // Ask for the close point only after the steady stage, so thinking time is not measured.
    P.mark("gap");
    if (!(await closePanel(kind, [nodes, pre]))) {
      var r = await ask("screen", "could not close the " + kind + " panel: auto.click(x, y) on its close, or auto.resume() if it is closed");
      if (r && r.click) pressAt(r.click, kind + " close");
      await sleep(1000);
    }
    await clearScreen(pre);
    return true;
  }

  // Where to press, from one screenshot. This stop is also the bet check before any spin.
  async function mapStop() {
    var B = CFG.buttons || {};
    var guess = function (b) { return b && b.point ? { name: b.name, text: (b.text || "").slice(0, 20), point: toTop(b.point) } : null; };
    var guesses = {
      spin: guess(spinGuess()),
      menu: guess(find(B.menu, { interactable: true })[0]),
      history: guess(find(B.history, { interactable: true })[0]),
      rules: guess(find(B.rules, { interactable: true })[0]),
      turbo: guess(find(B.turbo, { interactable: true })[0])
    };
    var note = "screenshot the game, show the user the bet and wait for their go, then auto.map({spin, menu, history, rules, turbo}) with screenshot points (null where absent). guess is what node names suggest";
    for (var tries = 0; tries < 4; tries += 1) {
      var r = await ask("map", note, { bet: betCandidates(), guess: guesses });
      var m = (r && r.map) || {};
      if (!m.spin) {
        note = "the spin point is required. " + note;
        continue;
      }
      var bad = ["spin", "menu", "history", "rules", "turbo"].filter(function (k) { return m[k] && unsafeAt(m[k]); });
      if (bad.length) {
        note = "refused " + bad.join(", ") + ": the node there looks like buy, bet or copy. " + note;
        log("map refused " + bad.join(","));
        continue;
      }
      st.map = m;
      if (r.spins != null) st.plan = Math.min(r.spins, CFG.maxSpins || 30);
      log("map " + JSON.stringify(m).slice(0, 100));
      return true;
    }
    return false;
  }

  function betCandidates() {
    var words = lower((CFG.buttons || {}).bet);
    var out = [];
    var cc = window.cc;
    var scene = cc && cc.director && cc.director.getScene();
    if (!scene) return out;
    var stack = [[scene, ""]];
    while (stack.length && out.length < 6) {
      var top = stack.pop();
      var node = top[0];
      if (node.activeInHierarchy === false) continue;
      var path = (top[1] + "/" + (node.name || "")).toLowerCase();
      var comps = node._components || node.components || [];
      for (var i = 0; i < comps.length; i += 1) {
        var s = comps[i] && comps[i].string;
        if (typeof s === "string" && /\d/.test(s) && words.some(function (w) { return path.slice(-80).indexOf(w) >= 0; })) out.push({ node: path.slice(-60), text: s.trim().slice(0, 24) });
      }
      var kids = node.children || node._children || [];
      for (var k = 0; k < kids.length; k += 1) stack.push([kids[k], path]);
    }
    return out;
  }

  async function oneSpin(name) {
    var S = CFG.settle || {};
    var wait = now() + 30000;
    var b = spinState();
    while (!b.ready && now() < wait) {
      await nudge();
      await sleep(500);
      b = spinState();
    }
    if (!b.ready || covered()) {
      var r = await ask("screen", (b.ready ? "something covers the game before " : "spin button is not ready before ") + name);
      if (r && r.click) click(r.click.x, r.click.y);
      await sleep(1000);
      b = spinState();
      if (!b.ready) return false;
    }
    // A spin far longer than the others is a feature, a big win, or the wrong screen. Look once.
    var times = st.spinTimes.slice().sort(function (x, y) { return x - y; });
    var median = times.length ? times[Math.floor(times.length / 2)] : 0;
    var longMs = Math.max(S.nudgeAfterMs || 30000, median * (((CFG.heap || {}).featureFactor) || 5));
    if (!times.length) longMs = Math.min(longMs, 15000);
    var asked = false;
    P.mark(name);
    var t0 = now();
    log("press spin");
    click(b.point.x, b.point.y);
    var sawBusy = false;
    var stable = 0;
    var nudged = false;
    var lastTexts = "";
    var lastChange = now();
    var lastDraws = null;
    var lastDrawChange = now();
    while (true) {
      await sleep(S.pollMs || 250);
      var el = now() - t0;
      var sb = spinState();
      if (sb.texts !== lastTexts) {
        lastTexts = sb.texts;
        lastChange = now();
      }
      var draws = P.live().draws;
      if (draws !== lastDraws) {
        lastDraws = draws;
        lastDrawChange = now();
      }
      if (!sb.ready) sawBusy = true;
      var drawsBack = st.idleDraws == null || draws == null || Math.abs(draws - st.idleDraws) <= Math.max(3, st.idleDraws * 0.15);
      // Some spin buttons never disable and the idle glow changes the draw count. Then a screen
      // whose texts and draw calls have both held still for a few seconds has settled.
      var quiet = now() - lastChange > (S.quietMs || 4000) && now() - lastDrawChange > (S.quietMs || 4000);
      stable = sb.ready && (sawBusy || drawsBack || quiet) ? stable + 1 : 0;
      if (el >= (S.minMs || 1500) && stable >= (S.stablePolls || 3)) break;
      if (el > longMs && !asked && st.longAsks < 4) {
        asked = true;
        st.longAsks += 1;
        var lr = await ask("screen", name + " has run " + Math.round(el / 1000) + "s: if a free game or win is playing call auto.resume(), if this is the wrong screen close it with auto.click()");
        if (lr && lr.click) click(lr.click.x, lr.click.y);
      }
      if (el > (S.nudgeAfterMs || 30000) && !nudged) {
        nudged = true;
        await nudge();
      }
      // Free games keep changing the screen; only ask once it has been still for a while.
      var still = now() - lastChange > (S.stillMs || 15000);
      if (el > (S.maxMs || 120000) && (still || el > (S.hardMaxMs || 600000))) {
        var rr = await ask("screen", name + " did not settle");
        if (rr && rr.click) click(rr.click.x, rr.click.y);
        break;
      }
    }
    var took = now() - t0;
    st.spinTimes.push(took);
    P.mark("gap");
    if (took > 12000) log(name + " long " + took + "ms (feature or big win?)");
    st.spins += 1;
    await sleep(300);
    return true;
  }

  // Close a big-win popup or a notice that blocks the spin button. Never presses avoid words.
  async function nudge() {
    var e = P.entry(CFG.entry);
    var pick = e.dismiss.filter(function (b) { return b.interactable && b.point; })[0];
    if (pick) {
      press(pick);
      await sleep(800);
    }
  }

  async function run() {
    st.started = now();
    st.phase = "entry";
    if (!(await entryLoop())) {
      st.phase = "stuck";
      await ask("screen", "could not reach the spin button", { texts: P.entry(CFG.entry).texts });
      st.phase = "done";
      return;
    }
    st.phase = "idle";
    await sleep(500);
    await idle("idle", CFG.idleSeconds || 8, "idle");
    st.coverBase = cover();
    var ch = P.summary().channels;
    st.channels = { frameLoop: ch.frameLoop, engineCpu: ch.engineCpu, gpuMemory: ch.gpuMemory, gpuTimer: ch.gpuTimer };
    if (!ch.engineCpu) st.coverage.cpu = "frameLoop " + ch.frameLoop + ": per-frame CPU unavailable";
    P.mark("gap");

    st.phase = "map";
    st.plan = CFG.maxSpins || 30;
    if (!(await mapStop())) {
      st.phase = "stuck";
      await ask("screen", "no usable spin point from the agent");
      st.phase = "done";
      return;
    }

    st.phase = "panels";
    await panel("history", "history-before", null);
    await panel("rules", "rules", "rules");
    await idle("idle-after-rules", 4, null);
    P.mark("gap");

    st.phase = "spins";
    var normal = Math.min(st.plan, CFG.normalSpins || 24);
    for (var i = 1; i <= normal; i += 1) {
      if (!(await oneSpin("spin-" + i))) break;
    }
    var rest = st.plan - st.spins;
    if (rest > 0) {
      var turbo = st.map.turbo;
      if (turbo && pressAt(turbo, "turbo")) {
        await sleep(600);
        st.coverage.turbo = "ok";
      } else {
        turbo = null;
        st.coverage.turbo = "not on screen, normal spins instead";
      }
      for (var j = 1; j <= rest; j += 1) {
        if (!(await oneSpin((turbo ? "turbo-" : "spin-") + (turbo ? j : normal + j)))) break;
      }
      // Some toggles cycle through several speeds, so one more press may not turn it off.
      if (turbo) {
        pressAt(turbo, "turbo");
        await sleep(800);
        for (var k = 0; k < 3; k += 1) {
          var tr = await ask("screen", "turbo was pressed again to turn it off: screenshot, auto.click(x, y) on it if it is still on, otherwise auto.resume()");
          if (!tr || !tr.click) break;
          pressAt(tr.click, "turbo");
          await sleep(800);
        }
      }
    }

    st.phase = "history-after";
    await panel("history", "history-after", "history-after");
    await idle("idle-end", 5, "idle-end");
    P.mark("gap");
    st.phase = "done";
    log("done");
  }

  function status() {
    var live = P.live();
    var out = { phase: st.phase, needs: st.needs, note: st.note, spins: st.spins, plan: st.plan, t: Math.round((now() - st.started) / 1000), stage: live.stage, fps: live.fps, gpuMb: live.gpuMb, heapMb: live.heapMb };
    if (st.needs === "map") {
      out.bet = st.bet;
      out.guess = st.guess;
    }
    if (st.needs === "screen" && st.texts) out.texts = st.texts.slice(0, 12);
    if (st.channels && st.phase !== "spins") out.channels = st.channels;
    return out;
  }

  P.auto = {
    start: function () {
      if (st.phase === "ready") run().catch(function (e) { st.phase = "error"; st.note = String(e && e.message || e); st.needs = "error"; });
      return status();
    },
    // Resolves as soon as the driver needs the agent, finishes, or ms passes. Keep ms under the tool timeout.
    wait: async function (ms) {
      var end = now() + (ms || 60000);
      while (now() < end && !st.needs && st.phase !== "done" && st.phase !== "error") await sleep(500);
      return status();
    },
    status: status,
    // Points read off the agent's screenshot of the top page: { spin, menu, history, rules, turbo,
    // close } as { x, y } or null. At the map stop it is also the user's go for the bet; spins
    // defaults to maxSpins.
    map: function (m, spins) {
      var out = {};
      Object.keys(m || {}).forEach(function (k) { out[k] = toLocal(m[k]); });
      return resume({ map: out, spins: spins == null ? null : spins });
    },
    // The panel the driver could not see is open.
    opened: function () { return resume({ opened: true }); },
    // The game screen is up although no spin button could be named.
    ready: function () { return resume({ ready: true }); },
    click: function (x, y, text) { return resume({ click: toLocal({ x: x, y: y }), text: text }); },
    resume: function () { return resume({}); },
    result: function () {
      return { autopilot: 1, summary: P.summary(), cocos: { snapshots: st.snapshots }, entry: st.entry, coverage: st.coverage, bet: st.bet, log: st.log };
    }
  };

  function resume(v) {
    var r = st.resume;
    st.resume = null;
    st.needs = null;
    st.note = null;
    if (r) r(v);
    return status();
  }
})();
