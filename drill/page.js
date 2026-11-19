// Page-side drill tools for one Cocos game page. Load with evaluate_script sourcePath; it returns
// "drill ok" and leaves window.__slotDrill. It does not need the slot-page-perf probe and is not
// part of the probe bundle. Tools change the live page only while they measure and put every
// value back; game files are never touched. Output is counts, node paths and asset file names.
() => {
  "use strict";
  if (window.__slotDrill) return "drill ok (already loaded)";
  var cc = window.cc;
  if (!cc || !cc.director || !cc.director.getScene) return "drill: no Cocos engine on this page";
  var V3 = /^3\./.test(String(cc.ENGINE_VERSION || ""));

  // ---------- frames and draw calls ----------
  // 2.x keeps the last frame's count in cc.renderer.drawCalls, 3.x in root.device.numDrawCalls.
  // Without either, WebGL draw calls are counted between two EVENT_AFTER_DRAW.
  var gl = { n: 0, wrapped: false };
  function wrapGl() {
    if (gl.wrapped) return;
    gl.wrapped = true;
    [window.WebGLRenderingContext, window.WebGL2RenderingContext].forEach(function (C) {
      if (!C || !C.prototype) return;
      ["drawElements", "drawArrays", "drawElementsInstanced", "drawArraysInstanced"].forEach(function (m) {
        var orig = C.prototype[m];
        if (typeof orig !== "function" || orig.__drill) return;
        var w = function () { gl.n += 1; return orig.apply(this, arguments); };
        w.__drill = true;
        C.prototype[m] = w;
      });
    });
  }
  function counterName() {
    if (!V3 && cc.renderer && typeof cc.renderer.drawCalls === "number") return "cc.renderer.drawCalls";
    var dev = cc.director.root && cc.director.root.device;
    if (V3 && dev && typeof dev.numDrawCalls === "number") return "device.numDrawCalls";
    wrapGl();
    return "webgl";
  }
  var COUNTER = counterName();
  function readDraws() {
    if (COUNTER === "cc.renderer.drawCalls") return cc.renderer.drawCalls;
    if (COUNTER === "device.numDrawCalls") return cc.director.root.device.numDrawCalls;
    var n = gl.n;
    gl.n = 0;
    return n;
  }
  var AFTER_DRAW = (cc.Director && cc.Director.EVENT_AFTER_DRAW) || "director_after_draw";
  // Draw counts of the next n frames, after skipping `skip` frames so a change has been drawn.
  // Resolves early with what it has when timeoutMs passes (a hidden page draws about once a second).
  function sample(n, skip, timeoutMs) {
    return new Promise(function (resolve) {
      var out = [];
      var seen = 0;
      if (COUNTER === "webgl") gl.n = 0;
      var done = false;
      var finish = function () {
        if (done) return;
        done = true;
        cc.director.off(AFTER_DRAW, on);
        clearTimeout(timer);
        resolve(out);
      };
      var on = function () {
        seen += 1;
        var d = readDraws();
        if (seen > skip) out.push(d);
        if (out.length >= n) finish();
      };
      var timer = setTimeout(finish, timeoutMs || 4000);
      cc.director.on(AFTER_DRAW, on);
    });
  }
  function median(xs) {
    if (!xs.length) return null;
    var s = xs.slice().sort(function (a, b) { return a - b; });
    return s[Math.floor(s.length / 2)];
  }

  // ---------- nodes ----------
  function kids(n) { return (n && (n.children || n._children)) || []; }
  function parentOf(n) { return n && (n.parent || n._parent); }
  function nodePath(node) {
    var names = [];
    var n = node;
    while (n && names.length < 6) {
      if (!parentOf(n)) break;
      names.unshift(n.name);
      n = parentOf(n);
    }
    return names.join("/");
  }
  function fold(s) { return String(s).replace(/\d+/g, "*"); }
  function className(o) {
    try { return (cc.js && cc.js.getClassName(o)) || (o && o.constructor && o.constructor.name) || "?"; } catch (e) { return "?"; }
  }
  function isCamera(n) {
    var comps = n._components || n.components || [];
    return comps.some(function (c) { return /Camera/.test(className(c)); });
  }
  // Drawn at all: active, and in 2.x not at opacity 0 (RenderFlow skips that subtree).
  function shown(n) {
    if (!parentOf(n)) return true; // the scene itself; 2.x reports a scene as active = false
    if (n.activeInHierarchy === false || n.active === false) return false;
    if (!V3 && typeof n.opacity === "number" && n.opacity === 0) return false;
    return true;
  }
  // 2.x hides a subtree with opacity 0, which fires no lifecycle callbacks. 3.x still draws
  // opacity 0, so it uses active = false, which does run onDisable/onEnable.
  var METHOD = V3 ? "active" : "opacity";
  function hide(n, touched) {
    if (METHOD === "opacity") { touched.push({ node: n, key: "opacity", value: n.opacity }); n.opacity = 0; }
    else { touched.push({ node: n, key: "active", value: n.active }); n.active = false; }
  }
  function restore(list) {
    var contended = [];
    for (var i = list.length - 1; i >= 0; i -= 1) {
      var t = list[i];
      try {
        var now = t.node[t.key];
        var hidden = t.key === "opacity" ? 0 : false;
        if (now !== hidden) contended.push(nodePath(t.node));
        t.node[t.key] = t.value;
      } catch (e) { contended.push(nodePath(t.node)); }
    }
    var wrong = list.filter(function (t) { try { return t.node[t.key] !== t.value; } catch (e) { return true; } }).map(function (t) { return nodePath(t.node); });
    return { contended: contended, notRestored: wrong };
  }
  // Nearest prefab the node came from, when the build kept the link: a hint toward the source.
  function prefabOf(node) {
    var n = node;
    for (var d = 0; n && d < 12; d += 1) {
      var p = n._prefab;
      if (p) {
        var a = p.asset;
        var name = (a && (a._name || a.name)) || (p.root && p.root.name) || null;
        if (name) return String(name).slice(0, 60);
      }
      n = parentOf(n);
    }
    return null;
  }
  function visibleRect() {
    try {
      var s = cc.view.getVisibleSize();
      var o = cc.view.getVisibleOrigin ? cc.view.getVisibleOrigin() : { x: 0, y: 0 };
      return { x0: o.x, y0: o.y, x1: o.x + s.width, y1: o.y + s.height };
    } catch (e) { return null; }
  }
  // true: the subtree's world box misses the visible area. null: no usable box (Spine and empty
  // containers often report zero size), so nothing is claimed.
  function offscreen(nodes) {
    var r = visibleRect();
    if (!r) return null;
    var any = false;
    for (var i = 0; i < nodes.length; i += 1) {
      var b = null;
      try {
        if (nodes[i].getBoundingBoxToWorld) b = nodes[i].getBoundingBoxToWorld();
        else {
          var ut = nodes[i].getComponent && cc.UITransform && nodes[i].getComponent(cc.UITransform);
          if (ut) b = ut.getBoundingBoxToWorld();
        }
      } catch (e) { b = null; }
      if (!b || !(b.width > 0) || !(b.height > 0)) return null;
      any = true;
      if (b.x < r.x1 && b.x + b.width > r.x0 && b.y < r.y1 && b.y + b.height > r.y0) return false;
    }
    return any ? true : null;
  }
  // Children of a selection grouped by folded name, so 30 cards card_1..card_30 are one group
  // that is hidden and measured together.
  function childGroups(selection) {
    var groups = {};
    var order = [];
    selection.forEach(function (n) {
      kids(n).forEach(function (k) {
        if (!shown(k) || isCamera(k)) return;
        var key = fold(k.name || "?");
        if (!groups[key]) { groups[key] = []; order.push(key); }
        groups[key].push(k);
      });
    });
    return order.map(function (k) { return { name: k, nodes: groups[k] }; });
  }

  // ---------- batch breaks ----------
  // 2.4 RenderComponent._checkBacth flushes when the first material's getHash() or the node's
  // culling mask differs from the batch in progress. Mask, Graphics and Spine run their own
  // assemblers and are listed as their own kind. 3.x is approximated by material and texture.
  function texName(comp) {
    try {
      var mat = comp._materials && comp._materials[0];
      var tex = mat && mat.getProperty && mat.getProperty("texture");
      if (!tex && comp.spriteFrame) tex = comp.spriteFrame._texture || (comp.spriteFrame.getTexture && comp.spriteFrame.getTexture()) || comp.spriteFrame.texture;
      if (!tex) return null;
      var url = tex.nativeUrl || tex._nativeUrl || tex.url || "";
      if (typeof url === "string" && url && url.indexOf("data:") !== 0) return url.split("?")[0].split("#")[0].split("/").pop();
      return tex.name || tex._name || (tex._uuid ? "uuid:" + String(tex._uuid).slice(0, 8) : "(canvas)");
    } catch (e) { return null; }
  }
  function renderKey(comp, node) {
    try {
      if (!V3) {
        var mat = comp._materials && comp._materials[0];
        if (!mat) return null;
        return (mat.getHash ? mat.getHash() : String(mat._uuid || "")) + "|" + (node._cullingMask != null ? node._cullingMask : "");
      }
      var m3 = comp.getRenderMaterial ? comp.getRenderMaterial(0) : comp.customMaterial || comp.sharedMaterial;
      var id = m3 ? (m3.hash || m3._hash || (m3.effectName || "") + (m3._uuid || "")) : "";
      return id + "|" + (texName(comp) || "") + "|" + (node.layer != null ? node.layer : "");
    } catch (e) { return null; }
  }
  function kindOf(comp) {
    var n = className(comp);
    if (/Mask/.test(n)) return "mask";
    if (/Graphics/.test(n)) return "graphics";
    if (/sp\.Skeleton|Skeleton$/.test(n)) return comp.enableBatch ? "spine-batched" : "spine";
    if (/dragonBones/i.test(n)) return "dragonbones";
    if (/Label$/.test(n) && !/RichText/.test(n)) {
      var bm = !comp.useSystemFont && cc.BitmapFont && comp.font instanceof cc.BitmapFont;
      if (!bm && (comp.cacheMode || 0) === 0) return "label-own-texture";
      return "label";
    }
    return "sprite";
  }
  function renderComp(node) {
    if (!V3) return node._renderComponent || null;
    var ui = node._uiProps && node._uiProps.uiComp;
    return ui || null;
  }
  // Walks one subtree in draw order and lists every place a new batch starts, grouped by the
  // folded path pair and the reason.
  function batchBreaks(selection, limit) {
    var pairs = {};
    var batches = 0;
    var comps = 0;
    var prev = null;
    var visit = function (node) {
      if (!shown(node)) return;
      var c = renderComp(node);
      if (c && c.enabled !== false && (c.enabledInHierarchy !== false)) {
        comps += 1;
        var cur = { path: fold(nodePath(node)), kind: kindOf(c), key: renderKey(c, node), tex: texName(c) };
        var own = cur.kind === "mask" || cur.kind === "graphics" || cur.kind === "spine" || cur.kind === "dragonbones";
        var reason = null;
        if (!prev) reason = "start";
        else if (own || prev.own) reason = own ? cur.kind : prev.kind;
        else if (cur.key == null || cur.key !== prev.key) reason = cur.kind === "label-own-texture" ? "label-own-texture" : cur.tex !== prev.tex ? "texture" : "material";
        if (reason) {
          batches += 1;
          if (prev) {
            var k = prev.path + " → " + cur.path + " · " + reason;
            var p = pairs[k] || (pairs[k] = { from: prev.path, to: cur.path, reason: reason, n: 0, fromTex: prev.tex, toTex: cur.tex });
            p.n += 1;
          }
        }
        cur.own = own;
        prev = cur;
      }
      var ks = kids(node);
      for (var i = 0; i < ks.length; i += 1) visit(ks[i]);
      // A mask ends its stencil after its children, which starts a batch again.
      if (c && kindOf(c) === "mask" && shown(node)) prev = { path: fold(nodePath(node)) + "(end)", kind: "mask", own: true, key: null, tex: null };
    };
    selection.forEach(visit);
    var list = Object.keys(pairs).map(function (k) { return pairs[k]; }).sort(function (a, b) { return b.n - a.n; });
    return { renderers: comps, batches: batches, pairs: list.slice(0, limit || 8), pairKinds: list.length };
  }

  // ---------- drawcalls ----------
  async function drawcalls(opts) {
    opts = opts || {};
    var frames = opts.frames || 8;
    var depth = opts.depth || 4;
    var minShare = opts.minShare != null ? opts.minShare : 0.05;
    var budgetMs = opts.budgetMs || 90000;
    var maxGroups = opts.maxGroups || 40;
    var t0 = performance.now();
    var scene = cc.director.getScene();
    var start = [scene];
    if (opts.root) {
      var found = cc.find ? cc.find(opts.root) : null;
      if (!found) return { status: "root not found", root: opts.root };
      start = [found];
    }
    var base = median(await sample(frames, 1, 6000));
    if (base == null) return { status: "no frames drawn (page hidden or paused?)", counter: COUNTER };
    var touched = [];
    var levels = [];
    var selection = start;
    var selName = opts.root || "(scene)";
    var partial = null;
    var check = null;
    try {
      for (var d = 0; d < depth; d += 1) {
        var groups = childGroups(selection);
        if (groups.length > maxGroups) { partial = "level " + (d + 1) + " has " + groups.length + " groups; measured the first " + maxGroups; groups = groups.slice(0, maxGroups); }
        var rows = [];
        for (var g = 0; g < groups.length; g += 1) {
          if (performance.now() - t0 > budgetMs) { partial = "time budget reached"; break; }
          var ns = groups[g].nodes;
          // Read before hiding: the game may remove or rebuild the node while it is measured.
          var info = { path: fold(nodePath(ns[0])), children: ns.reduce(function (s, x) { return s + kids(x).length; }, 0), offscreen: offscreen(ns), prefab: prefabOf(ns[0]) || undefined };
          var mark = touched.length;
          ns.forEach(function (n) { hide(n, touched); });
          var hid = median(await sample(frames, 2, 6000));
          var back = touched.splice(mark);
          var r = restore(back);
          if (r.contended.length || r.notRestored.length) check = (check || []).concat(r.contended, r.notRestored);
          await sample(2, 0, 2000);
          rows.push({
            name: groups[g].name,
            path: info.path,
            n: ns.length,
            draws: hid == null ? null : base - hid,
            children: info.children,
            offscreen: info.offscreen,
            prefab: info.prefab,
            gone: ns.some(function (x) { return x.isValid === false || !parentOf(x); }) || undefined,
            _nodes: ns
          });
        }
        rows.sort(function (a, b) { return (b.draws || 0) - (a.draws || 0); });
        levels.push({ under: selName, groups: rows.length, rows: rows.slice(0, opts.top || 6).map(function (x) { var o = Object.assign({}, x); delete o._nodes; return o; }) });
        var best = rows[0];
        if (!best || best.draws == null || best.draws < Math.max(1, minShare * base) || !best.children || partial === "time budget reached") break;
        selection = best._nodes;
        selName = best.path + (best.n > 1 ? " ×" + best.n : "");
      }
    } finally {
      var left = restore(touched);
      if (left.contended.length || left.notRestored.length) check = (check || []).concat(left.contended, left.notRestored);
    }
    var after = median(await sample(frames, 1, 6000));
    var br = batchBreaks(selection, opts.pairs || 8);
    var out = {
      status: partial ? "partial" : "ok",
      note: partial || undefined,
      engine: String(cc.ENGINE_VERSION || ""),
      counter: COUNTER,
      method: METHOD,
      frames: frames,
      base: base,
      baseAfter: after,
      focus: selName,
      levels: levels,
      breaks: br,
      offscreenDrawn: [],
      restore: check ? { ok: false, nodes: check.slice(0, 10) } : { ok: true },
      ms: Math.round(performance.now() - t0)
    };
    levels.forEach(function (l) { l.rows.forEach(function (x) { if (x.offscreen === true && x.draws > 0) out.offscreenDrawn.push({ path: x.path, n: x.n, draws: x.draws }); }); });
    out.summary = summarize(out);
    api.last = out;
    return out;
  }

  // ---------- fps ----------
  // Frames drawn over ms and the median gap between them, from EVENT_AFTER_DRAW. For the
  // fill-rate check: read it, shrink the page, read it again, put the size back.
  function fps(ms) {
    ms = ms || 4000;
    return new Promise(function (resolve) {
      var ts = [];
      var on = function () { ts.push(performance.now()); };
      cc.director.on(AFTER_DRAW, on);
      setTimeout(function () {
        cc.director.off(AFTER_DRAW, on);
        var gaps = [];
        for (var i = 1; i < ts.length; i += 1) gaps.push(ts[i] - ts[i - 1]);
        var canvas = cc.game && cc.game.canvas;
        api.last = {
          ms: ms,
          frames: ts.length,
          fps: Math.round((ts.length / ms) * 10000) / 10,
          medianGapMs: gaps.length ? Math.round(median(gaps) * 10) / 10 : null,
          canvas: canvas ? [canvas.width, canvas.height] : null,
          frameRate: cc.game && cc.game.getFrameRate ? cc.game.getFrameRate() : null
        };
        resolve(api.last);
      }, ms);
    });
  }

  var REASON = { texture: "貼圖不同", material: "材質不同", "label-own-texture": "Label 沒開快取，自己一張貼圖", mask: "遮罩", graphics: "Graphics", spine: "Spine（沒開合批）", dragonbones: "DragonBones" };
  function summarize(o) {
    var lines = [];
    lines.push("基準每幀 " + o.base + " 個 draw call（量完 " + o.baseAfter + "），" + (o.method === "opacity" ? "以 opacity 0 暫時隱藏" : "以 active=false 暫時關掉") + "量差值。");
    o.levels.forEach(function (l, i) {
      var top = l.rows.filter(function (x) { return x.draws > 0; }).slice(0, 3).map(function (x) {
        return x.path + (x.n > 1 ? "（" + x.n + " 個）" : "") + " −" + x.draws + (x.offscreen === true ? "，在畫面外" : "") + (x.prefab ? "，prefab " + x.prefab : "");
      });
      if (top.length) lines.push("第 " + (i + 1) + " 層 " + l.under + "：" + top.join("；"));
    });
    var b = o.breaks;
    if (b && b.pairs.length) lines.push(o.focus + " 裡 " + b.renderers + " 個繪製元件分成 " + b.batches + " 批；斷批最多：" + b.pairs.slice(0, 3).map(function (p) {
      return p.from + " → " + p.to + "（" + (REASON[p.reason] || p.reason) + (p.reason === "texture" && p.fromTex && p.toTex ? " " + p.fromTex + " → " + p.toTex : "") + "）×" + p.n;
    }).join("；"));
    if (o.offscreenDrawn.length) lines.push("在畫面外卻還在畫：" + o.offscreenDrawn.map(function (x) { return x.path + " −" + x.draws; }).join("；"));
    if (!o.restore.ok) lines.push("有節點量的時候被遊戲改過值或沒還原：" + o.restore.nodes.join("、"));
    return lines;
  }

  var api = {
    version: 1,
    engine: String(cc.ENGINE_VERSION || ""),
    counter: COUNTER,
    method: METHOD,
    last: null,
    drawcalls: drawcalls,
    fps: fps,
    // Batch breaks of one subtree (cc.find path) or the whole scene, without hiding anything.
    batchBreaks: function (root) { var n = root && cc.find ? cc.find(root) : cc.director.getScene(); api.last = n ? batchBreaks([n], 12) : null; return api.last; }
  };
  window.__slotDrill = api;
  return "drill ok";
}
