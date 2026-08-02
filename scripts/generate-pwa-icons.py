#!/usr/bin/env python3
"""Regenerate public/assets/pwa icons from the GridIron 24 brand mark.

Source: public/assets/gridiron24-pwa-source.png
- Dark-backed square app icons are used full-bleed (resize only).
- Legacy white-paper crests still get a white-field knockout.
"""

from __future__ import annotations

import io
import struct
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
SRC = ROOT / "public" / "assets" / "gridiron24-pwa-source.png"
OUT = ROOT / "public" / "assets" / "pwa"
PUBLIC = ROOT / "public"
BG = (2, 6, 15, 255)  # #02060f — matches manifest theme_color


def _corner_avg(im: Image.Image) -> float:
    px = im.load()
    w, h = im.size
    samples = [
        px[2, 2],
        px[w - 3, 2],
        px[2, h - 3],
        px[w - 3, h - 3],
        px[w // 2, 2],
        px[2, h // 2],
    ]
    vals = []
    for c in samples:
        r, g, b = c[:3]
        vals.append((r + g + b) / 3.0)
    return sum(vals) / len(vals)


def load_crest() -> Image.Image:
    raw = Image.open(SRC).convert("RGBA")
    # Ready-made app icon (dark square) — keep the full frame, including chrome.
    if _corner_avg(raw) < 40:
        return raw

    # Legacy white-paper crest: knock out near-white field
    px = raw.load()
    w, h = raw.size
    for y in range(h):
        for x in range(w):
            r, g, b, a = px[x, y]
            if r >= 245 and g >= 245 and b >= 245:
                px[x, y] = (0, 0, 0, 0)
            elif r >= 235 and g >= 235 and b >= 235:
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
    # Full-bleed square sources: use nearly the whole tile
    if crest.size[0] == crest.size[1] and _corner_avg(crest) < 40:
        fill = 1.0 if not maskable else 0.80
    target = int(size * (0.80 if maskable else fill))
    scale = target / max(crest.size)
    nw = max(1, int(crest.size[0] * scale))
    nh = max(1, int(crest.size[1] * scale))
    resized = crest.resize((nw, nh), Image.Resampling.LANCZOS)
    canvas.alpha_composite(resized, ((size - nw) // 2, (size - nh) // 2))
    return canvas


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
    print(f"source {crest.size} corner_avg={_corner_avg(crest):.1f}")
    OUT.mkdir(parents=True, exist_ok=True)
    for size, name in [(192, "icon-192.png"), (512, "icon-512.png"), (180, "apple-touch-icon.png")]:
        save_rgb(fit(crest, size), OUT / name)
    save_rgb(fit(crest, 512, maskable=True), OUT / "icon-maskable-512.png")
    fit(crest, 192, transparent=True).save(OUT / "icon-192-transparent.png", "PNG", optimize=True)
    fit(crest, 512, transparent=True).save(OUT / "icon-512-transparent.png", "PNG", optimize=True)
    print(f"wrote {(OUT / 'icon-192-transparent.png').relative_to(ROOT)}")
    print(f"wrote {(OUT / 'icon-512-transparent.png').relative_to(ROOT)}")

    c16 = fit(crest, 16)
    c32 = fit(crest, 32)
    c48 = fit(crest, 48)
    c64 = fit(crest, 64)
    write_ico(PUBLIC / "favicon.ico", [(16, c16), (32, c32), (48, c48)])
    save_rgb(c32, PUBLIC / "favicon-32.png")
    save_rgb(c48, PUBLIC / "favicon-48.png")
    save_rgb(c64, PUBLIC / "favicon.png")
    save_rgb(fit(crest, 180), PUBLIC / "apple-touch-icon.png")
    save_rgb(fit(crest, 180), PUBLIC / "apple-touch-icon-precomposed.png")

    print("done — run: npm run bump:pwa")


if __name__ == "__main__":
    main()
