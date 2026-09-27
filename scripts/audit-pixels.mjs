/**
 * Pixel diff for the visual audit's captures (#470).
 *
 * #469 made the audit fail on *signals* — contrast, page errors, skips,
 * overflow, unlabelled. Those answer "is this wrong". They cannot answer "did
 * this move", and a card that shifted 8px, a badge that vanished, or a panel
 * that stopped rendering all pass every signal the audit computes.
 *
 * This module is the decision half of the comparison: which captures to compare,
 * what counts as changed, and what the report says. It is pure and has **no
 * image dependency of its own** — the comparator is injected. That is deliberate:
 * the thresholds and the added/removed accounting are the parts worth testing
 * exhaustively, and testing them must not require decoding a PNG or installing
 * `pngjs`/`pixelmatch`. `audit.mjs` supplies the real comparator and the live
 * run is what verifies *that* one.
 *
 * ## What is a capture
 *
 * A PNG under a run directory, identified by its run-relative path:
 * `<route>/<viewport>-<theme>-<state>.png`. That key is what `audit.mjs` already
 * writes and what `audit-manifest.json` records, so a run directory is itself a
 * valid baseline and no new naming scheme is introduced.
 *
 * ## Why the comparison is local
 *
 * A pixel baseline is only comparable against the machine that produced it: a
 * different CPU, Chromium build or font rasterisation turns every edge into a
 * difference. So this never gates CI. See issue #470.
 */

import path from "node:path";

export const BASELINE_VERSION = 1;

/** Ignore per-pixel colour deltas at or below this (0–1). */
export const DEFAULT_PIXEL_TOLERANCE = 0.1;

/** A capture counts as changed once this share of its pixels differ (0–1). */
export const DEFAULT_CHANGED_RATIO = 0.001;

/** Recursively list `.png` files under a directory, as run-relative paths. */
export async function listCaptures(dir) {
  const fsp = await import("node:fs/promises");
  const found = [];
  const walk = async (current) => {
    let entries;
    try {
      entries = await fsp.readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const abs = path.join(current, entry.name);
      if (entry.isDirectory()) await walk(abs);
      // Sorted so two runs of the same build enumerate identically, which keeps
      // the report order stable and reviewable.
      else if (entry.name.toLowerCase().endsWith(".png")) found.push(abs);
    }
  };
  await walk(dir);
  return found.sort();
}

/** Absolute capture path -> the run-relative key used everywhere else. */
export function keyFor(root, abs) {
  return path.relative(root, abs).split(path.sep).join("/");
}

/**
 * Plan the comparison: pair up captures by key and label the leftovers.
 *
 * The added/removed sets are the reason this exists as a separate step. A
 * capture that is in the baseline but *not* in this run is not a non-event — it
 * is a state that stopped rendering, and a capture count would not show it,
 * because a dropped capture is offset by a new one appearing elsewhere.
 *
 * @param {string[]} baselineKeys from the baseline tree
 * @param {string[]} runKeys from this run's tree
 */
export function planComparison(baselineKeys, runKeys) {
  const baseSet = new Set(baselineKeys);
  const runSet = new Set(runKeys);
  const pairs = [];
  for (const key of runKeys) {
    if (baseSet.has(key)) pairs.push(key);
  }
  return {
    pairs: pairs.sort(),
    // Present now, absent from the baseline: a new state worth looking at.
    added: runKeys.filter((k) => !baseSet.has(k)).sort(),
    // In the baseline, absent now: a state that stopped rendering, or a
    // deliberate removal. Either way it is not silently ignored.
    removed: [...baseSet].filter((k) => !runSet.has(k)).sort(),
  };
}

/**
 * Classify one comparison.
 *
 * @param {object} result from the injected comparator
 * @param {object} opts `{ pixelTolerance, changedRatio }`
 */
export function classifyCapture(result, opts) {
  const ratio = opts.changedRatio;
  if (result.widthA !== result.widthB || result.heightA !== result.heightB) {
    // A resize is a real, visible change and cannot be scored as a pixel count.
    // Scored as "changed" rather than crashing, and reported separately so the
    // count of *content* differences is not inflated by a layout break.
    return {
      verdict: "resized",
      changedPixels: null,
      totalPixels: null,
      changedRatio: 1,
      width: [result.widthA, result.widthB],
      height: [result.heightA, result.heightB],
    };
  }
  const changedRatio = result.totalPixels === 0 ? 0 : result.changedPixels / result.totalPixels;
  return {
    verdict: changedRatio > ratio ? "changed" : "same",
    changedPixels: result.changedPixels,
    totalPixels: result.totalPixels,
    changedRatio,
  };
}

/** Read and validate the thresholds supplied on the command line. */
export function parseThresholds({ pixelTolerance, changedRatio }) {
  const tolerance = pixelTolerance ?? DEFAULT_PIXEL_TOLERANCE;
  const ratio = changedRatio ?? DEFAULT_CHANGED_RATIO;
  for (const [name, value] of [
    ["--pixel-tolerance", tolerance],
    ["--changed-ratio", ratio],
  ]) {
    if (!Number.isFinite(value) || value < 0 || value > 1) {
      throw new Error(`${name} must be between 0 and 1 (got ${value})`);
    }
  }
  return { pixelTolerance: tolerance, changedRatio: ratio };
}

/**
 * Assemble the report, worst first.
 *
 * Changed captures are ordered by how much moved, so the top of the list is the
 * thing to look at — an 11% difference and a 0.2% hairline both being "changed"
 * is only useful if they are not presented as equals.
 */
export function buildReport({ plan, results, thresholds, baselineDir, runDir }) {
  const scored = Object.entries(results)
    .map(([key, value]) => ({ key, ...value }))
    .sort((a, b) => (b.changedRatio ?? 1) - (a.changedRatio ?? 1) || a.key.localeCompare(b.key));
  const changed = scored.filter((r) => r.verdict !== "same");
  return {
    version: BASELINE_VERSION,
    baseline: baselineDir,
    run: runDir,
    thresholds,
    counts: {
      compared: scored.length,
      changed: changed.length,
      resized: scored.filter((r) => r.verdict === "resized").length,
      added: plan.added.length,
      removed: plan.removed.length,
    },
    changed,
    added: plan.added,
    removed: plan.removed,
  };
}

/** Human-readable lines describing a report. */
export function formatReport(report) {
  const { counts, thresholds } = report;
  const lines = [
    `PIXELS           ${counts.compared} compared, ${counts.changed} changed ` +
      `(${counts.resized} resized), ${counts.added} added, ${counts.removed} removed`,
    `thresholds       per-pixel ${thresholds.pixelTolerance}, per-capture ${thresholds.changedRatio}`,
  ];
  for (const item of report.changed.slice(0, 12)) {
    const detail =
      item.verdict === "resized"
        ? `${item.width[0]}x${item.height[0]} -> ${item.width[1]}x${item.height[1]}`
        : `${item.changedPixels}/${item.totalPixels} px (${(item.changedRatio * 100).toFixed(3)}%)`;
    lines.push(`  CHANGED  ${detail.padEnd(28)} ${item.key}`);
  }
  if (report.changed.length > 12) lines.push(`  … and ${report.changed.length - 12} more`);
  for (const key of report.added.slice(0, 5)) lines.push(`  ADDED    ${key}`);
  if (report.added.length > 5) lines.push(`  … and ${report.added.length - 5} more added`);
  for (const key of report.removed.slice(0, 5)) lines.push(`  REMOVED  ${key}`);
  if (report.removed.length > 5) lines.push(`  … and ${report.removed.length - 5} more removed`);
  return lines;
}
