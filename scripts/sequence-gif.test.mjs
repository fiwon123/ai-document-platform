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
  settledFrameIndices,
  webmDecodeArgs,
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
  // 64 was a guess, and it was wrong in a way only a rendered file shows: it
  // left 6.1% of pixels visibly wrong (dE > 24) against the decoded source, and
  // it is what a reviewer's "the stat tiles change colour" finding traced back
  // to. 256 halves the flat-area budget problem without moving the file size
  // (500K vs 497K) because the packer reserves entries for flat surfaces and
  // the rest is dither-free, so the extra entries cost almost nothing.
  assert.equal(GIF_DEFAULTS.colors, 256);
  assert.ok(GIF_DEFAULTS.frames > 1, "a single-frame GIF is a JPEG with extra steps");
});

// ── the probe names the capability it actually uses ────────────────────────

test("the decode step writes through image2, the muxer the probe asks about", () => {
  // The machine-independent half of the claim, and the half that actually matters.
  //
  // `probeSupport` asks whether the `image2` muxer exists; `webmDecodeArgs` is
  // what writes the PNG sequence. If those two ever diverge, the probe is asking
  // a question the decode step does not care about — which is the entire bug this
  // module was written to fix, in a form no reason string would reveal.
  //
  // Asserted from argv because it is pure: it holds on the dev image, on a CI
  // runner with no Playwright binaries, and on a laptop with no ffmpeg at all.
  // The three `-ss` tests below read the same array for the seek placement and
  // none of them looked at the muxer, which is how a probe could be pointed at
  // the wrong format with every test still green.
  const args = webmDecodeArgs("/tmp/clip.webm", "/tmp/f-%05d.png");
  assert.ok(args.includes("-f"), `decode argv must name an output format: ${args.join(" ")}`);
  assert.equal(args[args.indexOf("-f") + 1], "image2");
  // `-f image2` writes the numbered pattern, so the pattern has to be the last
  // argument and it must be the one the caller supplied — an ffmpeg that is
  // handed a format but no pattern writes nothing and says nothing.
  assert.equal(args[args.length - 1], "/tmp/f-%05d.png");
});

test("the ffmpeg half is probed with the muxer the decode step writes with", async () => {
  // The probe that used to be here asked for a *null* sink (`-f null -`), which
  // this ffmpeg build does not know. It reported a machine that decodes WebM
  // perfectly well as having no decoder at all. Asking about `image2` asks the
  // question that is actually asked later: can you write a PNG sequence?
  //
  // Probed with a python that does not exist, so the decode half is what decides
  // the answer. Written to hold on a machine without the baked Playwright too —
  // these tests are local, and a test that only passes in the dev image is a test
  // that quietly stops being run.
  const support = await gifSupport({ ffmpeg: FFMPEG, python: "/nonexistent/python" });
  assert.equal(support.ok, false);

  // Branch on whether this machine has ffmpeg at all, because the probe answers a
  // different question on each and the reason names the half that decided it.
  //
  // This branch is the reason the file exists in two halves. `FFMPEG` is a
  // hardcoded Playwright build path: the dev image has that binary baked, and a CI
  // runner knows the path (the `playwright` package configures it) without ever
  // running `playwright install`. So the probe genuinely cannot get past its
  // `execFileAsync` on a runner, and the reason comes back naming ffmpeg alone.
  // Asserting `/image2|Pillow/i` on it unconditionally is what made this test
  // fail on the first CI run it ever saw (#628) while passing in the container.
  if (/no ffmpeg/.test(support.reason)) {
    // No ffmpeg on this machine: the muxer question was never reached, so the
    // only honest thing to assert is that the reason says which tool is missing —
    // "no gif" on its own sends someone to the wrong machine.
    assert.match(support.reason, /ffmpeg/);
    assert.match(support.reason, /ENOENT|no such file/i);
  } else {
    // ffmpeg is present, so the probe got as far as the muxer and then the
    // encoder. With python pinned to a path that does not exist, the failure has
    // to be Pillow — which also means image2 was found.
    assert.match(support.reason, /image2|Pillow/i);
    assert.match(support.reason, /Pillow/i);
  }
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

// ── trimming the head off a recording (#566) ───────────────────────────────

test("the seek is an input-side one, so the dropped frames are never decoded", () => {
  // The distinction is invisible in the output GIF — both forms produce a GIF
  // that starts at the right frame — and the difference is ~1.2s of navigation
  // decoded and discarded on every single run. It can only be checked by
  // reading the argv, which is why it is built by a pure function.
  const args = webmDecodeArgs("/tmp/clip.webm", "/tmp/f-%05d.png", 1.5);
  assert.ok(args.indexOf("-ss") < args.indexOf("-i"), `-ss must precede -i: ${args.join(" ")}`);
  assert.equal(args[args.indexOf("-ss") + 1], "1.5");
});

test("no offset means no -ss at all", () => {
  // `-ss 0` changes nothing and makes the command harder to read back; more to
  // the point, a seek that is present-but-zero is a seek whose *default* is
  // being relied on, and the default is not the same as no seek.
  for (const start of [0, undefined]) {
    const args = webmDecodeArgs("/tmp/clip.webm", "/tmp/f-%05d.png", start);
    assert.ok(!args.includes("-ss"), `-ss must be absent for start=${start}`);
  }
});

test("a negative offset is not passed through to ffmpeg", () => {
  // `-ss -0.2` seeks *from the end* of the clip and decodes nothing, so the run
  // would report "no GIF" for a reason that reads like a broken encoder. The
  // clamp belongs to the caller (`gifStartSeconds`); this asserts the packer is
  // not the thing that has to be trusted to apply it.
  const args = webmDecodeArgs("/tmp/clip.webm", "/tmp/f-%05d.png", -0.2);
  assert.ok(!args.includes("-ss"), `a non-positive offset must not become a seek: ${args.join(" ")}`);
});

// ── sampling where the page had settled (#566) ─────────────────────────────

test("a settled mark becomes a frame, and the clip's ends are still reachable", () => {
  assert.deepEqual(settledFrameIndices(100, [0, 0.5, 1]), [0, 50, 99]);
});

test("settled marks win over even sampling, and duplicates collapse", () => {
  // A pause long enough to be sampled twice, or two marks that round onto the
  // same frame, must not produce a repeated image — a GIF that holds one frame
  // twice reads as a stutter in the capture.
  assert.deepEqual(settledFrameIndices(100, [0.2, 0.204, 0.5]), [20, 50]);
  assert.deepEqual(settledFrameIndices(100, [0.5, 0.2]), [20, 50], "order follows the clip, not the caller");
});

test("a mark outside the clip is clamped rather than dropped", () => {
  // Fractions are computed from wall-clock times and a rounding difference can
  // put one a hair past the end. Losing the last settled frame to that would be
  // the one frame most worth keeping.
  assert.deepEqual(settledFrameIndices(10, [1.4]), [9]);
  assert.deepEqual(settledFrameIndices(10, [-0.2]), [0]);
});

test("nothing to sample from returns null, so the caller can fall back and say so", () => {
  // Returning an index list here would be a silent substitution: the manifest
  // would claim the GIF was sampled where the page settled when it was not, and
  // a bad frame would be read as a page defect (#566's whole failure mode).
  for (const fractions of [undefined, [], null, [Number.NaN]]) {
    assert.equal(settledFrameIndices(100, fractions), null, `for ${JSON.stringify(fractions)}`);
  }
  assert.equal(settledFrameIndices(0, [0.5]), null);
});
