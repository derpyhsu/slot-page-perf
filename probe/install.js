(function () {
  if (window.__slotPerf && window.__slotPerf.version === 1) return;

  var HITCH_MS = 50;
  var state = {
    t0: performance.now(),
    stage: null,
    stages: [],
    sceneLog: [],
    sceneName: "",
    gameReady: false,
    loopHooked: false,
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

  function openStage(name) {
    closeStage();
    state.stage = {
      name: name,
      t0: performance.now(),
      frames: 0,
      sumDt: 0,
      sumCpu: 0,
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
    var s = state.stage;
    if (!s) return;
    s.frames += 1;
    s.sumDt += dt;
    s.sumCpu += cpu;
    s.sumDraws += draws;
    pushCapped(s.dts, dt);
    pushCapped(s.cpus, cpu);
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
        dt: round(dt),
        cpu: round(cpu),
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
      var t0 = performance.now();
      recordFrame(dt, performance.now() - t0, drawsThisFrame());
    }
    origRAF(rafLoop);
  }
  origRAF(rafLoop);

  try {
    var po = new PerformanceObserver(function (list) {
      list.getEntries().forEach(function (entry) {
        if (entry.duration >= HITCH_MS && state.stage && state.stage.hitches.length < 40) {
          state.stage.hitches.push({
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
    if (state.loopHooked || !cc.director || typeof cc.director.mainLoop !== "function") return;
    state.loopHooked = true;
    var orig = cc.director.mainLoop;
    var last = performance.now();
    cc.director.mainLoop = function () {
      var now = performance.now();
      var dt = now - last;
      last = now;
      state.loopHookedAt = now;
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

  function stat(arr) {
    if (!arr.length) return null;
    var sorted = arr.slice().sort(function (a, b) { return a - b; });
    var sum = 0;
    for (var i = 0; i < arr.length; i += 1) sum += arr[i];
    return { avg: round(sum / arr.length), p50: pct(sorted, 0.5), p95: pct(sorted, 0.95), max: round(sorted[sorted.length - 1]) };
  }

  function finishStage(s) {
    var wall = (s.t1 || performance.now()) - s.t0;
    var cpuPct = s.sumDt > 0 ? round(100 * s.sumCpu / s.sumDt) : null;
    var gpuPct = s.gpuN > 0 ? round(100 * (s.sumGpu / s.gpuN) / 16.7) : null;
    return {
      name: s.name,
      wallMs: round(wall),
      frames: s.frames,
      fps: s.sumDt > 0 ? round(1000 / (s.sumDt / s.frames)) : null,
      cpuMs: stat(s.cpus),
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

  function textureInfo() {
    var cc = window.cc;
    if (!cc) return { status: "unavailable" };
    var cache = (cc.loader && cc.loader._cache) || null;
    if (!cache) return { status: "unavailable" };
    var seen = [];
    var count = 0;
    var bytes = 0;
    var npot = 0;
    var big = [];
    var formats = {};
    function isPot(n) { return n > 0 && (n & (n - 1)) === 0; }
    Object.keys(cache).forEach(function (key) {
      var item = cache[key];
      var tex = item && (item.content || item);
      if (!tex || !(cc.Texture2D && tex instanceof cc.Texture2D)) return;
      if (seen.indexOf(tex) >= 0) return;
      seen.push(tex);
      var w = tex.width || 0;
      var h = tex.height || 0;
      if (!w || !h) return;
      count += 1;
      bytes += w * h * 4;
      if (!(isPot(w) && isPot(h))) npot += 1;
      var fmt = tex._format;
      var label = String(fmt);
      formats[label] = (formats[label] || 0) + 1;
      big.push({ w: w, h: h, mb: round(w * h * 4 / 1048576) });
    });
    big.sort(function (a, b) { return b.mb - a.mb; });
    return {
      status: "ok",
      count: count,
      mb: round(bytes / 1048576),
      npot: npot,
      formats: formats,
      largest: big.slice(0, 8),
      note: "RGBA8888 width*height*4 when the texture object does not expose bytes per pixel."
    };
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
    summary: function () {
      var open = state.stage ? finishStage(state.stage) : null;
      return {
        schemaVersion: 1,
        conditions: device(),
        channels: {
          frameLoop: state.loopHooked ? "mainLoop" : "raf",
          gpuTimer: !!state.gpuExt,
          jsHeap: !!performance.memory,
          textureResidency: textureInfo().status,
          sceneName: state.sceneLog.length > 0
        },
        sceneLog: state.sceneLog,
        stages: state.stages.map(finishStage).concat(open ? [open] : []),
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
