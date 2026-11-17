#!/usr/bin/env python3
"""
Draws the After Class favicon: a closed book seen at a slight angle, as a hand-placed 16x16 pixel grid.
Edit GRID or PALETTE, then run `python3 scripts/favicon.py` (needs Pillow). It writes src/app/assets/favicon/:
favicon-16.png, favicon-32.png (the grid scaled 2x, nearest neighbour), apple-touch-icon.png (180x180, the grid scaled
9x on a solid room-colored background) and favicon.ico (16, 32 and 48 px frames). It also writes the Chrome extension's icons into src/extension/icons/: icon-16,
32 and 48 are the grid scaled 1x, 2x and 3x, and icon-128 is the grid at 6x, 96 px of art inside 16 px of transparent
padding, as the Chrome Web Store asks.
Colors come from the room: the ink outline from src/app/front-row.css, cream paper and wood from the room plates, and the
teal-green of the rail plate.
"""
from pathlib import Path
from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "src/app/assets/favicon"
EXTENSION = ROOT / "src/extension/icons"

PALETTE = {
    ".": None,
    "O": "#2c2620",  # ink outline
    "T": "#3f7a6b",  # cover teal
    "H": "#58a08a",  # cover highlight
    "D": "#255148",  # spine, dark teal
    "C": "#f7e1d2",  # cream paper
    "S": "#d9bfa8",  # paper shade
    "G": "#e2b565",  # gold title bar
    "W": "#a06c52",  # wood brown, the cover's lower edge
}
APPLE_BACKGROUND = "#355853"  # the rail plate's teal-green

# 16 columns by 16 rows. The spine faces left, the page block shows on top and on the right.
GRID = [
    "................",
    "...OOOOOOOOOO...",
    "..OCCCCCCCCCCO..",
    ".OOOOOOOOOOOOSO.",
    ".ODDHHHHHHHHOCO.",
    ".ODDHTTTTTTTOSO.",
    ".ODDHTGGGGGTOCO.",
    ".ODDHTTTTTTTOSO.",
    ".ODDHTGGGTTTOCO.",
    ".ODDHTTTTTTTOSO.",
    ".ODDHTTTTTTTOCO.",
    ".ODDHTTTTTTTOSO.",
    ".ODDTTTTTTTTOCO.",
    ".OWWWWWWWWWWOOO.",
    "..OOOOOOOOOOOO..",
    "................",
]


def rgba(c):
    if c is None:
        return (0, 0, 0, 0)
    return tuple(int(c[i:i + 2], 16) for i in (1, 3, 5)) + (255,)


def build():
    assert len(GRID) == 16 and all(len(r) == 16 for r in GRID), "the grid must be 16x16"
    img = Image.new("RGBA", (16, 16))
    for y, row in enumerate(GRID):
        for x, ch in enumerate(row):
            img.putpixel((x, y), rgba(PALETTE[ch]))
    return img


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    book = build()
    big = book.resize((32, 32), Image.NEAREST)
    book.save(OUT / "favicon-16.png", optimize=True)
    big.save(OUT / "favicon-32.png", optimize=True)
    # 180px: the 16px grid at 9x is 144px, centered with 18px of padding on every side
    apple = Image.new("RGBA", (180, 180), rgba(APPLE_BACKGROUND))
    apple.alpha_composite(book.resize((144, 144), Image.NEAREST), (18, 18))
    apple.convert("RGB").save(OUT / "apple-touch-icon.png", optimize=True)
    book.resize((48, 48), Image.NEAREST).save(OUT / "favicon.ico", sizes=[(16, 16), (32, 32), (48, 48)])
    EXTENSION.mkdir(parents=True, exist_ok=True)
    for size in (16, 32, 48):
        book.resize((size, size), Image.NEAREST).save(EXTENSION / f"icon-{size}.png", optimize=True)
    store = Image.new("RGBA", (128, 128), (0, 0, 0, 0))
    store.alpha_composite(book.resize((96, 96), Image.NEAREST), (16, 16))
    store.save(EXTENSION / "icon-128.png", optimize=True)
    print(f"wrote the favicon files into {OUT} and the extension icons into {EXTENSION}")


if __name__ == "__main__":
    main()
