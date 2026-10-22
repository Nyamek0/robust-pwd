#!/usr/bin/env python3
"""Génère desktop/build/icon.png — icône de l'application (1024×1024)."""

from __future__ import annotations

import math
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw

SIZE = 1024
SCALE = 4
N = SIZE * SCALE
OUTPUT = Path(__file__).with_name("icon.png")

WHITE = (248, 247, 255, 255)
KEYHOLE = (60, 50, 184, 255)
TOP = np.array([139, 124, 255], dtype=float)
BOTTOM = np.array([65, 53, 190], dtype=float)


def sc(value: float) -> int:
    return int(round(value * SCALE))


def background() -> Image.Image:
    y, x = np.mgrid[0:N, 0:N]
    t = ((x / N) * 0.35 + (y / N) * 0.65)[..., None]
    pixels = TOP[None, None, :] * (1 - t) + BOTTOM[None, None, :] * t

    image = Image.fromarray(pixels.astype("uint8"), "RGB").convert("RGBA")

    # Reflet radial en haut à gauche.
    cx, cy = 0.32 * N, 0.18 * N
    distance = np.hypot(x - cx, y - cy) / (0.55 * N)
    glow = (np.exp(-(distance**2)) * 46).astype("uint8")
    highlight = Image.new("RGBA", (N, N), (255, 255, 255, 0))
    highlight.putalpha(Image.fromarray(glow, "L"))
    image = Image.alpha_composite(image, highlight)

    mask = Image.new("L", (N, N), 0)
    ImageDraw.Draw(mask).rounded_rectangle(
        [0, 0, N - 1, N - 1], radius=sc(230), fill=255
    )
    image.putalpha(mask)
    return image


def draw_lock(image: Image.Image) -> None:
    layer = Image.new("RGBA", (N, N), (0, 0, 0, 0))
    draw = ImageDraw.Draw(layer)

    # Anse : demi-anneau + deux montants.
    ring_radius = sc(150)
    ring_width = sc(56)
    cx, cy = sc(512), sc(445)
    draw.ellipse(
        [cx - ring_radius, cy - ring_radius, cx + ring_radius, cy + ring_radius],
        outline=WHITE,
        width=ring_width,
    )
    draw.rectangle([0, cy, N, N], fill=(0, 0, 0, 0))
    for center in (cx - sc(122), cx + sc(122)):
        draw.rounded_rectangle(
            [center - sc(28), cy - sc(20), center + sc(28), sc(515)],
            radius=sc(20),
            fill=WHITE,
        )

    # Corps du cadenas.
    draw.rounded_rectangle(
        [sc(332), sc(500), sc(692), sc(760)],
        radius=sc(64),
        fill=WHITE,
    )

    # Serrure.
    draw.ellipse([sc(476), sc(552), sc(548), sc(624)], fill=KEYHOLE)
    draw.rounded_rectangle(
        [sc(494), sc(596), sc(530), sc(668)],
        radius=sc(18),
        fill=KEYHOLE,
    )

    image.alpha_composite(layer)


def main() -> None:
    image = background()
    draw_lock(image)
    image = image.resize((SIZE, SIZE), Image.LANCZOS)
    image.save(OUTPUT, optimize=True)
    print(f"Icône écrite : {OUTPUT} ({OUTPUT.stat().st_size / 1024:.0f} Ko)")


if __name__ == "__main__":
    main()
