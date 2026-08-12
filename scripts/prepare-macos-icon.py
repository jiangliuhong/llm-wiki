#!/usr/bin/env python3
"""Prepare the supplied square artwork as a macOS/Tauri icon set."""

from pathlib import Path
import sys

from PIL import Image, ImageDraw


def main() -> None:
    if len(sys.argv) != 3:
        raise SystemExit("usage: prepare-macos-icon.py SOURCE.png OUTPUT_ICONSET")

    source_path = Path(sys.argv[1])
    iconset_path = Path(sys.argv[2])
    image = Image.open(source_path).convert("RGBA")

    # The supplied artwork is a 1254px square with the app mark centered in an
    # approximately 892px rounded square. Crop that mark and remove the dark
    # presentation background around it.
    left, top, right, bottom = (181, 166, 1073, 1058)
    artwork = image.crop((left, top, right, bottom))
    size = artwork.width
    mask_scale = 4
    mask = Image.new("L", (size * mask_scale, size * mask_scale), 0)
    draw = ImageDraw.Draw(mask)
    radius = 170 * mask_scale
    draw.rounded_rectangle(
        (0, 0, size * mask_scale - 1, size * mask_scale - 1),
        radius=radius,
        fill=255,
    )
    mask = mask.resize((size, size), Image.Resampling.LANCZOS)
    artwork.putalpha(mask)

    # Leave a transparent safety margin so the artwork does not visually
    # overpower neighboring macOS Dock icons.
    safe_size = round(size * 0.82)
    padded = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    offset = (size - safe_size) // 2
    padded.alpha_composite(
        artwork.resize((safe_size, safe_size), Image.Resampling.LANCZOS),
        (offset, offset),
    )
    artwork = padded

    iconset_path.mkdir(parents=True, exist_ok=True)
    for pixels, filename in (
        (16, "icon_16x16.png"),
        (32, "icon_16x16@2x.png"),
        (32, "icon_32x32.png"),
        (64, "icon_32x32@2x.png"),
        (128, "icon_128x128.png"),
        (256, "icon_128x128@2x.png"),
        (256, "icon_256x256.png"),
        (512, "icon_256x256@2x.png"),
        (512, "icon_512x512.png"),
        (1024, "icon_512x512@2x.png"),
    ):
        artwork.resize((pixels, pixels), Image.Resampling.LANCZOS).save(
            iconset_path / filename,
            format="PNG",
            optimize=True,
        )


if __name__ == "__main__":
    main()
