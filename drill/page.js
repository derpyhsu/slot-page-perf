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
  // The texture a component draws with: an identity for comparing, and a label a person can find.
  // 2.4 packs small sprites into canvas-backed dynamic atlas pages (no file), keeping the source
  // texture in spriteFrame._original; TTF and system-font labels draw from their own canvas.
  var texIds = typeof WeakMap === "function" ? new WeakMap() : null;
  var texSeq = 0;
  function texId(tex) {
    if (!tex || !texIds) return null;
    var id = texIds.get(tex);
    if (!id) { texSeq += 1; id = texSeq; texIds.set(tex, id); }
    return id;
  }
  function fileOf(tex) {
    if (!tex) return null;
    var url = tex.nativeUrl || tex._nativeUrl || tex.url || "";
    if (typeof url === "string" && url && url.indexOf("data:") !== 0) return url.split("?")[0].split("#")[0].split("/").pop();
    return tex.name || tex._name || null;
  }
  function texInfo(comp) {
    try {
      var mat = comp._materials && comp._materials[0];
      var frame = comp.spriteFrame || comp._spriteFrame || null;
      var tex = (mat && mat.getProperty && mat.getProperty("texture")) || (frame && (frame._texture || (frame.getTexture && frame.getTexture()) || frame.texture)) || null;
      if (!tex) return { id: null, label: null };
      var id = texId(tex);
      var file = fileOf(tex);
      if (file) return { id: id, label: file };
      var fname = frame && (frame.name || frame._name);
      var orig = frame && frame._original && frame._original._texture;
      if (orig) return { id: id, label: "動態合圖#" + id + "（" + (fname || "?") + "，原圖 " + (fileOf(orig) || "?") + "）" };
      if (/Label/.test(className(comp))) return { id: id, label: "文字貼圖#" + id };
      if (/Skeleton|dragonBones|Armature/i.test(className(comp))) return { id: id, label: "Spine " + (skeletonName(comp.skeletonData || comp.dragonAsset) || "?") };
      return { id: id, label: (fname ? fname + " " : "") + "canvas#" + id };
    } catch (e) { return { id: null, label: null }; }
  }
  function texName(comp) { return texInfo(comp).label; }
  function renderKey(comp, node) {
    try {
      if (!V3) {
        var mat = comp._materials && comp._materials[0];
        if (!mat) return null;
        return (mat.getHash ? mat.getHash() : String(mat._uuid || "")) + "|" + (node._cullingMask != null ? node._cullingMask : "");
      }
      var m3 = comp.getRenderMaterial ? comp.getRenderMaterial(0) : comp.customMaterial || comp.sharedMaterial;
      var id = m3 ? (m3.hash || m3._hash || (m3.effectName || "") + (m3._uuid || "")) : "";
      return id + "|" + (texInfo(comp).id || "") + "|" + (node.layer != null ? node.layer : "");
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
        var ti = texInfo(c);
        var cur = { path: fold(nodePath(node)), kind: kindOf(c), key: renderKey(c, node), tex: ti.label, texId: ti.id };
        var own = cur.kind === "mask" || cur.kind === "graphics" || cur.kind === "spine" || cur.kind === "dragonbones";
        var reason = null;
        if (!prev) reason = "start";
        else if (own || prev.own) reason = own ? cur.kind : prev.kind;
        else if (cur.key == null || cur.key !== prev.key) reason = cur.kind === "label-own-texture" ? "label-own-texture" : cur.texId !== prev.texId ? "texture" : "material";
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

  // How far the baselines measured during one call spread: a cut smaller than this may be animation.
  function noiseOf(xs) {
    if (!xs.length) return 0;
    return Math.max.apply(null, xs) - Math.min.apply(null, xs);
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
    // Animation moves the count while a group is measured, so each group is compared with the
    // count right before it was hidden; how far those baselines spread is the noise to beat.
    var pres = [base];
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
          var pre = median(await sample(frames, 1, 6000));
          if (pre != null) pres.push(pre);
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
            draws: hid == null || pre == null ? null : pre - hid,
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
        if (!best || best.draws == null || best.draws < Math.max(1, minShare * base, noiseOf(pres)) || !best.children || partial === "time budget reached") break;
        selection = best._nodes;
        selName = best.path + (best.n > 1 ? " ×" + best.n : "");
      }
    } finally {
      var left = restore(touched);
      if (left.contended.length || left.notRestored.length) check = (check || []).concat(left.contended, left.notRestored);
    }
    var after = median(await sample(frames, 1, 6000));
    if (after != null) pres.push(after);
    var noise = noiseOf(pres);
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
      baseRange: [Math.min.apply(null, pres), Math.max.apply(null, pres)],
      noise: noise,
      moving: noise > Math.max(2, 0.05 * base),
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

  // ---------- spine cache ----------
  // Spine in SHARED_CACHE or PRIVATE_CACHE mode keeps every frame of every animation it has played
  // (2.4 and 3.x sp.SkeletonCache: _skeletonCache[skeletonData uuid].animationsCache[name].frames).
  // Per skeleton data and animation: frames kept and their typed-array bytes, plus how many
  // components use each mode. Arrays of plain objects in a frame are estimated, so MB is about.
  var CACHE_MODES = ["realtime", "shared", "private"];
  function typedBytes(x) { return x && typeof x.byteLength === "number" ? x.byteLength : 0; }
  function frameBytes(f) {
    if (!f || !f.vertices) return 0;
    var b = typedBytes(f.vertices) + typedBytes(f.indices);
    if (f.uintVert && f.uintVert.buffer !== f.vertices.buffer) b += typedBytes(f.uintVert);
    b += ((f.segments && f.segments.length) || 0) * 48 + ((f.colors && f.colors.length) || 0) * 48 + ((f.boneInfos && f.boneInfos.length) || 0) * 120;
    return b;
  }
  function skeletonName(sd) {
    if (!sd) return null;
    return String(sd.name || sd._name || fileOf(sd) || (sd._uuid ? "uuid:" + String(sd._uuid).slice(0, 8) : "?")).slice(0, 60);
  }
  function spineCache(opts) {
    opts = opts || {};
    var scene = cc.director.getScene();
    var names = {};
    var uses = {};
    var caches = [];
    var walk = function (node) {
      var comps = node._components || node.components || [];
      for (var i = 0; i < comps.length; i += 1) {
        var c = comps[i];
        if (!/sp\.Skeleton|^Skeleton$/.test(className(c))) continue;
        var sd = c.skeletonData;
        var name = skeletonName(sd);
        if (!name) continue;
        if (sd && sd._uuid) names[sd._uuid] = name;
        var mode = c._cacheMode != null ? c._cacheMode : c.defaultCacheMode || 0;
        var u = uses[name] || (uses[name] = { realtime: 0, shared: 0, private: 0, shown: 0 });
        u[CACHE_MODES[mode] || "realtime"] += 1;
        if (shown(node) && node.activeInHierarchy !== false) u.shown += 1;
        var inst = c._skeletonCache;
        if (inst && caches.every(function (x) { return x.inst !== inst; })) caches.push({ inst: inst, owner: mode === 2 ? "private" : "shared" });
      }
      kids(node).forEach(walk);
    };
    walk(scene);
    var rows = {};
    var pooled = 0;
    caches.forEach(function (x) {
      var map = x.inst._skeletonCache || {};
      Object.keys(map).forEach(function (uuid) {
        var entry = map[uuid];
        var name = names[uuid] || "uuid:" + String(uuid).slice(0, 8);
        var key = name + " · " + x.owner;
        var r = rows[key] || (rows[key] = { skeleton: name, cache: x.owner, caches: 0, animations: {}, frames: 0, bytes: 0 });
        r.caches += 1;
        var anims = (entry && entry.animationsCache) || {};
        Object.keys(anims).forEach(function (a) {
          var ac = anims[a];
          var fr = (ac && ac.frames) || [];
          var n = 0, b = 0;
          for (var k = 0; k < fr.length; k += 1) { var fb = frameBytes(fr[k]); if (fb) { n += 1; b += fb; } }
          var an = r.animations[a] || (r.animations[a] = { animation: String(a).slice(0, 60), frames: 0, bytes: 0, complete: 0, caches: 0 });
          an.frames += n;
          an.bytes += b;
          an.caches += 1;
          if (ac && ac.isCompleted) an.complete += 1;
          r.frames += n;
          r.bytes += b;
        });
      });
      var pool = x.inst._animationPool || {};
      Object.keys(pool).forEach(function (k) { ((pool[k] && pool[k].frames) || []).forEach(function (f) { pooled += frameBytes(f); }); });
    });
    var mb = function (b) { return Math.round((b / 1048576) * 100) / 100; };
    var list = Object.keys(rows).map(function (k) {
      var r = rows[k];
      var anims = Object.keys(r.animations).map(function (a) { var x = r.animations[a]; return { animation: x.animation, frames: x.frames, mb: mb(x.bytes), complete: x.complete, caches: x.caches }; }).sort(function (a, b) { return b.mb - a.mb; });
      return { skeleton: r.skeleton, cache: r.cache, caches: r.caches, animations: anims.length, frames: r.frames, mb: mb(r.bytes), top: anims.slice(0, opts.top || 8), uses: uses[r.skeleton] || null };
    }).sort(function (a, b) { return b.mb - a.mb; });
    var total = list.reduce(function (t, x) { return t + x.mb; }, 0);
    var out = {
      status: caches.length ? "ok" : "no cached Spine in the scene",
      engine: String(cc.ENGINE_VERSION || ""),
      totalMb: Math.round(total * 100) / 100,
      pooledMb: mb(pooled),
      skeletons: list.slice(0, opts.limit || 20),
      uses: uses,
      note: "MB counts the typed arrays of each cached frame and estimates its small object arrays. Components outside the scene (pooled, removed) are not walked, but their shared cache is counted when any shared component is in the scene."
    };
    out.summary = [];
    out.summary.push("Spine 逐幀快取合計約 " + out.totalMb + " MB" + (out.pooledMb ? "（另有回收池 " + out.pooledMb + " MB）" : "") + "，" + list.length + " 組骨架。");
    list.slice(0, 5).forEach(function (x) {
      var u = x.uses;
      out.summary.push(x.skeleton + "（" + (x.cache === "shared" ? "SHARED_CACHE" : "PRIVATE_CACHE ×" + x.caches) + "）：" + x.animations + " 個動畫、" + x.frames + " 幀，約 " + x.mb + " MB" + (u ? "；場景裡 realtime " + u.realtime + "、shared " + u.shared + "、private " + u.private + " 個元件" : "") + (x.top.length ? "；最大 " + x.top.slice(0, 3).map(function (a) { return a.animation + " " + a.frames + " 幀 " + a.mb + " MB"; }).join("、") : ""));
    });
    api.last = out;
    return out;
  }

  // ---------- fps ----------
  // Frames drawn over ms and the median gap between them, from EVENT_AFTER_DRAW. For the
  // fill-rate check: read it, shrink the page, read it again, put the size back.
  // FPS over ms. With opts.hide (cc.find paths), it measures once as is and once with those
  // subtrees hidden (2.x opacity 0, 3.x active false), then puts them back: what one layer costs
  // in the state the page is in now, for example while the reels spin.
  function fps(ms, opts) {
    ms = ms || 4000;
    if (opts && opts.hide) return fpsAB(ms, [].concat(opts.hide));
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

  async function fpsAB(ms, paths) {
    var nodes = paths.map(function (p) { return { path: p, node: cc.find ? cc.find(p) : null }; });
    var missing = nodes.filter(function (x) { return !x.node; }).map(function (x) { return x.path; });
    if (missing.length) { api.last = { status: "not found", missing: missing }; return api.last; }
    var base = await fps(ms);
    var touched = [];
    nodes.forEach(function (x) { hide(x.node, touched); });
    var hidden;
    try { hidden = await fps(ms); } finally { var back = restore(touched); }
    api.last = {
      ms: ms, hide: paths, method: METHOD, base: base.fps, hidden: hidden.fps, gain: Math.round((hidden.fps - base.fps) * 10) / 10,
      restore: { ok: !back.contended.length && !back.notRestored.length, nodes: back.contended.concat(back.notRestored) },
      summary: [paths.join("、") + (METHOD === "opacity" ? " 以 opacity 0 暫時隱藏" : " 以 active=false 暫時關掉") + "：FPS " + base.fps + " → " + hidden.fps + "（" + (hidden.fps >= base.fps ? "+" : "") + (Math.round((hidden.fps - base.fps) * 10) / 10) + "）"]
    };
    return api.last;
  }

  // Screen coverage while the page does what it does now (idle, reels spinning, a win playing):
  // samples the slot-page-perf probe's coverage walk every 250 ms for seconds, and keeps the
  // average and the peak per subtree. Needs the probe on the page (it is there after a run).
  async function coverage(opts) {
    opts = opts || {};
    var P = window.__slotPerf;
    if (!P || typeof P.coverage !== "function") { api.last = { status: "needs the slot-page-perf probe on this page (it is there after a measuring run)" }; return api.last; }
    var end = Date.now() + (opts.seconds || 3) * 1000;
    var samples = [];
    while (Date.now() < end) {
      var c = P.coverage();
      if (c && c.groups) samples.push(c);
      await new Promise(function (r) { setTimeout(r, 250); });
    }
    if (!samples.length) { api.last = { status: "no samples" }; return api.last; }
    var groups = {};
    samples.forEach(function (c) {
      c.groups.forEach(function (g) {
        var x = groups[g[0]] || (groups[g[0]] = { path: g[0], sum: 0, peak: 0, nodes: 0 });
        x.sum += g[1]; x.peak = Math.max(x.peak, g[1]); x.nodes = Math.max(x.nodes, g[2]);
      });
    });
    var r2 = function (v) { return Math.round(v * 100) / 100; };
    var rows = Object.keys(groups).map(function (k) { var x = groups[k]; return { path: x.path, avg: r2(x.sum / samples.length), peak: r2(x.peak), nodes: x.nodes }; }).sort(function (a, b) { return b.avg - a.avg; });
    var tot = samples.map(function (c) { return c.screens; });
    var avg = r2(tot.reduce(function (a, b) { return a + b; }, 0) / tot.length);
    var peak = r2(Math.max.apply(null, tot));
    var add = r2(Math.max.apply(null, samples.map(function (c) { return c.additiveScreens || 0; })));
    var noArea = Math.max.apply(null, samples.map(function (c) { return c.spineNoArea || 0; }));
    api.last = {
      tool: "coverage", samples: samples.length, screens: { avg: avg, peak: peak }, additivePeak: add, spineNoArea: noArea || undefined, groups: rows.slice(0, 10),
      summary: ["每幀畫的面積平均約 " + avg + " 個螢幕、最多 " + peak + " 個（" + samples.length + " 次取樣）" + (add ? "，其中加色最多 " + add + " 個" : "") + (noArea ? "；" + noArea + " 個快取模式或 3.x 的 Spine 沒算面積" : ""),
        "最多的子樹：" + rows.slice(0, 5).map(function (x) { return x.path + " 平均 " + x.avg + "、最多 " + x.peak; }).join("；")]
    };
    return api.last;
  }

  var REASON = { texture: "貼圖不同", material: "材質不同", "label-own-texture": "Label 沒開快取，自己一張貼圖", mask: "遮罩", graphics: "Graphics", spine: "Spine（沒開合批）", dragonbones: "DragonBones" };
  function summarize(o) {
    var lines = [];
    lines.push("基準每幀 " + o.base + " 個 draw call（量完 " + o.baseAfter + "），" + (o.method === "opacity" ? "以 opacity 0 暫時隱藏" : "以 active=false 暫時關掉") + "，每組都跟隱藏前一刻的基準比。");
    if (o.moving) lines.push("畫面在動：量的期間基準在 " + o.baseRange[0] + "–" + o.baseRange[1] + " 之間，" + o.noise + " 個以內的差值可能只是動畫；只往下查比這大的組。");
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


  // ---------- picture files ----------
  // Same as drill/imagemeta.js (test/drill-smoke.js checks they agree).
  function imageMeta(u8) {
    var out = { type: null, w: null, h: null, bytes: u8.length, meta: [], removable: 0 };
    var be16 = function (i) { return (u8[i] << 8) | u8[i + 1]; };
    var be32 = function (i) { return ((u8[i] << 24) >>> 0) + (u8[i + 1] << 16) + (u8[i + 2] << 8) + u8[i + 3]; };
    var le32 = function (i) { return u8[i] + (u8[i + 1] << 8) + (u8[i + 2] << 16) + ((u8[i + 3] << 24) >>> 0); };
    var ascii = function (i, n) { var s = ""; for (var k = 0; k < n && i + k < u8.length; k += 1) { var c = u8[i + k]; if (c === 0) break; s += c >= 32 && c < 127 ? String.fromCharCode(c) : "?"; } return s; };
    var add = function (kind, key, size, removable) {
      out.meta.push({ kind: kind, key: key || undefined, bytes: size, removable: removable || undefined });
      if (removable) out.removable += size;
    };
    if (u8.length > 24 && u8[0] === 0x89 && u8[1] === 0x50 && u8[2] === 0x4e && u8[3] === 0x47) {
      out.type = "png";
      var KEEP = { IHDR: 1, PLTE: 1, IDAT: 1, IEND: 1, tRNS: 1, gAMA: 1, cHRM: 1, sRGB: 1, sBIT: 1, pHYs: 1, bKGD: 1, hIST: 1, sPLT: 1, acTL: 1, fcTL: 1, fdAT: 1 };
      for (var p = 8; p + 12 <= u8.length;) {
        var len = be32(p);
        var type = ascii(p + 4, 4);
        if (type === "IHDR") { out.w = be32(p + 8); out.h = be32(p + 12); }
        var size = 12 + len;
        if (type === "tEXt" || type === "zTXt" || type === "iTXt") add(type, ascii(p + 8, 79), size, true);
        else if (type === "eXIf" || type === "tIME") add(type, null, size, true);
        else if (type === "iCCP") add(type, ascii(p + 8, 79), size, false);
        else if (!KEEP[type] && /^[a-z]/.test(type)) add(type, null, size, true);
        if (type === "IEND") break;
        p += size;
      }
    } else if (u8.length > 4 && u8[0] === 0xff && u8[1] === 0xd8) {
      out.type = "jpeg";
      for (var q = 2; q + 4 <= u8.length;) {
        if (u8[q] !== 0xff) break;
        var m = u8[q + 1];
        if (m === 0xd9 || m === 0xda) break;
        if (m === 0xff || (m >= 0xd0 && m <= 0xd7) || m === 0x01) { q += m === 0xff ? 1 : 2; continue; }
        var sl = be16(q + 2);
        if ((m >= 0xc0 && m <= 0xc3) || (m >= 0xc5 && m <= 0xc7) || (m >= 0xc9 && m <= 0xcb) || (m >= 0xcd && m <= 0xcf)) { out.h = be16(q + 5); out.w = be16(q + 7); }
        var seg = 2 + sl;
        if (m >= 0xe0 && m <= 0xef) {
          var sig = ascii(q + 4, 32);
          var n = m - 0xe0;
          if (n === 0) add("APP0", sig, seg, false);
          else if (n === 1 && /^Exif/.test(sig)) add("APP1", "Exif", seg, false);
          else if (n === 1) add("APP1", sig.indexOf("adobe") >= 0 ? "XMP" : sig, seg, true);
          else if (n === 2) add("APP2", sig, seg, false);
          else if (n === 13) add("APP13", sig, seg, true);
          else if (n === 14) add("APP14", sig, seg, false);
          else add("APP" + n, sig, seg, true);
        } else if (m === 0xfe) add("COM", null, seg, true);
        q += seg;
      }
    } else if (u8.length > 12 && ascii(0, 4) === "RIFF" && ascii(8, 4) === "WEBP") {
      out.type = "webp";
      for (var r = 12; r + 8 <= u8.length;) {
        var ct = ascii(r, 4);
        var cl = le32(r + 4);
        var cs = 8 + cl + (cl & 1);
        if (ct === "VP8X") { out.w = 1 + (u8[r + 12] | (u8[r + 13] << 8) | (u8[r + 14] << 16)); out.h = 1 + (u8[r + 15] | (u8[r + 16] << 8) | (u8[r + 17] << 16)); }
        else if (ct === "EXIF" || ct === "XMP ") add(ct.trim(), null, cs, true);
        else if (ct === "ICCP") add(ct, null, cs, false);
        r += cs;
      }
    }
    return out;
  }

  // Fetches each loaded texture's picture file again (normally from the HTTP cache) and lists the
  // ones carrying metadata the picture does not need, or larger than their raw pixels. Picture
  // CDNs already allow the page to read these files, since WebGL needs that. File names only.
  async function images(opts) {
    opts = opts || {};
    var minKb = opts.minKb || 20;
    var urls = {};
    var add = function (a) {
      try {
        if (!a || !(cc.Texture2D && a instanceof cc.Texture2D)) return;
        var img = a._image || (a.image && (a.image.data || a.image._nativeAsset));
        var u = (img && typeof img.src === "string" && /^https?:/.test(img.src) && img.src) || a.nativeUrl || a._nativeUrl || "";
        if (!u || /^data:/.test(u) || urls[u]) return;
        urls[u] = { w: a.width, h: a.height, name: a.name || a._name || "" };
      } catch (e) {}
    };
    if (cc.assetManager && cc.assetManager.assets) cc.assetManager.assets.forEach(add);
    var list = Object.keys(urls).slice(0, opts.max || 300);
    var rows = [];
    var failed = 0;
    var t0 = Date.now();
    for (var i = 0; i < list.length; i += 6) {
      if (Date.now() - t0 > (opts.budgetMs || 60000)) break;
      await Promise.all(list.slice(i, i + 6).map(async function (u) {
        try {
          var r = await fetch(u, { cache: "force-cache" });
          if (!r.ok) { failed += 1; return; }
          var m = imageMeta(new Uint8Array(await r.arrayBuffer()));
          var w = m.w || urls[u].w, h = m.h || urls[u].h;
          var bpp = w && h ? m.bytes / (w * h) : null;
          if (m.removable < minKb * 1024 && !(bpp != null && bpp > 4 && m.bytes > 200 * 1024)) return;
          rows.push({ file: u.split("?")[0].split("#")[0].split("/").pop(), name: urls[u].name || undefined, w: w, h: h, kb: Math.round(m.bytes / 1024), bpp: bpp == null ? null : Math.round(bpp * 10) / 10, removableKb: Math.round(m.removable / 1024), blocks: m.meta.filter(function (x) { return x.bytes >= 1024; }).map(function (x) { return { kind: x.kind, key: x.key, kb: Math.round(x.bytes / 1024), removable: !!x.removable }; }) });
        } catch (e) { failed += 1; }
      }));
    }
    rows.sort(function (a, b) { return b.removableKb - a.removableKb || b.kb - a.kb; });
    var total = rows.reduce(function (a, r) { return a + r.removableKb; }, 0);
    var lines = ["看了 " + list.length + " 張圖" + (failed ? "（" + failed + " 張讀不到）" : "") + "，" + rows.length + " 張夾了 " + minKb + " KB 以上可拿掉的資料或比像素還大，合計可拿掉 " + Math.round(total / 102.4) / 10 + " MB"];
    rows.slice(0, 5).forEach(function (r) {
      lines.push((r.name ? r.name + "（" + r.file + "）" : r.file) + " " + r.w + "×" + r.h + "，檔案 " + r.kb + " KB" + (r.bpp != null ? "（每像素 " + r.bpp + " bytes）" : "") + "，可拿掉 " + r.removableKb + " KB：" + r.blocks.filter(function (b) { return b.removable; }).map(function (b) { return b.kind + (b.key ? " " + b.key : "") + " " + b.kb + " KB"; }).join("、"));
    });
    api.last = { tool: "images", scanned: list.length, failed: failed, rows: rows, summary: lines };
    return api.last;
  }

  var api = {
    version: 1,
    engine: String(cc.ENGINE_VERSION || ""),
    counter: COUNTER,
    method: METHOD,
    last: null,
    drawcalls: drawcalls,
    fps: fps,
    spineCache: spineCache,
    coverage: coverage,
    images: images,
    imageMeta: imageMeta,
    // Batch breaks of one subtree (cc.find path) or the whole scene, without hiding anything.
    batchBreaks: function (root) { var n = root && cc.find ? cc.find(root) : cc.director.getScene(); api.last = n ? batchBreaks([n], 12) : null; return api.last; }
  };
  window.__slotDrill = api;
  return "drill ok";
}
