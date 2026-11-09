(function () {
  if (window.__slotPerf && window.__slotPerf.version === 1) return;

  var HITCH_MS = 50;
  var BUCKET_MS = 250;
  var BAD_FRAME_MS = 33;
  var HEAP_SAMPLE_MS = 1000;
  var TEXTURE_SAMPLE_MS = 5000;
  var SERIES_CAP = 8000;
  var state = {
    bucket: null,
    buckets: [],
    longTasks: [],
    marks: [],
    heapSeries: [],
    textureSeries: [],
    t0: performance.now(),
    stage: null,
    stages: [],
    sceneLog: [],
    sceneName: "",
    gameReady: false,
    loopHooked: false,
    loopName: null,
    loopFrames: 0,
    loopHookedAt: 0,
    seenFrame: false,
    drawTotal: 0,
    texUploads: 0,
    texBytes: 0,
    active: new Set(),
    gpuExt: null,
    pendingGpu: [],
    lastDrawSample: 0
  };

  function round(n) {
    return Math.round(n * 100) / 100;
  }

  function pct(sorted, p) {
    if (!sorted.length) return null;
    var i = Math.min(sorted.length - 1, Math.max(0, Math.floor(p * (sorted.length - 1))));
    return round(sorted[i]);
  }

  function pathOnly(url) {
    try {
      var u = new URL(url, location.href);
      return u.origin + u.pathname;
    } catch (e) {
      return String(url).split("?")[0].slice(0, 160);
    }
  }

  // Engine warnings and errors grouped by message, with URL query strings removed.
  var consoleGroups = {};
  function consoleKey(args) {
    var text = Array.prototype.map.call(args, function (a) {
      try { return typeof a === "string" ? a : a instanceof Error ? a.message : JSON.stringify(a); } catch (e) { return String(a); }
    }).join(" ");
    return text.replace(/\?[^\s"')]*/g, "").replace(/\s+/g, " ").slice(0, 140);
  }
  ["warn", "error"].forEach(function (level) {
    var orig = console[level];
    if (typeof orig !== "function") return;
    console[level] = function () {
      try {
        var key = level + ": " + consoleKey(arguments);
        var g = consoleGroups[key];
        if (!g) {
          if (Object.keys(consoleGroups).length < 200) consoleGroups[key] = { level: level, text: key.slice(level.length + 2), count: 1, firstMs: Math.round(performance.now() - state.t0) };
        } else {
          g.count += 1;
        }
      } catch (e) {}
      return orig.apply(this, arguments);
    };
  });
  function consoleSummary() {
    return Object.keys(consoleGroups).map(function (k) { return consoleGroups[k]; }).sort(function (a, b) { return b.count - a.count; }).slice(0, 20);
  }

  function rel(t) {
    return Math.round(t - state.t0);
  }

  // Bucket row: [startMs, frames, maxDtMs, cpuMsSum or null, badFrames, maxDraws, texUploadMb]
  function bucketFrame(now, dt, cpu, draws) {
    var start = Math.floor((now - state.t0) / BUCKET_MS) * BUCKET_MS;
    var b = state.bucket;
    if (!b || b[0] !== start) {
      if (b && state.buckets.length < SERIES_CAP) state.buckets.push(b);
      b = state.bucket = [start, 0, 0, null, 0, 0, 0];
      b.texStart = state.texBytes;
    }
    b[1] += 1;
    if (dt > b[2]) b[2] = round(dt);
    if (cpu != null) b[3] = round((b[3] || 0) + cpu);
    if (dt > BAD_FRAME_MS) b[4] += 1;
    if (draws > b[5]) b[5] = draws;
    b[6] = round((state.texBytes - b.texStart) / 1048576);
  }

  function openStage(name) {
    closeStage();
    if (state.marks.length < SERIES_CAP) state.marks.push([name, rel(performance.now())]);
    state.stage = {
      name: name,
      t0: performance.now(),
      frames: 0,
      sumDt: 0,
      sumCpu: 0,
      cpuDt: 0,
      sumGpu: 0,
      gpuN: 0,
      sumDraws: 0,
      dts: [],
      cpus: [],
      gpus: [],
      draws: [],
      hitches: [],
      heapStart: heapMb(),
      texStart: state.texBytes
    };
  }

  function closeStage() {
    var s = state.stage;
    if (!s) return;
    s.t1 = performance.now();
    s.heapEnd = heapMb();
    s.texEnd = state.texBytes;
    state.stages.push(s);
    state.stage = null;
  }

  function heapMb() {
    if (!performance.memory) return null;
    return round(performance.memory.usedJSHeapSize / 1048576);
  }

  function pushCapped(arr, value) {
    if (arr.length < 12000) arr.push(value);
  }

  function recordFrame(dt, cpu, draws) {
    if (!(dt > 0) || dt > 10000) return;
    if (!state.seenFrame) {
      state.seenFrame = true;
      openStage("loading");
    }
    var now = performance.now();
    bucketFrame(now, dt, cpu, draws);
    var s = state.stage;
    if (!s) return;
    s.frames += 1;
    s.sumDt += dt;
    s.sumDraws += draws;
    pushCapped(s.dts, dt);
    if (cpu != null) {
      s.sumCpu += cpu;
      s.cpuDt += dt;
      pushCapped(s.cpus, cpu);
    }
    pushCapped(s.draws, draws);
    var gpu = takeGpu();
    if (gpu != null) {
      s.sumGpu += gpu;
      s.gpuN += 1;
      pushCapped(s.gpus, gpu);
    }
    if (dt >= HITCH_MS && s.hitches.length < 40) {
      var urls = [];
      state.active.forEach(function (item) {
        if (urls.length < 3) urls.push(item);
      });
      s.hitches.push({
        t: rel(now - dt),
        dt: round(dt),
        cpu: cpu == null ? null : round(cpu),
        gpu: gpu == null ? null : round(gpu),
        draws: draws,
        inFlight: state.active.size,
        urls: urls
      });
    }
  }

  function takeGpu() {
    var ext = state.gpuExt;
    var gl = state.gl;
    if (!ext || !gl || !state.pendingGpu.length) return null;
    var out = null;
    try {
      if (gl.getParameter(ext.GPU_DISJOINT_EXT)) {
        state.pendingGpu.length = 0;
        return null;
      }
    } catch (e) {
      return null;
    }
    for (var i = 0; i < state.pendingGpu.length;) {
      var q = state.pendingGpu[i];
      var avail = false;
      try { avail = ext.getQueryObjectEXT(q, ext.QUERY_RESULT_AVAILABLE_EXT); } catch (e) { avail = false; }
      if (!avail) { i += 1; continue; }
      try {
        out = ext.getQueryObjectEXT(q, ext.QUERY_RESULT_EXT) / 1e6;
        ext.deleteQueryEXT(q);
      } catch (e) {}
      state.pendingGpu.splice(i, 1);
    }
    return out;
  }

  function beginGpu() {
    var ext = state.gpuExt;
    var gl = state.gl;
    if (!ext || !gl) return;
    try {
      if (gl.getParameter(ext.GPU_DISJOINT_EXT)) return;
      var q = ext.createQueryEXT();
      ext.beginQueryEXT(ext.TIME_ELAPSED_EXT, q);
      state.pendingGpu.push(q);
    } catch (e) {}
  }

  function endGpu() {
    var ext = state.gpuExt;
    if (!ext || !state.pendingGpu.length) return;
    try { ext.endQueryEXT(ext.TIME_ELAPSED_EXT); } catch (e) {}
  }

  function hookGL(proto) {
    if (!proto || proto.__slotPerf) return;
    proto.__slotPerf = true;
    ["drawArrays", "drawElements", "drawArraysInstanced", "drawElementsInstanced", "drawArraysInstancedANGLE", "drawElementsInstancedANGLE"].forEach(function (name) {
      if (typeof proto[name] !== "function") return;
      var orig = proto[name];
      proto[name] = function () {
        state.drawTotal += 1;
        return orig.apply(this, arguments);
      };
    });
    ["texImage2D", "texSubImage2D", "compressedTexImage2D"].forEach(function (name) {
      if (typeof proto[name] !== "function") return;
      var orig = proto[name];
      proto[name] = function () {
        state.texUploads += 1;
        try {
          var src = arguments[arguments.length - 1];
          if (src && src.byteLength) state.texBytes += src.byteLength;
          else if (src && src.width && src.height) state.texBytes += src.width * src.height * 4;
        } catch (e) {}
        return orig.apply(this, arguments);
      };
    });
  }

  function drawsThisFrame() {
    var now = state.drawTotal;
    var delta = now - state.lastDrawSample;
    state.lastDrawSample = now;
    var engine = engineDraws();
    return engine == null ? delta : engine;
  }

  function engineDraws() {
    try {
      var n = window.cc && window.cc.renderer && window.cc.renderer.drawCalls;
      return typeof n === "number" ? n : null;
    } catch (e) {
      return null;
    }
  }

  hookGL(window.WebGLRenderingContext && WebGLRenderingContext.prototype);
  hookGL(window.WebGL2RenderingContext && WebGL2RenderingContext.prototype);

  var origRAF = window.requestAnimationFrame.bind(window);
  var lastRaf = performance.now();
  function rafLoop(t) {
    var dt = t - lastRaf;
    lastRaf = t;
    if (performance.now() - state.loopHookedAt > 500) {
      recordFrame(dt, null, drawsThisFrame());
    }
    origRAF(rafLoop);
  }
  origRAF(rafLoop);

  try {
    var po = new PerformanceObserver(function (list) {
      list.getEntries().forEach(function (entry) {
        if (state.longTasks.length < SERIES_CAP) {
          state.longTasks.push([Math.round(entry.startTime - state.t0), round(entry.duration), state.active.size]);
        }
        if (entry.duration >= HITCH_MS && state.stage && state.stage.hitches.length < 40) {
          state.stage.hitches.push({
            t: Math.round(entry.startTime - state.t0),
            dt: round(entry.duration),
            cpu: round(entry.duration),
            gpu: null,
            draws: null,
            inFlight: state.active.size,
            urls: [],
            source: "longtask"
          });
        }
      });
    });
    po.observe({ type: "longtask", buffered: true });
  } catch (e) {}

  function track(url, start) {
    var path = pathOnly(url);
    if (start) state.active.add(path);
    else state.active.delete(path);
  }

  var origOpen = XMLHttpRequest.prototype.open;
  var origSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (method, url) {
    this.__slotUrl = url;
    return origOpen.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function () {
    var self = this;
    var url = self.__slotUrl;
    if (url) track(url, true);
    function done() {
      if (url) track(url, false);
    }
    this.addEventListener("loadend", done);
    return origSend.apply(this, arguments);
  };

  if (window.fetch) {
    var origFetch = window.fetch.bind(window);
    window.fetch = function (input) {
      var url = typeof input === "string" ? input : (input && input.url) || "";
      if (url) track(url, true);
      return origFetch.apply(null, arguments).then(function (res) {
        if (url) track(url, false);
        return res;
      }, function (err) {
        if (url) track(url, false);
        throw err;
      });
    };
  }

  function attachContext(gl) {
    if (!gl || state.gl) return;
    state.gl = gl;
    state.gpuExt = gl.getExtension("EXT_disjoint_timer_query") || gl.getExtension("EXT_disjoint_timer_query_webgl2");
  }

  var origGetContext = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function (type) {
    var gl = origGetContext.apply(this, arguments);
    if (gl && /webgl/i.test(String(type))) attachContext(gl);
    return gl;
  };

  function hookDirector(cc) {
    var director = cc.director;
    if (state.loopHooked || !director) return;
    // Creator 3.x drives frames through director.tick and never calls mainLoop.
    var name = typeof director.tick === "function" ? "tick" : typeof director.mainLoop === "function" ? "mainLoop" : null;
    if (!name) return;
    state.loopHooked = true;
    state.loopName = name;
    var orig = director[name];
    var last = performance.now();
    director[name] = function () {
      var now = performance.now();
      var dt = now - last;
      last = now;
      state.loopHookedAt = now;
      state.loopFrames += 1;
      beginGpu();
      var t0 = performance.now();
      var ret = orig.apply(this, arguments);
      var cpu = performance.now() - t0;
      endGpu();
      recordFrame(dt, cpu, drawsThisFrame());
      return ret;
    };
  }

  function watch() {
    var cc = window.cc;
    if (!cc) return;
    try { hookDirector(cc); } catch (e) {}
    try {
      var scene = cc.director && cc.director.getScene && cc.director.getScene();
      var name = scene && scene.name;
      if (name && name !== state.sceneName) {
        state.sceneName = name;
        state.sceneLog.push({ name: name, t: round(performance.now() - state.t0) });
        if (state.gameReady && state.stage && state.stage.name.indexOf("scene:") !== 0) {
          openStage("scene:" + name);
        }
      }
    } catch (e) {}
    if (!state.gl && cc.game && cc.game._renderContext) attachContext(cc.game._renderContext);
  }
  setInterval(watch, 200);

  setInterval(function () {
    var mb = heapMb();
    if (mb != null && state.heapSeries.length < SERIES_CAP) state.heapSeries.push([rel(performance.now()), mb]);
  }, HEAP_SAMPLE_MS);

  setInterval(function () {
    var info = textureInfo();
    if (info.status === "ok" && state.textureSeries.length < SERIES_CAP) state.textureSeries.push([rel(performance.now()), info.mb]);
  }, TEXTURE_SAMPLE_MS);

  function stat(arr) {
    if (!arr.length) return null;
    var sorted = arr.slice().sort(function (a, b) { return a - b; });
    var sum = 0;
    for (var i = 0; i < arr.length; i += 1) sum += arr[i];
    return { avg: round(sum / arr.length), p50: pct(sorted, 0.5), p95: pct(sorted, 0.95), max: round(sorted[sorted.length - 1]) };
  }

  function finishStage(s) {
    var wall = (s.t1 || performance.now()) - s.t0;
    var cpuPct = s.cpuDt > 0 ? round(100 * s.sumCpu / s.cpuDt) : null;
    var gpuPct = s.gpuN > 0 ? round(100 * (s.sumGpu / s.gpuN) / 16.7) : null;
    return {
      name: s.name,
      startMs: rel(s.t0),
      wallMs: round(wall),
      frames: s.frames,
      fps: s.sumDt > 0 ? round(1000 / (s.sumDt / s.frames)) : null,
      cpuMs: stat(s.cpus),
      cpuFrames: s.cpus.length,
      gpuMs: s.gpuN ? stat(s.gpus) : null,
      cpuPct: cpuPct,
      gpuPct: gpuPct,
      draws: stat(s.draws),
      hitches: s.hitches,
      heapStartMb: s.heapStart,
      heapEndMb: s.heapEnd == null ? heapMb() : s.heapEnd,
      texUploadMb: round((s.texEnd - s.texStart) / 1048576)
    };
  }

  // Creator 2.x keeps assets in cc.loader._cache; 3.x in cc.assetManager.assets.
  function allAssets() {
    var cc = window.cc;
    if (!cc) return null;
    var items = [];
    var cache = cc.loader && cc.loader._cache;
    if (cache) {
      Object.keys(cache).forEach(function (key) {
        var item = cache[key];
        items.push(item && item.content ? item.content : item);
      });
    } else if (cc.assetManager && cc.assetManager.assets && typeof cc.assetManager.assets.forEach === "function") {
      cc.assetManager.assets.forEach(function (asset) { items.push(asset); });
    } else {
      return null;
    }
    return items;
  }

  function className(obj) {
    var cc = window.cc;
    try {
      return (cc && cc.js && cc.js.getClassName(obj)) || (obj && obj.constructor && obj.constructor.name) || "?";
    } catch (e) {
      return "?";
    }
  }

  function formatName(fmt) {
    var cc = window.cc;
    var e = cc && cc.Texture2D && cc.Texture2D.PixelFormat;
    if (e) {
      var keys = Object.keys(e);
      for (var i = 0; i < keys.length; i += 1) if (e[keys[i]] === fmt) return keys[i];
    }
    return String(fmt);
  }

  // Bytes per pixel by Cocos PixelFormat name. Unknown names fall back to 4.
  function bytesPerPixel(name) {
    if (/PVRTC_2/.test(name)) return 0.25;
    if (/PVRTC|ETC1|ETC2_RGB$|RGB_ETC2|RGB_ETC1|RGB_A_PVRTC/.test(name)) return 0.5;
    if (/ETC2|ASTC_4x4|ASTC/.test(name)) return 1;
    if (/^A8$|^I8$/.test(name)) return 1;
    if (/565|4444|5551|AI88/.test(name)) return 2;
    return 4;
  }

  function isCompressed(name) {
    return /PVRTC|ETC|ASTC/.test(name);
  }

  function textureInfo() {
    var cc = window.cc;
    var items = allAssets();
    if (!items) return { status: "unavailable" };
    var seen = [];
    var count = 0;
    var bytes = 0;
    var npot = 0;
    var compressed = 0;
    var big = [];
    var formats = {};
    function isPot(n) { return n > 0 && (n & (n - 1)) === 0; }
    items.forEach(function (tex) {
      if (!tex || !(cc.Texture2D && tex instanceof cc.Texture2D)) return;
      if (seen.indexOf(tex) >= 0) return;
      seen.push(tex);
      var w = tex.width || 0;
      var h = tex.height || 0;
      if (!w || !h) return;
      var name = formatName(tex._format != null ? tex._format : tex.format);
      var b = w * h * bytesPerPixel(name);
      count += 1;
      bytes += b;
      if (isCompressed(name)) compressed += 1;
      if (!(isPot(w) && isPot(h))) npot += 1;
      formats[name] = (formats[name] || 0) + 1;
      big.push({ w: w, h: h, format: name, mb: round(b / 1048576) });
    });
    big.sort(function (a, b) { return b.mb - a.mb; });
    return {
      status: "ok",
      count: count,
      mb: round(bytes / 1048576),
      npot: npot,
      compressed: compressed,
      formats: formats,
      largest: big.slice(0, 8),
      note: "Bytes from the Cocos pixel format name. Unknown formats count as 4 bytes per pixel."
    };
  }

  function walkScene(visit) {
    var cc = window.cc;
    var scene = cc && cc.director && cc.director.getScene && cc.director.getScene();
    if (!scene) return false;
    var stack = [[scene, 0]];
    while (stack.length) {
      var top = stack.pop();
      var node = top[0];
      visit(node, top[1]);
      var kids = node.children || node._children || [];
      for (var i = 0; i < kids.length; i += 1) stack.push([kids[i], top[1] + 1]);
    }
    return true;
  }

  function cocosInfo() {
    var cc = window.cc;
    if (!cc) return { status: "unavailable" };
    var out = {
      status: "ok",
      engine: cc.ENGINE_VERSION || cc.version || null,
      nodes: { total: 0, active: 0, maxDepth: 0 },
      components: {},
      spine: { total: 0, active: 0, realtime: 0, sharedCache: 0, privateCache: 0, batched: 0, activeRealtimeBones: 0 },
      dragonBones: { total: 0, active: 0 },
      labels: { total: 0, active: 0, noCache: 0, bitmap: 0, char: 0, systemFont: 0 },
      masks: { total: 0, active: 0 },
      particles: { total: 0, active: 0, maxParticles: 0 },
      graphics: { active: 0 },
      settings: {},
      assets: {}
    };
    var ok = walkScene(function (node, depth) {
      out.nodes.total += 1;
      var on = node.activeInHierarchy !== false && node.active !== false;
      if (on) out.nodes.active += 1;
      if (depth > out.nodes.maxDepth) out.nodes.maxDepth = depth;
      var comps = node._components || node.components || [];
      for (var i = 0; i < comps.length; i += 1) {
        var c = comps[i];
        var name = className(c);
        var live = on && c.enabled !== false;
        out.components[name] = (out.components[name] || 0) + 1;
        if (name === "sp.Skeleton") {
          out.spine.total += 1;
          var mode = c._cacheMode != null ? c._cacheMode : c.defaultCacheMode;
          if (live) {
            out.spine.active += 1;
            if (!mode) {
              out.spine.realtime += 1;
              try {
                var sk = c._skeleton || (c.getSkeleton && c.getSkeleton());
                if (sk && sk.bones) out.spine.activeRealtimeBones += sk.bones.length;
              } catch (e) {}
            } else if (mode === 1) out.spine.sharedCache += 1;
            else out.spine.privateCache += 1;
            if (c.enableBatch) out.spine.batched += 1;
          }
        } else if (name === "dragonBones.ArmatureDisplay") {
          out.dragonBones.total += 1;
          if (live) out.dragonBones.active += 1;
        } else if (name === "cc.Label") {
          out.labels.total += 1;
          if (live) {
            out.labels.active += 1;
            var cm = c.cacheMode || 0;
            if (cm === 0) out.labels.noCache += 1;
            else if (cm === 1) out.labels.bitmap += 1;
            else out.labels.char += 1;
            if (c.useSystemFont) out.labels.systemFont += 1;
          }
        } else if (name === "cc.Mask") {
          out.masks.total += 1;
          if (live) out.masks.active += 1;
        } else if (name === "cc.ParticleSystem" || name === "cc.ParticleSystem2D") {
          out.particles.total += 1;
          if (live) {
            out.particles.active += 1;
            out.particles.maxParticles += c.totalParticles || c.capacity || 0;
          }
        } else if (name === "cc.Graphics" && live) {
          out.graphics.active += 1;
        }
      }
    });
    if (!ok) out.status = "no-scene";
    var top = Object.keys(out.components).sort(function (a, b) { return out.components[b] - out.components[a]; }).slice(0, 15);
    var comps = {};
    top.forEach(function (k) { comps[k] = out.components[k]; });
    out.components = comps;
    try {
      var m = cc.macro || {};
      var game = cc.game || {};
      out.settings = {
        frameRate: game.frameRate || (game.config && game.config.frameRate) || (game.getFrameRate && game.getFrameRate()) || null,
        cleanupImageCache: m.CLEANUP_IMAGE_CACHE == null ? null : !!m.CLEANUP_IMAGE_CACHE,
        dynamicAtlas: cc.dynamicAtlasManager ? !!cc.dynamicAtlasManager.enabled : null,
        webglAntialias: m.ENABLE_WEBGL_ANTIALIAS == null ? null : !!m.ENABLE_WEBGL_ANTIALIAS,
        retina: cc.view && cc.view.isRetinaEnabled ? !!cc.view.isRetinaEnabled() : null,
        webglVersion: state.gl && typeof WebGL2RenderingContext !== "undefined" && state.gl instanceof WebGL2RenderingContext ? 2 : state.gl ? 1 : null,
        webgl2Available: typeof WebGL2RenderingContext !== "undefined"
      };
    } catch (e) {}
    var assets = allAssets() || [];
    var kinds = {};
    var seen = new Set();
    assets.forEach(function (a) {
      if (!a || typeof a !== "object" || seen.has(a)) return;
      seen.add(a);
      var k = className(a);
      kinds[k] = (kinds[k] || 0) + 1;
    });
    Object.keys(kinds).sort(function (a, b) { return kinds[b] - kinds[a]; }).slice(0, 12).forEach(function (k) { out.assets[k] = kinds[k]; });
    out.textures = textureInfo();
    out.console = consoleSummary();
    return out;
  }

  function device() {
    var gpu = null;
    var webgl = null;
    try {
      var gl = state.gl;
      if (gl) {
        var dbg = gl.getExtension("WEBGL_debug_renderer_info");
        gpu = dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
        webgl = gl.getParameter(gl.VERSION);
      }
    } catch (e) {}
    var canvas = document.querySelector("canvas");
    return {
      capturedAt: new Date().toISOString(),
      viewport: { w: window.innerWidth, h: window.innerHeight, dpr: window.devicePixelRatio || 1 },
      canvas: canvas ? { w: canvas.width, h: canvas.height } : null,
      gpu: gpu,
      webgl: webgl,
      engine: window.cc && (window.cc.ENGINE_VERSION || window.cc.version) || null,
      webdriver: navigator.webdriver === true,
      hidden: document.hidden,
      visibility: document.visibilityState,
      title: document.title,
      urlPath: location.pathname
    };
  }

  openStage("boot");

  window.__slotPerf = {
    version: 1,
    mark: function (name) {
      if (name === "game-ready") state.gameReady = true;
      openStage(String(name || "mark"));
      return name;
    },
    // Walks the live scene. Call it while a stage is on screen, not every frame.
    cocos: function (label) {
      var info = cocosInfo();
      info.at = label || (state.stage && state.stage.name) || null;
      info.t = rel(performance.now());
      return info;
    },
    summary: function () {
      var open = state.stage ? finishStage(state.stage) : null;
      return {
        schemaVersion: 1,
        conditions: device(),
        channels: {
          frameLoop: state.loopFrames > 0 ? state.loopName : "raf",
          engineCpu: state.loopFrames > 0,
          gpuTimer: !!state.gpuExt,
          jsHeap: !!performance.memory,
          textureResidency: textureInfo().status,
          sceneName: state.sceneLog.length > 0
        },
        sceneLog: state.sceneLog,
        stages: state.stages.map(finishStage).concat(open ? [open] : []),
        timeline: {
          bucketMs: BUCKET_MS,
          badFrameMs: BAD_FRAME_MS,
          bucketFields: ["startMs", "frames", "maxDtMs", "cpuMs", "badFrames", "maxDraws", "texUploadMb"],
          buckets: state.buckets.concat(state.bucket ? [state.bucket.slice(0, 7)] : []),
          longTasks: state.longTasks,
          longTaskFields: ["startMs", "durationMs", "inFlight"],
          marks: state.marks,
          heap: state.heapSeries,
          textures: state.textureSeries
        },
        memory: {
          heapMb: heapMb(),
          texUploadMb: round(state.texBytes / 1048576),
          texUploads: state.texUploads,
          textures: textureInfo()
        }
      };
    }
  };
})();
