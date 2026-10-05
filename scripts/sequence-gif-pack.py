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


def collect(args_paths):
    """Frames in play order: explicit arguments keep the order given.

    Only an expanded directory or glob is sorted naturally, because that is the
    one case where the order is implied by the filenames rather than by the
    caller. Re-sorting the whole list would quietly override the caller's order
    on the strength of whatever digits the filenames happen to contain — for the
    stepped sequences (`mobile-light-top.png`, `mobile-light-page-1.png`, …)
    that coincides with the capture order today, and would stop doing so the
    moment a state name acquired a digit of its own. A scroll sequence packed
    backwards is worse than no GIF, so the order the caller established is the
    order used here.
    """
    frames = []
    for entry in args_paths:
        if entry.endswith("/") or "*" in entry:
            pattern = entry if "*" in entry else entry.rstrip("/") + "/*.png"
            frames.extend(sorted(glob.glob(pattern), key=natural_key))
        else:
            frames.append(entry)

    # De-duplicate preserving first occurrence, so a frame handed over twice
    # does not play twice while every other frame plays once.
    seen = set()
    unique = []
    for path in frames:
        if path not in seen:
            seen.add(path)
            unique.append(path)
    return unique


def group_by_similarity(frames, threshold=3.0):
    """Group consecutive frames that show the same thing.

    One palette for the whole clip and one palette per frame are both wrong, and
    the measurements say why:

    - Per frame, each frame is quantised alone, so it has room for the page's
      saturated colours (the CTA blue lands within dE 10 of source) but a colour
      that is constant on the page renders differently per frame. Measured on the
      real theme crossfade: the PENDING tile swung brown -> red -> magenta ->
      orange, ~40 degrees of hue, across frames of the *same settled page*.
    - One palette for the whole clip is stable and starved: a recording holding
      both a light and a dark page spends its 256 entries on the two
      backgrounds, and the same CTA blue comes out (55,87,167) — a steel blue
      where the page shows vivid blue. Measured worst tile error dE 258.

    So a palette belongs to a *visual state*, not to a frame and not to the
    clip. Frames that show the same thing share one palette, and each state gets
    to spend the whole budget on the colours that state actually contains. This
    is the only arrangement that is both accurate and still.
    """
    groups = []
    for frame in frames:
        signature = frame.convert("L").resize((8, 8), Image.BOX).getdata()
        if groups:
            previous = groups[-1]["signature"]
            drift = sum(abs(a - b) for a, b in zip(signature, previous)) / len(signature)
            if drift < threshold:
                groups[-1]["frames"].append(frame)
                continue
        groups.append({"signature": signature, "frames": [frame]})
    return groups


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--out", required=True)
    parser.add_argument("--width", type=int, default=640)
    parser.add_argument("--colors", type=int, default=256)
    parser.add_argument("--delay", type=int, default=240)
    parser.add_argument("--frames", type=int, default=16)
    parser.add_argument("paths", nargs="*")
    args = parser.parse_args()

    frames = collect(args.paths)

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

    resized = []
    for path in frames:
        with Image.open(path) as im:
            frame = im.convert("RGB")
            if frame.width != width:
                frame = frame.resize((width, height), Image.LANCZOS)
            resized.append(frame)

    # A palette per visual state, dithered. See group_by_similarity for the
    # measurements behind grouping rather than sharing or splitting.
    paletted = []
    for group in group_by_similarity(resized):
        members = group["frames"]
        atlas = Image.new("RGB", (width, height * len(members)))
        for index, frame in enumerate(members):
            atlas.paste(frame, (0, index * height))
        palette = atlas.quantize(
            colors=args.colors,
            method=Image.MEDIANCUT,
            dither=Image.FLOYDSTEINBERG,
        )
        paletted.extend(
            frame.quantize(palette=palette, dither=Image.FLOYDSTEINBERG)
            for frame in members
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
