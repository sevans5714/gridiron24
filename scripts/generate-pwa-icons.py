#!/usr/bin/env python3
"""Regenerate public/assets/pwa icons.

Uses a bold blue "24" monogram on navy — the full crest collapses into
letter shapes (I / H) at bookmark / home-screen sizes.
"""

from pathlib import Path
from PIL import Image, ImageDraw, ImageFont, ImageFilter

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "public" / "assets" / "pwa"
BG = (2, 6, 15, 255)  # #02060f
BLUE = (47, 109, 255, 255)
SILVER = (236, 240, 248, 255)

FONT_CANDIDATES = [
    "/System/Library/Fonts/Supplemental/Arial Black.ttf",
    "/System/Library/Fonts/Supplemental/Impact.ttf",
    "/Library/Fonts/Arial Black.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
    "/System/Library/Fonts/Helvetica.ttc",
]


def pick_font(size: int) -> ImageFont.ImageFont:
    for path in FONT_CANDIDATES:
        try:
            return ImageFont.truetype(path, size=size)
        except Exception:
            continue
    return ImageFont.load_default()


def make_icon(size: int, maskable: bool = False, transparent: bool = False) -> Image.Image:
    canvas_bg = (0, 0, 0, 0) if transparent else BG
    img = Image.new("RGBA", (size, size), canvas_bg)

    glow = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    gd = ImageDraw.Draw(glow)
    m = int(size * (0.14 if maskable else 0.04))
    gd.ellipse([m, m, size - m, size - m], fill=(47, 109, 255, 55))
    img = Image.alpha_composite(img, glow.filter(ImageFilter.GaussianBlur(size * 0.1)))
    d = ImageDraw.Draw(img)

    inset = int(size * (0.10 if maskable else 0.05))
    frame_w = max(2, size // 64)
    d.rounded_rectangle(
        [inset, inset, size - inset - 1, size - inset - 1],
        radius=int(size * 0.18),
        outline=(47, 109, 255, 180),
        width=frame_w,
    )
    d.rounded_rectangle(
        [
            inset + frame_w * 2,
            inset + frame_w * 2,
            size - inset - 1 - frame_w * 2,
            size - inset - 1 - frame_w * 2,
        ],
        radius=int(size * 0.14),
        outline=(201, 162, 39, 90),
        width=max(1, frame_w // 2),
    )

    fsize = int(size * (0.52 if not maskable else 0.46))
    font = pick_font(fsize)
    text = "24"
    bbox = d.textbbox((0, 0), text, font=font)
    tw, th = bbox[2] - bbox[0], bbox[3] - bbox[1]
    tx = (size - tw) // 2 - bbox[0]
    ty = (size - th) // 2 - bbox[1] + int(size * 0.02)

    outline = max(2, size // 48)
    for dx in range(-outline, outline + 1):
        for dy in range(-outline, outline + 1):
            if dx * dx + dy * dy > outline * outline:
                continue
            if dx or dy:
                d.text((tx + dx, ty + dy), text, font=font, fill=SILVER)
    d.text((tx, ty), text, font=font, fill=BLUE)
    return img


def save_rgb(img: Image.Image, path: Path) -> None:
    bg = Image.new("RGBA", img.size, BG)
    Image.alpha_composite(bg, img).convert("RGB").save(path, "PNG", optimize=True)
    print(f"wrote {path.relative_to(ROOT)}")


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    for size, name in [(192, "icon-192.png"), (512, "icon-512.png"), (180, "apple-touch-icon.png")]:
        save_rgb(make_icon(size), OUT / name)
    save_rgb(make_icon(512, maskable=True), OUT / "icon-maskable-512.png")
    make_icon(192, transparent=True).save(OUT / "icon-192-transparent.png", "PNG", optimize=True)
    make_icon(512, transparent=True).save(OUT / "icon-512-transparent.png", "PNG", optimize=True)
    print("done — run: npm run bump:pwa")


if __name__ == "__main__":
    main()
