/* ============================================================
   ARCIS — Aircraft assembly
   Scroll-driven image sequence rendered to a FIXED full-page canvas.

   The effect
   ----------
   The aircraft is a fixed background layer that stays in the viewport
   while the page scrolls naturally over it — nothing is pinned. It begins
   exploded at the top of the page and finishes assembling by the time the
   "Engineering Process" section (#process, the 4th section) is reached.
   For the rest of the page the finished aircraft drifts very gently, so it
   stays quietly alive with the reader instead of freezing or vanishing.
   See sample() for the two scroll phases that produce this.

   It is kept deliberately faint and is feathered at the edges (CSS mask),
   so it reads as a supporting "blueprint" layer rather than competing with
   the content it now overlays. Frames gain a little opacity and settle to
   their resting scale as the airframe becomes one object.

   Frames
   ------
   Built by tools/build-frames.py from the Blender PNG renders. That script
   also keys the renders' black background to transparency — the canvas
   overlays real content (including lighter sections and photos), so opaque
   frames would paint a dark rectangle over them.

   Performance / smoothness
   ------------------------
   • One <canvas>, 90 WebP frames per device set (desktop ~6 MB / ~316 MB
     decoded, mobile ~2 MB / ~79 MB decoded), no libraries.
   • Cross-fade blending (see draw()/drawFrame()) between the two nearest
     frames removes hard frame-to-frame "pops". Together with the 90-frame
     density this is what fixes stop-motion-style stepping, which is most
     visible when scrolling slowly through a long assembly.
   • Updates are driven by passive 'scroll' events coalesced into a single
     requestAnimationFrame; redraws are skipped when the fractional frame
     position barely moves, and idle (no scrolling) costs nothing.

   Fallbacks (no scrub runs in any of these)
   -----------------------------------------
   • No JS / reduced motion / low-memory / data-saver
       → the static assembled still (<img>, inside the hero) is shown and
         simply scrolls away with the hero.
   Desktop's set decodes to ~316 MB of bitmaps, which risks low-memory
   desktop machines, so those fall back to the static still too (see the
   deviceMemory guard below). Mobile's set is intentionally much lighter
   (~79 MB) so it does not need that guard.

   Tuning: CONFIG below (assemblyEndIndex, completeAtSelector,
   completeOffsetVh, opacity floor/peak, fill, settle, vertical bias).
   Debug: append ?animdebug to log frame position, opacity and geometry.
   ============================================================ */

(function () {
  'use strict';

  var CONFIG = {
    // Two frame sets, SAME animation, rendered natively at each resolution
    // (see tools/build-frames.py, which also keys the black background to
    // transparency). count = frames; dir = folder; opMin/opMax = the opacity
    // ramp (exploded → assembled) for that device. Only the frame source
    // differs by device — timing / positioning / mapping below is shared.
    desktop: { count: 90, dir: 'assets/anim/',        opMin: 0.12,  opMax: 0.24 },  // 1280x720, ~316 MB decoded
    mobile:  { count: 90, dir: 'assets/anim/mobile/', opMin: 0.125, opMax: 0.25 },  // 640x360,  ~79 MB decoded

    // The render is two movements in one sequence (measured from the source
    // frames): the parts fly together over frames 0…assemblyEndIndex, then
    // the finished aircraft drifts very gently for the remaining frames.
    // We map those to two scroll phases — see sample() below.
    assemblyEndIndex: 59,

    completeAtSelector: '#process', // the assembly finishes when this section is reached…
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
  var assembleDist = 1;             // scroll px over which the assembly plays out
  var maxScroll    = 1;             // total scrollable px of the page
  var lastRaw = -1;                 // last drawn fractional frame position (for skip-redraw)
  var t0 = (performance && performance.now) ? performance.now() : Date.now();

  function easeOut(t) { return 1 - Math.pow(1 - t, 3); }
  function clamp01(t) { return t < 0 ? 0 : t > 1 ? 1 : t; }

  /* ── Canvas sizing (fixed, full viewport) ──────────────── */
  function sizeCanvas() {
    var dpr = Math.min(window.devicePixelRatio || 1, CONFIG.maxDPR);
    canvas.width  = Math.max(1, Math.round(window.innerWidth  * dpr));
    canvas.height = Math.max(1, Math.round(window.innerHeight * dpr));
  }

  /* ── Scroll geometry (recomputed on resize/load) ───────── */
  function computeMetrics() {
    var vh = window.innerHeight;
    var el = document.querySelector(CONFIG.completeAtSelector);
    if (el) {
      var docTop = el.getBoundingClientRect().top + window.pageYOffset;
      assembleDist = Math.max(vh * 0.6, docTop - vh * CONFIG.completeOffsetVh);
    } else {
      assembleDist = vh * 2.5;      // fallback if the anchor is missing
    }
    var docH = Math.max(document.documentElement.scrollHeight, document.body.scrollHeight);
    // Keep a sane drift span even on short pages / odd layouts.
    maxScroll = Math.max(assembleDist + vh, docH - vh);
  }

  /* ── Scroll position → { assembly progress, frame position } ──
     Phase A (page top → #process): frames 0…assemblyEndIndex — the parts
     flying together. This is the part the reader should perceive as "the
     aircraft is being assembled", so it gets the whole run-up to the
     Engineering Process section.
     Phase B (#process → page bottom): the remaining frames — the finished
     aircraft drifting gently. This keeps it quietly alive for the rest of
     the page instead of freezing on a single static frame. ── */
  function sample() {
    var y   = window.pageYOffset;
    var end = Math.max(0, Math.min(CONFIG.assemblyEndIndex, FRAME_COUNT - 1));
    var p   = clamp01(y / assembleDist);          // assembly progress 0..1
    var raw;
    if (p < 1) {
      raw = p * end;
    } else {
      var driftSpan = Math.max(1, maxScroll - assembleDist);
      raw = end + clamp01((y - assembleDist) / driftSpan) * ((FRAME_COUNT - 1) - end);
    }
    return { p: p, raw: raw };
  }

  /* ── Draw a single frame at alpha `a` (settle scale from progress `p`) ── */
  function drawFrame(index, p, a) {
    var img = frames[index];
    if (!img || !img.complete || !img.naturalWidth) return;
    var cw = canvas.width, ch = canvas.height;
    var settle = 1 + CONFIG.settle * (1 - easeOut(p));
    var scale  = Math.min(cw / img.naturalWidth, ch / img.naturalHeight)
               * CONFIG.fill * settle;
    var dw = img.naturalWidth  * scale;
    var dh = img.naturalHeight * scale;
    var dx = (cw - dw) / 2;
    var dy = (ch - dh) / 2 + ch * CONFIG.yOffsetFactor;
    ctx.globalAlpha = a;
    ctx.drawImage(img, dx, dy, dw, dh);
    ctx.globalAlpha = 1;
  }

  /* ── Draw the current position, CROSS-FADED between its two nearest
     frames. `raw` is a fractional frame index (e.g. 12.4 = 40% of the way
     from frame 12 to 13). Blending removes the hard "pop" of snapping to
     the nearest frame, which is what reads as blocky/stop-motion —
     especially when scrolling slowly through a long assembly.

     The two draws must ADD to a linear blend, t*B + (1-t)*A. Drawing A
     opaque and then laying B over it with normal (source-over) compositing
     does not do that: wherever B is transparent, A stays at full strength,
     so a moving part shows as a double image instead of a fade. Instead we
     draw A pre-faded onto the cleared canvas and add B with 'lighter'
     (additive), which — because both contributions are premultiplied —
     gives exactly the linear interpolation we want, for colour and alpha. ── */
  function draw(raw, p) {
    var f0 = Math.floor(raw);
    var f1 = Math.min(FRAME_COUNT - 1, f0 + 1);
    var t  = raw - f0;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (f1 === f0 || t <= 0.004) {          // sitting on a frame — no blend needed
      drawFrame(f0, p, 1);
      return;
    }
    drawFrame(f0, p, 1 - t);
    ctx.globalCompositeOperation = 'lighter';
    drawFrame(f1, p, t);
    ctx.globalCompositeOperation = 'source-over';
  }

  function render() {
    var s = sample();
    if (Math.abs(s.raw - lastRaw) < 0.01 && lastRaw >= 0) return;
    lastRaw = s.raw;
    var op = OP_MIN + (OP_MAX - OP_MIN) * easeOut(s.p);
    draw(s.raw, s.p);
    canvas.style.opacity = op.toFixed(3);
    if (DEBUG) console.log('[hero-aircraft] p=' + s.p.toFixed(2) +
      ' · frame ' + s.raw.toFixed(2) + '/' + (FRAME_COUNT - 1) +
      ' · op=' + op.toFixed(2) + ' · assembleDist=' + Math.round(assembleDist) + 'px');
  }

  /* ── Activate once frames are ready ────────────────────── */
  function onReady() {
    if (ready) return;
    ready = true;
    sizeCanvas();
    computeMetrics();
    lastRaw = -1;
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

    // Layout can shift as images/fonts settle → recompute the scroll geometry.
    // lastRaw must be reset too, otherwise the skip-redraw check can swallow
    // the redraw that the new geometry needs.
    window.addEventListener('load', function () {
      computeMetrics(); lastRaw = -1; render();
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
      computeMetrics();
      lastRaw = -1;                              // force redraw at the new size
      render();
    });
  }, { passive: true });

})();
