#!/usr/bin/env python3
"""Regenerate public/assets/pwa icons from the GridIron 24 crest.

Source: public/assets/gridiron24-pwa-source.png (white-backed brand art).
Knocks out the white field and places the crest on navy so home-screen /
bookmark tiles show the real logo, not a letter glyph.
"""

from pathlib import Path
from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
SRC = ROOT / "public" / "assets" / "gridiron24-pwa-source.png"
OUT = ROOT / "public" / "assets" / "pwa"
BG = (2, 6, 15, 255)  # #02060f — matches manifest theme_color


def load_crest() -> Image.Image:
    raw = Image.open(SRC).convert("RGBA")
    px = raw.load()
    w, h = raw.size
    # Knock out near-white paper background (keep crest chrome / blue)
    for y in range(h):
        for x in range(w):
            r, g, b, a = px[x, y]
            if r >= 245 and g >= 245 and b >= 245:
                px[x, y] = (0, 0, 0, 0)
            elif r >= 235 and g >= 235 and b >= 235:
                # soft anti-aliased fringe → fade
                strength = ((r + g + b) / 3 - 235) / 20.0
                px[x, y] = (r, g, b, max(0, int(a * (1 - strength))))
    bbox = raw.getbbox()
    if not bbox:
        raise RuntimeError("No crest content after white knockout")
    return raw.crop(bbox)


def fit(crest: Image.Image, size: int, fill: float = 0.94, maskable: bool = False, transparent: bool = False) -> Image.Image:
    canvas_bg = (0, 0, 0, 0) if transparent else BG
    canvas = Image.new("RGBA", (size, size), canvas_bg)
    target = int(size * (0.80 if maskable else fill))
    scale = target / max(crest.size)
    nw = max(1, int(crest.size[0] * scale))
    nh = max(1, int(crest.size[1] * scale))
    resized = crest.resize((nw, nh), Image.Resampling.LANCZOS)
    canvas.alpha_composite(resized, ((size - nw) // 2, (size - nh) // 2))
    return canvas


def save_rgb(img: Image.Image, path: Path) -> None:
    bg = Image.new("RGBA", img.size, BG)
    Image.alpha_composite(bg, img).convert("RGB").save(path, "PNG", optimize=True)
    print(f"wrote {path.relative_to(ROOT)}")


def main() -> None:
    if not SRC.exists():
        raise SystemExit(f"Missing source: {SRC}")
    crest = load_crest()
    print(f"crest crop {crest.size}")
    OUT.mkdir(parents=True, exist_ok=True)
    for size, name in [(192, "icon-192.png"), (512, "icon-512.png"), (180, "apple-touch-icon.png")]:
        save_rgb(fit(crest, size, fill=0.96), OUT / name)
    save_rgb(fit(crest, 512, maskable=True), OUT / "icon-maskable-512.png")
    fit(crest, 192, fill=0.98, transparent=True).save(OUT / "icon-192-transparent.png", "PNG", optimize=True)
    fit(crest, 512, fill=0.98, transparent=True).save(OUT / "icon-512-transparent.png", "PNG", optimize=True)
    print("done — run: npm run bump:pwa")


if __name__ == "__main__":
    main()
