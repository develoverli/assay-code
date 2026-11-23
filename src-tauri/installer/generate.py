"""Generate the installer artwork (NSIS header and sidebar, macOS .dmg background)
from the app's own design tokens.

NSIS only accepts BMP and ignores alpha, so its images are drawn flat on the
app background instead of relying on transparency.
"""

import os

from PIL import Image, ImageDraw, ImageFont

# next to this file, which is where tauri.conf.json points
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "")

BG = (10, 11, 13)  # --color-bg #0a0b0d
SURFACE = (20, 22, 25)  # --color-surface #141619
BORDER = (38, 41, 47)  # --color-border #26292f
TEXT = (230, 232, 235)  # --color-text #e6e8eb
TEXT_3 = (134, 141, 149)  # --color-text-3 #868d95
ACCENT = (124, 92, 255)  # --color-accent #7c5cff
BRASS = (201, 151, 63)  # --color-brass #c9973f


def mark(draw, x, y, size, color, width):
    """The assay streak: three strokes, each fainter than the last."""
    s = size / 64.0

    def line(x1, y1, x2, y2, alpha):
        c = tuple(int(BG[i] + (color[i] - BG[i]) * alpha) for i in range(3))
        draw.line(
            [(x + x1 * s, y + y1 * s), (x + x2 * s, y + y2 * s)],
            fill=c,
            width=max(1, int(width * s)),
        )

    line(16, 46, 34, 16, 1.0)
    line(28, 46, 40, 26, 0.62)
    line(40, 46, 46, 36, 0.34)


def font(size, bold=False):
    for name in (
        "C:/Windows/Fonts/segoeuisb.ttf" if bold else "C:/Windows/Fonts/segoeui.ttf",
        "C:/Windows/Fonts/arialbd.ttf" if bold else "C:/Windows/Fonts/arial.ttf",
    ):
        try:
            return ImageFont.truetype(name, size)
        except OSError:
            continue
    return ImageFont.load_default()


def header():
    """150x57, shown top-right on every page after the welcome screen."""
    img = Image.new("RGB", (150, 57), BG)
    d = ImageDraw.Draw(img)
    d.rectangle([0, 56, 150, 57], fill=BORDER)
    mark(d, 10, 8, 40, BRASS, 7)
    d.text((56, 13), "Assay", font=font(17, bold=True), fill=TEXT)
    d.text((57, 33), "build · check · ship", font=font(9), fill=TEXT_3)
    img.save(OUT + "header.bmp", "BMP")


def sidebar():
    """164x314, the welcome and finish pages."""
    img = Image.new("RGB", (164, 314), BG)
    d = ImageDraw.Draw(img)

    # a slab of surface behind the mark, so the panel reads as the app's window
    d.rectangle([0, 0, 164, 196], fill=SURFACE)
    d.rectangle([0, 196, 164, 197], fill=BORDER)
    mark(d, 40, 52, 96, BRASS, 7)

    d.text((16, 210), "Assay", font=font(24, bold=True), fill=TEXT)
    d.text((17, 242), "build · check · ship", font=font(12), fill=TEXT_3)
    d.text((17, 258), "your own projects,", font=font(12), fill=TEXT_3)
    d.text((17, 274), "with local or cloud AI", font=font(12), fill=TEXT_3)

    # one accent rule: the same "one accent, used once" rule as the app
    d.rectangle([16, 296, 52, 298], fill=ACCENT)
    img.save(OUT + "sidebar.bmp", "BMP")


def dmg():
    """660x400 background for the macOS drag-to-install window.

    Only the backdrop: the app icon and the Applications alias are placed by
    macOS at the coordinates in tauri.conf.json, so nothing is drawn there.
    """
    img = Image.new("RGB", (660, 400), BG)
    d = ImageDraw.Draw(img)

    d.rectangle([0, 0, 660, 92], fill=SURFACE)
    d.rectangle([0, 92, 660, 93], fill=BORDER)
    mark(d, 28, 22, 48, BRASS, 7)
    d.text((88, 26), "Assay", font=font(26, bold=True), fill=TEXT)
    d.text((90, 60), "build · check · ship your own projects, with local or cloud AI",
           font=font(12), fill=TEXT_3)

    # the gesture the window is asking for, under where macOS puts the icons
    d.text((196, 300), "drag", font=font(13), fill=TEXT_3)
    d.line([(250, 306), (410, 306)], fill=BORDER, width=2)
    d.polygon([(410, 300), (422, 306), (410, 312)], fill=ACCENT)
    d.text((432, 300), "to Applications", font=font(13), fill=TEXT_3)

    img.save(OUT + "dmg-background.png", "PNG")


header()
sidebar()
dmg()
print("wrote", OUT)
