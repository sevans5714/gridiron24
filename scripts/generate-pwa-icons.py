#!/usr/bin/env python3
"""Regenerate public/assets/pwa icons from the crest.

Makes the crest fill most of the icon so home-screen tiles don't collapse
into a thin vertical 'I' on a black field.
"""

from pathlib import Path
from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
SRC = ROOT / "public" / "assets" / "gridiron24-crest.png"
OUT = ROOT / "public" / "assets" / "pwa"
BG = (2, 6, 15, 255)  # #02060f — matches manifest theme_color


def fit_crest(crest: Image.Image, size: int, fill: float = 0.94, maskable: bool = False, transparent: bool = False) -> Image.Image:
    canvas_bg = (0, 0, 0, 0) if transparent else BG
    canvas = Image.new("RGBA", (size, size), canvas_bg)
    target = int(size * (0.80 if maskable else fill))
    cw, ch = crest.size
    scale = target / max(cw, ch)
    nw, nh = max(1, int(cw * scale)), max(1, int(ch * scale))
    resized = crest.resize((nw, nh), Image.Resampling.LANCZOS)
    px = resized.load()
    for y in range(nh):
        for x in range(nw):
            r, g, b, a = px[x, y]
            if 0 < a < 60 and (r + g + b) / 3 > 200:
                px[x, y] = (0, 0, 0, 0)
    ox = (size - nw) // 2
    oy = (size - nh) // 2
    canvas.alpha_composite(resized, (ox, oy))
    return canvas


def save_rgb(img: Image.Image, path: Path) -> None:
    bg = Image.new("RGBA", img.size, BG)
    Image.alpha_composite(bg, img).convert("RGB").save(path, "PNG", optimize=True)
    print(f"wrote {path.relative_to(ROOT)}")


def main() -> None:
    src = Image.open(SRC).convert("RGBA")
    crest = src.crop(src.getbbox())
    OUT.mkdir(parents=True, exist_ok=True)
    save_rgb(fit_crest(crest, 192), OUT / "icon-192.png")
    save_rgb(fit_crest(crest, 512), OUT / "icon-512.png")
    save_rgb(fit_crest(crest, 180), OUT / "apple-touch-icon.png")
    save_rgb(fit_crest(crest, 512, maskable=True), OUT / "icon-maskable-512.png")
    fit_crest(crest, 192, fill=0.98, transparent=True).save(OUT / "icon-192-transparent.png", "PNG", optimize=True)
    fit_crest(crest, 512, fill=0.98, transparent=True).save(OUT / "icon-512-transparent.png", "PNG", optimize=True)
    print("done — run: npm run bump:pwa")


if __name__ == "__main__":
    main()
