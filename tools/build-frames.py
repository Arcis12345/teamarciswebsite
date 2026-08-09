#!/usr/bin/env python3
"""
ARCIS — aircraft animation frame builder
========================================

Converts the Blender-rendered PNG sequences into the optimised WebP frame
sets that the website actually loads (assets/anim/ and assets/anim/mobile/).

Run this whenever the aircraft animation is re-rendered:

    python tools/build-frames.py "C:/path/to/1280 x 720 (90 frames)" \
                                 "C:/path/to/640 x 360 (90 frames)"

What it does
------------
1. Renames frames to a 0-based, zero-padded sequence (0000.webp, 0001.webp …)
   because assets/js/hero-aircraft.js indexes frames from 0.

2. Keys the black background to transparency. The Blender renders arrive as
   opaque RGB on pure black. The website draws them on a <canvas> that
   overlays real page content — including lighter sections (#161616) and
   photos — so an opaque frame would paint a visible dark rectangle over
   them.

   Alpha is built from max(R, G, B) and then multiplied by ALPHA_GAIN so it
   becomes a *coverage mask* (mostly 0 or 255) rather than a copy of the
   model's brightness. This matters twice over:
     • Correctness — with a raw luminance alpha, genuinely dark parts of the
       aircraft (tyres, shadowed structure) come out semi-transparent and
       fade away. A coverage mask keeps them solid, as they should be.
     • Size — a near-binary mask compresses far better than a detailed
       grayscale one. Measured on this sequence: ~95 KB/frame with luminance
       alpha vs ~47 KB/frame with the gain applied, i.e. half the payload
       for a visual difference of ~1/255 at the opacity the site draws at.

   NOTE: if you re-render, ticking Blender's Render Properties → Film →
   Transparent gives a true alpha channel and this keying step becomes a
   no-op (frames that already have alpha are passed through unchanged).

3. Encodes WebP (quality tuned per device) to keep the payload small.

Typical output: desktop ~5-6 MB, mobile ~2 MB.
"""

import os
import sys
import glob
from PIL import Image, ImageChops

# (source dir, output dir, webp quality)
TARGETS = [
    ("1280x720 desktop", "assets/anim",        80),
    ("640x360 mobile",   "assets/anim/mobile", 78),
]

# Alpha values <= this are treated as pure background (kills faint render noise).
NOISE_FLOOR = 2

# Multiplier turning the luminance key into a coverage mask (see docstring).
# Anything at least 255/ALPHA_GAIN bright becomes fully opaque; the ramp below
# that still gives antialiased edges. Raise it for a harder cutout, lower it
# for a softer/ghostlier one.
ALPHA_GAIN = 4


def key_black_to_alpha(im):
    """Return an RGBA image with the black background keyed out."""
    if im.mode in ("RGBA", "LA"):
        return im.convert("RGBA")          # already has alpha — leave it alone
    rgb = im.convert("RGB")
    r, g, b = rgb.split()
    alpha = ImageChops.lighter(ImageChops.lighter(r, g), b)   # max(R,G,B)
    alpha = alpha.point(
        lambda v: 0 if v <= NOISE_FLOOR else min(255, int(v * ALPHA_GAIN))
    )
    out = rgb.convert("RGBA")
    out.putalpha(alpha)
    return out


def build(src_dir, out_dir, quality):
    files = sorted(glob.glob(os.path.join(src_dir, "*.png")))
    if not files:
        sys.exit("No PNGs found in: %s" % src_dir)

    os.makedirs(out_dir, exist_ok=True)
    for old in glob.glob(os.path.join(out_dir, "*.webp")):
        os.remove(old)

    total = 0
    for i, path in enumerate(files):                 # 0-based output numbering
        frame = key_black_to_alpha(Image.open(path))
        dest = os.path.join(out_dir, "%04d.webp" % i)
        frame.save(dest, "WEBP", quality=quality, method=6)
        total += os.path.getsize(dest)

    w, h = Image.open(files[0]).size
    print("%-20s %d frames  %dx%d  ->  %5.2f MB   (~%d MB decoded)"
          % (out_dir, len(files), w, h,
             total / 1048576.0, len(files) * w * h * 4 / 1048576))
    return len(files)


if __name__ == "__main__":
    if len(sys.argv) != 3:
        sys.exit(__doc__)

    counts = []
    for src, (label, out_dir, q) in zip(sys.argv[1:3], TARGETS):
        counts.append(build(src, out_dir, q))

    if len(set(counts)) != 1:
        print("\nWARNING: frame counts differ %s — both sets must match, "
              "because hero-aircraft.js uses one scroll mapping for both."
              % counts)
    else:
        print("\nBoth sets have %d frames. Set `count` in the CONFIG block of "
              "assets/js/hero-aircraft.js to %d if it differs."
              % (counts[0], counts[0]))
