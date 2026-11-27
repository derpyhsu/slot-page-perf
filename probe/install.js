(function () {
  if (window.__slotPerf && window.__slotPerf.version === 1) return;

  var HITCH_MS = 50;
  var BUCKET_MS = 250;
  var BAD_FRAME_MS = 33;
  // Uploads at least this large count as loading still going on (settle wait). Glyph and small
  // label updates stay under it.
  var SETTLE_UPLOAD_BYTES = 256 * 1024;
  var HEAP_SAMPLE_MS = 1000;
  var TEXTURE_SAMPLE_MS = 5000;
  var SPINE_SAMPLE_MS = 500;
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
    shaderMs: 0,
    shaderN: 0,
    shaderMax: 0,
    shaderStalls: [],
    audioBytes: 0,
    audioPcm: 0,
    audioN: 0,
    audioMs: 0,
    audioMaxMs: 0,
    gameReadyAt: null,
    active: new Set(),
    gpuExt: null,
    pendingGpu: [],
    lastDrawSample: 0,
    // Spine components seen drawable at least once (any sample or snapshot), and how many samples ran.
    spineShown: typeof WeakSet !== "undefined" ? new WeakSet() : null,
    spineSamples: 0,
    // Long Animation Frame entries at or above HITCH_MS (see timeline.loafFields).
    loafs: [],
    // What ran between two recorded frames. A hitch keeps a copy as `work`; reset after each frame.
    fw: null,
    afterUpdateAt: 0,
    // Component update timing: wrapped classes, call count, measured cost per wrapped call.
    compWrapped: 0,
    lblWrapped: 0,
    lblReg: null,
    made: [],
    pools: [],
    wsEvents: [],
    progress: [],
    madeOff: false,
    compClassCount: -1,
    compCalls: 0,
    compFramesSeen: 0,
    compCallUs: null,
    compOff: false
  };

  function newLedger() {
    return { texN: 0, texBytes: 0, texMs: 0, texTopBytes: 0, texTop: "", dlDone: 0, dlNames: [], dlMax: 0, desN: 0, desMs: 0, shN: 0, shMs: 0, instN: 0, instMs: 0, instTop: "", instTopMs: 0, upd: 0, rnd: 0, ticks: 0, comps: {}, calls: 0, lblN: 0, lblMs: 0, lbl: null, wsN: 0, wsMs: 0, wsTopMs: 0, wsTopBytes: 0, actN: 0, actOff: 0, actMs: 0, churn: 0, actSeen: null, actTopMs: 0, actTopNode: null, hdN: 0, hdMs: 0, hdTop: "", hdTopMs: 0, texCanvasN: 0, texCanvasBytes: 0, texCanvasMs: 0, texLbl: null, spN: 0, spMs: 0, spTop: "", spTopMs: 0 };
  }
  state.fw = newLedger();

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
    state.fw = newLedger();
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
      // Texture uploads by source: [count, bytes, ms]. lblUp: per label component, its uploads.
      up: { canvas: [0, 0, 0], image: [0, 0, 0], data: [0, 0, 0] },
      lblUp: null,
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
    s.upLabels = labelUploads(s.lblUp);
    s.lblUp = null;
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
    if (!(dt > 0) || dt > 10000) { state.fw = newLedger(); return; }
    if (!state.seenFrame) {
      state.seenFrame = true;
      openStage("loading");
    }
    var now = performance.now();
    if (dt > Math.max(BAD_FRAME_MS, 1.5 * (state.capMs || 1000 / 60))) state.lastBadAt = now;
    state.lastDraws = draws;
    bucketFrame(now, dt, cpu, draws);
    var s = state.stage;
    if (!s) { state.fw = newLedger(); return; }
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
        urls: urls,
        work: workOf(state.fw)
      });
    }
    state.fw = newLedger();
  }

  // Compact copy of the ledger for a hitch: only what was measured, top 3 component classes.
  function workOf(fw) {
    var comps = Object.keys(fw.comps).map(function (k) { return [k, round(fw.comps[k])]; });
    comps.sort(function (a, b) { return b[1] - a[1]; });
    return {
      updMs: fw.ticks && !fw.noSplit ? round(fw.upd) : null,
      rndMs: fw.ticks && !fw.noSplit ? round(fw.rnd) : null,
      comps: state.compOff || !state.compWrapped ? null : comps.slice(0, 3),
      texN: fw.texN, texMb: round(fw.texBytes / 1048576), texMs: round(fw.texMs),
      texTop: fw.texTop || undefined, texTopMb: fw.texTopBytes ? round(fw.texTopBytes / 1048576) : undefined,
      dlDone: fw.dlDone, dlNames: fw.dlNames.length ? fw.dlNames : undefined, dlMax: Math.max(fw.dlMax, state.active.size),
      desN: fw.desN, desMs: round(fw.desMs),
      shN: fw.shN, shMs: round(fw.shMs),
      instN: fw.instN, instMs: round(fw.instMs), instTop: fw.instTop || undefined,
      texCanvas: fw.texCanvasN ? { n: fw.texCanvasN, mb: round(fw.texCanvasBytes / 1048576), ms: round(fw.texCanvasMs), top: safeTexLabels(fw) } : undefined,
      sp: fw.spN ? { n: fw.spN, ms: round(fw.spMs), top: fw.spTop || undefined, topMs: round(fw.spTopMs) } : undefined,
      lbl: state.compOff ? undefined : safeLabels(fw),
      ws: fw.wsN ? { n: fw.wsN, ms: round(fw.wsMs), topMs: round(fw.wsTopMs), topKb: round(fw.wsTopBytes / 1024) } : undefined,
      act: fw.actN + fw.actOff && !state.compOff ? { n: fw.actN, off: fw.actOff, ms: round(fw.actMs), churn: fw.churn, top: safePath(fw.actTopNode), topMs: round(fw.actTopMs) } : undefined,
      hd: fw.hdN && !state.compOff ? { n: fw.hdN, ms: round(fw.hdMs), top: fw.hdTop || undefined, topMs: round(fw.hdTopMs) } : undefined
    };
  }
  function safePath(node) {
    try { return node ? groupPath(node) : undefined; } catch (e) { return undefined; }
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
    // Chrome compiles and links in the background. The wait lands on the first status query
    // (getShaderParameter, getProgramParameter), so those are timed too; only compile and link count.
    ["compileShader", "linkProgram", "getShaderParameter", "getProgramParameter"].forEach(function (name) {
      if (typeof proto[name] !== "function") return;
      var orig = proto[name];
      var counts = name === "compileShader" || name === "linkProgram";
      proto[name] = function () {
        var t0 = performance.now();
        var ret = orig.apply(this, arguments);
        var ms = performance.now() - t0;
        state.shaderMs += ms;
        state.fw.shMs += ms;
        if (counts) { state.shaderN += 1; state.fw.shN += 1; }
        if (ms > state.shaderMax) state.shaderMax = ms;
        if (ms >= HITCH_MS && state.shaderStalls.length < 8) state.shaderStalls.push({ t: rel(t0), ms: round(ms), kind: name });
        return ret;
      };
    });
    ["texImage2D", "texSubImage2D", "compressedTexImage2D"].forEach(function (name) {
      if (typeof proto[name] !== "function") return;
      var orig = proto[name];
      proto[name] = function () {
        state.texUploads += 1;
        var t0 = performance.now();
        state.lastTexUploadAt = t0;
        var bytes = 0;
        try {
          var src = arguments[arguments.length - 1];
          if (src && src.byteLength) bytes = src.byteLength;
          else if (src && src.width && src.height) bytes = src.width * src.height * 4;
        } catch (e) {}
        state.texBytes += bytes;
        if (bytes >= SETTLE_UPLOAD_BYTES) state.lastBigUploadAt = t0;
        var srcArg = arguments[arguments.length - 1];
        var ret = orig.apply(this, arguments);
        state.fw.texN += 1;
        state.fw.texBytes += bytes;
        state.fw.texMs += performance.now() - t0;
        try { noteUpload(srcArg, bytes, performance.now() - t0); } catch (e) {}
        if (bytes > state.fw.texTopBytes) {
          state.fw.texTopBytes = bytes;
          var desc = "";
          try {
            var im = arguments[arguments.length - 1];
            if (im && im.width && im.height) desc = im.width + "x" + im.height;
            var u = im && (im.currentSrc || im.src);
            if (typeof u === "string" && u.indexOf("data:") !== 0) desc += " " + pathOnly(u).split("/").pop();
          } catch (e) {}
          state.fw.texTop = desc.slice(0, 80);
        }
        return ret;
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
        state.lastLongAt = Math.max(state.lastLongAt || 0, entry.startTime + entry.duration);
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

  // Long Animation Frames: which script ran (invoker type, file, function) and how long style and
  // layout took. Kept beside longTasks, which still feeds the load score.
  try {
    var LOAF = "long-animation-frame";
    if (PerformanceObserver.supportedEntryTypes && PerformanceObserver.supportedEntryTypes.indexOf(LOAF) >= 0) {
      var lo = new PerformanceObserver(function (list) {
        list.getEntries().forEach(function (e) {
          if (e.duration < HITCH_MS || state.loafs.length >= 400) return;
          var end = e.startTime + e.duration;
          var layout = e.styleAndLayoutStart > 0 ? end - e.styleAndLayoutStart : 0;
          var scripts = (e.scripts || []).slice().sort(function (a, b) { return b.duration - a.duration; }).slice(0, 3).map(function (s) {
            return [s.invokerType || "", String(s.invoker || "").slice(0, 60), pathOnly(s.sourceURL || ""), String(s.sourceFunctionName || "").slice(0, 60), round(s.duration), round(s.forcedStyleAndLayoutDuration || 0)];
          });
          state.loafs.push([Math.round(e.startTime - state.t0), round(e.duration), round(e.blockingDuration || 0), round(layout), scripts]);
        });
      });
      lo.observe({ type: LOAF, buffered: true });
    }
  } catch (e) {}

  function track(url, start) {
    var path = pathOnly(url);
    if (start) {
      state.active.add(path);
      if (state.active.size > state.fw.dlMax) state.fw.dlMax = state.active.size;
    } else if (state.active.delete(path)) {
      state.fw.dlDone += 1;
      if (state.fw.dlNames.length < 3) state.fw.dlNames.push(path.split("/").pop().slice(0, 60));
    }
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

  function hookAudio(Ctx) {
    if (!Ctx || !Ctx.prototype || Ctx.prototype.__slotAudio || typeof Ctx.prototype.decodeAudioData !== "function") return;
    Ctx.prototype.__slotAudio = true;
    var orig = Ctx.prototype.decodeAudioData;
    Ctx.prototype.decodeAudioData = function (data) {
      var bytes = data && data.byteLength ? data.byteLength : 0;
      var t0 = performance.now();
      state.audioBytes += bytes;
      state.audioN += 1;
      var ret = orig.apply(this, arguments);
      var done = function (buf) {
        var ms = performance.now() - t0;
        state.audioMs += ms;
        if (ms > state.audioMaxMs) state.audioMaxMs = ms;
        if (buf && buf.length && buf.numberOfChannels) state.audioPcm += buf.length * buf.numberOfChannels * 4;
      };
      if (ret && typeof ret.then === "function") ret.then(done, function () {});
      else done(ret);
      return ret;
    };
  }
  hookAudio(window.AudioContext);
  hookAudio(window.webkitAudioContext);

  // Chrome keeps 250 resource entries by default; a slot loads more than that before game-ready.
  try {
    if (performance.setResourceTimingBufferSize) performance.setResourceTimingBufferSize(3000);
  } catch (e) {}

  // Compact resource timing. Paths drop the query string so a session token never lands in the report.
  function resourceSummary() {
    var entries;
    try { entries = performance.getEntriesByType && performance.getEntriesByType("resource"); } catch (e) { entries = null; }
    if (!entries) return { status: "unavailable" };
    if (!entries.length) return { status: "empty", count: 0 };
    var hosts = {};
    var paths = {};
    var slow = [];
    var transfer = 0;
    var decoded = 0;
    var cached = 0;
    var duringPlay = state.gameReadyAt == null ? null : 0;
    // Requests that started before the spin button was ready, split by kind. Cocos asks for one
    // import JSON per asset unless the bundle merges them, so their count says whether it does.
    var load = { count: 0, transfer: 0, decoded: 0, cached: 0, json: 0, importJson: 0, images: 0, audio: 0, scripts: 0, queued: 0 };
    function shortPath(name) {
      var clean = String(name || "").split("?")[0].split("#")[0];
      var parts = clean.split("/").filter(Boolean);
      return parts.slice(-2).join("/") || clean;
    }
    function hostOf(name) {
      try { return new URL(name, location.href).host; } catch (e) { return ""; }
    }
    entries.forEach(function (e) {
      var path = shortPath(e.name);
      var host = hostOf(e.name) || "(page)";
      var ready = e.connectEnd || e.domainLookupEnd || e.fetchStart || e.startTime || 0;
      var queue = e.requestStart ? Math.max(0, e.requestStart - ready) : 0;
      var row = hosts[host] || (hosts[host] = { host: host, count: 0, queued: 0, queues: [], protocol: e.nextHopProtocol || "" });
      row.count += 1;
      if (queue >= 80) row.queued += 1;
      if (row.queues.length < 400) row.queues.push(queue);
      if (e.nextHopProtocol) row.protocol = e.nextHopProtocol;
      paths[path] = (paths[path] || 0) + 1;
      if (e.transferSize > 0) transfer += e.transferSize;
      if (e.decodedBodySize > 0) decoded += e.decodedBodySize;
      if (e.transferSize === 0 && e.decodedBodySize > 0) cached += 1;
      if (duringPlay != null && e.startTime >= state.gameReadyAt) duringPlay += 1;
      if (state.gameReadyAt == null || e.startTime < state.gameReadyAt) {
        var file = String(e.name || "").split("?")[0].split("#")[0].toLowerCase();
        load.count += 1;
        if (e.transferSize > 0) load.transfer += e.transferSize;
        if (e.decodedBodySize > 0) load.decoded += e.decodedBodySize;
        // Cross-origin files without Timing-Allow-Origin report no sizes, so a near-instant fetch
        // also counts as cached. On a throttled network nothing from the wire finishes in 5 ms.
        if (e.transferSize === 0 && (e.decodedBodySize > 0 || (e.duration || 0) < 5)) load.cached += 1;
        if (queue >= 80) load.queued += 1;
        if (/\.json$/.test(file)) {
          load.json += 1;
          if (/\/import\//.test(file)) load.importJson += 1;
        } else if (/\.(png|jpe?g|webp|gif|astc|pkm|pvr|ktx)$/.test(file)) load.images += 1;
        else if (/\.(mp3|ogg|wav|m4a|aac)$/.test(file)) load.audio += 1;
        else if (/\.js$/.test(file)) load.scripts += 1;
      }
      slow.push({ path: path, ms: round(e.duration || 0), queueMs: round(queue), kb: e.transferSize ? Math.round(e.transferSize / 1024) : 0 });
    });
    var hostRows = Object.keys(hosts).map(function (k) {
      var h = hosts[k];
      var qs = h.queues.slice().sort(function (a, b) { return a - b; });
      return { host: h.host, count: h.count, queued: h.queued, protocol: h.protocol, queueP95: qs.length ? round(qs[Math.min(qs.length - 1, Math.floor(qs.length * 0.95))]) : 0 };
    }).sort(function (a, b) { return b.queued - a.queued || b.count - a.count; }).slice(0, 4);
    var duplicates = Object.keys(paths).map(function (p) { return { path: p, count: paths[p] }; }).filter(function (d) { return d.count >= 2; }).sort(function (a, b) { return b.count - a.count; }).slice(0, 5);
    slow.sort(function (a, b) { return b.ms - a.ms; });
    var files = loadFiles(entries);
    return {
      status: "ok",
      files: files.rows,
      sizes: files.sized ? "ok" : "unavailable",
      bloated: imageBytesPerPixel(entries),
      count: entries.length,
      transferMb: round(transfer / 1048576),
      decodedMb: round(decoded / 1048576),
      cached: cached,
      duringPlay: duringPlay,
      load: { count: load.count, transferMb: round(load.transfer / 1048576), decodedMb: round(load.decoded / 1048576), cached: load.cached, json: load.json, importJson: load.importJson, images: load.images, audio: load.audio, scripts: load.scripts, queued: load.queued },
      hosts: hostRows,
      duplicates: duplicates,
      slowest: slow.slice(0, 5)
    };
  }

  // Requests made before the spin button was ready: [start, end] in ms from the probe start, KB
  // (-1 when the server does not expose sizes to the page, as cross-origin files without
  // Timing-Allow-Origin), short path, and the asset name when the file name is a uuid.
  function loadFiles(entries) {
    var rows = [];
    var sized = false;
    entries.forEach(function (e) {
      if (state.gameReadyAt != null && e.startTime >= state.gameReadyAt) return;
      if (rows.length >= 1500) return;
      var size = e.encodedBodySize > 0 ? e.encodedBodySize : e.transferSize > 0 ? e.transferSize : 0;
      if (size) sized = true;
      var clean = String(e.name || "").split("?")[0].split("#")[0];
      var short = clean.split("/").filter(Boolean).slice(-2).join("/");
      rows.push([Math.round(e.startTime - state.t0), Math.round((e.responseEnd || e.startTime + e.duration) - state.t0), size ? Math.round(size / 1024) : -1, short, assetNameOf(clean) || undefined]);
    });
    return { rows: rows, sized: sized };
  }
  var UUID_RE = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;
  function assetNameOf(url) {
    var m = UUID_RE.exec(url);
    var cc = window.cc;
    if (!m || !cc || !cc.assetManager) return null;
    var uuid = m[1].toLowerCase();
    try {
      var a = cc.assetManager.assets && cc.assetManager.assets.get(uuid);
      var n = a && (a.name || a._name);
      if (n) return String(n).slice(0, 60);
      var found = null;
      if (cc.assetManager.bundles) cc.assetManager.bundles.forEach(function (b) {
        if (found) return;
        var info = b.getAssetInfo ? b.getAssetInfo(uuid) : b._config && b._config.getAssetInfo && b._config.getAssetInfo(uuid);
        if (info && info.path) found = info.path;
      });
      return found ? String(found).slice(0, 80) : null;
    } catch (e) { return null; }
  }
  // Picture files larger than their pixels would be uncompressed (4 bytes a pixel): something other
  // than the picture is in the file, often editor metadata. Needs sizes, so same-origin builds only.
  function imageBytesPerPixel(entries) {
    var cc = window.cc;
    var items = allAssets();
    if (!items || !cc || !cc.Texture2D) return undefined;
    var sizes = {};
    entries.forEach(function (e) {
      var size = e.encodedBodySize || e.transferSize || 0;
      if (!size) return;
      var f = String(e.name || "").split("?")[0].split("#")[0].split("/").pop();
      if (/\.(png|jpe?g|webp)$/i.test(f)) sizes[f] = Math.max(sizes[f] || 0, size);
    });
    if (!Object.keys(sizes).length) return undefined;
    var out = [];
    var seen = [];
    items.forEach(function (tex) {
      if (!(tex instanceof cc.Texture2D) || seen.indexOf(tex) >= 0) return;
      seen.push(tex);
      var f = assetFile(tex);
      var size = f && sizes[f];
      if (!size || !tex.width || !tex.height) return;
      var bpp = size / (tex.width * tex.height);
      if (bpp > 4 && size > 200 * 1024) out.push({ file: f, name: assetNameOf(f) || undefined, w: tex.width, h: tex.height, kb: Math.round(size / 1024), bpp: round(bpp) });
    });
    return out.sort(function (a, b) { return b.kb - a.kb; }).slice(0, 10);
  }

  // Browser paint timing, in ms from navigation start. t0 is when the probe started on the same
  // clock, so stage times (relative to t0) can be put on it.
  function paintSummary() {
    var out = { t0: round(state.t0) };
    try {
      (performance.getEntriesByType("paint") || []).forEach(function (p) {
        if (p.name === "first-paint") out.fp = round(p.startTime);
        if (p.name === "first-contentful-paint") out.fcp = round(p.startTime);
      });
    } catch (e) {}
    return out;
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

  // Batch breaks on a sampled frame, counted by the engine's own batcher as it draws: each new draw
  // call goes to the render component whose commit started it, with the class pair at the switch
  // (a skeleton switching textures inside itself is "內部"). 2.x: ModelBatcher._flush on the
  // renderer's batcher and RenderComponent._checkBacth. 3.x: Batcher2D autoMergeBatches,
  // commitComp and commitMiddleware. The wrappers exist only for that one frame (put back in a
  // finally), only on spin and turbo stages, at most once every BB_EVERY_MS and BB_PER_STAGE times
  // a stage, when the last frame's draw calls were near the stage's highest so far. Component
  // references are dropped as soon as the frame is counted.
  var BB_EVERY_MS = 500, BB_PER_STAGE = 12;
  function batchWanted(lastDraws) {
    var s = state.stage;
    if (!s || !/^(spin|turbo)-\d+$/.test(s.name) || !(lastDraws > 0)) return false;
    s.bbSeen = Math.max(s.bbSeen || 0, lastDraws);
    if ((s.bbN || 0) >= BB_PER_STAGE || performance.now() - (state.bbLastAt || 0) < BB_EVERY_MS) return false;
    return lastDraws >= 0.9 * s.bbSeen;
  }
  function batchHookOn(cc) {
    var h = { counts: new Map(), pairs: {}, cur: null, prev: null, n: 0, undo: [] };
    var note = function () {
      h.n += 1;
      var c = h.cur;
      if (!c) return;
      h.counts.set(c, (h.counts.get(c) || 0) + 1);
      var pk = h.prev === c ? compName(c, cc) + " 內部" : (h.prev ? compName(h.prev, cc) : "?") + " → " + compName(c, cc);
      h.pairs[pk] = (h.pairs[pk] || 0) + 1;
    };
    var own = function (o, k) { return Object.prototype.hasOwnProperty.call(o, k); };
    var setOwn = function (o, k, f) {
      var had = own(o, k), was = o[k];
      o[k] = f;
      h.undo.push(function () { if (had) o[k] = was; else delete o[k]; });
    };
    try {
      var B3 = cc.director && cc.director.root && cc.director.root.batcher2D;
      var b2 = cc.renderer && cc.renderer._handle;
      var RC = cc.RenderComponent && cc.RenderComponent.prototype;
      if (B3 && typeof B3.autoMergeBatches === "function" && B3._batches) {
        var am = B3.autoMergeBatches;
        setOwn(B3, "autoMergeBatches", function () { var n0 = this._batches.length; var r = am.apply(this, arguments); for (var k = this._batches.length - n0; k > 0; k -= 1) note(); return r; });
        ["commitComp", "commitMiddleware"].forEach(function (m) {
          var f = B3[m];
          if (typeof f === "function") setOwn(B3, m, function (t) { h.prev = h.cur; h.cur = t; return f.apply(this, arguments); });
        });
        // commitIA and commitModel (graphics, masks, models in UI) push their own draw after
        // closing the previous batch; that draw is theirs.
        ["commitIA", "commitModel"].forEach(function (m) {
          var f = B3[m];
          if (typeof f !== "function") return;
          setOwn(B3, m, function (t) {
            h.prev = h.cur;
            h.cur = t;
            var n0 = this._batches.length, c0 = h.n;
            var r = f.apply(this, arguments);
            for (var k = this._batches.length - n0 - (h.n - c0); k > 0; k -= 1) note();
            return r;
          });
        });
      } else if (b2 && typeof b2._flush === "function" && b2._batchedModels && RC && typeof RC._checkBacth === "function") {
        var fl = b2._flush, ck = RC._checkBacth;
        setOwn(b2, "_flush", function () { var n0 = this._batchedModels.length; var r = fl.apply(this, arguments); if (this._batchedModels.length > n0) note(); return r; });
        RC._checkBacth = function () { h.prev = h.cur; h.cur = this; return ck.apply(this, arguments); };
        h.undo.push(function () { RC._checkBacth = ck; });
      } else return null;
    } catch (e) {
      batchHookOff(h);
      return null;
    }
    return h;
  }
  function batchHookOff(h) {
    while (h.undo.length) { try { h.undo.pop()(); } catch (e) {} }
  }
  function batchCount(h, draws, cc) {
    var s = state.stage;
    if (!s) return;
    var t0 = performance.now();
    s.bbN = (s.bbN || 0) + 1;
    state.bbLastAt = t0;
    var list = [];
    var byClass = {};
    h.counts.forEach(function (n, comp) {
      list.push([comp, n]);
      var k = compName(comp, cc);
      byClass[k] = (byClass[k] || 0) + n;
    });
    list.sort(function (a, b) { return b[1] - a[1]; });
    var byPath = {};
    list.slice(0, 20).forEach(function (x) {
      var k = groupPath(x[0].node || {}) + " [" + compName(x[0], cc) + "]";
      byPath[k] = (byPath[k] || 0) + x[1];
    });
    h.counts.clear();
    h.cur = h.prev = null;
    var top = function (o, n) { return Object.keys(o).map(function (k) { return [k, o[k]]; }).sort(function (a, b) { return b[1] - a[1]; }).slice(0, n); };
    var sample = { draws: draws, breaks: h.n, top: top(byPath, 8), classes: top(byClass, 6), pairs: top(h.pairs, 6), ms: round(performance.now() - t0) };
    // The batcher's count and the engine's draw calls for the frame should agree; far apart means
    // the hook missed a path (another renderer, a custom pipeline).
    if (draws > 0 && Math.abs(h.n - draws) > Math.max(3, draws * 0.3)) sample.partial = true;
    if (!s.bb || draws > s.bb.draws) s.bb = sample;
  }

  function hookDirector(cc) {
    var director = cc.director;
    if (state.loopHooked || !director) return;
    // Creator 3.x drives frames through director.tick and never calls mainLoop.
    var name = typeof director.tick === "function" ? "tick" : typeof director.mainLoop === "function" ? "mainLoop" : null;
    if (!name) return;
    state.loopHooked = true;
    state.loopName = name;
    try {
      var D = cc.Director;
      if (D && D.EVENT_AFTER_UPDATE && director.on) director.on(D.EVENT_AFTER_UPDATE, function () { state.afterUpdateAt = performance.now(); });
    } catch (e) {}
    var orig = director[name];
    var last = performance.now();
    var prevCpu = null, prevDraws = 0;
    director[name] = function () {
      var now = performance.now();
      var dt = now - last;
      last = now;
      state.loopHookedAt = now;
      state.loopFrames += 1;
      // The gap that ends now began when the previous tick started, so it holds that tick's work
      // and whatever ran between the two ticks. Record it before this tick adds its own.
      if (prevCpu != null) recordFrame(dt, prevCpu, prevDraws);
      else state.fw = newLedger();
      beginGpu();
      var bb = batchWanted(prevDraws) ? batchHookOn(cc) : null;
      var t0 = performance.now();
      var ret;
      try { ret = orig.apply(this, arguments); } finally { if (bb) batchHookOff(bb); }
      var t1 = performance.now();
      var cpu = t1 - t0;
      endGpu();
      // Split the tick at EVENT_AFTER_UPDATE: before it is game logic (components, schedulers,
      // tweens), after it is the engine drawing the frame.
      var fw = state.fw;
      fw.ticks += 1;
      if (state.afterUpdateAt >= t0 && state.afterUpdateAt <= t1) {
        fw.upd += state.afterUpdateAt - t0;
        fw.rnd += t1 - state.afterUpdateAt;
      } else {
        fw.noSplit = true;
      }
      if (fw.calls) { state.compCalls += fw.calls; state.compFramesSeen += 1; }
      prevCpu = cpu;
      prevDraws = drawsThisFrame();
      if (bb) batchCount(bb, prevDraws, cc);
      return ret;
    };
  }

  // Component update timing. Wrap update/lateUpdate on every registered component class (bundles
  // register more later, so rescan when the registry grows). Only the outermost call is timed, so a
  // super.update() call is not counted twice, and time goes to the concrete class of `this`.
  var compDepth = 0;
  function compName(obj, cc) {
    var C = obj.constructor;
    if (!C) return "?";
    if (!Object.prototype.hasOwnProperty.call(C, "__slotName")) {
      var n = "";
      try { n = cc.js.getClassName(C) || C.name || ""; } catch (e) {}
      try { Object.defineProperty(C, "__slotName", { value: n || "?", enumerable: false }); } catch (e) { return n || "?"; }
    }
    return C.__slotName;
  }
  function wrapMethod(proto, m, cc) {
    var orig = proto[m];
    if (typeof orig !== "function" || orig.__slotComp) return;
    var w = function () {
      if (compDepth || state.compOff) return orig.apply(this, arguments);
      compDepth = 1;
      var t0 = performance.now();
      try { return orig.apply(this, arguments); } finally {
        var ms = performance.now() - t0;
        compDepth = 0;
        var fw = state.fw, k = compName(this, cc) + "." + m;
        fw.comps[k] = (fw.comps[k] || 0) + ms;
        fw.calls += 1;
      }
    };
    w.__slotComp = true;
    proto[m] = w;
    state.compWrapped += 1;
  }
  function hookComponents(cc) {
    var reg = cc.js && (cc.js._registeredClassNames || cc.js._nameToClass);
    if (!reg || !cc.Component) return;
    var names = Object.keys(reg);
    if (names.length === state.compClassCount) return;
    state.compClassCount = names.length;
    names.forEach(function (n) {
      var C = reg[n];
      if (typeof C !== "function" || !C.prototype || !(C.prototype instanceof cc.Component)) return;
      ["update", "lateUpdate", "onLoad", "start", "onEnable"].forEach(function (m) {
        if (Object.prototype.hasOwnProperty.call(C.prototype, m)) wrapMethod(C.prototype, m, cc);
      });
    });
    if (state.compCallUs == null && state.compWrapped) {
      // Cost of one wrapper call over a bare call, measured once in this page.
      var dummy = { constructor: function () {} };
      var p = { f: function () {} };
      var bare = p.f;
      wrapMethod(p, "f", cc);
      state.compWrapped -= 1;
      var N = 20000, i, t0 = performance.now();
      for (i = 0; i < N; i++) bare.call(dummy);
      var t1 = performance.now();
      var save = state.fw;
      state.fw = newLedger();
      for (i = 0; i < N; i++) p.f.call(dummy);
      var t2 = performance.now();
      state.fw = save;
      state.compCallUs = Math.max(0, ((t2 - t1) - (t1 - t0)) / N * 1000);
    }
  }

  function hookInstantiate(cc) {
    if (typeof cc.instantiate !== "function" || cc.instantiate.__slotInst) return;
    var orig = cc.instantiate;
    var w = function (src) {
      var t0 = performance.now();
      var ret = orig.apply(this, arguments);
      var ms = performance.now() - t0;
      var fw = state.fw;
      fw.instN += 1;
      fw.instMs += ms;
      var n = "";
      try { n = String((src && (src.name || (src.data && src.data.name))) || (ret && ret.name) || "").slice(0, 60); } catch (e) {}
      if (ms > fw.instTopMs) {
        fw.instTopMs = ms;
        fw.instTop = n;
      }
      try { trackMade(ret, n); } catch (e) {}
      return ret;
    };
    for (var k in orig) { try { w[k] = orig[k]; } catch (e) {} }
    w.__slotInst = true;
    try { cc.instantiate = w; } catch (e) {}
  }

  // Nodes made by cc.instantiate, held weakly so the census after a forced GC sees only the ones
  // something still references. Nodes built with new cc.Node are not seen.
  var MADE_CAP = 30000;
  // cc.NodePool instances seen through put/get/size/clear, held weakly. Their _pool arrays are what
  // the census reads, so nodes put before the hook are counted too. Pools the game builds itself
  // (plain arrays) are not seen.
  var poolSeen = typeof WeakSet === "function" ? new WeakSet() : null;
  function hookPools(cc) {
    var NP = cc.NodePool || (cc.js && cc.js.getClassByName && cc.js.getClassByName("cc.NodePool"));
    var proto = NP && NP.prototype;
    if (!proto || proto.__slotPool || !poolSeen || typeof WeakRef !== "function") return;
    ["put", "get", "size", "clear"].forEach(function (m) {
      var orig = proto[m];
      if (typeof orig !== "function") return;
      proto[m] = function () {
        try { if (!poolSeen.has(this) && state.pools.length < 500) { poolSeen.add(this); state.pools.push(new WeakRef(this)); } } catch (e) {}
        return orig.apply(this, arguments);
      };
    });
    try { Object.defineProperty(proto, "__slotPool", { value: true }); } catch (e) {}
  }
  function pooledNodes() {
    var set = typeof Set === "function" ? new Set() : { has: function () { return false; }, add: function () {} };
    var n = 0;
    state.pools = state.pools.filter(function (r) {
      var p = r.deref();
      if (!p) return false;
      n += 1;
      (p._pool || []).forEach(function (x) { set.add(x); });
      return true;
    });
    return { set: set, pools: n };
  }
  function trackMade(node, name) {
    if (state.madeOff || typeof WeakRef !== "function" || !node || typeof node !== "object" || !("parent" in node || "_parent" in node)) return;
    if (state.made.length >= MADE_CAP) {
      state.made = state.made.filter(function (m) { return m.ref.deref() !== undefined; });
      if (state.made.length >= MADE_CAP) { state.madeOff = true; return; }
    }
    state.made.push({ ref: new WeakRef(node), name: name || "?" });
  }
  function topCounts(groups, n, by) {
    return Object.keys(groups).map(function (k) { return groups[k]; }).sort(by).slice(0, n);
  }
  // What the scene and instantiated nodes hold right now. Call it after a forced GC, in a gap:
  // the scene walk builds a path per node. Counts only; nothing is judged here.
  // Spine under nodes held in a cc.NodePool whose every track is a finished non-looping animation
  // while the skeleton still has an attachment to draw: the last frame stays on it, and the pool
  // gives the node back as it is. A skeleton in a cache mode, or one whose tracks or draw order
  // cannot be read (3.x Spine runs in wasm), is counted apart, never as clean. Only what the pools
  // hold; nothing is changed.
  function spineResidue(comp) {
    if (comp._cacheMode) return "cache";
    var stt = comp._state || (typeof comp.getState === "function" ? comp.getState() : null);
    var tracks = stt && stt.tracks;
    if (!tracks || typeof tracks.length !== "number") return "unreadable";
    var live = [];
    for (var i = 0; i < tracks.length; i += 1) if (tracks[i]) live.push(tracks[i]);
    if (!live.length) return "clean";
    var done = live.every(function (t) {
      if (t.loop) return false;
      if (typeof t.isComplete === "function") return t.isComplete();
      return typeof t.trackTime === "number" && t.trackTime >= (t.animationEnd || 0) - (t.animationStart || 0);
    });
    if (!done) return "clean";
    var sk = comp._skeleton;
    var order = sk && (sk.drawOrder || sk.slots);
    if (!order || typeof order.length !== "number") return "unreadable";
    var skA = sk.color && typeof sk.color.a === "number" ? sk.color.a : 1;
    for (var j = 0; j < order.length; j += 1) {
      var slot = order[j];
      if (!slot || (slot.bone && slot.bone.active === false)) continue;
      var att = typeof slot.getAttachment === "function" ? slot.getAttachment() : slot.attachment;
      if (!att) continue;
      var a = skA * (slot.color && typeof slot.color.a === "number" ? slot.color.a : 1) * (att.color && typeof att.color.a === "number" ? att.color.a : 1);
      if (a > 0) return "residue";
    }
    return "clean";
  }
  function poolResidue() {
    var out = { checked: 0, residue: 0, cacheMode: 0, unreadable: 0, byPath: {} };
    var pools = 0;
    state.pools.forEach(function (r) {
      var p = r.deref && r.deref();
      if (!p) return;
      pools += 1;
      (p._pool || []).forEach(function (root) {
        var visit = function (node, path, depth) {
          if (!node || depth > 12) return;
          var comps = node._components || node.components || [];
          for (var i = 0; i < comps.length; i += 1) {
            if (!/Skeleton/.test(className(comps[i]))) continue;
            out.checked += 1;
            var k = spineResidue(comps[i]);
            if (k === "residue") {
              out.residue += 1;
              var g = path.replace(/\d+/g, "*");
              out.byPath[g] = (out.byPath[g] || 0) + 1;
            } else if (k === "cache") out.cacheMode += 1;
            else if (k === "unreadable") out.unreadable += 1;
          }
          var kids = node._children || node.children || [];
          for (var j = 0; j < kids.length; j += 1) visit(kids[j], path + "/" + (kids[j] && kids[j].name || "?"), depth + 1);
        };
        visit(root, String(root && root.name || "?"), 0);
      });
    });
    if (!pools) return { status: "no pools" };
    if (!out.checked) return { status: "no spine in pools", pools: pools };
    out.status = out.unreadable && out.unreadable === out.checked - out.cacheMode ? "unavailable" : "ok";
    out.pools = pools;
    out.byPath = Object.keys(out.byPath).map(function (k) { return [k, out.byPath[k]]; }).sort(function (a, b) { return b[1] - a[1]; }).slice(0, 8);
    return out;
  }

  function census() {
    var cc = window.cc;
    var scene = cc && cc.director && cc.director.getScene && cc.director.getScene();
    if (!scene) return { status: "unavailable" };
    var paths = {};
    var total = 0;
    walkScene(function (node) {
      total += 1;
      var k = groupPath(node);
      var g = paths[k] || (paths[k] = [k, 0, 0]);
      g[1] += 1;
      if (node.activeInHierarchy !== false) g[2] += 1;
    });
    var pool = pooledNodes();
    var made = { status: typeof WeakRef !== "function" ? "unavailable" : state.madeOff ? "capped" : "ok", alive: 0, inScene: 0, detached: 0, destroyed: 0, pooled: 0, byName: [] };
    var byName = {};
    var keep = [];
    state.made.forEach(function (m) {
      var node = m.ref.deref();
      if (node === undefined) return;
      keep.push(m);
      made.alive += 1;
      var g = byName[m.name] || (byName[m.name] = { name: m.name, inScene: 0, detached: 0, destroyed: 0, pooled: 0 });
      if (node.isValid === false) { made.destroyed += 1; g.destroyed += 1; return; }
      var top = node;
      while (top && (top.parent || top._parent)) top = top.parent || top._parent;
      if (top === scene) { made.inScene += 1; g.inScene += 1; } else if (pool.set.has(node)) { made.pooled += 1; g.pooled += 1; } else { made.detached += 1; g.detached += 1; }
    });
    made.pools = pool.pools;
    Object.keys(byName).forEach(function (k) { if (!byName[k].pooled) delete byName[k].pooled; });
    state.made = keep;
    made.byName = topCounts(byName, 40, function (a, b) { return (b.detached + b.destroyed) - (a.detached + a.destroyed) || b.inScene - a.inScene; });
    // paths: [folded path, nodes, active], most nodes first, at most 1000 groups.
    var groups = Object.keys(paths).length;
    var inv;
    try { inv = invisibleDrawn(cc, scene); } catch (e) { inv = { status: "error" }; }
    var pr;
    try { pr = poolResidue(); } catch (e) { pr = { status: "error" }; }
    return { status: "ok", nodes: total, groups: groups, truncated: groups > 1000 || undefined, paths: topCounts(paths, 1000, function (a, b) { return b[1] - a[1]; }), made: made, invisible: inv, poolResidue: pr };
  }

  // Render nodes the engine still draws although nothing of them shows. Neither 2.x RenderFlow nor
  // 3.x Batcher2D culls by position, so a node whose own box lies outside its camera's view (pool
  // nodes parked far away) and a node whose box has no area because an ancestor is scaled to 0
  // still fill buffers and draw. In 2.x, Spine attachments at alpha 0 are still meshed and drawn,
  // and a skeleton with nothing to draw still breaks the batch around it. Both engines skip
  // opacity-0 subtrees, so those are not counted (hidden Spine bones are cocos-spine-hidden).
  // Only each node's own box is used, never the union with its children.
  var INV_TOP = 8;
  function invisibleDrawn(cc, scene) {
    var v3 = !!(cc.UITransform || /^3\./.test(String(cc.ENGINE_VERSION || "")));
    var out = { status: "ok", engine: v3 ? 3 : 2, offscreen: 0, scale0: 0, outsideMask: 0, checked: 0, noView: 0, offscreenBy: {}, scale0By: {}, outsideMaskBy: {} };
    if (!v3) out.spine = { skeletons: 0, transparent: 0, transparentScreens: 0, transparentBy: {}, empty: 0, emptyBy: {} };
    // Screen coverage: the area every drawn render node fills inside its camera's view (and inside
    // any ancestor mask), in screens. Many layers of full-screen art is what fill rate pays for.
    var cov = { screens: 0, full: 0, additive: 0, groups: {}, spineNoArea: 0 };
    var drawn = 0;
    var cover = null;
    var addCov = function (grp, screens, additive, full, node, alpha) {
      drawn += 1;
      if (full) cover = { path: groupPath(node), alpha: round(alpha, 2), under: drawn - 1 };
      if (!(screens > 0)) return;
      cov.screens += screens;
      if (additive) cov.additive += screens;
      if (full) cov.full += 1;
      var g = cov.groups[grp] || (cov.groups[grp] = [0, 0]);
      g[0] += screens;
      g[1] += 1;
    };
    var clipArea = function (b, v, c) {
      var x0 = Math.max(b.x0, v.x0, c ? c.x0 : -Infinity), x1 = Math.min(b.x1, v.x1, c ? c.x1 : Infinity);
      var y0 = Math.max(b.y0, v.y0, c ? c.y0 : -Infinity), y1 = Math.min(b.y1, v.y1, c ? c.y1 : Infinity);
      return x1 > x0 && y1 > y0 ? (x1 - x0) * (y1 - y0) : 0;
    };
    var isAdditive = function (comp) {
      var d = comp.dstBlendFactor != null ? comp.dstBlendFactor : comp._dstBlendFactor;
      return d === 1;
    };
    var views = new Map();
    var viewOf = function (node) {
      var cam = null;
      try {
        if (v3) {
          var cams = views.cams || (views.cams = scene.getComponentsInChildren(cc.Camera) || []);
          for (var i = 0; i < cams.length; i += 1) if (cams[i].enabledInHierarchy !== false && (cams[i].visibility == null || (cams[i].visibility & node.layer))) { cam = cams[i]; break; }
        } else if (cc.Camera && cc.Camera.findCamera) cam = cc.Camera.findCamera(node);
      } catch (e) { cam = null; }
      var k = cam || "none";
      if (views.has(k)) return views.get(k);
      var r = cameraView(cc, cam, v3);
      views.set(k, r);
      return r;
    };
    // A mask clips what is under it to its own box (rect, ellipse or image alike, the box bounds it).
    // Inside the view but wholly outside an ancestor mask still fills buffers and draws.
    var maskBox = function (node) {
      var comps = node._components || node.components || [];
      for (var i = 0; i < comps.length; i += 1) {
        var c = comps[i];
        if (!c || className(c) !== "cc.Mask" || c.enabledInHierarchy === false || c.enabled === false) continue;
        if (c.inverted || c._inverted) return null;
        return ownBox(node, v3);
      }
      return null;
    };
    var visit = function (node, opacity, clip, grp, depth) {
      if (!node || node.activeInHierarchy === false || node._activeInHierarchy === false) return;
      if (depth < 3) grp = (grp ? grp + "/" : "") + String(node.name || "?").replace(/\d+/g, "*");
      var op = opacity;
      if (v3) {
        var up = node._uiProps;
        var rc3 = up && up.uiComp;
        var a = rc3 && rc3.color && typeof rc3.color.a === "number" ? rc3.color.a / 255 : 1;
        op = opacity * a * (up && typeof up.localOpacity === "number" ? up.localOpacity : 1);
        if (op <= 0.0001) return;
        if (rc3 && rc3.enabledInHierarchy !== false && rc3._renderFlag !== false) rc3.__slotOp = op;
        // _renderFlag is false when the component has nothing it can draw (a sprite without a frame).
        if (rc3 && rc3.enabledInHierarchy !== false && rc3._renderFlag !== false) checkNode(node, rc3, clip, grp);
      } else {
        if (node._opacity === 0 || node.opacity === 0) return;
        op = opacity * (typeof node._opacity === "number" ? node._opacity / 255 : 1);
        var rc = node._renderComponent;
        if (rc && rc.enabledInHierarchy !== false && rc._enabled !== false) { rc.__slotOp = op; checkNode(node, rc, clip, grp); }
      }
      var mb = maskBox(node);
      var sub = mb ? (clip ? { x0: Math.max(clip.x0, mb.x0), x1: Math.min(clip.x1, mb.x1), y0: Math.max(clip.y0, mb.y0), y1: Math.min(clip.y1, mb.y1) } : mb) : clip;
      var kids = node._children || node.children || [];
      for (var i = 0; i < kids.length; i += 1) visit(kids[i], op, sub, grp, depth + 1);
    };
    var checkNode = function (node, comp, clip, grp) {
      var name = className(comp);
      if (/Skeleton|dragonBones|Armature/i.test(name)) {
        if (!v3 && /Skeleton/.test(name) && !comp._cacheMode) spineSlots(comp, node, clip, grp);
        else cov.spineNoArea += 1;
        return;
      }
      if (!v3 && cc.RenderFlow && cc.RenderFlow.FLAG_RENDER && typeof node._renderFlag === "number" && !(node._renderFlag & cc.RenderFlow.FLAG_RENDER)) return;
      var box = ownBox(node, v3);
      if (!box) return;
      out.checked += 1;
      var path = groupPath(node);
      if (box.area === 0) {
        out.scale0 += 1;
        out.scale0By[path] = (out.scale0By[path] || 0) + 1;
        return;
      }
      var view = viewOf(node);
      if (!view) { out.noView += 1; return; }
      if (box.x1 < view.x0 || box.x0 > view.x1 || box.y1 < view.y0 || box.y0 > view.y1) {
        out.offscreen += 1;
        out.offscreenBy[path] = (out.offscreenBy[path] || 0) + 1;
      } else if (clip && (box.x1 <= clip.x0 || box.x0 >= clip.x1 || box.y1 <= clip.y0 || box.y0 >= clip.y1)) {
        out.outsideMask += 1;
        out.outsideMaskBy[path] = (out.outsideMaskBy[path] || 0) + 1;
      } else {
        // The box is a rectangle through the node's transform; a rotated node's corners overcount a little.
        var shown = clipArea(box, view, clip) * Math.min(1, box.area / Math.max(1e-9, (box.x1 - box.x0) * (box.y1 - box.y0)));
        var ca = comp.color && typeof comp.color.a === "number" ? comp.color.a / 255 : 1;
        addCov(grp, shown / view.area, isAdditive(comp), shown >= 0.9 * view.area, node, (comp.__slotOp != null ? comp.__slotOp : 1) * (v3 ? 1 : ca));
      }
    };
    // 2.x realtime Spine: renderable attachments (they have uvs) at alpha 0, and skeletons with
    // none left to draw. Cached skeletons draw from baked frames and are not read here.
    var spineSlots = function (comp, node, clip, grp) {
      if (comp._cacheMode) return;
      var sk = comp._skeleton;
      var order = sk && sk.drawOrder;
      if (!order || typeof order.length !== "number") return;
      var sp = out.spine;
      sp.skeletons += 1;
      var path = groupPath(node);
      var skA = sk.color && typeof sk.color.a === "number" ? sk.color.a : 1;
      var drawn = 0, clear = 0, area = 0;
      var wm = worldAffine(node, false);
      var wview = viewOf(node);
      var det = wm ? Math.abs(wm.a * wm.d - wm.b * wm.c) : 0;
      var shownScreens = 0, addScreens = 0;
      for (var i = 0; i < order.length; i += 1) {
        var slot = order[i];
        if (!slot || (slot.bone && slot.bone.active === false)) continue;
        var att = typeof slot.getAttachment === "function" ? slot.getAttachment() : slot.attachment;
        if (!att || !att.uvs) continue;
        var a = skA * (slot.color && typeof slot.color.a === "number" ? slot.color.a : 1) * (att.color && typeof att.color.a === "number" ? att.color.a : 1);
        var geo = attachmentGeom(att, slot);
        if (a > 0) {
          drawn += 1;
          // Drawn slot: its triangles' area, cut to the part of its box inside the view and mask.
          if (geo && wm && wview && geo.area > 0) {
            var wb = affineBox(wm, geo);
            var full = (wb.x1 - wb.x0) * (wb.y1 - wb.y0);
            var s = full > 0 ? geo.area * det * (clipArea(wb, wview, clip) / full) / wview.area : 0;
            shownScreens += s;
            if (slot.data && slot.data.blendMode === 1) addScreens += s;
          }
          continue;
        }
        clear += 1;
        area += geo ? geo.area : 0;
      }
      if (drawn) addCov(grp, 0, false, false, node, 1);
      if (shownScreens > 0) {
        cov.screens += shownScreens;
        cov.additive += addScreens;
        var cg = cov.groups[grp] || (cov.groups[grp] = [0, 0]);
        cg[0] += shownScreens;
        cg[1] += 1;
      }
      if (clear) {
        sp.transparent += clear;
        var g = sp.transparentBy[path] || (sp.transparentBy[path] = [0, 0]);
        g[0] += clear;
        var view = viewOf(node);
        var m = worldAffine(node, false);
        if (view && m && area > 0) {
          var screens = area * Math.abs(m.a * m.d - m.b * m.c) / view.area;
          sp.transparentScreens += screens;
          g[1] += screens;
        }
      }
      if (!drawn) {
        sp.empty += 1;
        sp.emptyBy[path] = (sp.emptyBy[path] || 0) + 1;
      }
    };
    var roots = scene._children || scene.children || [];
    for (var r = 0; r < roots.length; r += 1) visit(roots[r], 1, null, "", 0);
    var top = function (by) {
      return Object.keys(by).map(function (k) { return [k, by[k]]; }).sort(function (a, b) { return b[1] - a[1]; }).slice(0, INV_TOP);
    };
    out.offscreenBy = top(out.offscreenBy);
    out.scale0By = top(out.scale0By);
    out.outsideMaskBy = top(out.outsideMaskBy);
    if (out.spine) {
      var sp = out.spine;
      sp.transparentScreens = round(sp.transparentScreens, 2);
      sp.transparentBy = Object.keys(sp.transparentBy).map(function (k) { var g = sp.transparentBy[k]; return [k, g[0], round(g[1], 2)]; })
        .sort(function (a, b) { return b[2] - a[2] || b[1] - a[1]; }).slice(0, INV_TOP);
      sp.emptyBy = top(sp.emptyBy);
    }
    out.coverage = {
      screens: round(cov.screens, 2),
      full: cov.full,
      additiveScreens: round(cov.additive, 2),
      spineNoArea: cov.spineNoArea || undefined,
      // The last drawn node that covers 90% of the view, its alpha, and how many drawn nodes are under it.
      cover: cover ? { path: cover.path, alpha: cover.alpha, under: cover.under, over: drawn - cover.under - 1 } : undefined,
      groups: Object.keys(cov.groups).map(function (k) { var g = cov.groups[k]; return [k, round(g[0], 2), g[1]]; }).sort(function (a, b) { return b[1] - a[1]; }).slice(0, 8)
    };
    return out;
  }
  // The world box of a skeleton-space box through a node's world transform.
  function affineBox(m, b) {
    var xs = [b.x0, b.x1], ys = [b.y0, b.y1];
    var x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (var i = 0; i < 2; i += 1) for (var j = 0; j < 2; j += 1) {
      var x = m.a * xs[i] + m.c * ys[j] + m.tx, y = m.b * xs[i] + m.d * ys[j] + m.ty;
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
    }
    return { x0: x0, x1: x1, y0: y0, y1: y1 };
  }

  // The affine part of a node's world matrix: x' = a*x + c*y + tx, y' = b*x + d*y + ty.
  function worldAffine(node, v3) {
    if (v3) {
      var w = node.worldMatrix || (node.getWorldMatrix && node.getWorldMatrix());
      return w ? { a: w.m00, b: w.m01, c: w.m04, d: w.m05, tx: w.m12, ty: w.m13 } : null;
    }
    if (typeof node._updateWorldMatrix === "function") node._updateWorldMatrix();
    var m = node._worldMatrix && node._worldMatrix.m;
    return m ? { a: m[0], b: m[1], c: m[4], d: m[5], tx: m[12], ty: m[13] } : null;
  }

  // A node's own box in world space from its content size and anchor, without its children.
  // null when it has no size to test (empty containers, labels with no text yet).
  function ownBox(node, v3) {
    var size, anchor;
    if (v3) {
      var ui = node._uiProps && node._uiProps.uiTransformComp;
      if (!ui) return null;
      size = ui.contentSize || ui._contentSize;
      anchor = ui.anchorPoint || ui._anchorPoint;
    } else {
      size = node._contentSize;
      anchor = node._anchorPoint;
    }
    if (!size || !(size.width > 0) || !(size.height > 0)) return null;
    var m = worldAffine(node, v3);
    if (!m) return null;
    var ax = anchor ? anchor.x : 0.5, ay = anchor ? anchor.y : 0.5;
    var xs = [-ax * size.width, (1 - ax) * size.width];
    var ys = [-ay * size.height, (1 - ay) * size.height];
    var x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (var i = 0; i < 2; i += 1) for (var j = 0; j < 2; j += 1) {
      var x = m.a * xs[i] + m.c * ys[j] + m.tx;
      var y = m.b * xs[i] + m.d * ys[j] + m.ty;
      if (x < x0) x0 = x; if (x > x1) x1 = x;
      if (y < y0) y0 = y; if (y > y1) y1 = y;
    }
    if (!isFinite(x0) || !isFinite(y0) || !isFinite(x1) || !isFinite(y1)) return null;
    return { x0: x0, x1: x1, y0: y0, y1: y1, area: Math.abs(m.a * m.d - m.b * m.c) * size.width * size.height };
  }

  // What a camera sees, as a world-space rectangle. 2D orthographic cameras only; a camera that
  // renders into a texture, or that cannot be read, gives null and its nodes are not judged.
  function cameraView(cc, cam, v3) {
    try {
      if (v3) {
        if (!cam || cam.targetTexture) return null;
        var canvas = cc.game && cc.game.canvas;
        if (!canvas || !cc.Vec3) return null;
        var old = /^3\.[0-3]\./.test(String(cc.ENGINE_VERSION || ""));
        var corner = function (x, y) {
          var o = new cc.Vec3();
          if (old) cam.screenToWorld(o, new cc.Vec3(x, y, 0)); else cam.screenToWorld(new cc.Vec3(x, y, 0), o);
          return o;
        };
        return rectOf(corner(0, 0), corner(canvas.width, canvas.height));
      }
      var vs = cc.view && cc.view.getVisibleSize && cc.view.getVisibleSize();
      if (!vs) return null;
      if (cam) {
        if (cam.targetTexture || cam.ortho === false) return null;
        if (typeof cam.getScreenToWorldPoint === "function") return rectOf(cam.getScreenToWorldPoint(cc.v2(0, 0)), cam.getScreenToWorldPoint(cc.v2(vs.width, vs.height)));
      }
      var vo = cc.view.getVisibleOrigin ? cc.view.getVisibleOrigin() : { x: 0, y: 0 };
      return rectOf({ x: vo.x, y: vo.y }, { x: vo.x + vs.width, y: vo.y + vs.height });
    } catch (e) {
      return null;
    }
  }
  function rectOf(p, q) {
    if (!p || !q || !isFinite(p.x) || !isFinite(q.x) || !isFinite(p.y) || !isFinite(q.y)) return null;
    var r = { x0: Math.min(p.x, q.x), x1: Math.max(p.x, q.x), y0: Math.min(p.y, q.y), y1: Math.max(p.y, q.y) };
    r.area = (r.x1 - r.x0) * (r.y1 - r.y0);
    return r.area > 0 ? r : null;
  }

  // Area of one Spine attachment in skeleton space, from its world vertices (spine-ts 3.x API).
  var spineVerts = null;
  function attachmentGeom(att, slot) {
    try {
      var n, tris;
      if (att.triangles && att.worldVerticesLength) {
        n = att.worldVerticesLength;
        spineVerts = spineVerts && spineVerts.length >= n ? spineVerts : new Float32Array(Math.max(n, 64));
        att.computeWorldVertices(slot, 0, n, spineVerts, 0, 2);
        tris = att.triangles;
      } else if (att.offset) {
        spineVerts = spineVerts && spineVerts.length >= 8 ? spineVerts : new Float32Array(64);
        att.computeWorldVertices(slot.bone, spineVerts, 0, 2);
        tris = [0, 1, 2, 2, 3, 0];
      } else return null;
      var sum = 0;
      var x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
      for (var i = 0; i + 2 < tris.length; i += 3) {
        var p = tris[i] * 2, q = tris[i + 1] * 2, r = tris[i + 2] * 2;
        sum += Math.abs((spineVerts[q] - spineVerts[p]) * (spineVerts[r + 1] - spineVerts[p + 1]) - (spineVerts[r] - spineVerts[p]) * (spineVerts[q + 1] - spineVerts[p + 1])) / 2;
        [p, q, r].forEach(function (k) { var vx = spineVerts[k], vy = spineVerts[k + 1]; if (vx < x0) x0 = vx; if (vx > x1) x1 = vx; if (vy < y0) y0 = vy; if (vy > y1) y1 = vy; });
      }
      return isFinite(sum) ? { area: sum, x0: x0, x1: x1, y0: y0, y1: y1 } : null;
    } catch (e) {
      return null;
    }
  }

  // Where an uploaded texture came from. A canvas is text drawn by a system-font or TTF label (or
  // another canvas the game draws); an image or bitmap is a picture file; typed data is a
  // compressed or raw texture. Canvases are matched to the label that owns them; a canvas upload
  // made while a label is being laid out is put on that label.
  var labelCanvas = typeof WeakMap === "function" ? new WeakMap() : null;
  function srcKind(src) {
    if (!src || typeof src !== "object") return "data";
    if (src.byteLength != null) return "data";
    if (typeof src.getContext === "function") return "canvas";
    return "image";
  }
  function noteLabelCanvas(comp) {
    try {
      var d = comp._assemblerData || comp.assemblerData;
      if (labelCanvas && d && d.canvas) labelCanvas.set(d.canvas, comp);
    } catch (e) {}
  }
  function strHash(str) {
    var h = 2166136261;
    for (var i = 0; i < str.length; i += 1) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
    return h >>> 0;
  }
  function noteUpload(src, bytes, ms) {
    var kind = srcKind(src);
    var s = state.stage;
    if (s) { var u = s.up[kind]; u[0] += 1; u[1] += bytes; u[2] += ms; }
    if (kind !== "canvas") return;
    var fw = state.fw;
    fw.texCanvasN += 1;
    fw.texCanvasBytes += bytes;
    fw.texCanvasMs += ms;
    var comp = (labelCanvas && labelCanvas.get(src)) || state.curLabel;
    if (!comp || typeof Map !== "function") return;
    var m = fw.texLbl || (fw.texLbl = new Map());
    var t = m.get(comp) || [0, 0];
    t[0] += 1; t[1] += bytes;
    m.set(comp, t);
    if (!s) return;
    // The same label uploaded again with the same text means the text was drawn again for nothing.
    var lm = s.lblUp || (s.lblUp = new Map());
    var r = lm.get(comp);
    if (!r) { r = { n: 0, bytes: 0, same: 0, sameBytes: 0, enable: 0, render: 0, component: 0, hash: null }; lm.set(comp, r); }
    var hash = typeof comp.string === "string" ? strHash(comp.string) : null;
    if (r.n && hash != null && hash === r.hash) { r.same += 1; r.sameBytes += bytes; }
    r.hash = hash;
    r.n += 1;
    r.bytes += bytes;
    if (actDepth) r.enable += 1; else if (compDepth) r.component += 1; else r.render += 1;
  }
  // Per stage: label uploads grouped by folded node path, most bytes first. Text is never kept.
  function labelUploads(lm) {
    if (!lm) return null;
    var groups = {};
    lm.forEach(function (r, comp) {
      var k = "?";
      try { k = comp.node ? groupPath(comp.node) : "?"; } catch (e) {}
      var g = groups[k] || (groups[k] = { path: k, labels: 0, n: 0, bytes: 0, same: 0, sameBytes: 0, enable: 0, render: 0, component: 0 });
      g.labels += 1; g.n += r.n; g.bytes += r.bytes; g.same += r.same; g.sameBytes += r.sameBytes;
      g.enable += r.enable; g.render += r.render; g.component += r.component;
    });
    var all = Object.keys(groups).map(function (k) { return groups[k]; });
    var tot = all.reduce(function (a, g) { a.labels += g.labels; a.same += g.same; a.sameBytes += g.sameBytes; return a; }, { labels: 0, same: 0, sameBytes: 0 });
    var top = all.sort(function (a, b) { return b.bytes - a.bytes; }).slice(0, 5).map(function (g) {
      return { path: g.path, labels: g.labels, n: g.n, mb: round(g.bytes / 1048576), same: g.same || undefined, sameMb: g.same ? round(g.sameBytes / 1048576) : undefined, enable: g.enable || undefined, render: g.render || undefined, component: g.component || undefined };
    });
    return { labels: tot.labels, same: tot.same, sameMb: round(tot.sameBytes / 1048576), top: top };
  }
  function uploadsOf(s) {
    var u = s.up;
    if (!u) return undefined;
    var f = function (x) { return x[0] ? { n: x[0], mb: round(x[1] / 1048576), ms: round(x[2]) } : undefined; };
    if (!u.canvas[0] && !u.image[0] && !u.data[0]) return undefined;
    return { canvas: f(u.canvas), image: f(u.image), data: f(u.data), labels: s.upLabels || (s.lblUp ? labelUploads(s.lblUp) : undefined) || undefined };
  }
  function safeTexLabels(fw) {
    try {
      if (!fw.texLbl) return undefined;
      var groups = {};
      fw.texLbl.forEach(function (t, comp) {
        var k = comp.node ? groupPath(comp.node) : "?";
        var g = groups[k] || (groups[k] = { path: k, n: 0, bytes: 0 });
        g.n += t[0]; g.bytes += t[1];
      });
      return Object.keys(groups).map(function (k) { return groups[k]; }).sort(function (a, b) { return b.bytes - a.bytes; }).slice(0, 3).map(function (g) { return { path: g.path, n: g.n, mb: round(g.bytes / 1048576) }; });
    } catch (e) { return undefined; }
  }

  // Spine skeleton data parsed on first use: SkeletonData.getRuntimeData builds the runtime data
  // from JSON or binary the first time a skeleton needs it, and caches it.
  function hookSpineBuild(cc) {
    var SD = null;
    try { SD = (window.sp && window.sp.SkeletonData) || (cc.js && cc.js.getClassByName && cc.js.getClassByName("sp.SkeletonData")); } catch (e) {}
    var proto = SD && SD.prototype;
    if (!proto || typeof proto.getRuntimeData !== "function" || proto.getRuntimeData.__slotSp) return;
    var orig = proto.getRuntimeData;
    var w = function () {
      if (this._skeletonCache) return orig.apply(this, arguments);
      var t0 = performance.now();
      var ret = orig.apply(this, arguments);
      var ms = performance.now() - t0;
      if (this._skeletonCache) {
        var fw = state.fw;
        fw.spN += 1;
        fw.spMs += ms;
        if (ms > fw.spTopMs) { fw.spTopMs = ms; fw.spTop = String(this.name || this._name || "").slice(0, 60); }
      }
      return ret;
    };
    w.__slotSp = true;
    try { proto.getRuntimeData = w; } catch (e) {}
  }

  // Label text layout and drawing. Every path that rebuilds a label's text, onEnable and the render
  // flow alike, ends in its assembler's updateRenderData(comp): 2.4 Label._applyFontTexture and
  // RenderFlow._updateRenderData, 3.x Label/UIRenderer.updateRenderData. The assembler is wrapped
  // before its first call: 2.x through cc.Label.__assembler__ and Label._resetAssembler, 3.x through
  // Label.Assembler.getAssembler. Per call only the time per component is kept; path, font and
  // settings are read when the frame turns out to be a hitch. The text itself is never kept.
  var lblDepth = 0;
  function wrapLabelAssembler(obj, cc) {
    var t = obj;
    while (t && t !== Object.prototype && !Object.prototype.hasOwnProperty.call(t, "updateRenderData")) t = Object.getPrototypeOf(t);
    if (!t || t === Object.prototype) return;
    var orig = t.updateRenderData;
    if (typeof orig !== "function" || orig.__slotLbl) return;
    var L = cc.Label;
    var w = function (comp) {
      if (!L || !(comp instanceof L)) return orig.apply(this, arguments);
      noteLabelCanvas(comp);
      var prev = state.curLabel;
      state.curLabel = comp;
      try {
        if (lblDepth || state.compOff) return orig.apply(this, arguments);
        lblDepth = 1;
        var t0 = performance.now();
        try { return orig.apply(this, arguments); } finally {
          var ms = performance.now() - t0;
          lblDepth = 0;
          var fw = state.fw;
          fw.lblMs += ms;
          fw.lblN += 1;
          fw.calls += 1;
          var m = fw.lbl || (fw.lbl = new Map());
          m.set(comp, (m.get(comp) || 0) + ms);
        }
      } finally {
        state.curLabel = prev;
        noteLabelCanvas(comp);
      }
    };
    w.__slotLbl = true;
    try { t.updateRenderData = w; state.lblWrapped += 1; } catch (e) {}
  }
  function hookLabels(cc) {
    var L = cc.Label;
    if (!L || !L.prototype) return;
    var reg = L.__assembler__;
    if (reg && reg !== state.lblReg) {
      state.lblReg = reg;
      Object.keys(reg).forEach(function (k) { if (typeof reg[k] === "function" && reg[k].prototype) wrapLabelAssembler(reg[k].prototype, cc); });
    }
    var A = L.Assembler;
    if (A && typeof A.getAssembler === "function" && !A.getAssembler.__slotLbl) {
      var get = A.getAssembler;
      var g = function () {
        var a = get.apply(this, arguments);
        if (a) { try { wrapLabelAssembler(a, cc); } catch (e) {} }
        return a;
      };
      g.__slotLbl = true;
      try { A.getAssembler = g; } catch (e) {}
    }
    var apply = L.prototype._applyFontTexture;
    if (typeof apply === "function" && !apply.__slotLbl) {
      var a2 = function () {
        var prev = state.curLabel;
        state.curLabel = this;
        try { return apply.apply(this, arguments); } finally { state.curLabel = prev; noteLabelCanvas(this); }
      };
      a2.__slotLbl = true;
      try { L.prototype._applyFontTexture = a2; } catch (e) {}
    }
    var reset = L.prototype._resetAssembler;
    if (typeof reset === "function" && !reset.__slotLbl) {
      var r = function () {
        var ret = reset.apply(this, arguments);
        if (this._assembler) { try { wrapLabelAssembler(this._assembler, cc); } catch (e) {} }
        return ret;
      };
      r.__slotLbl = true;
      try { L.prototype._resetAssembler = r; } catch (e) {}
    }
  }
  var CACHE_NAMES = ["NONE", "BITMAP", "CHAR"];
  var OVERFLOW_NAMES = ["NONE", "CLAMP", "SHRINK", "RESIZE_HEIGHT"];
  function safeLabels(fw) {
    try { return labelsOf(fw); } catch (e) { return undefined; }
  }
  // The labels a hitch frame spent its label time on, grouped by folded node path, top 3 by time.
  function labelsOf(fw) {
    if (!fw.lbl || !fw.lblN) return undefined;
    var cc = window.cc;
    var groups = {};
    fw.lbl.forEach(function (ms, c) {
      var node = c.node;
      var key = node ? groupPath(node) : "?";
      var g = groups[key];
      if (!g) {
        var bm = !c.useSystemFont && cc && cc.BitmapFont && c.font instanceof cc.BitmapFont;
        var font = c.useSystemFont || !c.font ? "system" : bm ? "bmfont" : "ttf";
        var fontName = font === "system" ? c.fontFamily : c.font && (c.font.name || c.font._name);
        var effects = [];
        var comps = (node && (node._components || node.components)) || [];
        comps.forEach(function (o) { var n = className(o); if (/Outline/.test(n)) effects.push("outline"); else if (/Shadow/.test(n)) effects.push("shadow"); });
        if (c.enableOutline && effects.indexOf("outline") < 0) effects.push("outline");
        if (c.enableShadow && effects.indexOf("shadow") < 0) effects.push("shadow");
        var str = c.string;
        g = groups[key] = {
          path: key,
          n: 0,
          ms: 0,
          font: font,
          fontName: typeof fontName === "string" && fontName ? fontName.slice(0, 40) : undefined,
          cache: CACHE_NAMES[c.cacheMode || 0] || String(c.cacheMode),
          overflow: OVERFLOW_NAMES[c.overflow || 0] || String(c.overflow),
          size: typeof c.fontSize === "number" ? c.fontSize : undefined,
          chars: str != null ? String(str).length : undefined,
          wrap: c.enableWrapText === true ? true : undefined,
          effects: effects.length ? effects : undefined
        };
      }
      g.n += 1;
      g.ms += ms;
      if (c.string != null) g.chars = Math.max(g.chars || 0, String(c.string).length);
    });
    var top = Object.keys(groups).map(function (k) { return groups[k]; }).sort(function (a, b) { return b.ms - a.ms; }).slice(0, 3);
    top.forEach(function (g) { g.ms = round(g.ms); });
    return { ms: round(fw.lblMs), n: fw.lblN, top: top };
  }

  // Deserializing scenes, prefabs and other assets, and large JSON.parse calls, both on the main thread.
  var desDepth = 0;
  function timeInto(fn, flag) {
    var w = function () {
      if (desDepth) return fn.apply(this, arguments);
      desDepth = 1;
      var t0 = performance.now();
      try { return fn.apply(this, arguments); } finally {
        desDepth = 0;
        state.fw.desN += 1;
        state.fw.desMs += performance.now() - t0;
      }
    };
    for (var k in fn) { try { w[k] = fn[k]; } catch (e) {} }
    w[flag] = true;
    return w;
  }
  function hookDeserialize(cc) {
    if (typeof cc.deserialize === "function" && !cc.deserialize.__slotDes) {
      try { cc.deserialize = timeInto(cc.deserialize, "__slotDes"); } catch (e) {}
    }
  }
  try { if (!JSON.parse.__slotDes) JSON.parse = timeInto(JSON.parse, "__slotDes"); } catch (e) {}

  // WebSocket message handlers: time and count per frame, and the size of the slowest message.
  // The payload is never read. Listeners added with addEventListener("message") and the onmessage
  // property are both wrapped; the page reads back what it set.
  var wsDepth = 0;
  function wsTimed(fn, self, ev) {
    if (wsDepth) return fn.call(self, ev);
    wsDepth = 1;
    var t0 = performance.now();
    try { return fn.call(self, ev); } finally {
      var ms = performance.now() - t0;
      wsDepth = 0;
      var fw = state.fw;
      fw.wsN += 1;
      fw.wsMs += ms;
      fw.calls += 1;
      if (ms > fw.wsTopMs) {
        fw.wsTopMs = ms;
        var d = ev && ev.data;
        fw.wsTopBytes = d == null ? 0 : typeof d === "string" ? d.length : d.byteLength != null ? d.byteLength : d.size || 0;
      }
    }
  }
  function hookWebSocket() {
    var WS = window.WebSocket;
    var proto = WS && WS.prototype;
    if (!proto || proto.__slotWs) return;
    var wrapped = new WeakMap();
    var wrap = function (l) {
      if (typeof l !== "function" && !(l && typeof l.handleEvent === "function")) return l;
      var w = wrapped.get(l);
      if (w) return w;
      w = function (ev) { return typeof l === "function" ? wsTimed(l, this, ev) : wsTimed(l.handleEvent, l, ev); };
      w.__slotOrig = l;
      wrapped.set(l, w);
      return w;
    };
    var add = proto.addEventListener;
    var remove = proto.removeEventListener;
    if (typeof add !== "function" || typeof remove !== "function") return;
    // Every game listens for messages; a socket seen there also gets close and error listeners,
    // once. Only the close code, whether it was clean, the stage and the seconds since it was seen
    // are kept; never the URL.
    var watched = typeof WeakMap === "function" ? new WeakMap() : null;
    var watchSocket = function (ws) {
      if (!watched || watched.has(ws)) return;
      watched.set(ws, performance.now());
      var note = function (kind, ev) {
        if (state.wsEvents.length >= 40) return;
        state.wsEvents.push({ t: rel(performance.now()), kind: kind, code: ev && ev.code != null ? ev.code : undefined, clean: ev && ev.wasClean != null ? ev.wasClean : undefined, stage: state.stage && state.stage.name, sec: round((performance.now() - watched.get(ws)) / 1000), afterReady: !!state.gameReady });
      };
      try {
        add.call(ws, "close", function (ev) { note("close", ev); });
        add.call(ws, "error", function (ev) { note("error", ev); });
      } catch (e) {}
    };
    Object.defineProperty(proto, "addEventListener", { configurable: true, writable: true, value: function (type, l, opts) {
      if (type === "message") watchSocket(this);
      return add.call(this, type, type === "message" ? wrap(l) : l, opts);
    } });
    Object.defineProperty(proto, "removeEventListener", { configurable: true, writable: true, value: function (type, l, opts) {
      return remove.call(this, type, (type === "message" && l && wrapped.get(l)) || l, opts);
    } });
    var d = Object.getOwnPropertyDescriptor(proto, "onmessage");
    if (d && d.get && d.set && d.configurable) {
      Object.defineProperty(proto, "onmessage", {
        configurable: true,
        enumerable: d.enumerable,
        get: function () { var f = d.get.call(this); return (f && f.__slotOrig) || f; },
        set: function (f) { if (typeof f === "function") watchSocket(this); d.set.call(this, typeof f === "function" ? wrap(f) : f); }
      });
    }
    Object.defineProperty(proto, "__slotWs", { value: true });
  }
  try { hookWebSocket(); } catch (e) {}

  // Node activation: every node.active change, and every node added under an active parent, goes
  // through director._nodeActivator.activateNode(node, active), and from there onEnable/onDisable of
  // the whole subtree. Only the outermost call is timed. churn counts a node switched back the
  // other way within the same frame (off then on, or on then off).
  var actDepth = 0;
  function hookActivator(cc) {
    var na = cc.director && cc.director._nodeActivator;
    if (!na || typeof na.activateNode !== "function" || na.activateNode.__slotAct) return;
    var orig = na.activateNode;
    var w = function (node, active) {
      if (state.compOff) return orig.apply(this, arguments);
      var fw = state.fw;
      fw.calls += 1;
      if (active) fw.actN += 1; else fw.actOff += 1;
      try {
        var seen = fw.actSeen || (fw.actSeen = new Map());
        var was = seen.get(node);
        if (was !== undefined && was !== !!active) fw.churn += 1;
        seen.set(node, !!active);
      } catch (e) {}
      if (actDepth) return orig.apply(this, arguments);
      actDepth = 1;
      var t0 = performance.now();
      try { return orig.apply(this, arguments); } finally {
        var ms = performance.now() - t0;
        actDepth = 0;
        var f = state.fw;
        f.actMs += ms;
        if (ms > f.actTopMs) { f.actTopMs = ms; f.actTopNode = node; }
      }
    };
    w.__slotAct = true;
    try { na.activateNode = w; } catch (e) {}
  }

  // Callbacks wired in the editor (Button clickEvents and the like) run through
  // Component.EventHandler.prototype.emit. The name is the component and handler strings set in
  // the editor; customEventData is never read.
  var hdDepth = 0;
  function hookHandlers(cc) {
    var EH = (cc.Component && cc.Component.EventHandler) || cc.EventHandler;
    var proto = EH && EH.prototype;
    if (!proto || typeof proto.emit !== "function" || proto.emit.__slotHd) return;
    var orig = proto.emit;
    var w = function () {
      if (hdDepth || state.compOff) return orig.apply(this, arguments);
      hdDepth = 1;
      var t0 = performance.now();
      try { return orig.apply(this, arguments); } finally {
        var ms = performance.now() - t0;
        hdDepth = 0;
        var fw = state.fw;
        fw.hdN += 1;
        fw.hdMs += ms;
        fw.calls += 1;
        if (ms > fw.hdTopMs) {
          fw.hdTopMs = ms;
          var comp = "";
          try { comp = typeof this.component === "string" && this.component ? this.component : String(this._componentName || ""); } catch (e) {}
          var h = typeof this.handler === "string" ? this.handler : "";
          fw.hdTop = (comp + (h ? "." + h : "")).slice(0, 80);
        }
      }
    };
    w.__slotHd = true;
    try { proto.emit = w; } catch (e) {}
  }

  function watch() {
    var cc = window.cc;
    if (!cc) return;
    try { hookDirector(cc); } catch (e) {}
    try { hookComponents(cc); } catch (e) {}
    try { hookDeserialize(cc); } catch (e) {}
    try { hookInstantiate(cc); } catch (e) {}
    try { hookLabels(cc); } catch (e) {}
    try { hookActivator(cc); } catch (e) {}
    try { state.capMs = 1000 / frameCap(); } catch (e) {}
    try { hookHandlers(cc); } catch (e) {}
    try { hookSpineBuild(cc); } catch (e) {}
    try { hookPools(cc); } catch (e) {}
    // Component timing must stay cheap; above 0.3 ms per frame it is switched off for the run.
    if (!state.compOff && state.compCallUs != null && state.compFramesSeen > 300 && (state.compCalls / state.compFramesSeen) * state.compCallUs / 1000 > 0.3) state.compOff = true;
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
  // The loading screen's percentage, while loading: when it changed, to put downloads against it.
  setInterval(function () {
    if (state.gameReady || state.progress.length >= 400) return;
    try {
      var best = null;
      activeTexts(80).forEach(function (t) {
        var m = /^\s*(\d{1,3})\s*%\s*$/.exec(t);
        if (m && +m[1] <= 100 && (best == null || +m[1] > best)) best = +m[1];
      });
      var last = state.progress[state.progress.length - 1];
      if (best != null && (!last || last[1] !== best)) state.progress.push([rel(performance.now()), best]);
    } catch (e) {}
  }, 500);
  setInterval(function () { try { sampleSpine(); } catch (e) {} }, SPINE_SAMPLE_MS);

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
      uploads: uploadsOf(s),
      batches: s.bb || undefined,
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
  // ASTC packs one block of WxH pixels into 16 bytes, so 4x4 is 1 byte per pixel and 8x8 is 0.25.
  function bytesPerPixel(name) {
    var astc = /ASTC_(\d+)x(\d+)/.exec(name);
    if (astc) return 16 / (Number(astc[1]) * Number(astc[2]));
    if (/PVRTC_2/.test(name)) return 0.25;
    if (/PVRTC|ETC1|ETC2_RGB$|RGB_ETC2|RGB_ETC1|RGB_A_PVRTC/.test(name)) return 0.5;
    if (/ETC2/.test(name)) return 1;
    if (/^A8$|^I8$/.test(name)) return 1;
    if (/565|4444|5551|AI88/.test(name)) return 2;
    return 4;
  }

  function isCompressed(name) {
    return /PVRTC|ETC|ASTC/.test(name);
  }

  // Last path segment of an asset's native URL, without the query string, so a report can name the file.
  function assetFile(a) {
    try {
      var url = a.nativeUrl || a._nativeUrl || a.url || (a._image && a._image.src) || "";
      if (typeof url !== "string" || !url || url.indexOf("data:") === 0) return a.name || a._name || null;
      return url.split("?")[0].split("#")[0].split("/").pop() || a.name || null;
    } catch (e) {
      return null;
    }
  }

  // The last few node names up to the scene, enough to find a node in the editor.
  function nodePath(node) {
    var names = [];
    var n = node;
    while (n && names.length < 5) {
      if (n.name) names.unshift(n.name);
      n = n.parent || n._parent;
      if (n && !n.parent && !n._parent) break;
    }
    return names.join("/");
  }

  // Node path with digits folded, so Symbol_3/scatter and Symbol_17/scatter group together.
  function groupPath(node) {
    return nodePath(node).replace(/\d+/g, "*");
  }

  function topGroups(groups, n) {
    var out = {};
    Object.keys(groups).sort(function (a, b) { return groups[b] - groups[a]; }).slice(0, n).forEach(function (k) { out[k] = groups[k]; });
    return out;
  }

  // Whether a live Spine can show anything: opacity, color alpha and scale up the parent chain.
  // Being off screen is not checked; Spine nodes often have no content size to test against.
  function spineDrawable(c, node) {
    if (c.color && c.color.a === 0) return false;
    var n = node;
    while (n) {
      var op = typeof n.opacity === "number" ? n.opacity : n._uiProps && typeof n._uiProps.localOpacity === "number" ? n._uiProps.localOpacity * 255 : 255;
      if (op <= 0) return false;
      var sx = typeof n.scaleX === "number" ? n.scaleX : n.scale && typeof n.scale.x === "number" ? n.scale.x : 1;
      var sy = typeof n.scaleY === "number" ? n.scaleY : n.scale && typeof n.scale.y === "number" ? n.scale.y : 1;
      if (sx === 0 || sy === 0) return false;
      n = n.parent || n._parent;
    }
    return true;
  }

  function spineBones(c) {
    try {
      var sk = c._skeleton || (c.getSkeleton && c.getSkeleton());
      return sk && sk.bones ? sk.bones.length : 0;
    } catch (e) {
      return 0;
    }
  }

  function sampleSpine() {
    if (!state.spineShown || !window.cc) return;
    var ok = walkScene(function (node) {
      if (node.activeInHierarchy === false || node.active === false) return;
      var comps = node._components || node.components || [];
      for (var i = 0; i < comps.length; i += 1) {
        var c = comps[i];
        if (c.enabled === false || state.spineShown.has(c) || className(c) !== "sp.Skeleton") continue;
        if (spineDrawable(c, node)) state.spineShown.add(c);
      }
    });
    if (ok) state.spineSamples += 1;
  }

  function pushSample(list, value) {
    if (list.length < 5 && list.indexOf(value) < 0) list.push(value);
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
    var bigCount = 0;
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
      if (b > 16 * 1048576) bigCount += 1;
      big.push({ w: w, h: h, format: name, mb: round(b / 1048576), file: assetFile(tex), uuid: tex._uuid || null });
    });
    big.sort(function (a, b) { return b.mb - a.mb; });
    return {
      status: "ok",
      count: count,
      mb: round(bytes / 1048576),
      npot: npot,
      compressed: compressed,
      formats: formats,
      bigCount: bigCount,
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
      // hidden*: live realtime Spine that cannot show anything yet still pose bones every frame.
      // unused*: Spine in the scene never seen drawable in any sample this run (every SPINE_SAMPLE_MS).
      spine: { total: 0, active: 0, realtime: 0, sharedCache: 0, privateCache: 0, batched: 0, activeRealtimeBones: 0, realtimeBy: {}, hiddenRealtime: 0, hiddenBones: 0, hiddenBy: {}, unused: state.spineShown ? 0 : null, unusedLive: state.spineShown ? 0 : null, unusedBones: state.spineShown ? 0 : null, unusedBy: {}, samples: state.spineSamples, sampleMs: SPINE_SAMPLE_MS },
      cameras: { total: 0, active: 0 },
      renderTextures: { count: 0, mb: 0, largest: null },
      dragonBones: { total: 0, active: 0 },
      // noCacheTtf: TTF or system-font labels with cacheMode NONE. BMFont labels batch with their atlas,
      // so cacheMode does not apply to them and they are not counted there.
      labels: { total: 0, active: 0, noCache: 0, noCacheTtf: 0, bmfont: 0, bitmap: 0, char: 0, systemFont: 0, samples: [] },
      masks: { total: 0, active: 0, byType: {}, samples: [], stencilSamples: [] },
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
          var data = c.skeletonData;
          var key = (data && (data.name || data._name)) || assetFile(data || {}) || "?";
          var drawable = live && spineDrawable(c, node);
          if (drawable && state.spineShown) state.spineShown.add(c);
          if (state.spineShown && !state.spineShown.has(c)) {
            var ug = groupPath(node) + " · " + key;
            out.spine.unusedBy[ug] = (out.spine.unusedBy[ug] || 0) + 1;
            out.spine.unused += 1;
            if (live) out.spine.unusedLive += 1;
            out.spine.unusedBones += spineBones(c);
          }
          if (live) {
            out.spine.active += 1;
            if (!mode) {
              out.spine.realtime += 1;
              out.spine.realtimeBy[key] = (out.spine.realtimeBy[key] || 0) + 1;
              var nb = spineBones(c);
              out.spine.activeRealtimeBones += nb;
              if (!drawable && !c.paused) {
                var hg = groupPath(node) + " · " + key;
                out.spine.hiddenBy[hg] = (out.spine.hiddenBy[hg] || 0) + 1;
                out.spine.hiddenRealtime += 1;
                out.spine.hiddenBones += nb;
              }
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
            var bm = !c.useSystemFont && cc.BitmapFont && c.font instanceof cc.BitmapFont;
            if (bm) out.labels.bmfont += 1;
            if (cm === 0) {
              out.labels.noCache += 1;
              if (!bm) {
                out.labels.noCacheTtf += 1;
                pushSample(out.labels.samples, nodePath(node));
              }
            } else if (cm === 1) out.labels.bitmap += 1;
            else out.labels.char += 1;
            if (c.useSystemFont) out.labels.systemFont += 1;
          }
        } else if (name === "cc.Mask") {
          out.masks.total += 1;
          if (live) {
            out.masks.active += 1;
            var types = cc.Mask && cc.Mask.Type ? cc.Mask.Type : {};
            var tname = Object.keys(types).filter(function (k) { return types[k] === c.type; })[0] || String(c.type);
            out.masks.byType[tname] = (out.masks.byType[tname] || 0) + 1;
            pushSample(out.masks.samples, nodePath(node));
            if (tname === "IMAGE_STENCIL") pushSample(out.masks.stencilSamples, nodePath(node));
          }
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
    out.spine.realtimeBy = topGroups(out.spine.realtimeBy, 5);
    out.spine.hiddenBy = topGroups(out.spine.hiddenBy, 5);
    out.spine.unusedBy = topGroups(out.spine.unusedBy, 5);
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
      if (k === "cc.RenderTexture") {
        var rw = a.width || 0;
        var rh = a.height || 0;
        var rmb = (rw * rh * 4) / 1048576;
        out.renderTextures.count += 1;
        out.renderTextures.mb += rmb;
        if (!out.renderTextures.largest || rmb > out.renderTextures.largest.mb) out.renderTextures.largest = { w: rw, h: rh, mb: round(rmb) };
      }
    });
    out.renderTextures.mb = round(out.renderTextures.mb);
    try {
      var scene = cc.director && cc.director.getScene && cc.director.getScene();
      var cams = scene && scene.getComponentsInChildren && cc.Camera ? scene.getComponentsInChildren(cc.Camera) : [];
      out.cameras.total = cams.length;
      out.cameras.active = cams.filter(function (c) {
        var node = c.node;
        return c.enabled !== false && (!node || node.activeInHierarchy !== false);
      }).length;
    } catch (e2) {}
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
      // window.cc can be a different copy from the engine the game runs, so ask by class name too.
      var ui = node._uiProps && node._uiProps.uiTransformComp;
      if (!ui && node.getComponent) {
        try { ui = node.getComponent("cc.UITransform"); } catch (e) {}
        if (!ui && cc.UITransform) ui = node.getComponent(cc.UITransform);
      }
      if (ui && cc.Camera) {
        var cams = cc.director.getScene().getComponentsInChildren(cc.Camera);
        var cam = null;
        for (var i = 0; i < cams.length; i += 1) {
          if (cams[i].visibility == null || (cams[i].visibility & node.layer)) { cam = cams[i]; break; }
        }
        if (!cam) return null;
        var box = ui.getBoundingBoxToWorld();
        var cx = box.x + box.width / 2;
        var cy = box.y + box.height / 2;
        // 3.4 and later take (worldPos, out); 3.0 to 3.3 take (out, worldPos).
        var out = new cc.Vec3();
        cam.worldToScreen(new cc.Vec3(cx, cy, 0), out);
        if (!out.x && !out.y) {
          out = new cc.Vec3();
          cam.worldToScreen(out, new cc.Vec3(cx, cy, 0));
        }
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
  var GENERIC_NAME = /^(hit[_ ]?area|hit|button|btn|bg|background|touch([_ ]?area)?|click([_ ]?area)?|icon|img|image|sprite)$/i;
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
      // A generic name such as HitArea says nothing; its parent (SpinButtonView) does.
      var name = node.name || "";
      if (GENERIC_NAME.test(name) && node.parent && node.parent !== root) name = (node.parent.name || "") + "/" + name;
      list.push({ kind: btn ? "button" : "touch", name: name, text: nodeText(node), interactable: btn ? btn.interactable !== false : true, node: node, sigNode: name !== (node.name || "") ? node.parent : node });
    });
    return list;
  }

  function buttonList(words) {
    var match = lower(words);
    return clickables(200)
      .filter(function (b) { return !match.length || hits((b.name + " " + b.text).toLowerCase(), match); })
      .slice(0, 30)
      .map(function (b) { return { kind: b.kind, name: b.name, text: b.text, interactable: b.interactable, point: screenPoint(b.node), sig: activeSig(b.sigNode) }; });
  }

  // Which descendants of a button are showing, by name. A spin button that stays pressable while
  // the reels turn often shows a stop label or icon instead; the autopilot compares this with what
  // it saw while idle.
  function activeSig(node) {
    var out = [];
    var walk = function (n, depth) {
      var kids = (n && (n._children || n.children)) || [];
      for (var i = 0; i < kids.length && out.length < 40; i += 1) {
        var k = kids[i];
        if (!k || k.activeInHierarchy === false || k.active === false) continue;
        out.push(depth + ":" + (k.name || ""));
        if (depth < 3) walk(k, depth + 1);
      }
    };
    try { walk(node, 1); } catch (e) { return null; }
    return out.join("|");
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
    // How long since the last request finished. Not every loading screen shows a percentage, but
    // every one is still downloading, and on a throttled network the screen can sit still between
    // texture uploads while files keep arriving.
    var lastNet = 0;
    try {
      (performance.getEntriesByType("resource") || []).forEach(function (r) { if (r.responseEnd > lastNet) lastNet = r.responseEnd; });
    } catch (e) {}
    return {
      quietMs: Math.round(performance.now() - (state.lastTexUploadAt || state.t0)),
      netQuietMs: Math.round(performance.now() - (lastNet || state.t0)),
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
      context: (function () {
        try {
          var g = state.gl;
          if (!g || !g.getContextAttributes) return null;
          var a = g.getContextAttributes() || {};
          return {
            alpha: !!a.alpha,
            antialias: !!a.antialias,
            preserveDrawingBuffer: !!a.preserveDrawingBuffer,
            desynchronized: !!a.desynchronized,
            bufferW: g.drawingBufferWidth || null,
            bufferH: g.drawingBufferHeight || null
          };
        } catch (e) { return null; }
      })(),
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
      if (name === "game-ready") {
        state.gameReady = true;
        if (state.gameReadyAt == null) state.gameReadyAt = performance.now();
      }
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
    // Node counts by folded scene path, and instantiated nodes still referenced. After a forced GC.
    census: function () {
      try { return census(); } catch (e) { return { status: "error", note: String(e && e.message || e).slice(0, 80) }; }
    },
    // Milliseconds since the last bad frame (over 1.5 frame lengths at the cap), the last long task
    // and the last large texture upload. The autopilot waits on these before the first stage.
    quiet: function () {
      var t = performance.now();
      var since = function (at) { return Math.round(t - (at || state.t0)); };
      return { badMs: since(state.lastBadAt), longMs: since(state.lastLongAt), uploadMs: since(state.lastBigUploadAt) };
    },
    // WebSocket closes and errors after the game was ready, from index on. The autopilot asks at gaps.
    wsEvents: function (from) {
      return state.wsEvents.filter(function (e) { return e.afterReady; }).slice(from || 0);
    },
    // Screen coverage of what is drawn now (census walk only). For slot-perf-drill coverage().
    coverage: function () {
      var cc = window.cc;
      var scene = cc && cc.director && cc.director.getScene && cc.director.getScene();
      if (!scene) return { status: "unavailable" };
      try { return invisibleDrawn(cc, scene).coverage; } catch (e) { return { status: "error", note: String(e && e.message || e).slice(0, 80) }; }
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
          loafs: state.loafs,
          loafFields: ["startMs", "durationMs", "blockingMs", "styleLayoutMs", "scripts"],
          loafScriptFields: ["invokerType", "invoker", "path", "function", "durationMs", "forcedLayoutMs"],
          componentTiming: {
            status: !state.compWrapped ? "unavailable" : state.compOff ? "off-overhead" : "ok",
            wrappedMethods: state.compWrapped,
            labelAssemblers: state.lblWrapped,
            callUs: state.compCallUs == null ? null : Math.round(state.compCallUs * 1000) / 1000,
            callsPerFrame: state.compFramesSeen ? round(state.compCalls / state.compFramesSeen) : null,
            overheadMsPerFrame: state.compFramesSeen && state.compCallUs != null ? Math.round(state.compCalls / state.compFramesSeen * state.compCallUs) / 1000 : null
          },
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
        },
        resources: resourceSummary(),
      progress: state.progress.length ? state.progress : undefined,
      ws: state.wsEvents.length ? state.wsEvents : undefined,
        paint: paintSummary(),
        shaders: state.shaderN ? { status: "ok", ms: round(state.shaderMs), maxMs: round(state.shaderMax), count: state.shaderN, stalls: state.shaderStalls } : { status: "none", ms: 0, count: 0, stalls: [] },
        audio: state.audioN ? { status: "ok", pcmMb: round(state.audioPcm / 1048576), count: state.audioN, maxMs: round(state.audioMaxMs) } : { status: "none", pcmMb: 0, count: 0, maxMs: 0 }
      };
    }
  };
})();
