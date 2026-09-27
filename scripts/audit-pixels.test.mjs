/**
 * Unit tests for the pixel-diff decision logic (#470).
 *
 * The comparator is injected, so none of this needs `pngjs` or `pixelmatch`
 * installed. That is the point of splitting it out: the threshold behaviour and
 * the added/removed accounting are the parts that are easy to get subtly wrong
 * and cheap to test exhaustively, and they should be testable on a machine that
 * has never run the audit. The real comparator is verified by a live run, not
 * here.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  BASELINE_VERSION,
  DEFAULT_CHANGED_RATIO,
  DEFAULT_PIXEL_TOLERANCE,
  buildReport,
  classifyCapture,
  formatReport,
  keyFor,
  listCaptures,
  parseThresholds,
  planComparison,
} from "./audit-pixels.mjs";

/** A comparator stand-in: reports a fixed number of differing pixels. */
const fakeCompare = (changedPixels, { width = 100, height = 100, total = width * height } = {}) => ({
  widthA: width,
  heightA: height,
  widthB: width,
  heightB: height,
  changedPixels,
  totalPixels: total,
});

const withTempTree = async (build, run) => {
  const dir = await mkdtemp(path.join(tmpdir(), "audit-pixels-"));
  try {
    return await run(await build(dir), dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
};

test("exports its defaults and version", () => {
  assert.equal(BASELINE_VERSION, 1);
  // Both default thresholds are deliberately small: the per-pixel tolerance
  // exists to ignore antialiasing, and the per-capture share exists so a
  // handful of stray pixels are not a finding.
  assert.equal(DEFAULT_PIXEL_TOLERANCE, 0.1);
  assert.equal(DEFAULT_CHANGED_RATIO, 0.001);
});

test("lists pngs recursively, as sorted run-relative keys", async () => {
  await withTempTree(
    async (dir) => {
      await mkdir(path.join(dir, "app", "documents"), { recursive: true });
      await mkdir(path.join(dir, "marketing"), { recursive: true });
      await writeFile(path.join(dir, "app", "documents", "desktop-light-ready.png"), "x");
      await writeFile(path.join(dir, "app", "documents", "mobile-light-ready.png"), "x");
      await writeFile(path.join(dir, "marketing", "desktop-light-hero.png"), "x");
      // Non-png files and a differently-cased extension must be ignored: the run
      // directory also holds JSON reports and WebM screencasts.
      await writeFile(path.join(dir, "marketing", "audit-manifest.json"), "{}");
      await writeFile(path.join(dir, "marketing", "clip.webm"), "x");
      await writeFile(path.join(dir, "marketing", "stale.PNG"), "x");

      const keys = (await listCaptures(dir)).map((abs) => keyFor(dir, abs));
      assert.deepEqual(keys, [
        "app/documents/desktop-light-ready.png",
        "app/documents/mobile-light-ready.png",
        "marketing/desktop-light-hero.png",
        "marketing/stale.PNG",
      ]);
    },
    async (built) => built,
  );
});

test("listCaptures treats a missing directory as empty, not an error", async () => {
  assert.deepEqual(await listCaptures(path.join(tmpdir(), "audit-pixels-does-not-exist")), []);
});

test("planComparison pairs by key and keeps sorted order", () => {
  const plan = planComparison(
    ["a/one.png", "a/two.png", "b/three.png"],
    ["a/one.png", "a/two.png", "c/four.png"],
  );
  assert.deepEqual(plan.pairs, ["a/one.png", "a/two.png"]);
  assert.deepEqual(plan.added, ["c/four.png"]);
  assert.deepEqual(plan.removed, ["b/three.png"]);
});

test("planComparison reports both sides as non-empty when the whole tree changed", () => {
  const plan = planComparison(["a/one.png"], ["b/two.png"]);
  assert.deepEqual(plan.pairs, []);
  assert.deepEqual(plan.added, ["b/two.png"]);
  assert.deepEqual(plan.removed, ["a/one.png"]);
});

test("planComparison against an empty baseline is all added, never all removed", () => {
  // The first `--update-pixel-baseline` case. Reporting these as "removed"
  // instead would invert the meaning of a fresh baseline.
  const plan = planComparison([], ["a/one.png", "b/two.png"]);
  assert.deepEqual(plan.pairs, []);
  assert.deepEqual(plan.added, ["a/one.png", "b/two.png"]);
  assert.deepEqual(plan.removed, []);
});

test("planComparison against an empty run is all removed", () => {
  const plan = planComparison(["a/one.png"], []);
  assert.deepEqual(plan.pairs, []);
  assert.deepEqual(plan.added, []);
  assert.deepEqual(plan.removed, ["a/one.png"]);
});

test("classifyCapture reports `same` under the per-capture threshold", () => {
  // 0 of 10000 pixels, and 5 of 10000 = 0.05% against a 0.1% default: under the
  // bar, so not a finding.
  const opts = { pixelTolerance: DEFAULT_PIXEL_TOLERANCE, changedRatio: DEFAULT_CHANGED_RATIO };
  const clean = classifyCapture(fakeCompare(0), opts);
  assert.equal(clean.verdict, "same");
  assert.equal(clean.changedRatio, 0);
  const under = classifyCapture(fakeCompare(5), opts);
  assert.equal(under.verdict, "same");
  assert.equal(under.changedPixels, 5);
  assert.equal(under.totalPixels, 10000);
});

test("classifyCapture reports `changed` over the per-capture threshold", () => {
  const opts = { pixelTolerance: DEFAULT_PIXEL_TOLERANCE, changedRatio: DEFAULT_CHANGED_RATIO };
  // 0.1% of 10000 is exactly 10 pixels: at the bar.
  assert.equal(classifyCapture(fakeCompare(10), opts).verdict, "same");
  // One more pixel crosses it. Strictly greater than, so the threshold itself is
  // not a finding — a run that sits exactly on the bar does not flap.
  const over = classifyCapture(fakeCompare(11), opts);
  assert.equal(over.verdict, "changed");
  assert.equal(over.changedRatio, 0.0011);
});

test("classifyCapture honours a custom per-capture threshold", () => {
  const opts = { pixelTolerance: DEFAULT_PIXEL_TOLERANCE, changedRatio: 0.05 };
  // 5% of 10000 = 500 pixels: at the bar, still `same`.
  assert.equal(classifyCapture(fakeCompare(500), opts).verdict, "same");
  assert.equal(classifyCapture(fakeCompare(501), opts).verdict, "changed");
});

test("classifyCapture reports a dimension change as `resized`, not a crash", () => {
  const opts = { pixelTolerance: DEFAULT_PIXEL_TOLERANCE, changedRatio: DEFAULT_CHANGED_RATIO };
  // A responsive layout that stopped responding to its viewport. There is no
  // meaningful pixel count to compare, so it is called out on its own rather
  // than scored (and rather than throwing, which would lose the whole run).
  const resized = classifyCapture(
    { widthA: 375, heightA: 812, widthB: 1440, heightB: 900, changedPixels: 0, totalPixels: 0 },
    opts,
  );
  assert.equal(resized.verdict, "resized");
  assert.deepEqual(resized.width, [375, 1440]);
  assert.deepEqual(resized.height, [812, 900]);
  // Scored as fully changed so it still surfaces in the report, but with no
  // pixel numbers, because any number here would be made up.
  assert.equal(resized.changedRatio, 1);
  assert.equal(resized.changedPixels, null);
  assert.equal(resized.totalPixels, null);
});

test("classifyCapture treats a zero-pixel capture as unchanged rather than NaN", () => {
  // A 0x0 PNG is possible from a capture that failed to size. Guarding the
  // division keeps one empty file from poisoning a report with NaN.
  const opts = { pixelTolerance: DEFAULT_PIXEL_TOLERANCE, changedRatio: DEFAULT_CHANGED_RATIO };
  const empty = classifyCapture(
    { widthA: 0, heightA: 0, widthB: 0, heightB: 0, changedPixels: 0, totalPixels: 0 },
    opts,
  );
  assert.equal(empty.verdict, "same");
  assert.equal(empty.changedRatio, 0);
});

test("parseThresholds defaults both thresholds when unset", () => {
  assert.deepEqual(parseThresholds({}), {
    pixelTolerance: DEFAULT_PIXEL_TOLERANCE,
    changedRatio: DEFAULT_CHANGED_RATIO,
  });
  // 0 is a legitimate value — a strictly exact comparison — so it must not be
  // confused with "not supplied".
  assert.equal(parseThresholds({ pixelTolerance: 0 }).pixelTolerance, 0);
  assert.equal(parseThresholds({ changedRatio: 0 }).changedRatio, 0);
  assert.equal(parseThresholds({ pixelTolerance: 0.02, changedRatio: 0.5 }).changedRatio, 0.5);
});

test("parseThresholds rejects values outside 0..1 and non-numbers", () => {
  for (const bad of [1.5, -0.1, NaN, Infinity]) {
    assert.throws(() => parseThresholds({ pixelTolerance: bad }), /--pixel-tolerance/);
    assert.throws(() => parseThresholds({ changedRatio: bad }), /--changed-ratio/);
  }
  assert.throws(() => parseThresholds({ pixelTolerance: "0.1" }), /--pixel-tolerance/);
});

test("buildReport counts each outcome and leaves `same` out of the changed list", () => {
  const opts = { pixelTolerance: DEFAULT_PIXEL_TOLERANCE, changedRatio: DEFAULT_CHANGED_RATIO };
  const results = {
    "a/one.png": classifyCapture(fakeCompare(0), opts),
    "b/two.png": classifyCapture(fakeCompare(2000), opts),
    "c/three.png": classifyCapture(
      { widthA: 100, heightA: 100, widthB: 100, heightB: 200, changedPixels: 0, totalPixels: 0 },
      opts,
    ),
  };
  const report = buildReport({
    plan: planComparison(["a/one.png", "b/two.png", "c/three.png"], [
      "a/one.png",
      "b/two.png",
      "c/three.png",
      "d/four.png",
    ]),
    results,
    thresholds: opts,
    baselineDir: "/tmp/opencode/pixel-baseline",
    runDir: "/tmp/opencode/visual-audit/20260927-000000",
  });
  assert.equal(report.version, BASELINE_VERSION);
  assert.deepEqual(report.counts, {
    compared: 3,
    changed: 2,
    resized: 1,
    added: 1,
    removed: 0,
  });
  // The unchanged capture is compared but not listed — the report is a list of
  // things to look at. The resize sorts above the 20% pixel change because it is
  // scored 1: a broken layout is the thing to look at first.
  assert.deepEqual(report.changed.map((r) => r.key), ["c/three.png", "b/two.png"]);
  assert.deepEqual(report.added, ["d/four.png"]);
  assert.deepEqual(report.removed, []);
});

test("buildReport orders worst first so the top of the list is the thing to look at", () => {
  const opts = { pixelTolerance: DEFAULT_PIXEL_TOLERANCE, changedRatio: DEFAULT_CHANGED_RATIO };
  const results = {
    "a/small.png": classifyCapture(fakeCompare(2000), opts),
    "b/huge.png": classifyCapture(fakeCompare(8000), opts),
    "c/resized.png": classifyCapture(
      { widthA: 10, heightA: 10, widthB: 20, heightB: 20, changedPixels: 0, totalPixels: 0 },
      opts,
    ),
  };
  const report = buildReport({
    plan: planComparison([], []),
    results,
    thresholds: opts,
    baselineDir: "b",
    runDir: "r",
  });
  // A resize sorts to the top (scored 1) because a broken layout outranks a
  // colour shift; between two real pixel counts, larger first.
  assert.deepEqual(report.changed.map((r) => r.key), ["c/resized.png", "b/huge.png", "a/small.png"]);
  assert.deepEqual(report.changed.map((r) => r.verdict), ["resized", "changed", "changed"]);
});

test("buildReport breaks ties by key, so two identical runs render identically", () => {
  const opts = { pixelTolerance: DEFAULT_PIXEL_TOLERANCE, changedRatio: DEFAULT_CHANGED_RATIO };
  const results = {
    "z/last.png": classifyCapture(fakeCompare(5000), opts),
    "a/first.png": classifyCapture(fakeCompare(5000), opts),
  };
  const report = buildReport({ plan: planComparison([], []), results, thresholds: opts, baselineDir: "b", runDir: "r" });
  assert.deepEqual(report.changed.map((r) => r.key), ["a/first.png", "z/last.png"]);
});

test("buildReport of a clean run is empty and still counts what it compared", () => {
  const opts = { pixelTolerance: DEFAULT_PIXEL_TOLERANCE, changedRatio: DEFAULT_CHANGED_RATIO };
  const keys = ["a/one.png", "b/two.png"];
  const results = Object.fromEntries(
    keys.map((key) => [key, classifyCapture(fakeCompare(0), opts)]),
  );
  const report = buildReport({
    plan: planComparison(keys, keys),
    results,
    thresholds: opts,
    baselineDir: "b",
    runDir: "r",
  });
  assert.deepEqual(report.changed, []);
  assert.deepEqual(report.added, []);
  assert.deepEqual(report.removed, []);
  assert.equal(report.counts.compared, 2);
  assert.equal(report.counts.changed, 0);
});

test("formatReport summarises counts and thresholds", () => {
  const opts = { pixelTolerance: 0.1, changedRatio: 0.001 };
  const text = formatReport({
    counts: { compared: 170, changed: 2, resized: 1, added: 1, removed: 3 },
    thresholds: opts,
    changed: [],
    added: [],
    removed: [],
  }).join("\n");
  assert.match(text, /PIXELS\s+170 compared, 2 changed \(1 resized\), 1 added, 3 removed/);
  // Thresholds are echoed into the human output as well as the JSON, because a
  // threshold without its value is not interpretable a week later.
  assert.match(text, /per-pixel 0\.1, per-capture 0\.001/);
});

test("formatReport prints changed captures with counts and a percentage", () => {
  const opts = { pixelTolerance: 0.1, changedRatio: 0.001 };
  const text = formatReport({
    counts: { compared: 1, changed: 1, resized: 0, added: 0, removed: 0 },
    thresholds: opts,
    changed: [
      { key: "app/documents/desktop-light-ready.png", verdict: "changed", changedPixels: 2000, totalPixels: 10000, changedRatio: 0.2 },
      { key: "marketing/desktop-light-hero.png", verdict: "resized", changedRatio: 1, width: [375, 1440], height: [812, 900] },
    ],
    added: [],
    removed: [],
  }).join("\n");
  assert.match(text, /CHANGED\s+2000\/10000 px \(20\.000%\)\s+app\/documents\/desktop-light-ready\.png/);
  assert.match(text, /CHANGED\s+375x812 -> 1440x900\s+marketing\/desktop-light-hero\.png/);
});

test("formatReport truncates long lists rather than flooding the terminal", () => {
  const opts = { pixelTolerance: 0.1, changedRatio: 0.001 };
  const many = (n, prefix) =>
    Array.from({ length: n }, (_, i) => ({
      key: `${prefix}/${i}.png`,
      verdict: "changed",
      changedPixels: 5000,
      totalPixels: 10000,
      changedRatio: 0.5,
    }));
  const text = formatReport({
    counts: { compared: 40, changed: 30, resized: 0, added: 20, removed: 20 },
    thresholds: opts,
    changed: many(30, "c"),
    added: many(20, "a").map((m) => m.key),
    removed: many(20, "r").map((m) => m.key),
  }).join("\n");
  assert.match(text, /… and 18 more$/m);
  assert.match(text, /ADDED\s+a\/4\.png/);
  assert.match(text, /… and 15 more added/);
  assert.match(text, /REMOVED\s+r\/0\.png/);
  assert.match(text, /… and 15 more removed/);
  // 12 changed lines shown, the rest counted.
  assert.equal(text.split("\n").filter((l) => l.includes("CHANGED")).length, 12);
});
