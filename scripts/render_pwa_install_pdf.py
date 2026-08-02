#!/usr/bin/env python3
"""Render GridIron 24 PWA install guide PDF (branded, print-clean)."""

from __future__ import annotations

import io
import json
import os
import struct
import sys
import zlib
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter, ImageFont

ROOT = Path(__file__).resolve().parents[1]
CREST_SRC = ROOT / "public" / "assets" / "gridiron24-crest-md.png"
APPLE_ICON = ROOT / "public" / "assets" / "icons" / "apple-white.png"
ANDROID_ICON = ROOT / "public" / "assets" / "icons" / "android.png"
GUIDE_JS = ROOT / "pwa-install-guide.js"

# Letter @ 2x for sharp print
W, H = 1700, 2200
MARGIN_X = 110
HEADER_H = 360
FOOTER_H = 90
NAVY = (13, 13, 13)  # matches crest disc / email #0d0d0d
BLUE = (47, 109, 255)
GOLD = (201, 162, 39)
GREEN = (31, 138, 91)
ANDROID_GREEN = (27, 138, 76)
INK = (22, 28, 38)
MUTED = (90, 98, 112)
PAPER = (255, 255, 255)
LINE = (220, 225, 232)
CARD_BG = (248, 250, 252)


def load_guide():
    """Minimal extract of GUIDE object from pwa-install-guide.js via node."""
    import subprocess

    code = r"""
const g = require('./pwa-install-guide').GUIDE;
process.stdout.write(JSON.stringify(g));
"""
    out = subprocess.check_output(["node", "-e", code], cwd=str(ROOT))
    return json.loads(out)


def font(size: int, bold: bool = False) -> ImageFont.FreeTypeFont:
    candidates = [
        "/System/Library/Fonts/Supplemental/Arial Bold.ttf" if bold else "/System/Library/Fonts/Supplemental/Arial.ttf",
        "/System/Library/Fonts/Supplemental/Helvetica.ttc",
        "/Library/Fonts/Arial.ttf",
        "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf" if bold else "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    ]
    for path in candidates:
        if os.path.exists(path):
            try:
                return ImageFont.truetype(path, size=size, index=0)
            except Exception:
                continue
    return ImageFont.load_default()


def prepare_crest(size: int = 260) -> Image.Image:
    src = Image.open(CREST_SRC).convert("RGBA")
    r, g, b, a = src.split()
    a = a.filter(ImageFilter.MinFilter(3))
    clean = Image.merge("RGBA", (r, g, b, a))
    px = clean.load()
    w, h = clean.size
    for y in range(h):
        for x in range(w):
            rr, gg, bb, aa = px[x, y]
            if aa == 0:
                px[x, y] = (0, 0, 0, 0)
                continue
            if aa < 255:
                af = aa / 255.0
                inv = 1 - af
                rr = max(0, min(255, int(round((rr - 255 * inv) / af))))
                gg = max(0, min(255, int(round((gg - 255 * inv) / af))))
                bb = max(0, min(255, int(round((bb - 255 * inv) / af))))
                px[x, y] = (rr, gg, bb, aa)
    resized = clean.resize((size, size), Image.Resampling.BICUBIC)
    # Kill any light fringe introduced by resampling against transparency
    px2 = resized.load()
    sw, sh = resized.size
    for y in range(sh):
        for x in range(sw):
            rr, gg, bb, aa = px2[x, y]
            if aa == 0:
                continue
            # Near-transparent edge pixels: force toward matte (no bright fringe)
            if aa < 40:
                px2[x, y] = (NAVY[0], NAVY[1], NAVY[2], 0)
                continue
            if aa < 220 and (rr + gg + bb) / 3 > 160:
                px2[x, y] = (NAVY[0], NAVY[1], NAVY[2], 0)
    bg = Image.new("RGBA", (size, size), NAVY + (255,))
    return Image.alpha_composite(bg, resized).convert("RGB")


def wrap(draw: ImageDraw.ImageDraw, text: str, font_obj, max_w: int) -> list[str]:
    words = text.split()
    lines: list[str] = []
    cur = ""
    for word in words:
        trial = f"{cur} {word}".strip()
        if draw.textlength(trial, font=font_obj) <= max_w:
            cur = trial
        else:
            if cur:
                lines.append(cur)
            cur = word
    if cur:
        lines.append(cur)
    return lines or [""]


def draw_header(page: Image.Image, crest: Image.Image, guide: dict, continued: bool = False) -> int:
    draw = ImageDraw.Draw(page)
    if continued:
        bar_h = 96
        draw.rectangle([0, 0, W, bar_h], fill=NAVY)
        draw.rectangle([0, 0, W, 6], fill=BLUE)
        draw.rectangle([0, bar_h - 5, W, bar_h], fill=GOLD)
        small = crest.resize((64, 64), Image.Resampling.LANCZOS)
        page.paste(small, (MARGIN_X, 16))
        draw.text((MARGIN_X + 80, 34), "GridIron 24  |  Install Guide (continued)", font=font(28, True), fill=(245, 245, 245))
        return bar_h + 36

    draw.rectangle([0, 0, W, HEADER_H], fill=NAVY)
    draw.rectangle([0, 0, W, 8], fill=BLUE)
    draw.rectangle([0, HEADER_H - 6, W, HEADER_H], fill=GOLD)

    crest_y = (HEADER_H - crest.size[0]) // 2 + 4
    page.paste(crest, (MARGIN_X - 8, crest_y))

    tx = MARGIN_X + crest.size[0] + 28
    draw.text((tx, 78), "GRIDIRON 24  |  FANTASY HQ", font=font(22, True), fill=GOLD)
    draw.text((tx, 120), "INSTALL THE APP", font=font(64, True), fill=(255, 255, 255))
    draw.text((tx, 200), guide["subtitle"], font=font(28), fill=(180, 186, 196))
    meta = f'{guide["updatedLabel"].upper()}  |  www.gridiron24.com'
    draw.text((tx, 250), meta, font=font(20, True), fill=BLUE)
    return HEADER_H + 40


def draw_footer(page: Image.Image, page_i: int, page_n: int) -> None:
    draw = ImageDraw.Draw(page)
    y = H - FOOTER_H
    draw.line([(MARGIN_X, y), (W - MARGIN_X, y)], fill=LINE, width=2)
    left = "GridIron 24 created by S.Evans  |  https://www.gridiron24.com"
    draw.text((MARGIN_X, y + 22), left, font=font(18), fill=MUTED)
    right = f"{page_i} / {page_n}"
    rw = draw.textlength(right, font=font(18))
    draw.text((W - MARGIN_X - rw, y + 22), right, font=font(18), fill=MUTED)


def load_icon(path: Path, size: int = 56) -> Image.Image:
    img = Image.open(path).convert("RGBA")
    return img.resize((size, size), Image.Resampling.LANCZOS)


def paste_rgba(page: Image.Image, icon: Image.Image, xy: tuple[int, int]) -> None:
    page.paste(icon, xy, icon)


def layout_blocks(guide: dict) -> list[dict]:
    blocks: list[dict] = []

    def para(text: str, muted: bool = False):
        blocks.append({"type": "para", "text": text, "muted": muted})

    def head(text: str, color, icon: str | None = None):
        blocks.append({"type": "head", "text": text.upper(), "color": color, "icon": icon})

    def tips():
        blocks.append({"type": "tips"})

    def bullets(items, numbered=False):
        for i, item in enumerate(items, 1):
            prefix = f"{i}.  " if numbered else "-  "
            blocks.append({"type": "bullet", "text": prefix + item})

    def space(h=18):
        blocks.append({"type": "space", "h": h})

    def platform_banner(kind: str, title: str):
        blocks.append({"type": "platform", "kind": kind, "title": title})

    para(guide["intro"][0])
    para(guide["intro"][1])
    space(22)
    head("Before you start", GOLD)
    bullets(guide["beforeYouStart"])
    space(26)
    platform_banner("apple", guide["apple"]["title"])
    space(10)
    bullets(guide["apple"]["steps"], numbered=True)
    space(28)
    platform_banner("android", guide["android"]["title"])
    space(10)
    bullets(guide["android"]["steps"], numbered=True)
    space(26)
    head(guide["afterInstall"]["title"], GOLD)
    bullets(guide["afterInstall"]["bullets"])
    return blocks


def paginate(guide: dict, crest: Image.Image) -> list[Image.Image]:
    blocks = layout_blocks(guide)
    pages: list[Image.Image] = []
    body_font = font(27)
    head_font = font(30, True)
    tip_font = font(22, True)
    platform_font = font(32, True)
    kicker_font = font(18, True)
    max_w = W - 2 * MARGIN_X
    apple_icon = load_icon(APPLE_ICON, 58)
    android_icon = load_icon(ANDROID_ICON, 58)

    def new_page(continued: bool) -> tuple[Image.Image, ImageDraw.ImageDraw, int]:
        page = Image.new("RGB", (W, H), PAPER)
        y = draw_header(page, crest, guide, continued=continued)
        return page, ImageDraw.Draw(page), y

    page, draw, y = new_page(False)
    bottom = H - FOOTER_H - 20

    def ensure(need: int):
        nonlocal page, draw, y
        if y + need <= bottom:
            return
        pages.append(page)
        page, draw, y = new_page(True)

    for b in blocks:
        if b["type"] == "space":
            ensure(b["h"])
            y += b["h"]
            continue
        if b["type"] == "platform":
            ensure(100)
            is_apple = b["kind"] == "apple"
            accent = BLUE if is_apple else ANDROID_GREEN
            icon = apple_icon if is_apple else android_icon
            # Card banner
            draw.rounded_rectangle(
                [MARGIN_X, y, W - MARGIN_X, y + 88],
                radius=14,
                fill=CARD_BG,
                outline=LINE,
                width=2,
            )
            draw.rectangle([MARGIN_X, y, MARGIN_X + 10, y + 88], fill=accent)
            # Icon tile
            tile = [MARGIN_X + 28, y + 15, MARGIN_X + 28 + 58, y + 15 + 58]
            tile_bg = (17, 17, 17) if is_apple else (16, 36, 24)
            draw.rounded_rectangle(tile, radius=12, fill=tile_bg)
            paste_rgba(page, icon, (MARGIN_X + 28, y + 15))
            kicker = "APPLE" if is_apple else "GOOGLE"
            draw.text((MARGIN_X + 106, y + 18), kicker, font=kicker_font, fill=MUTED)
            draw.text((MARGIN_X + 106, y + 42), b["title"].upper(), font=platform_font, fill=INK)
            y += 104
            continue
        if b["type"] == "head":
            ensure(50)
            draw.rectangle([MARGIN_X, y + 4, MARGIN_X + 7, y + 34], fill=b["color"])
            draw.text((MARGIN_X + 22, y), b["text"], font=head_font, fill=INK)
            y += 48
            continue
        if b["type"] == "tips":
            ensure(36)
            draw.rectangle([MARGIN_X, y + 2, MARGIN_X + 7, y + 26], fill=BLUE)
            draw.text((MARGIN_X + 22, y), "TIPS", font=tip_font, fill=BLUE)
            y += 36
            continue
        color = MUTED if b.get("muted") else INK
        lines = wrap(draw, b["text"], body_font, max_w - (20 if b["type"] == "bullet" else 0))
        for i, line in enumerate(lines):
            ensure(34)
            x = MARGIN_X + (20 if b["type"] == "bullet" else 0)
            draw.text((x, y), line, font=body_font, fill=color)
            y += 34
        y += 4

    pages.append(page)
    for i, p in enumerate(pages, 1):
        draw_footer(p, i, len(pages))
    return pages


def jpeg_bytes(img: Image.Image, quality: int = 92) -> bytes:
    buf = io.BytesIO()
    img.save(buf, format="JPEG", quality=quality, optimize=True, subsampling=0)
    return buf.getvalue()


def write_pdf(pages: list[Image.Image], out_path: Path) -> None:
    """Minimal PDF with one JPEG image per page (Letter)."""
    page_w, page_h = 612, 792  # 72dpi letter
    objects: list[bytes | tuple[bytes, bytes]] = []

    def add(obj: bytes | tuple[bytes, bytes]) -> int:
        objects.append(obj)
        return len(objects)

    # placeholder then fill
    font_ignored = None  # images only
    image_ids = []
    content_ids = []
    for img in pages:
        data = jpeg_bytes(img)
        img_obj = (
            f"<< /Type /XObject /Subtype /Image /Width {img.width} /Height {img.height} "
            f"/ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length {len(data)} >>".encode(),
            data,
        )
        image_ids.append(add(img_obj))
        # draw image full page
        stream = f"q {page_w} 0 0 {page_h} 0 0 cm /Im{len(image_ids)} Do Q".encode()
        content_ids.append(add((f"<< /Length {len(stream)} >>".encode(), stream)))

    page_ids = []
    for i, (img_id, content_id) in enumerate(zip(image_ids, content_ids), 1):
        page_dict = (
            f"<< /Type /Page /Parent 0 0 R /MediaBox [0 0 {page_w} {page_h}] "
            f"/Resources << /XObject << /Im{i} {img_id} 0 R >> >> "
            f"/Contents {content_id} 0 R >>"
        ).encode()
        page_ids.append(add(page_dict))

    pages_id = add(b"PLACEHOLDER")
    catalog_id = add(f"<< /Type /Catalog /Pages {pages_id} 0 R >>".encode())
    kids = " ".join(f"{pid} 0 R" for pid in page_ids)
    objects[pages_id - 1] = f"<< /Type /Pages /Count {len(page_ids)} /Kids [{kids}] >>".encode()
    for pid in page_ids:
        objects[pid - 1] = objects[pid - 1].replace(b"/Parent 0 0 R", f"/Parent {pages_id} 0 R".encode())

    out = bytearray(b"%PDF-1.4\n")
    offsets = [0]
    for i, obj in enumerate(objects, 1):
        offsets.append(len(out))
        if isinstance(obj, tuple):
            dict_part, stream = obj
            out.extend(f"{i} 0 obj\n".encode())
            out.extend(dict_part)
            out.extend(b"\nstream\n")
            out.extend(stream)
            out.extend(b"\nendstream\nendobj\n")
        else:
            out.extend(f"{i} 0 obj\n".encode())
            out.extend(obj)
            out.extend(b"\nendobj\n")
    xref = len(out)
    out.extend(f"xref\n0 {len(objects) + 1}\n".encode())
    out.extend(b"0000000000 65535 f \n")
    for off in offsets[1:]:
        out.extend(f"{off:010d} 00000 n \n".encode())
    out.extend(f"trailer\n<< /Size {len(objects) + 1} /Root {catalog_id} 0 R >>\n".encode())
    out.extend(f"startxref\n{xref}\n%%EOF\n".encode())
    out_path.write_bytes(bytes(out))


def main():
    out = Path(sys.argv[1]) if len(sys.argv) > 1 else ROOT / "public" / "docs" / "gridiron24-app-install.pdf"
    out.parent.mkdir(parents=True, exist_ok=True)
    guide = load_guide()
    crest = prepare_crest(260)
    pages = paginate(guide, crest)
    write_pdf(pages, out)
    print(f"Rendered {len(pages)} page(s) -> {out}")


if __name__ == "__main__":
    main()
