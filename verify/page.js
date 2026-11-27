// slot-perf-verify page tools. Load with evaluate_script sourcePath after the slot-page-perf probe
// is on the page; returns "verify ok" and leaves window.__slotVerify. Unlike slot-perf-drill these
// change the game and do not put it back: reload the page when done.
(function () {
  var P = window.__slotPerf;
  if (!P || typeof P.pools !== "function" || typeof P.spineResidue !== "function") return "needs the slot-page-perf probe on this page (probe/dist/stash.js and the loader)";
  var cc = window.cc;
  var isSkeleton = function (c) {
    try { return /Skeleton/.test(cc.js.getClassName(c)); } catch (e) { return false; }
  };
  // The same Spine the probe's census counts as pool residue: under nodes a cc.NodePool holds,
  // every track finished and not looping, something still drawable.
  function residueComps() {
    var out = [];
    P.pools().forEach(function (pool) {
      (pool._pool || []).forEach(function (root) {
        var visit = function (node, depth) {
          if (!node || depth > 12) return;
          (node._components || node.components || []).forEach(function (c) {
            if (isSkeleton(c) && P.spineResidue(c) === "residue") out.push(c);
          });
          (node._children || node.children || []).forEach(function (k) { visit(k, depth + 1); });
        };
        visit(root, 0);
      });
    });
    return out;
  }
  window.__slotVerify = {
    version: 1,
    residue: function () { return { count: residueComps().length }; },
    // Clears the finished tracks of each residue skeleton and puts it in its setup pose. What a
    // pool would hand back after that is what this A/B tests.
    clearPoolResidue: function () {
      var list = residueComps();
      var failed = 0;
      list.forEach(function (c) {
        try {
          if (typeof c.clearTracks === "function") c.clearTracks();
          if (typeof c.setToSetupPose === "function") c.setToSetupPose();
        } catch (e) { failed += 1; }
      });
      return { cleared: list.length - failed, failed: failed || undefined, left: residueComps().length };
    }
  };
  return "verify ok";
})();
