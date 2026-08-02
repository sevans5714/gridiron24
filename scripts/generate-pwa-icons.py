#!/usr/bin/env python3
"""Regenerate public/assets/pwa icons from the GridIron 24 crest.

Source: public/assets/gridiron24-pwa-source.png (white-backed brand art).
Knocks out the white field and places the crest on navy so home-screen /
bookmark tiles show the real logo, not a letter glyph.

Tiny favicons (16/32) use a clear blue "24" mark — the full crest collapses
into a shape that reads as a giant "H" at those sizes.
"""

from __future__ import annotations

import io
import struct
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parents[1]
SRC = ROOT / "public" / "assets" / "gridiron24-pwa-source.png"
OUT = ROOT / "public" / "assets" / "pwa"
PUBLIC = ROOT / "public"
BG = (2, 6, 15, 255)  # #02060f — matches manifest theme_color
BLUE = (47, 109, 255, 255)
SILVER = (236, 240, 248, 255)


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


def fit(
    crest: Image.Image,
    size: int,
    fill: float = 0.94,
    maskable: bool = False,
    transparent: bool = False,
) -> Image.Image:
    canvas_bg = (0, 0, 0, 0) if transparent else BG
    canvas = Image.new("RGBA", (size, size), canvas_bg)
    target = int(size * (0.80 if maskable else fill))
    scale = target / max(crest.size)
    nw = max(1, int(crest.size[0] * scale))
    nh = max(1, int(crest.size[1] * scale))
    resized = crest.resize((nw, nh), Image.Resampling.LANCZOS)
    canvas.alpha_composite(resized, ((size - nw) // 2, (size - nh) // 2))
    return canvas


def mark_24(size: int) -> Image.Image:
    """Legible blue '24' for bookmark/tab favicons (crest reads as 'H' below ~40px)."""
    img = Image.new("RGBA", (size, size), BG)
    draw = ImageDraw.Draw(img)
    font_paths = [
        "/System/Library/Fonts/Supplemental/Arial Black.ttf",
        "/System/Library/Fonts/Supplemental/Arial Bold.ttf",
        "/Library/Fonts/Arial Black.ttf",
        "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
    ]
    font = None
    for path in font_paths:
        try:
            font = ImageFont.truetype(path, max(10, int(size * 0.72)))
            break
        except OSError:
            continue
    if font is None:
        font = ImageFont.load_default()
    text = "24"
    bbox = draw.textbbox((0, 0), text, font=font)
    tw, th = bbox[2] - bbox[0], bbox[3] - bbox[1]
    tx = (size - tw) // 2 - bbox[0]
    ty = (size - th) // 2 - bbox[1]
    for dx, dy in ((-1, 0), (1, 0), (0, -1), (0, 1)):
        draw.text((tx + dx, ty + dy), text, font=font, fill=SILVER)
    draw.text((tx, ty), text, font=font, fill=BLUE)
    return img


def png_bytes(im: Image.Image) -> bytes:
    buf = io.BytesIO()
    im.convert("RGBA").save(buf, format="PNG")
    return buf.getvalue()


def write_ico(path: Path, frames: list[tuple[int, Image.Image]]) -> None:
    """Write a multi-size ICO with embedded PNG frames (modern browsers)."""
    pngs = [(size, png_bytes(im)) for size, im in frames]
    num = len(pngs)
    offset = 6 + 16 * num
    entries: list[bytes] = []
    payload = b""
    for size, data in pngs:
        w = 0 if size >= 256 else size
        h = 0 if size >= 256 else size
        entries.append(struct.pack("<BBBBHHII", w, h, 0, 0, 1, 32, len(data), offset + len(payload)))
        payload += data
    path.write_bytes(struct.pack("<HHH", 0, 1, num) + b"".join(entries) + payload)
    print(f"wrote {path.relative_to(ROOT)} ({path.stat().st_size} bytes, sizes={[s for s, _ in frames]})")


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
    print(f"wrote {(OUT / 'icon-192-transparent.png').relative_to(ROOT)}")
    print(f"wrote {(OUT / 'icon-512-transparent.png').relative_to(ROOT)}")

    # Favicons: 16/32 = legible "24"; 48+ = full crest for larger chrome tabs
    m16 = mark_24(16)
    m32 = mark_24(32)
    c48 = fit(crest, 48, fill=0.96)
    c64 = fit(crest, 64, fill=0.96)
    write_ico(PUBLIC / "favicon.ico", [(16, m16), (32, m32), (48, c48)])
    save_rgb(m32, PUBLIC / "favicon-32.png")
    save_rgb(c48, PUBLIC / "favicon-48.png")
    save_rgb(c64, PUBLIC / "favicon.png")
    save_rgb(fit(crest, 180, fill=0.96), PUBLIC / "apple-touch-icon.png")
    save_rgb(fit(crest, 180, fill=0.96), PUBLIC / "apple-touch-icon-precomposed.png")

    print("done — run: npm run bump:pwa")


if __name__ == "__main__":
    main()
