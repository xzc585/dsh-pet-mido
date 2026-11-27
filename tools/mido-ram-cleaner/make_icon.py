#!/usr/bin/env python3
"""Build a multi-size Midou Windows .ico from the pet-pack character art."""

from __future__ import annotations

import io
import struct
import sys
from pathlib import Path

from PIL import Image, ImageFilter

HERE = Path(__file__).resolve().parent
CANDIDATES = [
    HERE.parents[1] / "dsh-pet/assets/pet-packs/dog/dog-character.png",
    Path("/workspace/dsh-pet/dsh-pet/assets/pet-packs/dog/dog-character.png"),
    Path("/workspace/publish/dsh-pet-mido/dsh-pet/assets/pet-packs/dog/dog-character.png"),
]
OUT = HERE / "icon.ico"
SIZES = (16, 32, 48, 64, 128, 256)
# Small Explorer/tray sizes read better as a tight face crop; larger sizes keep the full sit pose.
FACE_SIZES = {16, 32, 48}


def find_source() -> Path:
    for path in CANDIDATES:
        if path.is_file():
            return path
    raise SystemExit("dog-character.png not found; cannot build icon.ico")


def crop_square(img: Image.Image, box: tuple[int, int, int, int], margin_ratio: float) -> Image.Image:
    x0, y0, x1, y1 = box
    cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
    side = max(x1 - x0, y1 - y0) * (1 + margin_ratio * 2)
    half = side / 2
    left, top, right, bottom = cx - half, cy - half, cx + half, cy + half
    width, height = img.size
    pad_l = int(max(0, -left))
    pad_t = int(max(0, -top))
    pad_r = int(max(0, right - width))
    pad_b = int(max(0, bottom - height))
    if pad_l or pad_t or pad_r or pad_b:
        canvas = Image.new("RGBA", (width + pad_l + pad_r, height + pad_t + pad_b), (0, 0, 0, 0))
        canvas.paste(img, (pad_l, pad_t), img)
        img = canvas
        left, top, right, bottom = left + pad_l, top + pad_t, right + pad_l, bottom + pad_t
    return img.crop((int(round(left)), int(round(top)), int(round(right)), int(round(bottom))))


def downscale(img: Image.Image, size: int) -> Image.Image:
    work = img
    while max(work.size) > size * 4:
        work = work.resize((work.size[0] // 2, work.size[1] // 2), Image.Resampling.LANCZOS)
    out = work.resize((size, size), Image.Resampling.LANCZOS)
    alpha = out.getchannel("A")
    if size <= 64:
        rgb = out.convert("RGB").filter(
            ImageFilter.UnsharpMask(
                radius=0.8 if size <= 32 else 1.0,
                percent=120 if size <= 32 else 90,
                threshold=2,
            )
        )
        alpha = alpha.point(lambda p: 0 if p < 8 else (255 if p > 240 else p))
        out = Image.merge("RGBA", (*rgb.split(), alpha))
    else:
        out.putalpha(alpha.point(lambda p: 0 if p < 4 else p))
    return out


def png_bytes(img: Image.Image) -> bytes:
    buf = io.BytesIO()
    img.save(buf, format="PNG", optimize=True)
    return buf.getvalue()


def write_ico(path: Path, frames: list[tuple[int, bytes]]) -> None:
    # Pillow's ICO saver often keeps only one size; pack PNG frames ourselves.
    # Vista+ Windows accepts PNG-compressed images inside .ico, including 256px.
    count = len(frames)
    header = struct.pack("<HHH", 0, 1, count)
    offset = 6 + 16 * count
    entries = bytearray()
    payload = bytearray()
    for size, data in frames:
        width = 0 if size >= 256 else size
        height = 0 if size >= 256 else size
        entries += struct.pack("<BBBBHHII", width, height, 0, 0, 1, 32, len(data), offset)
        payload += data
        offset += len(data)
    path.write_bytes(header + entries + payload)


def main() -> int:
    src_path = find_source()
    src = Image.open(src_path).convert("RGBA")
    bbox = src.getchannel("A").getbbox()
    if not bbox:
        raise SystemExit(f"{src_path} has no opaque pixels")
    full = crop_square(src, bbox, 0.035)
    face = crop_square(src, (bbox[0], bbox[1], bbox[2], 700), 0.03)
    frames = []
    for size in SIZES:
        img = face if size in FACE_SIZES else full
        frames.append((size, png_bytes(downscale(img, size))))
    write_ico(OUT, frames)
    print(f"wrote {OUT} from {src_path} sizes={list(SIZES)} bytes={OUT.stat().st_size}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
