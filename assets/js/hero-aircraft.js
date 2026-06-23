/* ============================================================
   ARCIS — Aircraft assembly
   Scroll-driven image sequence rendered to a FIXED full-page canvas.

   The effect
   ----------
   The aircraft is a fixed background layer that stays in the viewport
   while the page scrolls naturally over it — nothing is pinned. Its
   assembly is driven by overall page-scroll position, deliberately slow:
   it begins exploded at the top and finishes assembling by the time the
   "Engineering Process" section (#process, the 4th section) is reached.
   After that it holds — fully assembled — for the rest of the page, so it
   stays with the reader to the end instead of vanishing.

   It is kept deliberately faint and is feathered at the edges (CSS mask),
   so it reads as a supporting "blueprint" layer rather than competing with
   the content it now overlays. Frames gain a little opacity and settle to
   their resting scale as the airframe becomes one object.

   Performance / smoothness
   ------------------------
   • One <canvas>, 61 WebP frames (~2.4 MB), no libraries.
   • Updates are driven by passive 'scroll' events coalesced into a single
     requestAnimationFrame; we only redraw when the frame index changes and
     only touch opacity when progress moves. Idle = zero work.

   Fallbacks (no scrub runs in any of these)
   -----------------------------------------
   • No JS / reduced motion / mobile / low-memory / data-saver
       → the static assembled still (<img>, inside the hero) is shown and
         simply scrolls away with the hero.
   The full sequence decodes to ~200 MB of bitmaps, which risks crashing
   memory-constrained mobile browsers, so we only run it on pointer-precise
   desktop-class devices.

   Tuning: CONFIG below (completeAtSelector, completeOffsetVh, opacity
   floor/peak, fill, settle, vertical bias). Debug: append ?animdebug.
   ============================================================ */

(function () {
  'use strict';

  var CONFIG = {
    // Two frame sets, SAME animation. Desktop is the approved/locked set;
    // mobile is a downscaled, decimated copy (~0.5 MB, ~33 MB decoded) so the
    // effect is safe on phones. Only the frame source differs by device — all
    // the timing / opacity / positioning / scroll-mapping below is shared.
    // count = frames in the set; dir = its folder; opMin/opMax = the opacity
    // ramp (exploded → assembled) for that device. Both sets use the full 61
    // frames for smoothness; mobile's are downscaled (~54 MB decoded vs ~200).
    desktop: { count: 61, dir: 'assets/anim/',        opMin: 0.12,  opMax: 0.24 },
    mobile:  { count: 61, dir: 'assets/anim/mobile/', opMin: 0.125, opMax: 0.25 },
    completeAtSelector: '#process', // assembly finishes when this section is reached…
    completeOffsetVh: 0.5,          // …specifically when its top is this far (in viewports) above the fold
    fill: 1.12,                     // >1 lets wings reach past the edges (mask feathers them)
    settle: 0.05,                   // extra scale while exploded; eases to 0 (assembled)
    yOffsetFactor: 0.05,            // small downward bias
    maxDPR: 2                       // cap device-pixel-ratio (memory / fill cost)
  };

  var canvas   = document.getElementById('heroAircraft');
  var hero     = canvas && canvas.closest('.hero');
  var fallback = hero && hero.querySelector('.hero-aircraft-fallback');
  if (!canvas || !hero) return;

  // Respect reduced-motion: leave the static still in place, do nothing else.
  if (window.matchMedia &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

  if (!window.matchMedia) return;          // can't detect device → keep static still

  // Data-saver: keep the lightweight static still on every device.
  var conn = navigator.connection || {};
  if (conn.saveData) return;

  // Pick the frame set by device. Desktop keeps its original guard — the heavy
  // ~200 MB decode means low-memory DESKTOPS fall back to the static still.
  // Mobile uses the small set, which is safe even on low-memory phones, so it
  // is NOT subject to the desktop memory guard.
  var isDesktopClass =
    window.matchMedia('(min-width: 769px) and (pointer: fine)').matches;
  var set;
  if (isDesktopClass) {
    if (navigator.deviceMemory && navigator.deviceMemory <= 4) return;
    set = CONFIG.desktop;
  } else {
    set = CONFIG.mobile;
  }
  var FRAME_COUNT = set.count;
  function framePath(i) { return set.dir + String(i).padStart(4, '0') + '.webp'; }

  var ctx     = canvas.getContext('2d');
  var DEBUG   = location.search.indexOf('animdebug') !== -1;
  var OP_MIN  = set.opMin;
  var OP_MAX  = set.opMax;
  var frames  = new Array(FRAME_COUNT);
  var loaded  = 0;
  var ready   = false;
  var target  = 1;                  // scroll distance (px) over which assembly completes
  var lastFrame = -1;
  var lastP     = -1;
  var t0 = (performance && performance.now) ? performance.now() : Date.now();

  function easeOut(t) { return 1 - Math.pow(1 - t, 3); }
  function clamp01(t) { return t < 0 ? 0 : t > 1 ? 1 : t; }

  /* ── Canvas sizing (fixed, full viewport) ──────────────── */
  function sizeCanvas() {
    var dpr = Math.min(window.devicePixelRatio || 1, CONFIG.maxDPR);
    canvas.width  = Math.max(1, Math.round(window.innerWidth  * dpr));
    canvas.height = Math.max(1, Math.round(window.innerHeight * dpr));
  }

  /* ── Where assembly should finish (recomputed on resize/load) ── */
  function computeTarget() {
    var vh = window.innerHeight;
    var el = document.querySelector(CONFIG.completeAtSelector);
    if (el) {
      var docTop = el.getBoundingClientRect().top + window.pageYOffset;
      target = Math.max(vh * 0.6, docTop - vh * CONFIG.completeOffsetVh);
    } else {
      target = vh * 2.5;            // fallback if the anchor is missing
    }
  }

  function progress() { return clamp01(window.pageYOffset / target); }

  /* ── Draw one frame at assembly progress `p` (0..1) ────── */
  function draw(index, p) {
    var img = frames[index];
    if (!img || !img.complete || !img.naturalWidth) return;
    var cw = canvas.width, ch = canvas.height;
    ctx.clearRect(0, 0, cw, ch);
    var settle = 1 + CONFIG.settle * (1 - easeOut(p));
    var scale  = Math.min(cw / img.naturalWidth, ch / img.naturalHeight)
               * CONFIG.fill * settle;
    var dw = img.naturalWidth  * scale;
    var dh = img.naturalHeight * scale;
    var dx = (cw - dw) / 2;
    var dy = (ch - dh) / 2 + ch * CONFIG.yOffsetFactor;
    ctx.drawImage(img, dx, dy, dw, dh);
  }

  function render() {
    var p = progress();
    if (Math.abs(p - lastP) < 0.0005 && lastFrame >= 0) return;
    lastP = p;
    var f  = Math.round(p * (FRAME_COUNT - 1));
    var op = OP_MIN + (OP_MAX - OP_MIN) * easeOut(p);
    if (f !== lastFrame) { lastFrame = f; draw(f, p); }
    canvas.style.opacity = op.toFixed(3);
    if (DEBUG) console.log('[hero-aircraft] p=' + p.toFixed(2) +
      ' · frame ' + f + ' · op=' + op.toFixed(2) + ' · target=' + Math.round(target) + 'px');
  }

  /* ── Activate once frames are ready ────────────────────── */
  function onReady() {
    if (ready) return;
    ready = true;
    sizeCanvas();
    computeTarget();
    lastFrame = -1; lastP = -1;
    render();
    if (fallback) {                              // crossfade the static still out
      fallback.style.opacity = '0';
      setTimeout(function () { fallback.style.display = 'none'; }, 650);
    }

    // Update on scroll, coalesced into one rAF; idle when not scrolling.
    var ticking = false;
    window.addEventListener('scroll', function () {
      if (ticking) return;
      ticking = true;
      requestAnimationFrame(function () { ticking = false; render(); });
    }, { passive: true });

    // Layout can shift as images/fonts settle → recompute the finish point.
    window.addEventListener('load', function () {
      computeTarget(); lastP = -1; render();
    });

    if (DEBUG) {
      var ms = Math.round(performance.now() - t0);
      var px = 0, ok = 0;
      frames.forEach(function (im) {
        if (im && im.naturalWidth) { ok++; px += im.naturalWidth * im.naturalHeight; }
      });
      console.log('[hero-aircraft] ' + ok + '/' + FRAME_COUNT +
        ' frames loaded in ' + ms + 'ms; ~' +
        (px * 4 / 1048576).toFixed(0) + ' MB decoded if all held in memory.');
      if (performance.getEntriesByType) {
        var bytes = performance.getEntriesByType('resource')
          .filter(function (r) { return r.name.indexOf('/assets/anim/') !== -1; })
          .reduce(function (s, r) { return s + (r.transferSize || r.encodedBodySize || 0); }, 0);
        if (bytes) console.log('[hero-aircraft] payload ~' +
          (bytes / 1048576).toFixed(2) + ' MB transferred.');
      }
    }
  }

  function countLoad() { if (++loaded === FRAME_COUNT) onReady(); }

  for (var i = 0; i < FRAME_COUNT; i++) {
    var img = new Image();
    img.decoding = 'async';
    img.onload  = countLoad;
    img.onerror = countLoad;                     // don't hang the sequence on one bad frame
    img.src = framePath(i);
    frames[i] = img;
  }

  /* ── Resize (rAF-debounced) ────────────────────────────── */
  var resizeQueued = false;
  var lastW = window.innerWidth;
  window.addEventListener('resize', function () {
    // On mobile, ignore height-only changes (URL bar showing/hiding while
    // scrolling). Re-fitting the canvas mid-scroll would cause visible jumps.
    // Desktop is unaffected (it reacts to any resize, as before).
    if (!isDesktopClass && window.innerWidth === lastW) return;
    lastW = window.innerWidth;
    if (resizeQueued || !ready) return;
    resizeQueued = true;
    requestAnimationFrame(function () {
      resizeQueued = false;
      sizeCanvas();
      computeTarget();
      lastFrame = -1; lastP = -1;                // force redraw at the new size
      render();
    });
  }, { passive: true });

})();
