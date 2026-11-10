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
    gpuSeries: [],
    t0: performance.now(),
    stage: null,
    stages: [],
    sceneLog: [],
    sceneName: "",
    gameReady: false,
    loopHooked: false,
    loopName: null,
    loopFrames: 0,
    frameCount: 0,
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

  // Bucket row: [startMs, frames, maxDtMs, cpuMsSum or null, badFrames, maxDraws, texUploadMb, maxPresentMs, presentedFrames]
  function bucketFrame(now, dt, cpu, draws) {
    var start = Math.floor((now - state.t0) / BUCKET_MS) * BUCKET_MS;
    var b = state.bucket;
    if (!b || b[0] !== start) {
      if (b && state.buckets.length < SERIES_CAP) state.buckets.push(b);
      b = state.bucket = [start, 0, 0, null, 0, 0, 0, 0, 0];
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
      texStart: state.texBytes,
      gpuStart: gpuTotal(),
      gpuPeak: gpuTotal(),
      bad: 0,
      // Frames that reached the screen, as vsync multiples: hist[k] counts gaps of k vsyncs.
      pres: { n: 0, hist: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0], wasted: 0 }
    };
  }

  function closeStage() {
    var s = state.stage;
    if (!s) return;
    s.t1 = performance.now();
    s.heapEnd = heapMb();
    s.texEnd = state.texBytes;
    s.gpuEnd = gpuTotal();
    s.vsyncMs = vsyncMs();
    s.capFps = frameCap();
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
    state.lastDraws = draws;
    bucketFrame(now, dt, cpu, draws);
    var s = state.stage;
    if (!s) return;
    state.frameCount += 1;
    s.frames += 1;
    s.sumDt += dt;
    s.sumDraws += draws;
    if (dt > BAD_FRAME_MS) s.bad += 1;
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

  // Live GPU memory from WebGL allocation calls: textures, buffers and renderbuffers that are
  // still alive. The default framebuffer is not included. Drivers pad and keep mips, so this is an
  // estimate of what the page asked for, not what the GPU reports.
  var gpuSizes = new WeakMap();
  var gpuMem = state.gpuMem = { tex: 0, buf: 0, rb: 0, peak: 0 };
  function gpuTotal() {
    return gpuMem.tex + gpuMem.buf + gpuMem.rb;
  }
  function gpuSet(obj, kind, key, bytes) {
    if (!obj || !(bytes >= 0)) return;
    var e = gpuSizes.get(obj);
    if (!e) {
      e = { kind: kind, bytes: 0, parts: {} };
      gpuSizes.set(obj, e);
    }
    var delta = bytes - (e.parts[key] || 0);
    e.parts[key] = bytes;
    e.bytes += delta;
    gpuMem[kind] += delta;
    var total = gpuTotal();
    if (total > gpuMem.peak) gpuMem.peak = total;
    if (state.stage && total > (state.stage.gpuPeak || 0)) state.stage.gpuPeak = total;
  }
  function gpuFree(obj) {
    var e = obj && gpuSizes.get(obj);
    if (!e) return;
    gpuMem[e.kind] -= e.bytes;
    gpuSizes.delete(obj);
  }
  function gpuBind(gl) {
    return gl.__spBind || (gl.__spBind = { unit: 0, tex: {}, buf: {}, rb: null });
  }
  var CUBE_FACE0 = 0x8515;
  function texSlot(gl, target) {
    var face = target >= CUBE_FACE0 && target <= CUBE_FACE0 + 5 ? target - CUBE_FACE0 : -1;
    var bindTarget = face >= 0 ? 0x8513 : target;
    var b = gpuBind(gl);
    return { tex: b.tex[b.unit + ":" + bindTarget], face: face < 0 ? 0 : face };
  }
  function texelBytes(format, type) {
    if (type === 0x8033 || type === 0x8034 || type === 0x8363) return 2;
    var per = type === 0x1406 ? 4 : type === 0x140b || type === 0x8d61 || type === 0x1403 ? 2 : 1;
    var ch = format === 0x1909 || format === 0x1906 || format === 0x1903 ? 1 : format === 0x190a || format === 0x8227 ? 2 : 4;
    return ch * per;
  }
  function sourceSize(src) {
    if (!src) return null;
    var w = src.videoWidth || src.naturalWidth || src.displayWidth || src.width;
    var h = src.videoHeight || src.naturalHeight || src.displayHeight || src.height;
    return w && h ? [w, h] : null;
  }

  function hookGpuMemory(proto) {
    var wrap = function (name, fn) {
      if (typeof proto[name] !== "function") return;
      var orig = proto[name];
      proto[name] = function () {
        try { fn.apply(this, arguments); } catch (e) {}
        return orig.apply(this, arguments);
      };
    };
    wrap("activeTexture", function (unit) { gpuBind(this).unit = unit; });
    wrap("bindTexture", function (target, tex) { var b = gpuBind(this); b.tex[b.unit + ":" + target] = tex; });
    wrap("texImage2D", function (target, level, internalformat) {
      var slot = texSlot(this, target);
      var bytes;
      if (arguments.length >= 8) bytes = arguments[3] * arguments[4] * texelBytes(arguments[6], arguments[7]);
      else {
        var size = sourceSize(arguments[5]);
        bytes = size ? size[0] * size[1] * texelBytes(arguments[3], arguments[4]) : null;
      }
      if (bytes != null) gpuSet(slot.tex, "tex", slot.face + ":" + level, bytes);
    });
    wrap("compressedTexImage2D", function (target, level) {
      var slot = texSlot(this, target);
      var data = arguments[6];
      var bytes = data && data.byteLength != null ? data.byteLength : typeof arguments[6] === "number" ? arguments[6] : null;
      if (bytes != null) gpuSet(slot.tex, "tex", slot.face + ":" + level, bytes);
    });
    wrap("texStorage2D", function (target, levels, internalformat, w, h) {
      var slot = texSlot(this, target);
      var bytes = 0;
      for (var i = 0; i < levels; i += 1) bytes += Math.max(1, w >> i) * Math.max(1, h >> i) * 4;
      gpuSet(slot.tex, "tex", "storage", bytes * (target === 0x8513 ? 6 : 1));
    });
    wrap("generateMipmap", function (target) {
      var slot = texSlot(this, target);
      var e = slot.tex && gpuSizes.get(slot.tex);
      if (e && e.parts["0:0"]) gpuSet(slot.tex, "tex", "mips", Math.round(e.parts["0:0"] / 3));
    });
    wrap("deleteTexture", function (tex) { gpuFree(tex); });
    wrap("bindBuffer", function (target, buf) { gpuBind(this).buf[target] = buf; });
    wrap("bufferData", function (target, data) {
      var bytes = typeof data === "number" ? data : data && data.byteLength;
      if (bytes != null) gpuSet(gpuBind(this).buf[target], "buf", "0", bytes);
    });
    wrap("deleteBuffer", function (buf) { gpuFree(buf); });
    wrap("bindRenderbuffer", function (target, rb) { gpuBind(this).rb = rb; });
    wrap("renderbufferStorage", function (target, format, w, h) { gpuSet(gpuBind(this).rb, "rb", "0", w * h * 4); });
    wrap("renderbufferStorageMultisample", function (target, samples, format, w, h) { gpuSet(gpuBind(this).rb, "rb", "0", w * h * 4 * Math.max(1, samples)); });
    wrap("deleteRenderbuffer", function (rb) { gpuFree(rb); });
  }

  function gpuMb() {
    return round(gpuTotal() / 1048576);
  }

  function hookGL(proto) {
    if (!proto || proto.__slotPerf) return;
    proto.__slotPerf = true;
    hookGpuMemory(proto);
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
        state.lastTexUploadAt = performance.now();
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
  // The engine loop can run off vsync (Creator 2.x uses setTimeout for caps other than 30 and 60),
  // so its call interval is not what reaches the screen. This loop ticks once per vsync: it
  // measures the refresh interval, and a tick that sees new engine frames counts one presented frame.
  var vsyncRing = [];
  var lastSeen = 0;
  var lastPresent = 0;
  function vsyncMs() {
    if (vsyncRing.length < 10) return null;
    return pct(vsyncRing.slice().sort(function (a, b) { return a - b; }), 0.5);
  }
  function presentTick(t, dt) {
    if (dt > 0 && dt < 100) {
      vsyncRing.push(dt);
      if (vsyncRing.length > 240) vsyncRing.shift();
    }
    var seen = state.frameCount - lastSeen;
    if (seen <= 0) return;
    lastSeen = state.frameCount;
    var gap = lastPresent ? t - lastPresent : 0;
    lastPresent = t;
    var s = state.stage;
    var v = vsyncMs();
    if (!s || !v || !gap || gap > 10000) return;
    var k = Math.max(1, Math.round(gap / v));
    s.pres.n += 1;
    s.pres.hist[Math.min(k, 9)] += 1;
    s.pres.wasted += seen - 1;
    // Credit the bucket of the engine frame that was presented, which may be one vsync back.
    var b = state.bucket;
    if (b) {
      b[8] += 1;
      if (gap > b[7]) b[7] = round(gap);
    }
  }
  function rafLoop(t) {
    var dt = t - lastRaf;
    lastRaf = t;
    if (performance.now() - state.loopHookedAt > 500) {
      recordFrame(dt, null, drawsThisFrame());
    }
    presentTick(t, dt);
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
    if (state.gl && state.gpuSeries.length < SERIES_CAP) state.gpuSeries.push([rel(performance.now()), gpuMb(), round(gpuMem.tex / 1048576)]);
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
    return { avg: round(sum / arr.length), p50: pct(sorted, 0.5), p95: pct(sorted, 0.95), p99: pct(sorted, 0.99), max: round(sorted[sorted.length - 1]) };
  }

  function frameCap() {
    var g = window.cc && window.cc.game;
    if (!g) return 60;
    try {
      return (typeof g.getFrameRate === "function" && g.getFrameRate()) || g.frameRate || (g.config && g.config.frameRate) || 60;
    } catch (e) {
      return 60;
    }
  }

  function dropShare(dts, fps) {
    if (dts.length < 20 || !fps) return null;
    var med = pct(dts.slice().sort(function (a, b) { return a - b; }), 0.5);
    var expected = Math.min(1000 / med, frameCap());
    return Math.max(0, Math.round(1000 * (1 - fps / expected)) / 1000);
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
      // 1% low: the FPS of the slowest 1% of frames. badShare: share of frames over BAD_FRAME_MS.
      fpsLow: s.dts.length >= 20 ? round(1000 / pct(s.dts.slice().sort(function (a, b) { return a - b; }), 0.99)) : null,
      badShare: s.frames ? Math.round((1000 * s.bad) / s.frames) / 1000 : null,
      // dropShare: expected frames that never showed. Expected is the slower of the display
      // refresh (median frame) and the engine's frame cap, so a 60 cap on a 64 Hz screen is not a drop.
      dropShare: dropShare(s.dts, s.sumDt > 0 ? 1000 / (s.sumDt / s.frames) : 0),
      frameMs: stat(s.dts),
      gpuMemMb: { start: round(s.gpuStart / 1048576), end: round((s.gpuEnd == null ? gpuTotal() : s.gpuEnd) / 1048576), peak: round(s.gpuPeak / 1048576) },
      cpuMs: stat(s.cpus),
      cpuFrames: s.cpus.length,
      gpuMs: s.gpuN ? stat(s.gpus) : null,
      cpuPct: cpuPct,
      gpuPct: gpuPct,
      draws: stat(s.draws),
      hitches: s.hitches,
      heapStartMb: s.heapStart,
      heapEndMb: s.heapEnd == null ? heapMb() : s.heapEnd,
      texUploadMb: round((s.texEnd - s.texStart) / 1048576),
      // What reached the screen. capFps is cc.game's frame cap when the stage closed.
      presented: { frames: s.pres.n, hist: s.pres.hist, wasted: s.pres.wasted, vsyncMs: s.vsyncMs != null ? s.vsyncMs : vsyncMs(), capFps: s.capFps != null ? s.capFps : frameCap() }
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

  function nodeText(node) {
    var out = [];
    var stack = [node];
    while (stack.length && out.length < 4) {
      var n = stack.pop();
      if (n.activeInHierarchy === false) continue;
      var comps = n._components || n.components || [];
      for (var i = 0; i < comps.length; i += 1) {
        var s = comps[i] && comps[i].string;
        if (typeof s === "string" && s.trim()) out.push(s.trim().slice(0, 30));
      }
      var kids = n.children || n._children || [];
      for (var k = 0; k < kids.length; k += 1) stack.push(kids[k]);
    }
    return out.join(" ");
  }

  // Center of a node in CSS pixels of the page, or null. Best effort; confirm with a screenshot.
  function screenPoint(node) {
    var cc = window.cc;
    var canvas = document.querySelector("canvas");
    if (!cc || !canvas) return null;
    try {
      var rect = canvas.getBoundingClientRect();
      var p = null;
      var ui = cc.UITransform && node.getComponent && node.getComponent(cc.UITransform);
      if (ui && cc.Camera) {
        var cams = cc.director.getScene().getComponentsInChildren(cc.Camera);
        var cam = null;
        for (var i = 0; i < cams.length; i += 1) {
          if (cams[i].visibility == null || (cams[i].visibility & node.layer)) { cam = cams[i]; break; }
        }
        if (!cam) return null;
        var box = ui.getBoundingBoxToWorld();
        var out = new cc.Vec3();
        cam.worldToScreen(out, new cc.Vec3(box.x + box.width / 2, box.y + box.height / 2, 0));
        p = { x: out.x / canvas.width, y: 1 - out.y / canvas.height };
      } else if (node.convertToWorldSpaceAR && cc.view) {
        var w = node.convertToWorldSpaceAR(cc.v2(0, 0));
        // The canvas can be wider than the game. Menus parked just outside the design area are
        // active but cannot be hit, so treat them as off screen.
        if (cc.view.getVisibleSize && cc.view.getVisibleOrigin) {
          var vs = cc.view.getVisibleSize();
          var vo = cc.view.getVisibleOrigin();
          if (w.x < vo.x || w.x > vo.x + vs.width || w.y < vo.y || w.y > vo.y + vs.height) return null;
        }
        var vp = cc.view.getViewportRect();
        var px = w.x * cc.view.getScaleX() + vp.x;
        var py = w.y * cc.view.getScaleY() + vp.y;
        p = { x: px / canvas.width, y: 1 - py / canvas.height };
      }
      if (!p || !isFinite(p.x) || !isFinite(p.y) || p.x < 0 || p.x > 1 || p.y < 0 || p.y > 1) return null;
      return { x: Math.round(rect.left + p.x * rect.width), y: Math.round(rect.top + p.y * rect.height) };
    } catch (e) {
      return null;
    }
  }

  function lower(words) {
    return (words || []).map(function (w) { return String(w).toLowerCase(); });
  }

  function hits(hay, words) {
    return words.some(function (w) { return hay.indexOf(w) >= 0; });
  }

  var TOUCH_EVENTS = ["touchend", "touchstart", "mouseup", "mousedown", "touch-end", "touch-start", "mouse-up", "mouse-down"];

  function listensToTouch(node) {
    if (node._touchListener) return true;
    if (typeof node.hasEventListener !== "function") return false;
    try {
      return TOUCH_EVENTS.some(function (e) { return node.hasEventListener(e); });
    } catch (e) {
      return false;
    }
  }

  // Clickable Cocos nodes: cc.Button, or any node with a touch or mouse listener.
  function clickables(limit) {
    var list = [];
    var root = window.cc && window.cc.director.getScene();
    walkScene(function (node) {
      if (list.length >= limit || node.activeInHierarchy === false || node === root) return;
      var comps = node._components || node.components || [];
      var btn = null;
      for (var i = 0; i < comps.length; i += 1) {
        if (className(comps[i]) === "cc.Button" && comps[i].enabled !== false) { btn = comps[i]; break; }
      }
      if (!btn && !listensToTouch(node)) return;
      list.push({ kind: btn ? "button" : "touch", name: node.name || "", text: nodeText(node), interactable: btn ? btn.interactable !== false : true, node: node });
    });
    return list;
  }

  function buttonList(words) {
    var match = lower(words);
    return clickables(200)
      .filter(function (b) { return !match.length || hits((b.name + " " + b.text).toLowerCase(), match); })
      .slice(0, 30)
      .map(function (b) { return { kind: b.kind, name: b.name, text: b.text, interactable: b.interactable, point: screenPoint(b.node) }; });
  }

  function domCandidates(words) {
    var out = [];
    if (!words.length || !document.querySelectorAll) return out;
    var els = document.querySelectorAll("button, a, [role=button], [onclick], div, span");
    for (var i = 0; i < els.length && out.length < 10; i += 1) {
      var el = els[i];
      var text = (el.innerText || el.textContent || "").trim();
      if (!text || text.length > 16 || !hits(text.toLowerCase(), words)) continue;
      var r = el.getBoundingClientRect();
      if (!r.width || !r.height || getComputedStyle(el).visibility === "hidden") continue;
      out.push({ kind: "dom", name: el.tagName.toLowerCase(), text: text, interactable: !el.disabled, point: { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) } });
    }
    return out;
  }

  function activeTexts(limit) {
    var out = [];
    walkScene(function (node) {
      if (out.length >= limit || node.activeInHierarchy === false) return;
      var comps = node._components || node.components || [];
      for (var i = 0; i < comps.length; i += 1) {
        var s = comps[i] && comps[i].string;
        if (typeof s === "string" && s.trim()) out.push(s.trim().slice(0, 30));
      }
    });
    return out;
  }

  // What stands between loading and the first spin. cfg is protocol/thresholds.json "entry".
  function entryState(cfg) {
    cfg = cfg || {};
    var spinW = lower(cfg.spinWords);
    var startW = lower(cfg.startWords);
    var dismissW = lower(cfg.dismissWords);
    var tapW = lower(cfg.tapAnywhereWords);
    var avoidW = lower(cfg.avoidWords);
    var hasScene = !!(window.cc && cc.director && cc.director.getScene && cc.director.getScene());
    var all = hasScene ? clickables(300) : [];
    var pick = function (words) {
      return all
        .filter(function (b) {
          var hay = (b.name + " " + b.text).toLowerCase();
          return hits(hay, words) && !hits(hay, avoidW);
        })
        .slice(0, 8)
        .map(function (b) { return { kind: b.kind, name: b.name, text: b.text, interactable: b.interactable, point: screenPoint(b.node) }; });
    };
    var texts = hasScene ? activeTexts(60) : [];
    var spin = pick(spinW);
    return {
      quietMs: Math.round(performance.now() - (state.lastTexUploadAt || state.t0)),
      scene: hasScene,
      spinReady: spin.some(function (b) { return b.interactable; }),
      spin: spin,
      start: pick(startW),
      dismiss: pick(dismissW),
      dom: domCandidates(startW.concat(dismissW).filter(function (w) { return !hits(w, avoidW); })),
      tapAnywhere: texts.filter(function (t) { return hits(t.toLowerCase(), tapW); }).slice(0, 3),
      texts: texts.slice(0, 20)
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
    // Walks the live scene. Call it while a stage is on screen, not every frame.
    cocos: function (label) {
      var info = cocosInfo();
      info.at = label || (state.stage && state.stage.name) || null;
      info.t = rel(performance.now());
      return info;
    },
    // Clickable Cocos nodes, optionally only those whose name or text contains one of words.
    // quietMs is how long since the last texture upload, a sign that loading has settled.
    buttons: function (words) {
      return {
        quietMs: Math.round(performance.now() - (state.lastTexUploadAt || state.t0)),
        buttons: buttonList(words)
      };
    },
    entry: function (cfg) {
      return entryState(cfg);
    },
    // Cheap reading for drivers: last second of frames, current draws, optional active node count.
    live: function (withNodes) {
      var now = performance.now() - state.t0;
      var rows = state.buckets.slice(-6).concat(state.bucket ? [state.bucket] : []).filter(function (b) { return b[0] >= now - 1000 - BUCKET_MS; });
      var frames = rows.reduce(function (a, b) { return a + b[1]; }, 0);
      var span = rows.length ? Math.max(BUCKET_MS, now - rows[0][0]) : 0;
      var out = {
        stage: state.stage && state.stage.name,
        fps: span ? round((1000 * frames) / span) : null,
        draws: state.lastDraws == null ? null : state.lastDraws,
        gpuMb: gpuMb(),
        heapMb: heapMb()
      };
      if (withNodes) {
        var n = 0;
        walkScene(function (node) { if (node.activeInHierarchy !== false) n += 1; });
        out.activeNodes = n;
      }
      return out;
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
          gpuMemory: !!state.gl,
          sceneName: state.sceneLog.length > 0
        },
        sceneLog: state.sceneLog,
        stages: state.stages.map(finishStage).concat(open ? [open] : []),
        timeline: {
          bucketMs: BUCKET_MS,
          badFrameMs: BAD_FRAME_MS,
          bucketFields: ["startMs", "frames", "maxDtMs", "cpuMs", "badFrames", "maxDraws", "texUploadMb", "maxPresentMs", "presentedFrames"],
          buckets: state.buckets.concat(state.bucket ? [state.bucket.slice(0, 9)] : []),
          longTasks: state.longTasks,
          longTaskFields: ["startMs", "durationMs", "inFlight"],
          marks: state.marks,
          heap: state.heapSeries,
          textures: state.textureSeries,
          gpu: state.gpuSeries,
          gpuFields: ["t", "totalMb", "textureMb"]
        },
        memory: {
          heapMb: heapMb(),
          gpu: { status: state.gl ? "ok" : "unavailable", mb: gpuMb(), peakMb: round(gpuMem.peak / 1048576), textureMb: round(gpuMem.tex / 1048576), bufferMb: round(gpuMem.buf / 1048576), renderbufferMb: round(gpuMem.rb / 1048576), note: "Live WebGL allocations the page asked for. Excludes the default framebuffer and driver padding." },
          texUploadMb: round(state.texBytes / 1048576),
          texUploads: state.texUploads,
          textures: textureInfo()
        }
      };
    }
  };
})();
