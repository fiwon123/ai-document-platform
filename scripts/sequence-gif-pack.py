#!/usr/bin/env python3
"""Assemble an ordered list of PNGs into a single animated GIF.

The encoding half of `scripts/sequence-gif.mjs`. Kept as a separate process
because Pillow lives in the system python, not the backend venv, and a Node
GIF encoder would mean reimplementing LZW and median-cut quantisation for no
benefit.

Frames are passed after `--` in the order they should play, and that order is
the contract: a scroll sequence assembled backwards is a page scrolling up,
which is worse than no GIF at all.

Both list lengths are printed to stdout on success and diagnostics go to
stderr, so the Node caller can report a real frame count rather than echoing
back what it hoped for.
"""

import argparse
import glob
import sys

from PIL import Image


def natural_key(path):
    """Sort `f-00010.png` after `f-0002.png`.

    Lexical ordering gets this wrong as soon as a clip runs past nine frames,
    which at 25fps is a third of a second.
    """
    digits = "".join(c for c in path.split("/")[-1] if c.isdigit())
    return (int(digits) if digits else 0, path)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--out", required=True)
    parser.add_argument("--width", type=int, default=640)
    parser.add_argument("--colors", type=int, default=64)
    parser.add_argument("--delay", type=int, default=240)
    parser.add_argument("--frames", type=int, default=16)
    parser.add_argument("paths", nargs="*")
    args = parser.parse_args()

    frames = []
    for entry in args.paths:
        # A directory is expanded so the decoded frame set can be passed whole.
        if entry.endswith("/") or "*" in entry:
            frames.extend(glob.glob(entry.rstrip("/") + "/*.png") if "*" not in entry
                          else glob.glob(entry))
        else:
            frames.append(entry)
    frames = sorted(set(frames), key=natural_key)

    if not frames:
        print("no input frames", file=sys.stderr)
        return 1

    # Evenly spread the sample across the whole sequence, endpoints included:
    # the tail of a long scroll is the part that used to be invisible.
    if len(frames) > args.frames:
        last = len(frames) - 1
        idx = [round(i * last / (args.frames - 1)) for i in range(args.frames)]
        frames = [frames[i] for i in sorted(set(idx))]

    first = Image.open(frames[0])
    width = min(args.width, first.width)
    height = max(1, round(first.height * width / first.width))

    paletted = []
    for path in frames:
        with Image.open(path) as im:
            im = im.convert("RGB")
            if im.width != width:
                im = im.resize((width, height), Image.LANCZOS)
            paletted.append(
                im.quantize(
                    colors=args.colors,
                    method=Image.MEDIANCUT,
                    dither=Image.FLOYDSTEINBERG,
                )
            )

    head, *tail = paletted
    head.save(
        args.out,
        save_all=True,
        append_images=tail,
        duration=args.delay,
        loop=0,
        optimize=True,
        # disposal=2 so each frame is cleared before the next: without it a
        # partially-drawn frame composites onto its predecessor and a moving
        # region smears a trail behind it.
        disposal=2,
    )
    print(len(paletted))
    return 0


if __name__ == "__main__":
    sys.exit(main())
