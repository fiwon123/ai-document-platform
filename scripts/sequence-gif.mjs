/**
 * One GIF per capture sequence — a reviewable artifact, not just a pile of stills.
 *
 * ## Why this exists
 *
 * `read` renders images, GIFs and PDFs. It does **not** render WebM. So the eight
 * animation recordings the audit produces cannot be opened by a model reviewer at
 * all, and the only way to review motion today is as a pile of separate stills.
 * Stepped marketing routes are worse: `/how-it-works` on mobile is eleven PNGs for
 * one page, so reviewing it costs eleven attachments. That is the direct cause of
 * the `Rate limit exceeded` failures hit during the 2026-09-29 run, where a
 * fifteen-way fan-out came back rate-limited and partly cancelled.
 *
 * The capture pipeline is not the problem. The *shape of the output* is. This
 * module packs a whole sequence into a single file.
 *
 * ## Why not ffmpeg
 *
 * Because ffmpeg cannot do it — and the audit already says so honestly. Playwright's
 * bundled binary is a screencast build:
 *
 *     $ ffmpeg-linux -hide_banner -muxers
 *     E  image2          image2 sequence
 *     E  webm            WebM
 *
 * No GIF muxer, so `-f gif` cannot work. But the same binary *decodes* WebM
 * perfectly well — measured 126 frames out of a 5.04s / 25fps / 1440x900 clip via
 * `-f image2`. Only its filter parser is crippled: `-vf fps=8` fails with
 * `Error parsing filter description`. So decoding is ffmpeg's job and frame
 * sampling has to happen outside it.
 *
 * The encoder is Pillow, in the **system** python (`/usr/local/bin/python3`, 12.3.0)
 * rather than the backend venv, which does not have it. That is a real constraint
 * and it is why every entry point here degrades instead of throwing: Pillow is not
 * a declared dependency of this repository, and a run must not fail because a
 * derived convenience artifact could not be written.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const HERE = path.dirname(fileURLToPath(import.meta.url));

/**
 * Playwright's bundled screencast ffmpeg. Muxes image2/webm, decodes vp8.
 *
 * The single place this path is written down. It is a Playwright build number,
 * so it moves when Playwright does — and when it does, `gifSupport()` says "no
 * ffmpeg at <path>" rather than the run silently producing no GIF, which is the
 * failure this whole module exists to stop repeating.
 */
export const FFMPEG = "/opt/ms-playwright/ffmpeg-1011/ffmpeg-linux";

/** The Pillow half of the pipeline. */
export const PACKER = path.join(HERE, "sequence-gif-pack.py");

/**
 * Defaults, measured on a real 5.04s / 25fps / 1440x900 recording rather than
 * guessed:
 *
 * | frames | width | colours | size  | time |
 * |--------|-------|---------|-------|------|
 * | 24     | 720   | 128     | 1161K | 2.0s |
 * | 20     | 720   | 96      |  899K | 1.6s |
 * | 16     | 640   |  64     |  510K | 1.2s |
 * | 12     | 560   |  64     |  316K | 0.8s |
 *
 * Sixteen frames at 640px is the knee: about half a megabyte and a bit over a
 * second per sequence, which is small enough to attach and fast enough not to
 * dominate a run.
 *
 * The downscale is a deliberate limit rather than a bug. A 640px GIF is a *motion
 * summary* — it is not where fine text is read, which is exactly why the full-res
 * PNGs and the WebM are kept alongside it rather than replaced.
 */
export const GIF_DEFAULTS = Object.freeze({
  frames: 16,
  width: 640,
  colors: 64,
  /** Per-frame delay in ms. 240ms ≈ 4fps: enough to read as motion, not flicker. */
  frameDelayMs: 240,
});

/**
 * Probed once per (ffmpeg, python) pair and cached.
 *
 * Keyed rather than a single memo, because a single memo answers a question
 * nobody asked: a caller that passes an explicit `python` gets the verdict from
 * whichever probe happened to run first, which reports a healthy machine as
 * broken (or the reverse) depending on call order. The audit only ever uses the
 * defaults, so it probes once per run either way.
 */
const supportCache = new Map();

/**
 * Can this machine produce a GIF at all?
 *
 * Both halves matter and they fail for different reasons, so both are named in
 * the reason string — an operator who sees "GIF unavailable" needs to know
 * whether to install ffmpeg or Pillow. The first half to fail is the one
 * reported, for the same reason: reporting the second would send them to fix
 * the thing that is already fine.
 *
 * Returns `{ ok, reason }`. Never throws: the audit calls this on every sequence
 * and a run must not die here.
 */
export async function gifSupport({ python = "python3", ffmpeg = FFMPEG } = {}) {
  // A visible separator, not a NUL: an invisible one is invisible in the source
  // too, and makes git treat the whole file as binary.
  const key = `${ffmpeg}::${python}`;
  const cached = supportCache.get(key);
  if (cached) return cached;
  const support = await probeSupport({ python, ffmpeg });
  supportCache.set(key, support);
  return support;
}

async function probeSupport({ python, ffmpeg }) {
  // Decode half.
  //
  // Probed by asking whether the `image2` muxer exists, because that is literally
  // what the decode step needs: ffmpeg *writes* the PNG sequence through image2.
  // The question that looks equivalent and is not available here is "can you give
  // me a null sink to test with" — `-f null -` fails on Playwright's minimal build
  // (`Requested output format 'null' is not known`), which reports this machine
  // as having no decoder when it decodes WebM perfectly well. That is the same
  // mistake the old `ffmpegSupportsGif()` probe in audit.mjs had to learn, in a
  // different place: probe the capability actually used, not a convenient proxy.
  try {
    const { stdout } = await execFileAsync(ffmpeg, ["-hide_banner", "-muxers"], {
      timeout: 10_000,
    });
    if (!/^\s*E\s+.*\bimage2\b/m.test(stdout)) {
      return { ok: false, reason: `${ffmpeg} cannot write an image2 PNG sequence` };
    }
  } catch (err) {
    return { ok: false, reason: `no ffmpeg at ${ffmpeg}: ${err.message}` };
  }

  // Encoding half.
  try {
    const { stdout } = await execFileAsync(
      python,
      ["-c", "import PIL; print(PIL.__version__)"],
      { timeout: 10_000 },
    );
    const version = stdout.trim();
    return { ok: true, reason: `Pillow ${version}`, version };
  } catch {
    return {
      ok: false,
      reason: `no Pillow in ${python} — install it there (system python, not the backend venv)`,
    };
  }
}

/**
 * Choose which frames of a longer sequence to keep, evenly spread and always
 * including the first and last.
 *
 * Pure and separately exported because it is the one piece of arithmetic here
 * that is worth being sure about, and because it is impossible to unit-test once
 * it is buried inside a subprocess call.
 *
 * A naive `frames[i * total / frames]` drops the tail of a long scroll — which is
 * the part that was invisible before #552 and the whole reason the GIF exists.
 * So the last index is pinned to `total - 1` rather than being left to rounding.
 *
 * @returns {number[]} ascending, unique indices
 */
export function sampleFrameIndices(total, wanted) {
  if (total <= 0) return [];
  if (wanted <= 1) return [0];
  if (total <= wanted) return Array.from({ length: total }, (_, i) => i);

  const picked = [];
  for (let i = 0; i < wanted; i += 1) {
    picked.push(Math.round((i * (total - 1)) / (wanted - 1)));
  }
  // `round` on an evenly spaced ramp can repeat a value at the low end when
  // total is only just above `wanted`; de-duplicate while keeping order.
  return [...new Set(picked)].sort((a, b) => a - b);
}

/**
 * Name for a packed sequence.
 *
 * Deliberately *not* the first frame's name with the extension swapped: for a
 * scroll sequence that would be `desktop-light-top.gif`, which reads as though it
 * only covers the top of the page — the exact misreading this whole change exists
 * to prevent. `scroll` says what the file is.
 */
export function sequenceGifName(base, kind) {
  if (kind === "scroll") return `${base}-scroll.gif`;
  return `${base}.gif`;
}

/**
 * Pack an ordered list of PNGs into one animated GIF.
 *
 * `frames` must be in the order they should play. For a scroll sequence that is
 * `plan.states` order; getting it backwards yields a GIF that scrolls up, which is
 * worse than no GIF, so the caller is responsible and the audit passes the order
 * it captured in.
 *
 * @returns {Promise<{ok: boolean, reason?: string, file?: string, bytes?: number, frames?: number}>}
 */
export async function packFrames(frames, outPath, options = {}) {
  const { frames: wanted, width, colors, frameDelayMs, python = "python3" } = {
    ...GIF_DEFAULTS,
    ...options,
  };

  if (!frames.length) return { ok: false, reason: "no frames to pack" };

  const support = await gifSupport({ python });
  if (!support.ok) return { ok: false, reason: support.reason };

  try {
    const { stdout } = await execFileAsync(
      python,
      [
        PACKER,
        "--out", outPath,
        "--width", String(width),
        "--colors", String(colors),
        "--delay", String(frameDelayMs),
        "--frames", String(wanted),
        "--",
        ...frames,
      ],
      { timeout: 120_000 },
    );
    const stat = await fs.stat(outPath);
    return {
      ok: true,
      file: outPath,
      bytes: stat.size,
      frames: Number(stdout.trim()) || frames.length,
    };
  } catch (err) {
    return { ok: false, reason: err.stderr?.toString().trim() || err.message };
  }
}

/**
 * Pack a recorded WebM into one animated GIF.
 *
 * Decoding and sampling are both done here rather than pushed into ffmpeg's
 * filter graph, because the filter parser in Playwright's build cannot express
 * `fps=` (it fails with `Error parsing filter description`). Decoding every frame
 * and discarding most of them costs disk in the temp dir for a few seconds; that
 * is a fair price for a filter graph that works, and the alternative is a
 * pipeline that silently produces nothing.
 */
export async function packWebm(webmPath, outPath, options = {}) {
  const { python = "python3", ffmpeg = FFMPEG, frames: wanted, width, colors, frameDelayMs } = {
    ...GIF_DEFAULTS,
    ...options,
  };

  const support = await gifSupport({ python, ffmpeg });
  if (!support.ok) return { ok: false, reason: support.reason };

  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "audit-gif-"));
  const pattern = path.join(tmp, "f-%05d.png");
  try {
    await execFileAsync(
      ffmpeg,
      ["-hide_banner", "-loglevel", "error", "-i", webmPath, "-f", "image2", pattern],
      { timeout: 120_000 },
    );

    const decoded = (await fs.readdir(tmp)).filter((f) => f.endsWith(".png")).sort();
    if (!decoded.length) {
      return { ok: false, reason: `ffmpeg decoded no frames from ${path.basename(webmPath)}` };
    }

    // Sorted numerically, not lexically: f-00010.png sorts before f-0002.png as
    // strings once a clip runs past nine frames — which at 25fps is a third of a
    // second — and a GIF assembled in the wrong order is a GIF of a page
    // scrolling backwards.
    const ordered = decoded
      .map((f) => ({ f, n: Number(f.match(/(\d+)\.png$/)[1]) }))
      .sort((a, b) => a.n - b.n)
      .map(({ f }) => path.join(tmp, f));

    return await packFrames(ordered, outPath, { python, frames: wanted, width, colors, frameDelayMs });
  } catch (err) {
    return { ok: false, reason: err.stderr?.toString().trim() || err.message };
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
}
