// In-page driver for the whole scenario in protocol/scenarios.md. Loaded after probe/install.js.
// The agent starts it, waits on short status replies, confirms the bet with the user, and saves
// the result to a file. Clicks are pointer and mouse events on the canvas at the node's position.
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
  function click(x, y) {
    var target = document.elementFromPoint(x, y) || (window.cc && cc.game && cc.game.canvas) || document.querySelector("canvas");
    if (!target) return false;
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
    return list.map(function (b, i) { return { b: b, r: rank(b), i: i }; })
      .sort(function (a, c) { return a.r - c.r || a.i - c.i; })
      .map(function (x) { return x.b; });
  }

  function spinButton() {
    var e = P.entry(CFG.entry);
    var ready = e.spin.filter(function (b) { return b.interactable && b.point; });
    return { ready: ready[0] || null, any: e.spin[0] || null, texts: (e.texts || []).join("|") };
  }

  async function entryLoop() {
    var E = CFG.entry || {};
    var deadline = now() + (E.maxSeconds || 90) * 1000;
    var prev = null;
    var same = 0;
    var splashMarked = false;
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
      if (!settled || !e.scene) {
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
        var r = await ask("screen", "loading looks done but nothing safe to press was found", { texts: e.texts });
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
    return { nodes: P.live(true).activeNodes, dom: document.getElementsByTagName("*").length, onScreen: onScreen };
  }
  function differs(a, b) {
    return Math.abs(a.nodes - b.nodes) > Math.max(5, b.nodes * 0.03) || Math.abs(a.dom - b.dom) > 3 || a.onScreen !== b.onScreen;
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

  function domClose() {
    var words = lower((CFG.buttons || {}).close).concat(["×", "✕", "x"]);
    var els = document.querySelectorAll("button, a, [role=button], [onclick], div, span, i, img");
    for (var i = els.length - 1; i >= 0; i -= 1) {
      var el = els[i];
      var text = ((el.innerText || el.textContent || "") + " " + (el.className && el.className.baseVal == null ? el.className : "") + " " + (el.getAttribute("aria-label") || "")).trim().toLowerCase();
      if (!text || text.length > 40) continue;
      if (!words.some(function (w) { return w.length > 1 ? text.indexOf(w) >= 0 : text === w; })) continue;
      var r = el.getBoundingClientRect();
      if (r.width && r.height) return { kind: "dom", name: el.tagName.toLowerCase(), text: text.slice(0, 16), interactable: true, point: { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) } };
    }
    return null;
  }

  // Open a panel, record spike then steady, close it. Returns false when the button is not found.
  // Several nodes can match the menu words (a Feature list named MenuButton, the real ≡ menu).
  // Try each, keep the one that shows the wanted button, close the others.
  async function openMenuFor(kind) {
    var B = CFG.buttons || {};
    var menus = find(B.menu, { interactable: true });
    if (st.menuKey) menus.sort(function (a, b) { return (key(b) === st.menuKey) - (key(a) === st.menuKey); });
    for (var i = 0; i < menus.length && i < 3; i += 1) {
      var before = new Set(P.buttons().buttons.map(key));
      var f0 = footprint();
      P.mark("menu");
      press(menus[i]);
      await waitChange(f0, 2000);
      await sleep(600);
      var t = find(B[kind], { interactable: true })[0];
      if (t) {
        st.menuKey = key(menus[i]);
        return { menu: menus[i], target: t };
      }
      await closeOpened(before, menus[i], f0);
    }
    return null;
  }

  async function panel(kind, stage, snapLabel) {
    var B = CFG.buttons || {};
    var openedMenu = null;
    var target = find(B[kind], { interactable: true })[0];
    if (!target) {
      var om = await openMenuFor(kind);
      if (om) {
        openedMenu = om.menu;
        target = om.target;
      }
    }
    if (!target) {
      st.coverage[stage] = "not found: " + (B[kind] || []).join("/");
      if (openedMenu) await closeOpened(new Set(), openedMenu);
      P.mark("gap");
      return false;
    }
    var before = new Set(P.buttons().buttons.map(key));
    var nodes = footprint();
    P.mark(stage + "-spike");
    press(target);
    var changed = await waitChange(nodes, 3000);
    // Buttons folded inside a closed menu still report active. Open the menu and try again.
    if (changed == null && !openedMenu) {
      var om2 = await openMenuFor(kind);
      if (om2) {
        openedMenu = om2.menu;
        target = om2.target;
        before = new Set(P.buttons().buttons.map(key));
        nodes = footprint();
        P.mark(stage + "-spike");
        press(target);
        changed = await waitChange(nodes, 3000);
      }
    }
    if (changed == null) {
      st.coverage[stage] = "pressed " + (target.text || target.name) + " but nothing opened";
      P.mark("gap");
      if (openedMenu) await closeOpened(new Set(), openedMenu, null);
      return false;
    }
    await sleep((CFG.panelSpikeSeconds || 2) * 1000);
    P.mark(stage);
    await sleep((CFG.panelSteadySeconds || 5) * 1000);
    if (snapLabel) st.snapshots.push(P.cocos(snapLabel));
    st.coverage[stage] = "ok via " + (target.text || target.name);
    P.mark("gap");
    var closed = await closeOpened(before, target, nodes);
    if (!closed) {
      var r = await ask("screen", "could not close the " + kind + " panel");
      if (r && r.click) click(r.click.x, r.click.y);
      await sleep(1000);
    }
    if (openedMenu && !spinButton().ready) await closeOpened(new Set(), openedMenu, null);
    return true;
  }

  async function closeOpened(before, opener, footBefore) {
    var B = CFG.buttons || {};
    for (var attempt = 0; attempt < 3; attempt += 1) {
      var fresh = P.buttons(B.close).buttons.filter(function (b) { return b.interactable && b.point && !before.has(key(b)); });
      var pick = fresh[0] || domClose() || (attempt === 2 ? opener : null);
      if (!pick) pick = P.buttons(B.close).buttons.filter(function (b) { return b.interactable && b.point; })[0];
      if (!pick) break;
      press(pick);
      await sleep(900);
      if (footBefore == null) return true;
      if (!differs(footprint(), footBefore)) return true;
      // Closing can also fold the menu, so the page will not match the pre-open state. The close
      // button going away is enough.
      var k = key(pick);
      if (pick.kind !== "dom" && !P.buttons(B.close).buttons.some(function (b) { return b.point && key(b) === k; })) return true;
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
    var b = spinButton();
    while (!b.ready && now() < wait) {
      await nudge();
      await sleep(500);
      b = spinButton();
    }
    if (!b.ready) {
      var r = await ask("screen", "spin button is not ready before " + name);
      if (r && r.click) click(r.click.x, r.click.y);
      await sleep(1000);
      b = spinButton();
      if (!b.ready) return false;
    }
    P.mark(name);
    var t0 = now();
    press(b.ready);
    var sawBusy = false;
    var stable = 0;
    var nudged = false;
    var lastTexts = "";
    var lastChange = now();
    while (true) {
      await sleep(S.pollMs || 250);
      var el = now() - t0;
      var sb = spinButton();
      if (sb.texts !== lastTexts) {
        lastTexts = sb.texts;
        lastChange = now();
      }
      var draws = P.live().draws;
      if (!sb.ready) sawBusy = true;
      var drawsBack = st.idleDraws == null || draws == null || Math.abs(draws - st.idleDraws) <= Math.max(3, st.idleDraws * 0.15);
      stable = sb.ready && (sawBusy || drawsBack) ? stable + 1 : 0;
      if (el >= (S.minMs || 1500) && stable >= (S.stablePolls || 3)) break;
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
    var ch = P.summary().channels;
    st.channels = { frameLoop: ch.frameLoop, engineCpu: ch.engineCpu, gpuMemory: ch.gpuMemory, gpuTimer: ch.gpuTimer };
    if (!ch.engineCpu) st.coverage.cpu = "frameLoop " + ch.frameLoop + ": per-frame CPU unavailable";
    P.mark("gap");

    st.phase = "panels";
    await panel("history", "history-before", null);
    await panel("rules", "rules", "rules");
    await idle("idle-after-rules", 4, null);
    P.mark("gap");

    st.phase = "confirm-bet";
    st.plan = CFG.maxSpins || 30;
    var go = await ask("bet", "show the bet to the user and call auto.go() after they confirm", { bet: betCandidates() });
    if (go && go.spins != null) st.plan = Math.min(go.spins, CFG.maxSpins || 30);

    st.phase = "spins";
    var normal = Math.min(st.plan, CFG.normalSpins || 24);
    for (var i = 1; i <= normal; i += 1) {
      if (!(await oneSpin("spin-" + i))) break;
    }
    var rest = st.plan - st.spins;
    if (rest > 0) {
      var turbo = find((CFG.buttons || {}).turbo, { interactable: true })[0];
      if (turbo) {
        press(turbo);
        await sleep(600);
        st.coverage.turbo = "ok via " + (turbo.text || turbo.name);
      } else st.coverage.turbo = "not found, normal spins instead";
      for (var j = 1; j <= rest; j += 1) {
        if (!(await oneSpin((turbo ? "turbo-" : "spin-") + (turbo ? j : normal + j)))) break;
      }
      if (turbo) {
        press(turbo);
        await sleep(600);
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
    if (st.needs === "bet") out.bet = st.bet;
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
    // After the user confirms the bet. spins defaults to maxSpins.
    go: function (spins) { return resume({ spins: spins == null ? null : spins }); },
    click: function (x, y, text) { return resume({ click: { x: x, y: y }, text: text }); },
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
