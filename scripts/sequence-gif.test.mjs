/**
 * Sequence-GIF tests (#561).
 *
 * The failure this module exists to fix is not observable from a unit test at
 * all: on this machine the old code asked ffmpeg for a GIF muxer, the answer was
 * permanently no, and the run reported a clean success while producing zero
 * GIFs. So the tests here are deliberately split.
 *
 * - The **pure** parts are asserted directly: which frames are kept, what the
 *   file is called, and what a failure says. The reason strings matter because
 *   the reason is the only thing an operator has — the same lesson as #559's
 *   `noneOf` list, where a skip reporting the wrong cause sends someone to the
 *   wrong machine.
 * - The **subprocess** parts are asserted as contract rather than as output: a
 *   missing Pillow or ffmpeg must come back as `{ok: false, reason}`, never as a
 *   throw. A run that dies over a derived convenience artifact has lost more
 *   than it was protecting.
 *
 * The one thing these cannot check is whether the GIF is *ordered* correctly —
 * that needs real frames, and is covered by the packer's own order contract
 * (`collect()`), which the caller relies on rather than re-derives.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  FFMPEG,
  GIF_DEFAULTS,
  PACKER,
  gifSupport,
  packFrames,
  packWebm,
  sampleFrameIndices,
  sequenceGifName,
} from "./sequence-gif.mjs";

// ── frame sampling ─────────────────────────────────────────────────────────

test("a sequence shorter than the target keeps every frame", () => {
  assert.deepEqual(sampleFrameIndices(4, 16), [0, 1, 2, 3]);
});

test("sampling pins the first and last frame, and the last one especially", () => {
  // The tail of a long scroll is what #552 made visible and what the naive
  // `i * total / frames` sample drops on the floor.
  const picked = sampleFrameIndices(126, 16);
  assert.equal(picked.at(0), 0);
  assert.equal(picked.at(-1), 125);
});

test("sampled indices stay ascending and unique when total is just above wanted", () => {
  // `round` on an evenly spaced ramp can repeat a value at the low end; a
  // duplicated index would play one frame twice while another never appears.
  const picked = sampleFrameIndices(18, 16);
  assert.deepEqual(picked, [...new Set(picked)]);
  assert.deepEqual([...picked].sort((a, b) => a - b), picked);
});

test("an empty sequence samples to nothing rather than to frame zero", () => {
  assert.deepEqual(sampleFrameIndices(0, 16), []);
});

test("asking for a single frame yields the first one", () => {
  assert.deepEqual(sampleFrameIndices(100, 1), [0]);
});

// ── naming ─────────────────────────────────────────────────────────────────

test("a scroll sequence is named for the scroll, not for its first frame", () => {
  // `mobile-light-top.gif` reads as though it only covers the top of the page —
  // the exact misreading the artifact exists to prevent.
  assert.equal(sequenceGifName("mobile-light", "scroll"), "mobile-light-scroll.gif");
});

test("any other kind keeps the plain name", () => {
  assert.equal(sequenceGifName("desktop-light-menu-open", "menu"), "desktop-light-menu-open.gif");
});

// ── defaults ───────────────────────────────────────────────────────────────

test("the defaults are the measured knee, not a guess", () => {
  // Measured on a real 5.04s / 25fps / 1440x900 recording: 16 frames at 640px is
  // ~510K and ~1.2s to encode, which is small enough to attach to a review.
  assert.equal(GIF_DEFAULTS.frames, 16);
  assert.equal(GIF_DEFAULTS.width, 640);
  assert.equal(GIF_DEFAULTS.colors, 64);
  assert.ok(GIF_DEFAULTS.frames > 1, "a single-frame GIF is a JPEG with extra steps");
});

// ── the probe names the capability it actually uses ────────────────────────

test("the ffmpeg half is probed with the muxer the decode step writes with", async () => {
  // The probe that used to be here asked for a *null* sink (`-f null -`), which
  // this ffmpeg build does not know. It reported a machine that decodes WebM
  // perfectly well as having no decoder at all. Asking about `image2` asks the
  // question that is actually asked later: can you write a PNG sequence?
  //
  // Probed with a python that does not exist, so the decode half is what decides
  // the answer. Written to hold on a machine without the baked Playwright too —
  // these tests are local, and a test that only passes in the dev image is a
  // test that quietly stops being run.
  const support = await gifSupport({ ffmpeg: FFMPEG, python: "/nonexistent/python" });
  assert.equal(support.ok, false);
  assert.match(support.reason, /image2|Pillow/i);
  // On a machine that *does* have the decode half, the reason must name the half
  // that actually failed. "no gif" on its own sends someone to the wrong tool.
  if (!/no ffmpeg/.test(support.reason)) assert.match(support.reason, /Pillow/i);
});

test("a missing ffmpeg is reported as a reason, not thrown", async () => {
  const support = await gifSupport({ ffmpeg: "/nonexistent/ffmpeg", python: "python3" });
  assert.equal(support.ok, false);
  assert.match(support.reason, /ffmpeg/);
});

// ── every entry point degrades instead of throwing ─────────────────────────

test("packing no frames fails with a reason", async () => {
  const result = await packFrames([], "/tmp/opencode/should-not-exist.gif");
  assert.equal(result.ok, false);
  assert.match(result.reason, /no frames/);
});

test("a missing encoder costs the GIF, not the run", async () => {
  // `packFrames` reaches the encoder only when the probe passes, so a machine
  // without Pillow gets `{ok: false}` here. The audit's contract is that it then
  // keeps the PNGs and the WebM and says so — never that the run dies.
  const result = await packFrames(
    ["/sandbox/ai-document-platform/scripts/package.json"],
    "/tmp/opencode/should-not-exist.gif",
    { python: "/nonexistent/python" },
  );
  assert.equal(result.ok, false);
  assert.ok(result.reason.length > 0);
});

test("a WebM that does not exist fails with a reason rather than a stack trace", async () => {
  const result = await packWebm("/nonexistent/clip.webm", "/tmp/opencode/should-not-exist.gif");
  assert.equal(result.ok, false);
  assert.ok(result.reason.length > 0);
});

// ── the packer is a separate process for a stated reason ──────────────────

test("the packer is invoked as a script in this directory", () => {
  // Pillow lives in the system python, not the backend venv, so the encoder is
  // a separate file rather than an inline `python -c`. A path that drifts out
  // of scripts/ would fail only at run time, in a capture.
  assert.match(PACKER, /scripts\/sequence-gif-pack\.py$/);
});
