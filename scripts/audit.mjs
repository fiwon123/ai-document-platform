#!/usr/bin/env node
/**
 * Interactive visual audit — captures the states a static page sweep cannot see.
 *
 * The Phase 6 sweep (`ui_sweep.mjs`) took one screenshot per route × viewport ×
 * theme: 156 images of the *initial paint*. It never scrolled, clicked, hovered
 * or toggled, so an entire class of visual problems was invisible to it —
 * footers below the fold, hover washes, focus rings, open modals, populated
 * filter chips, skeleton shimmer, and every scroll-triggered `Reveal`.
 *
 * This tool loads a route once and then drives it: it fills forms, opens
 * disclosures, toggles filters, hovers cards, expands the mobile menu, and
 * captures a screenshot at each step. States that are *animated* (the theme
 * crossfade, scroll reveals, the carousel, modal open/close, skeletons) are
 * recorded as video as well, because a screenshot of the final state is not
 * evidence that the animation to it works.
 *
 * Run it inside the `dev` container — never from a host browser, so rendering is
 * consistent and reproducible:
 *
 *   docker compose exec dev node scripts/audit.mjs
 *   docker compose exec dev node scripts/audit.mjs --only=landing,documents
 *   docker compose exec dev node scripts/audit.mjs --budget-mb=200 --keep-runs=1
 *
 * Output lands in `/tmp/opencode/visual-audit/<YYYYMMDD-HHMMSS>/` (override with
 * --out=). Runs are timestamped and pruned to the newest --keep-runs (default 2),
 * because a single pass measured 37 MB (170 PNGs, 25.9 MB of them, the rest WebM
 * screencasts) and an unpruned output directory is how a visual audit quietly
 * eats a disk. Note /tmp is not a mounted volume: a container restart wipes the
 * output, which is another reason to keep only a shortlist.
 *
 * ── Three rules this file follows, each learned the hard way ───────────────
 *
 * 1. ASSERT PRESENCE BEFORE EVERY CAPTURE. A rate-limited run makes /app/* and
 *    /auth/* redirect to /login, and an absent element then reads as a clean
 *    capture. `shot()` refuses to photograph something it has not first found.
 *
 * 2. THROTTLE OFF THE APP'S OWN SIGNAL. The rate limiter is per client IP at
 *    100 req/60 s and every response carries `X-RateLimit-Remaining`, so the
 *    script paces itself from that header instead of walking into a 429 and
 *    misreading the results.
 *
 * 3. A CAPTURE THAT CANNOT FAIL IS WORSE THAN NONE. The counters in `PROBE` are
 *    deliberately labelled: `smallTargetsRaw` is the *unfiltered* total — the
 *    inline-text and form-control excuses are applied as an `excused` label per
 *    item and split out in the summary, but both are heuristics that can
 *    disagree with a human audit — and `contrastFailures` only covers solid
 *    backgrounds (see below). They are lead-lists for a human, not verdicts.
 *    The gate below is different: it fails on signals that are not heuristics.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_GATE_SIGNALS,
  collectFindings,
  compareFindings,
  formatComparison,
  parseBaseline,
  parseGateSignals,
  serializeBaseline,
} from "./audit-baseline.mjs";
import {
  buildReport,
  classifyCapture,
  formatReport,
  keyFor,
  listCaptures,
  parseThresholds,
  planComparison,
} from "./audit-pixels.mjs";
import {
  BROWSERS_ROOT,
  installedBrowsers,
  launchFailure,
  resolvePlaywright,
} from "./audit-playwright.mjs";
import { waitForFonts } from "./audit-fonts.mjs";
import {
  buildAttrWaitArgs,
  checkClassExpectation,
  describeSkip,
  orderedStepKeys,
  unreachableStepKeys,
} from "./audit-interactions.mjs";
import { Pacer, rateLimitFindings } from "./audit-pacer.mjs";

// ─────────────────────────────────────────────────────────────────────────────
// Playwright resolution
//
// Playwright is installed globally in the dev image and is deliberately NOT a
// project dependency (the project uses Vitest; this is a one-off tool), so the
// image's baked browsers belong to that global install. What used to go wrong:
// `import("playwright")` resolved an *undeclared* leftover in
// `scripts/node_modules` whose browser revision the image does not have, the
// import succeeded anyway, and the audit died at launch with a raw Playwright
// banner. The resolution rule (prefer a local install, but only accept one whose
// browser is on disk, and name the versions and revisions when none is) lives in
// `audit-playwright.mjs` so it can be tested without a browser — see #529.
// ─────────────────────────────────────────────────────────────────────────────
async function loadPlaywright() {
  return resolvePlaywright({
    importModule: (specifier) => import(specifier),
    // A thunk, not a value: `npm root -g` is only needed if the local import
    // turns out to be unusable, and its failure is not fatal on its own.
    globalRoot: () => execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim(),
    existsSync: (p) => fs.existsSync(p),
    readFileSync: (p, encoding) => fs.readFileSync(p, encoding),
    readdirSync: (dir) => fs.readdirSync(dir),
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Configuration
// ─────────────────────────────────────────────────────────────────────────────
const VIEWPORTS = {
  mobile: { width: 375, height: 812, isMobile: true },
  tablet: { width: 768, height: 1024, isMobile: false },
  desktop: { width: 1440, height: 900, isMobile: false },
};

const DEFAULT_BASE_URL = "http://localhost:5173";
const DEFAULT_OUT_ROOT = "/tmp/opencode/visual-audit";
const FFMPEG = "/opt/ms-playwright/ffmpeg-1011/ffmpeg-linux";

/**
 * The gate's baseline, resolved relative to this file so that `--gate` behaves
 * the same whether it is invoked from the repo root or from scripts/.
 */
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_BASELINE_FILE = path.join(SCRIPT_DIR, "audit-baseline.json");

/**
 * Does the container's ffmpeg have a GIF muxer?
 *
 * Playwright's bundled ffmpeg is a minimal screencast build: it muxes
 * image2/matroska-webm and encodes libvpx, and has no GIF muxer at all. Trying
 * anyway produces one scary "Error opening output file" per video and zero
 * GIFs, so the capability is checked once up front and reported honestly.
 */
let gifSupport = null;
function ffmpegSupportsGif() {
  if (gifSupport !== null) return gifSupport;
  try {
    const formats = execFileSync(FFMPEG, ["-hide_banner", "-muxers"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    gifSupport = /^\s*E\s+.*\bgif\b/m.test(formats);
  } catch {
    gifSupport = false;
  }
  return gifSupport;
}

/** Viewport tiers per route group, so a full pass stays inside the time budget. */
const TIER = {
  /**
   * Mobile + desktop, every theme. Tablet was dropped deliberately: the issue's
   * bar is one screenshot per theme at desktop, mobile catches the narrow
   * layouts, and the third width cost ~1/3 of the run for no distinct layout.
   * Re-add "tablet" here if a breakpoint lands between 375 and 1440.
   */
  full: ["mobile", "desktop"],
  /** Desktop + mobile. The middle width is not visually distinct for these. */
  wide: ["desktop", "mobile"],
  /** Desktop only — the issue's minimum bar is "one screenshot per theme". */
  desktop: ["desktop"],
};

function parseArgs(argv) {
  const opts = {
    baseUrl: DEFAULT_BASE_URL,
    outRoot: DEFAULT_OUT_ROOT,
    keepRuns: 2,
    budgetMb: 500,
    only: null,
    videoThemes: null,
    headed: false,
    gate: false,
    updateBaseline: false,
    baselineFile: DEFAULT_BASELINE_FILE,
    pixelBaseline: null,
    updatePixelBaseline: false,
    pixelTolerance: undefined,
    changedRatio: undefined,
    help: false,
  };
  for (const arg of argv) {
    const [flag, ...rest] = arg.split("=");
    const value = rest.join("=");
    switch (flag) {
      case "--base":
        opts.baseUrl = value;
        break;
      case "--out":
        opts.outRoot = value;
        break;
      case "--keep-runs":
        opts.keepRuns = Number(value);
        break;
      case "--video-themes": {
        const list = value.split(",").map((s) => s.trim()).filter(Boolean);
        if (!list.length || list.some((s) => s !== "light" && s !== "dark")) {
          throw new Error("--video-themes must be a comma list of light and/or dark");
        }
        opts.videoThemes = list;
        break;
      }
      case "--budget-mb":
        opts.budgetMb = Number(value);
        break;
      case "--only":
        opts.only = value.split(",").map((s) => s.trim()).filter(Boolean);
        break;
      case "--gate":
        // Bare `--gate` means the default signal list; `--gate=a,b` narrows it.
        // Parsed eagerly so an unknown signal fails before an 11-minute run.
        opts.gate = parseGateSignals(value === "" ? undefined : value);
        break;
      case "--update-baseline":
        opts.updateBaseline = true;
        break;
      case "--baseline":
        if (!value) throw new Error("--baseline needs a path");
        opts.baselineFile = value;
        break;
      // ── Pixel diffing (#470) ────────────────────────────────────────────────
      // Named `--pixel-*` rather than reusing `--baseline`/`--update-baseline`
      // because #469 already gave those names to the *signal* baseline, and one
      // tool meaning "baseline" for a JSON file here and a directory of PNGs
      // there is a trap.
      case "--pixel-baseline":
        if (!value) throw new Error("--pixel-baseline needs a directory");
        opts.pixelBaseline = value;
        break;
      case "--update-pixel-baseline":
        // Accepts the path directly (`--update-pixel-baseline=DIR`) as well as
        // the bare flag plus `--pixel-baseline=DIR`. Two spellings of the same
        // thing is normally a smell, but here the bare form reads as a boolean
        // switch and the `=DIR` form reads as a path, and a user will reach for
        // either. Rejecting one of them would just be a trap.
        opts.updatePixelBaseline = true;
        if (value) opts.pixelBaseline = value;
        break;
      case "--pixel-tolerance":
        opts.pixelTolerance = Number(value);
        break;
      case "--changed-ratio":
        opts.changedRatio = Number(value);
        break;
      case "--headed":
        opts.headed = true;
        break;
      case "-h":
      case "--help":
        opts.help = true;
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return opts;
}

const USAGE = `
Interactive visual audit (see scripts/audit.mjs for the full rationale).

  docker compose exec dev node scripts/audit.mjs [options]

  --base=URL         Frontend origin         (default ${DEFAULT_BASE_URL})
  --out=DIR          Output root             (default ${DEFAULT_OUT_ROOT})
  --only=a,b         Only these groups       (see GROUPS below)
  --keep-runs=N      Run directories to keep (default 2)
  --budget-mb=N      Stop capturing past this many MB (default 500)
  --video-themes=L,D Themes to record animations in (default light)
  --gate[=a,b,c]  Fail (exit 1) on findings not in the baseline.
                  Signals: ${DEFAULT_GATE_SIGNALS.join(", ")}, landmarks.
  --baseline=PATH  Baseline file (default scripts/audit-baseline.json)
  --update-baseline  Accept this run as the baseline and exit 0
  --pixel-baseline=DIR  Compare this run's captures against DIR (see below)
  --update-pixel-baseline[=DIR]  Make this run the pixel baseline (PNGs only).
                   Takes the path itself, or use it with --pixel-baseline=DIR.
  --pixel-tolerance=N  Per-pixel delta to ignore, 0..1 (default 0.1)
  --changed-ratio=N  Per-capture share that counts as changed, 0..1 (default 0.001)
  --headed           Run with a visible browser (debugging only)
  -h, --help         This message

GROUPS: public, landing, legal, auth, app, documents, search, qa, settings,
        webhooks, profile, admin, videos

PIXEL DIFFING (--pixel-baseline, --update-pixel-baseline)

  Compares captures by their run-relative path
  (<route>/<viewport>-<theme>-<state>.png), so a run directory is itself a valid
  baseline. Two thresholds: a per-pixel tolerance that ignores antialiasing, and
  a per-capture share of changed pixels above which a capture counts as changed.
  Captures present on only one side are reported as added/removed rather than
  skipped. Changed captures over the threshold get a diff PNG in the run's diff/
  directory and an entry in pixel-diff.json.

  This is deliberately NOT a CI gate. A pixel baseline is only comparable
  against the machine that produced it — a different CPU, Chromium build or font
  rasterisation turns every edge into a difference — so it runs in this container
  only, and a mismatch is a reason to look, not a red X. CI gates on the signal
  baseline above, which is the environment-independent half. See issue #470.

KNOWN LIMITATIONS
  * GIF output needs an ffmpeg with a GIF muxer. The container ships
    Playwright's screencast build (webm/image2 only), so animations are
    recorded as WebM and the run says so once. See ffmpegSupportsGif().
  * The /app/admin capture is the access-denied branch: the fixture user is a
    customer and nothing in the public API can promote it to admin.
  * --gate cannot be combined with --only. The baseline describes a full pass,
    so a partial run would report every group it skipped as "resolved" and a
    reviewer could accept the truncated list by accident.
  * Console and network errors are report-only and never gate. Third-party font
    CDNs are frequently unreachable from inside the container, so a failed
    asset request often describes the environment rather than the UI.
  * 429s *do* gate, under their own \`rate-limited\` signal, because they indict
    the audit rather than the UI (#535). The pacer keeps a reserve of 12
    requests in the tail of each 60 s window so it should never provoke one; a
    finding here means the reserve was not enough (or the limiter got tighter),
    and it is reported as a pacing failure instead of being filed as a missing
    element.
  * The gate compares *signals*, not pixels. Pixels are only comparable against
    the machine that produced them, so a CI-runner diff would be antialiasing
    noise. See issue #470 for the local pixel-diff tool.
`;

// ─────────────────────────────────────────────────────────────────────────────
// Small utilities
// ─────────────────────────────────────────────────────────────────────────────
const log = (...args) => console.log("[audit]", ...args);
const warn = (...args) => console.warn("[audit] WARN", ...args);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Filesystem-safe directory name for a route. */
function routeSlug(route) {
  if (route === "/") return "landing";
  return route.replace(/^\//, "").replace(/\//g, "-");
}

async function dirSizeBytes(dir) {
  let total = 0;
  let entries;
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) total += await dirSizeBytes(full);
    else {
      try {
        total += (await fsp.stat(full)).size;
      } catch {
        /* raced with a delete; ignore */
      }
    }
  }
  return total;
}

function timestampSlug(date = new Date()) {
  const pad = (n) => String(n).padStart(2, "0");
  return (
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}` +
    `-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// In-page probe
//
// Self-contained on purpose: it was going to be imported from the sweep
// harness, but that harness lived in /tmp and was lost to a container restart.
// Lessons worth honouring while writing it:
//
// - Contrast is measured for SOLID backgrounds only. Resolving a backdrop by
//   walking `background-color` invents a white-on-white failure for anything
//   gradient-backed (the landing hero is a gradient), and reporting those
//   numbers as defects is worse than not reporting them. Text clipped by
//   `background-clip: text` is not measurable this way at all.
// - Small targets are a RAW count, with WCAG 2.5.8's excuses applied as a
//   per-item label rather than used to drop items. Inline-text and form-control
//   are both heuristics — an anchor inside a <p> that is a whole button, or a
//   checkbox whose <label> is itself a 16px target, will be excused when a human
//   auditor would not. So the count stays visible and the excuse travels with it.
// ─────────────────────────────────────────────────────────────────────────────
const PROBE = () => {
  const visible = (el) => {
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return false;
    const style = getComputedStyle(el);
    return style.visibility !== "hidden" && style.display !== "none";
  };

  // Resolve CSS colours through the browser's own colour engine rather than by
  // regex. This stylesheet uses oklab()/color-mix(), which come back from
  // getComputedStyle in a form a regex turns into near-black - manufacturing
  // failures out of correct CSS. A 1x1 canvas + getImageData is exact for
  // every syntax, and gives alpha as well as RGB.
  const colourCanvas = document.createElement("canvas");
  colourCanvas.width = colourCanvas.height = 1;
  const colourCtx = colourCanvas.getContext("2d", { willReadFrequently: true });
  const resolveColor = (value) => {
    if (!colourCtx || !value || value === "transparent") return null;
    // Sentinel trick: an unparseable value leaves fillStyle untouched, so a
    // fillStyle still reading as the sentinel means the CSS did not parse.
    colourCtx.fillStyle = "#010203";
    colourCtx.fillStyle = value;
    if (colourCtx.fillStyle === "#010203" && value.trim().toLowerCase() !== "#010203") return null;
    colourCtx.clearRect(0, 0, 1, 1);
    colourCtx.fillStyle = value;
    colourCtx.fillRect(0, 0, 1, 1);
    const [r, g, b, a] = colourCtx.getImageData(0, 0, 1, 1).data;
    if (a === 0) return null;
    return { r, g, b, a: a / 255 };
  };

  const luminance = ({ r, g, b }) => {
    const channel = (c) => {
      const s = c / 255;
      return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
  };

  const contrast = (fg, bg) => {
    const l1 = luminance(fg);
    const l2 = luminance(bg);
    const [hi, lo] = l1 > l2 ? [l1, l2] : [l2, l1];
    return (hi + 0.05) / (lo + 0.05);
  };

  /**
   * The colour actually painted behind `el`, compositing every translucent
   * layer up the tree onto the first opaque one.
   *
   * The previous version took the first layer with any alpha and compared text
   * against it as if it were opaque. Text on a 12%-opacity tint therefore
   * compared against white and produced a 1:1 "catastrophic" failure on the
   * landing hero that does not exist in the rendered pixels.
   *
   * Returns null when the backdrop is not a plain colour (gradient, image, or
   * background-clip:text). An unreliable measurement is worse than none: it
   * files a bug about an invisible headline that is plainly visible.
   */
  const backdropFor = (el) => {
    const layers = [];
    let node = el;
    while (node) {
      const style = getComputedStyle(node);
      if (style.backgroundImage && style.backgroundImage !== "none") return null;
      const colour = resolveColor(style.backgroundColor);
      if (colour) {
        layers.push(colour);
        if (colour.a >= 1) break;
      }
      node = node.parentElement;
    }
    let result = { r: 255, g: 255, b: 255 };
    for (let i = layers.length - 1; i >= 0; i -= 1) {
      const layer = layers[i];
      result = {
        r: layer.r * layer.a + result.r * (1 - layer.a),
        g: layer.g * layer.a + result.g * (1 - layer.a),
        b: layer.b * layer.a + result.b * (1 - layer.a),
      };
    }
    return { r: result.r, g: result.g, b: result.b };
  };

  const contrastFailures = [];
  // Counted, not silently dropped: a high not-measurable count is itself a
  // signal that the probe is skipping a whole region of the page.
  let notMeasurable = 0;
  const seen = new Set();
  for (const el of document.querySelectorAll("body *")) {
    if (!visible(el)) continue;
    // Only elements that directly own text.
    const ownText = Array.from(el.childNodes)
      .filter((n) => n.nodeType === 3)
      .map((n) => n.textContent.trim())
      .join("");
    if (!ownText) continue;
    const style = getComputedStyle(el);
    // Gradient-clipped or transparent-filled text has no single ink colour.
    const fill = style.webkitTextFillColor;
    if (style.webkitBackgroundClip === "text" || style.backgroundClip === "text") { notMeasurable += 1; continue; }
    if (fill === "transparent" || resolveColor(fill)?.a === 0) { notMeasurable += 1; continue; }
    const fgColor = fill && fill !== "rgba(0, 0, 0, 0)" ? fill : style.color;
    const fg = resolveColor(fgColor);
    const bg = backdropFor(el);
    if (!fg || !bg) { notMeasurable += 1; continue; }
    const size = parseFloat(style.fontSize);
    const weight = Number(style.fontWeight) || 400;
    // WCAG large text: >=24px, or >=18.66px bold.
    const isLarge = size >= 24 || (size >= 18.66 && weight >= 700);
    const required = isLarge ? 3 : 4.5;
    const ratio = contrast(fg, bg);
    if (ratio >= required) continue;
    const key = `${style.color}|${bg.r},${bg.g},${bg.b}|${Math.round(size)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    contrastFailures.push({
      ratio: Number(ratio.toFixed(2)),
      required,
      color: `rgb(${Math.round(fg.r)}, ${Math.round(fg.g)}, ${Math.round(fg.b)})`,
      background: `rgb(${Math.round(bg.r)}, ${Math.round(bg.g)}, ${Math.round(bg.b)})`,
      fontSize: Number(size.toFixed(2)),
      weight,
      sample: ownText.slice(0, 40),
      tag: el.tagName.toLowerCase(),
      className: typeof el.className === "string" ? el.className.slice(0, 60) : "",
    });
  }

  const INTERACTIVE = "a[href], button, input, select, textarea, [role='button'], [tabindex]:not([tabindex='-1'])";
  // Every sub-24px target is recorded, but classified: a raw list of 234 items
  // where 230 are inline prose links and checkboxes is a lead-list nobody reads.
  // WCAG 2.5.8 excuses a target that sits in a sentence or block of text ("the
  // inline exception"), and a checkbox's real target is its <label>.
  const smallTargetsRaw = [];
  for (const el of document.querySelectorAll(INTERACTIVE)) {
    if (!visible(el)) continue;
    const rect = el.getBoundingClientRect();
    if (rect.width >= 24 && rect.height >= 24) continue;
    const style = getComputedStyle(el);
    const tag = el.tagName.toLowerCase();
    let excused = null;
    if (rect.bottom < 0 || rect.top > window.innerHeight || rect.right < 0 || rect.left > window.innerWidth) {
      excused = "off-screen";
    } else if (tag === "input" && /^(checkbox|radio)$/.test(el.type ?? "")) {
      excused = "form-control";
    } else if (
      tag === "a" &&
      style.display.startsWith("inline") &&
      el.closest("p, li, h1, h2, h3, h4, h5, h6, td, th, blockquote, figcaption, dd")
    ) {
      excused = "inline-text";
    }
    smallTargetsRaw.push({
      tag,
      className: typeof el.className === "string" ? el.className.slice(0, 60) : "",
      width: Number(rect.width.toFixed(2)),
      height: Number(rect.height.toFixed(2)),
      excused,
    });
  }

  const unlabelled = [];
  for (const el of document.querySelectorAll(INTERACTIVE)) {
    if (!visible(el)) continue;
    const name =
      el.getAttribute("aria-label") ||
      (el.getAttribute("aria-labelledby")
        ? document.getElementById(el.getAttribute("aria-labelledby"))?.textContent
        : "") ||
      (el.id ? document.querySelector(`label[for="${CSS.escape(el.id)}"]`)?.textContent : "") ||
      el.closest("label")?.textContent ||
      el.getAttribute("title") ||
      el.textContent?.trim();
    if (!name) {
      unlabelled.push({
        tag: el.tagName.toLowerCase(),
        className: typeof el.className === "string" ? el.className.slice(0, 60) : "",
      });
    }
  }

  return {
    mainCount: document.querySelectorAll("main").length,
    navCount: document.querySelectorAll("nav").length,
    footerCount: document.querySelectorAll("footer").length,
    h1Count: document.querySelectorAll("h1").length,
    title: document.title,
    theme: document.documentElement.dataset.theme || null,
    // Horizontal overflow of the document, not of any inner scroll container.
    overflowPx: Math.max(
      0,
      document.documentElement.scrollWidth - document.documentElement.clientWidth,
    ),
    unlabelled,
    smallTargetsRaw,
    contrastFailures,
    notMeasurable,
  };
};

// ─────────────────────────────────────────────────────────────────────────────
// Budget + retention
// ─────────────────────────────────────────────────────────────────────────────
class Budget {
  constructor(limitBytes) {
    this.limit = limitBytes;
    this.written = 0;
    this.exhausted = false;
  }

  get remainingBytes() {
    return Math.max(0, this.limit - this.written);
  }

  /** True when a capture of this size would exceed the budget. */
  wouldExceed(size) {
    return this.written + size > this.limit;
  }

  charge(size) {
    this.written += size;
  }

  exhaust() {
    this.exhausted = true;
  }
}

/**
 * Delete all but the newest `keep` run directories. Returns what it reclaimed.
 */
async function pruneOldRuns(outRoot, keep) {
  let entries;
  try {
    entries = await fsp.readdir(outRoot, { withFileTypes: true });
  } catch {
    return { removed: [], bytes: 0 };
  }
  const runs = entries
    .filter((e) => e.isDirectory() && /^\d{8}-\d{6}$/.test(e.name))
    .map((e) => e.name)
    .sort()
    .reverse();
  const doomed = runs.slice(keep);
  let bytes = 0;
  for (const name of doomed) {
    const full = path.join(outRoot, name);
    bytes += await dirSizeBytes(full);
    await fsp.rm(full, { recursive: true, force: true });
  }
  return { removed: doomed, bytes };
}

// Rate-limit-aware pacing lives in ./audit-pacer.mjs so its decisions are
// unit-testable without a browser, a network, or a 60-second sleep. The audit
// owns the I/O and the warning line.

// ─────────────────────────────────────────────────────────────────────────────
// PDF fixture
//
// The documents page needs a card *with a thumbnail* to be worth photographing,
// and the worker only renders one for a PDF. Built by hand rather than shelling
// out to PyMuPDF, so the tool stays a single self-contained file — and so the
// bytes are deterministic, which makes a diff between two runs meaningful.
// Object offsets are computed, not typed, so a longer string cannot corrupt the
// cross-reference table.
// ─────────────────────────────────────────────────────────────────────────────
function buildSimplePdf(lines) {
  const escape = (s) => s.replace(/([\\()])/g, "\\$1");
  let content = "BT\n/F1 18 Tf\n72 720 Td\n28 TL\n";
  for (const line of lines) content += `(${escape(line)}) Tj T*\n`;
  content += "ET\n";

  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] " +
      "/Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
    `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}endstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];

  let pdf = "%PDF-1.4\n";
  const offsets = [];
  objects.forEach((body, index) => {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${index + 1} 0 obj\n${body}\nendobj\n`;
  });

  const xrefOffset = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) pdf += `${String(offset).padStart(10, "0")} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;

  return Buffer.from(pdf, "latin1");
}

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures: one throwaway user, seeded with a few documents
//
// The audit registers a single user and reuses it everywhere, because the rate
// limiter is per IP — a fresh user per scenario would not help, but a fresh user
// per page load would blow the window on logins alone.
//
// The documents are setup, not interaction: the issue's route table asks for
// "card with thumbnail" and "card with error", and both are unreachable with an
// empty account. No *form* is submitted against the API.
// ─────────────────────────────────────────────────────────────────────────────
const AUDIT_PASSWORD = "AuditPassw0rd!visual";

async function apiRequest(pathname, { method = "GET", token, json, body, headers: extra } = {}) {
  const headers = { ...extra };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (json) headers["Content-Type"] = "application/json";
  return fetch(`${BASE_URL}${pathname}`, {
    method,
    headers,
    body: json ? JSON.stringify(json) : body,
  });
}

let BASE_URL = DEFAULT_BASE_URL;

async function createAuditUser() {
  const username = `audit${Date.now().toString(36).slice(-6)}`;
  const created = await apiRequest("/v1/auth/register", {
    method: "POST",
    json: {
      username,
      password: AUDIT_PASSWORD,
      confirm_password: AUDIT_PASSWORD,
    },
  });
  if (!created.ok) {
    throw new Error(`register failed: ${created.status} ${await created.text()}`);
  }
  const login = await apiRequest("/v1/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ username, password: AUDIT_PASSWORD }).toString(),
  });
  if (!login.ok) {
    throw new Error(`login failed: ${login.status} ${await login.text()}`);
  }
  const data = await login.json();
  return { username, token: data.access_token, userId: data.user?.id ?? null };
}

async function seedDocuments(token) {
  const uploaded = [];
  const send = async (filename, mime, bytes) => {
    const form = new FormData();
    form.append("upload_file", new Blob([bytes], { type: mime }), filename);
    const res = await apiRequest("/v1/documents/", { method: "POST", token, body: form });
    return { filename, ok: res.ok, status: res.status };
  };

  uploaded.push(
    await send(
      "quarterly-report.txt",
      "text/plain",
      Buffer.from(
        "Quarterly Report\n\nRevenue grew across every region this quarter. " +
          "The ingestion pipeline processed 1,284 documents with a 99.2% success " +
          "rate. Median search latency was 180 ms. Support ticket volume fell 12% " +
          "after the self-service knowledge base shipped.\n",
      ),
    ),
  );
  uploaded.push(
    await send(
      "onboarding-checklist.md",
      "text/markdown",
      Buffer.from(
        "# Onboarding checklist\n\n- Request repository access\n- Read the " +
          "architecture overview\n- Deploy to staging once\n- Shadow a support " +
          "rotation\n",
      ),
    ),
  );
  uploaded.push(
    await send(
      "product-tour.pdf",
      "application/pdf",
      buildSimplePdf([
        "AskDocs product tour",
        "",
        "Upload a document and the worker extracts,",
        "chunks and embeds its text in the background.",
        "",
        "Search runs semantically against those",
        "embeddings; ask questions to get an answer",
        "with sources.",
      ]),
    ),
  );
  // Deliberately unparseable, so the list has a `failed` card next to the ready
  // ones — the error state is a distinct visual, not a variation of the happy one.
  // A valid PDF header followed by ~1 KB of binary garbage. A short "not really
  // a pdf" string was not enough: PyMuPDF still parsed it and the document came
  // back `ready`, so there was no failure state to photograph. This payload was
  // verified to reach `failed` in ~21s against the running worker.
  uploaded.push(
    await send(
      "corrupt-scan.pdf",
      "application/pdf",
      Buffer.concat([
        Buffer.from("%PDF-1.4\n"),
        Buffer.from(Array.from({ length: 1024 }, (_, i) => i % 256)),
        Buffer.from("\ntrailer garbage\n"),
      ]),
    ),
  );

  return uploaded;
}

/** Wait for the worker to leave pending/processing, so cards are not all spinners. */
async function waitForProcessing(token, { timeoutMs = 90_000, quiet = false } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await apiRequest("/v1/documents/", { token });
    if (res.ok) {
      const docs = await res.json();
      const pending = docs.filter((d) => d.status === "pending" || d.status === "processing");
      if (pending.length === 0 && docs.length > 0) {
        return docs;
      }
      if (!quiet) log(`  processing… ${docs.length - pending.length}/${docs.length} settled`);
    }
    await sleep(2000);
  }
  warn("documents did not settle before the timeout — capturing whatever state exists");
  const res = await apiRequest("/v1/documents/", { token });
  return res.ok ? res.json() : [];
}

/** "2 ready, 1 failed" — the states the captures depend on, stated explicitly. */
function describeSettleStates(docs) {
  const byStatus = {};
  for (const doc of docs) byStatus[doc.status] = (byStatus[doc.status] ?? 0) + 1;
  const parts = Object.entries(byStatus).map(([status, count]) => `${count} ${status}`);
  const summary = parts.join(", ") || "none";
  if (!docs.some((d) => d.status === "failed")) {
    warn(`no document reached "failed" (${summary}) — the processing-error card cannot be captured`);
  } else if (!docs.some((d) => d.status === "ready")) {
    warn(`no document reached "ready" (${summary}) — preview, search and QA states are not real`);
  }
  return summary;
}

// ─────────────────────────────────────────────────────────────────────────────
// The run
// ─────────────────────────────────────────────────────────────────────────────
class Audit {
  constructor(opts, { chromium, runDir, budget, pacer }) {
    this.opts = opts;
    this.chromium = chromium;
    this.runDir = runDir;
    this.budget = budget;
    this.pacer = pacer;
    this.manifest = [];
    this.videoTempDir = path.join(runDir, ".video-tmp");
    this.auth = null;
    this.browser = null;
    this.consoleErrors = [];
    this.networkFailures = [];
    // 429s are separated out because they indict the audit, not the UI (#535).
    this.rateLimited = [];
    this.pageErrors = [];
  }

  // ── capture bookkeeping ────────────────────────────────────────────────

  /**
   * Attribute a skip that happened while the limiter was throttling us.
   *
   * A missing selector is a UI finding. A missing selector *after* a 429 on a
   * request the page depends on is the audit misfiring: the app redirects to
   * /login when /auth/me is refused and drops its model list when /qa/models is,
   * and both present as "the element is gone". Recording the reason with the
   * 429 attached means the two cannot be confused, whatever a reviewer goes on
   * to read.
   */
  #skipReason(reason, throttledBefore) {
    if (throttledBefore === null) return reason;
    const landed = this.rateLimited.length - throttledBefore;
    if (landed <= 0) return reason;
    return `rate limited (${landed}× 429 during this capture) — audit-induced, not a UI finding: ${reason}`;
  }

  addEntry(entry) {
    const record = { timestamp: new Date().toISOString(), ...entry };
    this.manifest.push(record);
    return record;
  }

  /**
   * The single gate every capture goes through.
   *
   * Presence is asserted BEFORE the shutter, because the alternative is a
   * screenshot of a page that silently lost its content (rate-limit redirect,
   * slow render, renamed selector) being filed as evidence of a healthy state.
   */
  async shot(page, { route, viewport, theme, state, dir, require: requireSelector, requireMs = null, fullPage = false, clipSelector = null, probe = true, action = null, note = null, throttledBefore = null }) {
    const slug = routeSlug(route);
    const target = path.join(this.runDir, dir ?? slug);
    await fsp.mkdir(target, { recursive: true });
    const file = `${viewport}-${theme}-${state}.png`;
    const abs = path.join(target, file);

    if (this.budget.exhausted) {
      this.addEntry({
        route, viewport, theme, state, type: "screenshot", file: null, skipped: "disk budget",
      });
      return false;
    }

    if (requireSelector) {
      const locator = page.locator(requireSelector).first();
      let found = false;
      try {
        await locator.waitFor({ state: "attached", timeout: requireMs ?? 5000 });
        found = true;
      } catch {
        found = false;
      }
      if (!found) {
        const reason = this.#skipReason(`selector not present: ${requireSelector}`, throttledBefore);
        warn(`SKIP ${route} [${viewport}/${theme}] ${state}: ${reason}`);
        this.addEntry({
          route, viewport, theme, state, type: "screenshot", file: null,
          skipped: reason,
          note,
        });
        return false;
      }
    }

    // The last gate before the shutter, and the one #537 was missing: a capture
    // in a fallback typeface is a photograph of a page the user never sees, and
    // it is *worse* than a missing capture — a fallback face shifts every glyph
    // box, so it differs from the next capture of the same page by far more
    // than any real regression would. Measured on the H1 of that capture: 103px
    // in the fallback against 120px in Manrope, seconds apart, with
    // `pageErrors: 0, consoleErrors: 0, overflowPx: 0` recorded for it.
    //
    // `settleVisuals()` already awaits `document.fonts.ready`, which cannot see
    // this: the page's faces arrive through a CSS `@import`, so at the moment
    // that wait resolves there is nothing pending and the faces are not
    // registered yet. See `audit-fonts.mjs` for the whole argument.
    //
    // Skipping rather than photographing is the same rule the selector check
    // above follows, and it is bounded (3s), so a run cannot be held up by a
    // page whose fonts never arrive.
    const fonts = await waitForFonts(page);
    if (!fonts.ready) {
      const reason = this.#skipReason(fonts.reason, throttledBefore);
      warn(`SKIP ${route} [${viewport}/${theme}] ${state}: ${reason}`);
      this.addEntry({
        route, viewport, theme, state, type: "screenshot", file: null,
        skipped: reason,
        note,
      });
      return false;
    }

    const probeStarted = Date.now();
    let probeData = null;
    if (probe) {
      try {
        probeData = await page.evaluate(PROBE);
      } catch (err) {
        warn(`probe failed on ${route} ${state}: ${err.message}`);
      }
    }

    // `animations: "disabled"` is required for pixel diffing, not a nicety.
    // The pages carry at least nine infinite CSS animations (`logo-scroll` 42s,
    // `mesh-drift` 16s, `auth-bg-shift` 18s, `preview-float` 9s, …), and none of
    // them respect prefers-reduced-motion, so without this the position of the
    // logo marquee at capture time is arbitrary. Measured on the landing group:
    // two runs of identical code differed in 8 of 28 captures, up to 17.8% of
    // the hero's pixels — which would drown every real regression in noise.
    // Playwright fast-forwards the animations to their end state, so the
    // capture is both stable and complete. App behaviour is untouched.
    const anim = { animations: "disabled" };
    const buffer = clipSelector
      ? await page.locator(clipSelector).first().screenshot(anim)
      : await page.screenshot({ fullPage, ...anim });

    if (this.budget.wouldExceed(buffer.length)) {
      this.budget.exhaust();
      warn(`budget reached (${(this.budget.written / 1e6).toFixed(1)} MB) — no more captures`);
      this.addEntry({
        route, viewport, theme, state, type: "screenshot", file: null, skipped: "disk budget",
      });
      return false;
    }

    await fsp.writeFile(abs, buffer);
    this.budget.charge(buffer.length);

    this.addEntry({
      route, viewport, theme, state, type: "screenshot",
      file: path.relative(this.runDir, abs),
      bytes: buffer.length,
      // Recorded so a reviewer can tell a whole-page capture from a viewport
      // one without opening the PNG. page.screenshot() does not scroll for
      // fullPage (it resizes the capture surface), so the probe above only ever
      // measured the top viewport even on a 4000px-tall page.
      fullPage: fullPage === true,
      // Per-scenario cost. A 200-capture run cannot be tuned to a time budget
      // from a single total.
      durationMs: Date.now() - probeStarted,
      probe: probeData
        ? {
            consoleErrors: this.consoleErrors.length,
            pageErrors: this.pageErrors.length,
            mainCount: probeData.mainCount,
            navCount: probeData.navCount,
            footerCount: probeData.footerCount,
            h1Count: probeData.h1Count,
            overflowPx: probeData.overflowPx,
            unlabelled: probeData.unlabelled.length,
            smallTargetsRaw: probeData.smallTargetsRaw.length,
            contrastFailures: probeData.contrastFailures.length,
            notMeasurable: probeData.notMeasurable,
          }
        : null,
      probeDetail: probeData,
      interaction: action,
      note,
    });
    return true;
  }

  // ── video ──────────────────────────────────────────────────────────────
  /**
   * Record one animated scenario into its OWN BrowserContext.
   *
   * Isolation is not optional: Playwright writes one video per context, so
   * sharing a context would concatenate unrelated clips into a single file and
   * make the manifest's file names a fiction.
   */
  async recordAnimation({ route, viewport, theme, state, dir, action, run, expect: expectSelector, requireAuth = false }) {
    const slug = routeSlug(route);
    const target = path.join(this.runDir, dir ?? slug);
    await fsp.mkdir(target, { recursive: true });
    const base = `${viewport}-${theme}-${state}`;

    if (this.budget.exhausted) {
      this.addEntry({ route, viewport, theme, state, type: "video", file: null, skipped: "disk budget" });
      return;
    }

    const vp = VIEWPORTS[viewport];
    await fsp.mkdir(this.videoTempDir, { recursive: true });

    const context = await this.browser.newContext({
      viewport: { width: vp.width, height: vp.height },
      recordVideo: { dir: this.videoTempDir, size: { width: vp.width, height: vp.height } },
    });
    const consoleErrors = [];
    const pageErrors = [];
    // A 429 during *this* capture, so a selector that failed to appear can be
    // attributed to the limiter instead of being filed as a missing element.
    // #535: a starved /qa/models leaves the settings page with no options, and
    // a starved /auth/me redirects to /login — both look exactly like a UI
    // regression and neither is one.
    const throttledHere = [];

    // The auth token has to be in place before the app's first script runs.
    if (this.auth) await injectAuth(context, this.auth.token, theme);

    let page = null;
    const started = Date.now();
    try {
      page = await context.newPage();
      wirePage(page, consoleErrors, pageErrors, this.networkFailures, this.rateLimited, throttledHere);
      // Navigate before the scenario runs. This was missing entirely, so every
      // video recorded about:blank — a 4 KB WebM of nothing that looked like a
      // successful capture in the manifest.
      await this.pacer.beforeRequest();
      const response = await page.goto(`${BASE_URL}${route}`, {
        waitUntil: "domcontentloaded",
        timeout: 30_000,
      });
      if (response) this.pacer.observe(response.headers());
      if (expectSelector) {
        await page.locator(expectSelector).first().waitFor({ state: "attached", timeout: 12_000 });
      }
      // Deliberately no reveal-forcing here: the point of these recordings is
      // the real animation, including the pre-reveal state.
      await settleVisuals(page);
      await run(page);
    } catch (err) {
      warn(`video scenario ${base} failed: ${err.message}`);
      this.addEntry({ route, viewport, theme, state, type: "video", file: null, error: err.message });
      await context.close().catch(() => {});
      return;
    }
    // Playwright finalises the video when the page closes; the path is only
    // readable afterwards, so it has to be captured before the context goes.
    const video = page.video();
    await context.close().catch(() => {});
    const videoPath = video ? await video.path().catch(() => null) : null;

    const entry = {
      route, viewport, theme, state, type: "video",
      duration_ms: Date.now() - started,
      interaction: action,
    };

    if (!videoPath || !fs.existsSync(videoPath)) {
      warn(`no video produced for ${base}`);
      this.addEntry({ ...entry, file: null, error: "no video produced" });
      return;
    }

    const webmPath = path.join(target, `${base}.webm`);
    const webmSize = (await fsp.stat(videoPath)).size;
    if (this.budget.wouldExceed(webmSize)) {
      this.budget.exhaust();
      warn(`budget reached before writing ${base}.webm — dropping the raw capture`);
      await fsp.rm(videoPath, { force: true });
      this.addEntry({ ...entry, file: null, skipped: "disk budget" });
      return;
    }
    await fsp.copyFile(videoPath, webmPath);
    await fsp.rm(videoPath, { force: true });
    this.budget.charge(webmSize);

    // GIF for quick review (viewable without a player); WebM kept alongside for
    // frame-accurate review. GIF is the single largest cost in a run, so a size
    // check before converting is not paranoia.
    const gifPath = path.join(target, `${base}.gif`);
    let gifBytes = 0;
    if (!this.budget.exhausted && ffmpegSupportsGif()) {
      // Convert to a scratch file first. Measuring a GIF only after writing it
      // lets a single conversion overshoot a *hard* budget, and the run dir is
      // already over the limit by the time we find out.
      const gifTmp = path.join(this.videoTempDir, `${base}.gif`);
      try {
        execFileSync(
          FFMPEG,
          ["-y", "-loglevel", "error", "-i", webmPath, "-vf", "fps=10,scale=640:-1:flags=lanczos", "-loop", "0", gifTmp],
          { stdio: "pipe" },
        );
        gifBytes = (await fsp.stat(gifTmp)).size;
        if (this.budget.wouldExceed(gifBytes)) {
          warn(`GIF for ${base} is ${(gifBytes / 1e6).toFixed(1)} MB and would exceed the budget — keeping the WebM only`);
          await fsp.rm(gifTmp, { force: true });
          gifBytes = 0;
        } else {
          await fsp.move(gifTmp, gifPath);
          this.budget.charge(gifBytes);
        }
      } catch (err) {
        warn(`ffmpeg conversion failed for ${base}: ${err.message}`);
        await fsp.rm(gifTmp, { force: true }).catch(() => {});
      }
    }

    this.addEntry({
      ...entry,
      file: path.relative(this.runDir, gifBytes ? gifPath : webmPath),
      format: gifBytes ? "gif" : "webm",
      source_webm: path.relative(this.runDir, webmPath),
      bytes: webmSize + gifBytes,
    });
  }

  // ── navigation ─────────────────────────────────────────────────────────
  /**
   * Load a route and confirm we actually got it.
   *
   * `expect` is asserted after navigation for the same reason captures assert
   * presence: a rate-limited /app/* load lands on /login, which renders
   * perfectly and looks like a successful capture of the wrong page.
   */
  async open(context, route, { theme, expect: expectSelector, requireAuth = false }) {
    const page = await context.newPage();
    wirePage(page, this.consoleErrors, this.pageErrors, this.networkFailures, this.rateLimited);
    if (this.auth) await injectAuth(context, this.auth.token, theme);

    // Sleep out the rate-limit window *before* navigating, not after hitting a
    // 429 — a 429 on /app/* is answered with a redirect to /login, which then
    // looks like a successful capture of the wrong page.
    await this.pacer.beforeRequest();
    const response = await page.goto(`${BASE_URL}${route}`, {
      waitUntil: "domcontentloaded",
      timeout: 30_000,
    });
    if (response) this.pacer.observe(response.headers());

    // Assert the route we asked for is the route we got, independently of any
    // selector. `main` also exists on /login, so a presence check alone cannot
    // distinguish the real page from an auth bounce.
    const landedPath = new URL(page.url()).pathname.replace(/\/$/, "") || "/";
    const wantedPath = route.replace(/\/$/, "") || "/";
    if (landedPath !== wantedPath) {
      const reason = `redirected ${wantedPath} -> ${landedPath} (rate limit, or the route needs auth)`;
      warn(`SKIP ${route}: ${reason}`);
      this.addEntry({ route, viewport: null, theme, state: "open", type: "navigation", file: null, skipped: reason });
      await page.close();
      return null;
    }

    if (expectSelector) {
      try {
        await page.locator(expectSelector).first().waitFor({ state: "attached", timeout: 10_000 });
      } catch {
        const reason = `"${expectSelector}" never appeared on ${wantedPath}`;
        warn(`SKIP ${route}: ${reason}`);
        this.addEntry({ route, viewport: null, theme, state: "open", type: "navigation", file: null, skipped: reason });
        await page.close();
        return null;
      }
    }
    await settleVisuals(page);
    return page;
  }

  async dispose() {
    if (this.browser) await this.browser.close().catch(() => {});
    // Playwright's raw video dir is scratch: without this every run leaks a
    // second copy of every clip.
    await fsp.rm(this.videoTempDir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Wait until the page is visually stable enough to photograph.
 *
 * Replaces `waitForLoadState("networkidle")`, which cost 1.75s on *every* load
 * (measured across eight routes) on top of a readiness check the `expect`
 * selector had already made. Fonts and images are the two things that visibly
 * change a screenshot after first paint, so those are what we wait for.
 */
async function settleVisuals(page, cap = 3000) {
  // Not sufficient on its own, and deliberately left in place anyway: it drains
  // the font loads that *are* already pending (a real win for the video path,
  // which records rather than photographs), but it resolves before the CSS
  // `@import`'s faces are registered, so it cannot see the #537 race. The gate
  // that can is `waitForFonts` in `shot()`.
  await page.evaluate(() => document.fonts.ready).catch(() => {});
  await page
    .waitForFunction(() => [...document.images].every((img) => img.complete), null, { timeout: cap })
    .catch(() => {});
  // Repeated reveals can be mid-transition, or not yet triggered at all, after a
  // scroll. Both are non-deterministic and both wreck a pixel comparison: the
  // measured effect on the landing group was 39% of a capture's pixels flipping
  // between runs because one block's text was present in one run and still at
  // opacity 0 in the other.
  //
  // This mirrors the app's own observer (useScrollReveal: threshold 0.15,
  // rootMargin "0px 0px -10% 0px") rather than guessing at "is it on screen".
  // Guessing strictly is worse than useless: the pricing table is 837px tall, so
  // "any part in the viewport" is true when 150px of it peeks in at the bottom
  // edge, the wait then demands a reveal that will never come, and every
  // scrolled capture times out. The band between 0.10 and 0.20 is deliberately
  // not required either way — that is where the observer's own decision is
  // legitimately marginal.
  const revealsSettled = () => {
    const rootBottom = window.innerHeight * 0.9;
    for (const el of document.querySelectorAll(".reveal")) {
      const rect = el.getBoundingClientRect();
      if (!rect.height) continue;
      const visible = Math.min(rect.bottom, rootBottom) - Math.max(rect.top, 0);
      if (visible / rect.height < 0.2) continue;
      if (!el.classList.contains("is-revealed")) return false;
      const style = getComputedStyle(el);
      if (style.opacity !== "1" || style.transform !== "none") return false;
    }
    return true;
  };
  try {
    await page.waitForFunction(revealsSettled, null, { timeout: 2000 });
  } catch {
    // Timed out. That is either a genuinely slow reveal or content that never
    // reveals at all — both worth photographing, so capture as-is. A pixel diff
    // against a stable baseline will then flag it, which is the right outcome
    // for a real defect.
    warn("reveal did not settle within 2s — capturing as-is");
  }
  // One frame for the compositor to flush the decoded assets.
  await page.waitForTimeout(120);
}

function wirePage(page, consoleErrors, pageErrors, networkFailures = [], rateLimited = [], throttledHere = null) {
  page.on("console", (msg) => {
    if (msg.type() === "error") consoleErrors.push(msg.text().slice(0, 300));
  });
  page.on("pageerror", (err) => pageErrors.push(String(err).slice(0, 300)));
  page.on("response", (res) => {
    // One hook for the pacer so every route's traffic counts, including XHR.
    if (res.headers()["x-ratelimit-remaining"] !== undefined) {
      currentPacer?.observe(res.headers());
    }
    // A 429 is the audit's own fault, never a UI regression, so it gets its own
    // list and its own gate signal rather than hiding in networkFailures (#535).
    if (res.status() === 429) {
      const what = `${res.status()} ${res.request().method()} ${res.url()}`;
      rateLimited.push(what);
      throttledHere?.push(what);
    }
    // "28 console errors" is unactionable; the URL and status are the finding.
    if (res.status() >= 400) {
      networkFailures.push(`${res.status()} ${res.request().method()} ${res.url()}`);
    }
  });
  // A connection refused never produces a response, so it needs its own hook —
  // this is how an unreachable asset host shows up at all.
  page.on("requestfailed", (req) => {
    networkFailures.push(`FAILED ${req.method()} ${req.url()} (${req.failure()?.errorText ?? "unknown"})`);
  });
  // Destructive actions use window.confirm. Accept it, or a scenario that
  // reaches one hangs until the navigation timeout with no explanation.
  page.on("dialog", (dialog) => {
    dialog.accept().catch(() => {});
  });
}

/** Register the auth + theme seed script. Theme first so no flash of the wrong one. */
async function injectAuth(context, token, theme) {
  await context.addInitScript(
    ({ token, theme }) => {
      try {
        window.localStorage.setItem("askdocs-theme", theme);
        if (token) window.localStorage.setItem("token", token);
      } catch {
        /* private mode / storage disabled — the capture will show the consequence */
      }
    },
    { token, theme },
  );
}

let currentPacer = null;

// ─────────────────────────────────────────────────────────────────────────────
// Scenarios
//
// Grouped so `--only=` can select a subset, and written as data where possible so
// adding a route is a one-line change rather than a new copy-pasted block.
// ─────────────────────────────────────────────────────────────────────────────
const GROUPS = {};

GROUPS.public = [
  { route: "/demo", state: "hero", require: ".demo-page, main", expect: "main" },
  { route: "/product", state: "hub", require: "main", expect: "main" },
  { route: "/features", state: "top", require: "main", expect: "main" },
  { route: "/how-it-works", state: "top", require: "main", expect: "main" },
  { route: "/company", state: "hub", require: "main", expect: "main" },
  { route: "/about", state: "top", require: "main", expect: "main" },
  { route: "/blog", state: "empty", require: "main", expect: "main" },
  { route: "/careers", state: "top", require: "main", expect: "main" },
  { route: "/contact", state: "top", require: "main", expect: "main" },
];

GROUPS.legal = [
  { route: "/privacy", state: "top", require: "main", expect: "main", fullPage: true },
  { route: "/terms", state: "top", require: "main", expect: "main", fullPage: true },
  { route: "/security", state: "top", require: "main", expect: "main", fullPage: true },
  { route: "/gdpr", state: "top", require: "main", expect: "main", fullPage: true },
];

GROUPS.landing = [
  { route: "/", state: "hero", require: ".landing-navbar", expect: ".landing-navbar" },
  { route: "/", state: "mid", require: "footer", expect: ".landing-navbar", scrollTo: "middle" },
  { route: "/", state: "footer", require: ".landing-navbar", expect: ".landing-navbar", scrollTo: "bottom" },
  { route: "/", state: "disclosure-open", require: ".nav-group-trigger", expect: ".landing-navbar", click: ".nav-group-trigger" },
  {
    // The captured state is the *annual* table, so the post-condition is
    // asserted rather than assumed. The click occasionally lands before React
    // has attached the handler, and the capture then silently showed the
    // monthly table — same pixels as `pricing-monthly`, so nothing downstream
    // could tell. Asserting `aria-checked` makes that a reported skip.
    route: "/", state: "pricing-annual", require: ".billing-toggle", expect: ".landing-navbar",
    scrollTo: "selector:.billing-toggle", click: '.billing-toggle [role="switch"]',
    assertAttr: { selector: '.billing-toggle [role="switch"]', attr: "aria-checked", value: "true" },
  },
  {
    route: "/", state: "pricing-monthly", require: ".billing-toggle", expect: ".landing-navbar",
    scrollTo: "selector:.billing-toggle",
  },
  {
    // Pinned to a known slide on purpose. The carousel auto-advances every 5s,
    // so which slide is showing when the shutter opens depended on elapsed
    // wall-clock time since load — three identical runs produced three
    // different images. `clickNth` hovers first (which stops the interval) and
    // then clicks dot 1, and refuses to capture unless dot 1 ends up `.active`.
    route: "/", state: "carousel-hover", require: ".screenshot-carousel", expect: ".landing-navbar",
    scrollTo: "selector:.screenshot-carousel",
    clickNth: { selector: ".carousel-dot", index: 1, expectClass: "active" },
  },
];

GROUPS.auth = [
  { route: "/login", state: "empty", require: ".auth-card", expect: ".auth-card" },
  {
    route: "/login", state: "filled", require: "#password", expect: ".auth-card",
    fill: { "#username": "audit-visual", "#password": AUDIT_PASSWORD },
  },
  {
    route: "/login", state: "password-visible", require: ".password-toggle", expect: ".auth-card",
    fill: { "#password": AUDIT_PASSWORD }, click: ".password-toggle",
  },
  {
    route: "/login", state: "remember-checked", require: "#login-remember", expect: ".auth-card",
    check: "#login-remember",
  },
  {
    route: "/login", state: "button-hover", require: ".auth-card", expect: ".auth-card",
    hover: "button[type=submit]",
  },
  { route: "/register", state: "empty", require: ".auth-card", expect: ".auth-card" },
  {
    route: "/register", state: "filled", require: "#password", expect: ".auth-card",
    fill: { "#username": "audit_visual", "#password": "Str0ngPassw0rd!visual", "#confirmPassword": "Str0ngPassw0rd!visual" },
  },
];

GROUPS.app = [
  { route: "/app", state: "dashboard", require: "main", expect: "main", auth: true },
];

GROUPS.documents = [
  { route: "/app/documents", state: "list", require: ".document-card", expect: ".main-content, main", auth: true },
  { route: "/app/documents", state: "card-hover", require: ".document-card", expect: "main", auth: true, hover: ".document-card" },
  { route: "/app/documents", state: "filter-ready", require: ".status-filter", expect: "main", auth: true, click: '.filter-chip:has-text("Ready")' },
  { route: "/app/documents", state: "filter-all", require: ".status-filter", expect: "main", auth: true, click: ".status-filter .filter-chip" },
  {
    // Scoped to a document known to be ready. The preview button renders for
    // every status, and the list is newest-first, so "the first card" is the
    // deliberately-corrupt fixture — whose /preview 404s and never opens a
    // modal. Clicking the first card made this scenario fail every time.
    route: "/app/documents", state: "modal-open", expect: "main", auth: true,
    click: '.document-card:has-text("quarterly-report.txt") button[aria-label="Preview document"]',
    // The modal only mounts after the preview text fetch resolves, which is
    // subject to the same 100 req/min limit as everything else.
    require: ".modal-overlay", requireMs: 12_000,
  },
  {
    // The failure path is a real state a user hits, and the only place the
    // Failed badge and the reprocess affordance are reachable.
    route: "/app/documents", state: "card-failed", expect: "main", auth: true,
    require: '.document-card:has-text("corrupt-scan.pdf")',
    note: "processing-failure path: Failed badge + reprocess button",
  },
  { route: "/app/documents", state: "dropzone", require: ".dropzone", expect: "main", auth: true, hover: ".dropzone" },
];

GROUPS.search = [
  { route: "/app/search", state: "empty", require: "main", expect: "main", auth: true },
  {
    route: "/app/search", state: "query-filled", require: "#search-query", expect: "main", auth: true,
    fill: { "#search-query": "revenue" },
  },
];

GROUPS.qa = [
  { route: "/app/qa", state: "empty", require: ".qa-model-select", expect: "main", auth: true },
  { route: "/app/qa", state: "model-open", require: ".qa-model-select", expect: "main", auth: true, click: ".qa-model-select" },
  { route: "/app/qa", state: "suggestions", require: ".suggestion-chip", expect: "main", auth: true, hover: ".suggestion-chip" },
];

GROUPS.settings = [
  { route: "/app/settings", state: "default", require: ".settings-model-option", expect: "main", auth: true },
  { route: "/app/settings", state: "api-key-filled", require: "#settings-api-key", expect: "main", auth: true, fill: { "#settings-api-key": "sk-audit-visual-placeholder" } },
  { route: "/app/settings", state: "model-option-hover", require: ".settings-model-option", expect: "main", auth: true, hover: ".settings-model-option" },
];

GROUPS.webhooks = [
  { route: "/app/webhooks", state: "tutorial-open", require: ".webhook-tutorial", expect: "main", auth: true, click: ".webhook-tutorial > summary" },
  { route: "/app/webhooks", state: "tutorial-closed", require: ".webhook-tutorial", expect: "main", auth: true, click: ".webhook-tutorial > summary", clickAgain: true },
  { route: "/app/webhooks", state: "form-filled", require: "#webhook-url", expect: "main", auth: true, fill: { "#webhook-url": "https://example.com/hook" } },
];

GROUPS.profile = [
  { route: "/app/profile", state: "default", require: ".settings-card", expect: "main", auth: true },
  { route: "/app/profile", state: "username-filled", require: "input", expect: "main", auth: true, fill: { "#profile-username": "audit_visual_renamed" } },
  { route: "/app/profile", state: "danger-zone", require: ".danger-zone", expect: "main", auth: true, click: ".danger-zone button" },
];

GROUPS.admin = [
  // The audit fixture registers as a customer, and there is no way to mint an
  // admin from the public API (role changes are admin-only, and the tool has no
  // psql). AdminPage renders a real access-denied branch for non-admins, so
  // that is what gets captured — labelled, rather than silently passing on
  // `main` and pretending to be the admin dashboard.
  {
    route: "/app/admin", state: "access-denied", expect: "main", auth: true,
    require: "main",
    note: "captured as a customer: /app/admin is admin-only, so this is the access-denied branch, not the user table",
  },
];

/** Animated scenarios — one BrowserContext each (see recordAnimation). */
GROUPS.videos = [
  {
    route: "/", viewport: "desktop", state: "scroll-reveal", expect: ".landing-navbar",
    description: "Continuous scroll from hero to footer, firing every Reveal",
    run: async (page) => {
      await page.waitForTimeout(600);
      const height = await page.evaluate(() => document.body.scrollHeight);
      const steps = 24;
      for (let i = 0; i <= steps; i += 1) {
        await page.evaluate((y) => window.scrollTo({ top: y, behavior: "instant" }), (height / steps) * i);
        await page.waitForTimeout(120);
      }
      await page.waitForTimeout(400);
    },
  },
  {
    route: "/", viewport: "desktop", state: "theme-toggle", expect: ".theme-toggle",
    description: "The theme crossfade: 220ms of every themed property at once",
    run: async (page) => {
      await page.waitForTimeout(500);
      await page.locator(".theme-toggle").click();
      await page.waitForTimeout(700);
      await page.locator(".theme-toggle").click();
      await page.waitForTimeout(700);
    },
  },
  {
    route: "/", viewport: "desktop", state: "hover-cards", expect: ".landing-navbar",
    description: "Card lift and link colour transitions on hover",
    run: async (page) => {
      const card = page.locator(".landing-card").first();
      await card.waitFor({ state: "attached", timeout: 5000 }).catch(() => {});
      for (const selector of [".landing-card", ".nav-group-trigger", ".theme-toggle"]) {
        await safeHover(page, selector, 2000);
        await page.waitForTimeout(500);
      }
    },
  },
  {
    route: "/", viewport: "desktop", state: "carousel", expect: ".screenshot-carousel",
    description: "Carousel auto-advance and dot navigation",
    run: async (page) => {
      await page
        .evaluate(() => {
          document.querySelector(".screenshot-carousel")?.scrollIntoView({ block: "center" });
        })
        .catch(() => {});
      await page.waitForTimeout(6000);
      const dots = page.locator(".carousel-dot");
      if (await dots.count()) {
        await dots.nth(1).click().catch(() => {});
        await page.waitForTimeout(1200);
        await dots.nth(2).click().catch(() => {});
        await page.waitForTimeout(1200);
      }
    },
  },
  {
    route: "/", viewport: "mobile", state: "hamburger", expect: ".navbar-toggle, .landing-navbar",
    description: "Mobile menu open, focus moved into it, Escape and focus back",
    run: async (page) => {
      const toggle = page.locator(".navbar-toggle, .landing-navbar button[aria-expanded]").first();
      await toggle.waitFor({ state: "attached", timeout: 5000 }).catch(() => {});
      if (await toggle.count()) {
        await toggle.click();
        await page.waitForTimeout(700);
        await page.keyboard.press("Escape");
        await page.waitForTimeout(700);
      }
    },
  },
  {
    route: "/app/documents", viewport: "desktop", state: "modal-open", expect: "main", auth: true,
    description: "PreviewModal open, focus trap, Escape close",
    run: async (page) => {
      await page
        .locator('.document-card:has-text("quarterly-report.txt") button[aria-label="Preview document"]')
        .first()
        .click();
      await page.locator(".modal-overlay").waitFor({ state: "attached", timeout: 12_000 });
      await page.waitForTimeout(800);
      await page.keyboard.press("Escape");
      await page.waitForTimeout(800);
    },
  },
  {
    route: "/app/documents", viewport: "desktop", state: "skeleton", expect: "main", auth: true,
    description: "Skeleton shimmer resolving into the real document list",
    run: async (page) => {
      // Reload with the network throttled enough that the loading state is
      // actually on screen — the whole point is to catch the shimmer.
      // "**/v1/documents" (no trailing slash) is the list request; the old
      // pattern only matched children of it, so the throttle never applied and
      // the skeleton was never on screen.
      await page.route("**/v1/documents**", async (route) => {
        await new Promise((resolve) => setTimeout(resolve, 2500));
        await route.continue();
      });
      await page.reload({ waitUntil: "domcontentloaded" });
      await page.waitForTimeout(900);
    },
  },
  {
    route: "/app/search", viewport: "desktop", state: "search-debounce", expect: "main", auth: true,
    description: "Keystroke-by-keystroke typing with the 300ms debounce and result swap",
    run: async (page) => {
      const input = page.locator("#search-query").first();
      await input.waitFor({ state: "attached", timeout: 8000 }).catch(() => {});
      if (!(await input.count())) return;
      await input.click();
      // Typed faster than the 300ms debounce on purpose: that is the point of a
      // debounce. Waiting the full window between characters would show one
      // request per keystroke and prove nothing about coalescing.
      await page.keyboard.type("quarterly revenue", { delay: 70 });
      await page.waitForTimeout(3000);
    },
  },
];

// Per-group viewport tier.
const GROUP_TIERS = {
  public: "full",
  legal: "full",
  landing: "wide",
  auth: "wide",
  app: "full",
  documents: "wide",
  search: "desktop",
  qa: "desktop",
  settings: "desktop",
  webhooks: "desktop",
  profile: "desktop",
  admin: "desktop",
};

// ─────────────────────────────────────────────────────────────────────────────
// Scenario execution
// ─────────────────────────────────────────────────────────────────────────────
/**
 * The element a scenario's `scrollTo` centres, if it has one.
 *
 * Shared by `applyScroll` and `waitForStablePage` so the thing being scrolled
 * to and the thing being waited on cannot be different elements.
 */
function settleSelector(scenario) {
  if (typeof scenario.scrollTo === "string" && scenario.scrollTo.startsWith("selector:")) {
    return scenario.scrollTo.slice("selector:".length);
  }
  return null;
}

/**
 * Wait until the page stops moving: the scroll position and the scenario's
 * target geometry must be identical on two consecutive animation frames.
 *
 * This is the general answer to "the capture is a snapshot of a transient
 * frame", and it was found by measurement rather than guessed. Two captures
 * that differ by a *single pixel* of scroll were being reported as 0.12% of the
 * image changing, and the billing toggle was captured at scrollY 508 in one run
 * and 509 in the next with identical code and identical DOM. The culprit is
 * `scrollIntoView({ block: "center" })`, which computes a fractional target and
 * lets the browser round it — so a half-pixel difference in the target's height
 * decides which integer the page lands on, and the shutter records whichever it
 * got.
 *
 * `settleVisuals` cannot catch this: it runs at load, when the page is at
 * scroll 0 and nothing has been interacted with yet. Everything that moves the
 * page happens after it.
 *
 * Returns false on timeout, and the caller reports the capture as skipped. A
 * page that genuinely never settles — an auto-advancing carousel with nothing
 * pinning it, say — is not a capture to take, it is a scenario to pin.
 */
async function waitForStablePage(page, scenario, { frames = 2, timeout = 3000 } = {}) {
  const selector = settleSelector(scenario);
  const ok = await page
    .waitForFunction(
      ({ sel, frames: need }) => {
        const el = sel ? document.querySelector(sel) : null;
        const rect = el?.getBoundingClientRect();
        // Rounded: sub-pixel jitter below a pixel is not visible in the capture,
        // so insisting on it would wait forever on a page that is otherwise fine.
        const key = [
          Math.round(window.scrollX),
          Math.round(window.scrollY),
          rect ? Math.round(rect.top) : null,
          rect ? Math.round(rect.height) : null,
          Math.round(document.body.scrollHeight),
        ].join(":");
        const seen = window.__auditStableKey;
        window.__auditStableKey = key;
        window.__auditStableHits = seen === key ? (window.__auditStableHits ?? 0) + 1 : 0;
        return window.__auditStableHits >= need;
      },
      { sel: selector, frames },
      { timeout, polling: "raf" },
    )
    .then(() => true)
    .catch(() => false);
  return ok;
}

/**
 * Put the page where the scenario says the photograph should be taken.
 *
 * The one place the framing of a capture is defined, so the `scrollTo` step and
 * `waitForStablePage` cannot end up centring different elements. A click that
 * finds its target outside the viewport does its own scroll in `clickAtPoint`,
 * because it has to: the framing has to be re-measured from the element's box.
 */
async function applyScroll(page, scenario, acts) {
  const label = "scrollTo";
  if (scenario.scrollTo === "bottom") {
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(500);
    acts.push({ action: label, to: "bottom" });
  } else if (scenario.scrollTo === "middle") {
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight / 2));
    await page.waitForTimeout(500);
    acts.push({ action: label, to: "middle" });
  } else if (settleSelector(scenario)) {
    const selector = settleSelector(scenario);
    // Scrolled from inside the page rather than with locator.scrollIntoViewIfNeeded:
    // Playwright waits for the target to be *stable*, and the carousel is
    // auto-advancing, so its box never settles and the action times out.
    //
    // The centring is computed here and rounded to a whole pixel rather than
    // delegated to `scrollIntoView({ block: "center" })`. That call computes a
    // fractional target and lets the browser round it, so a half-pixel
    // difference in the target's height — which image decode can produce — picks
    // the integer the page lands on, and two runs of identical code capture
    // scrollY 508 and 509. Measured as 0.12% of a capture's pixels changing, in
    // a band only 34px tall, which reads as a mysterious flicker in review.
    const found = await page.evaluate((sel) => {
      const el = document.querySelector(sel);
      if (!el) return false;
      const rect = el.getBoundingClientRect();
      const absoluteTop = rect.top + window.scrollY;
      const centred = absoluteTop - (window.innerHeight - rect.height) / 2;
      window.scrollTo(0, Math.round(centred));
      return true;
    }, selector);
    if (found) {
      await page.waitForTimeout(400);
      acts.push({ action: label, selector });
    } else {
      warn(`scrollTo target missing: ${selector}`);
    }
  }
}

/**
 * Click an element without letting Playwright choose where to scroll.
 *
 * `locator.click()` is the obvious way to do this and it is wrong for a
 * capture tool. Before clicking, it scrolls the target into view — and *where*
 * it scrolls to is not the audit's decision: it lands the element wherever its
 * actionability check decided, which is usually flush against the top of the
 * viewport rather than framed as the scenario asked. Whether it re-scrolls at
 * all depends on sampling the element's box over two consecutive frames, so it
 * is timing-dependent. Measured over six identical runs of `pricing-annual`,
 * four captured with the billing toggle at the viewport top (scrollY 3711) and
 * two centred (scrollY 3274) — 39% of the image differing between two runs of
 * the same code, with identical DOM.
 *
 * So the framing decision is made here, from geometry alone: an element already
 * inside the viewport is clicked where it is, and one that is not gets scrolled
 * to a rounded centred position. Either way the click is dispatched at measured
 * coordinates via `page.mouse`, which performs no scroll and no actionability
 * wait of its own.
 *
 * Dropping actionability is acceptable *because* every click in the audit is
 * verified by a post-condition instead of by the mechanism: a click that missed
 * leaves its post-condition unsatisfied and the capture is reported as skipped
 * rather than photographed. That is the trade #474 makes — verify the outcome,
 * not the mechanism.
 */
async function clickAtPoint(page, locator, { align = "centre" } = {}) {
  let box = await locator.boundingBox().catch(() => null);
  if (!box) return { clicked: false, reason: "no box" };

  const inView =
    box.y >= 0 && box.x >= 0 && box.y + box.height <= page.viewportSize().height &&
    box.x + box.width <= page.viewportSize().width;
  if (!inView) {
    await locator.evaluate((el) => {
      const r = el.getBoundingClientRect();
      const centred = r.top + window.scrollY - (window.innerHeight - r.height) / 2;
      window.scrollTo(0, Math.round(centred));
    });
    await page.waitForTimeout(250);
    box = await locator.boundingBox().catch(() => null);
    if (!box) return { clicked: false, reason: "no box after scroll" };
  }
  const x = align === "centre" ? box.x + box.width / 2 : box.x;
  const y = align === "centre" ? box.y + box.height / 2 : box.y;
  await page.mouse.click(x, y);
  return { clicked: true, point: { x: Math.round(x), y: Math.round(y) }, moved: !inView };
}

/**
 * Run a scenario's interactions, in the order `STEP_ORDER` fixes.
 *
 * Returns the actions performed and, when a step could not complete, a skip
 * reason. A skip means "do not photograph this": the capture would show
 * whatever state the page happened to be in, and a plausible wrong image is
 * worse than a missing one because pixel diffing would report it as a real
 * regression.
 */
async function applyInteraction(page, scenario) {
  const acts = [];

  /**
   * One entry per step. Each returns a skip reason — a string — when it cannot
   * complete, which ends the scenario: the capture would otherwise photograph
   * whatever state the page happened to be in. Returning `null` continues.
   *
   * The *order* these run in is not this object's property order. It comes from
   * `orderedStepKeys(scenario)`, so the declared order in ORDER_AFTER_ACT is the
   * one the audit performs.
   */
  const steps = {
    fill: async () => {
      for (const [selector, value] of Object.entries(scenario.fill)) {
        const locator = page.locator(selector).first();
        if (await locator.count()) {
          await locator.fill(value);
          acts.push({ action: "fill", selector, value: value.length > 8 ? `${value.slice(0, 4)}…` : value });
        } else {
          warn(`fill target missing: ${selector}`);
        }
      }
      return null;
    },
    check: async () => {
      const locator = page.locator(scenario.check).first();
      if (await locator.count()) {
        await locator.check();
        acts.push({ action: "check", selector: scenario.check });
      }
      return null;
    },
    scrollTo: async () => {
      await applyScroll(page, scenario, acts);
      return null;
    },
    click: async () => {
      const locator = page.locator(scenario.click).first();
      if (await locator.count()) {
        const res = await clickAtPoint(page, locator);
        if (!res.clicked) {
          warn(`click target unreachable: ${scenario.click} (${res.reason})`);
        } else {
          await page.waitForTimeout(450);
          acts.push({ action: "click", selector: scenario.click, ...res.point });
          if (scenario.clickAgain) {
            await clickAtPoint(page, locator);
            await page.waitForTimeout(450);
            acts.push({ action: "click", selector: scenario.click, note: "toggled back" });
          }
        }
      } else {
        warn(`click target missing: ${scenario.click}`);
      }
      return null;
    },
    hover: async () => {
      if (await safeHover(page, scenario.hover)) {
        await page.waitForTimeout(350);
        acts.push({ action: "hover", selector: scenario.hover });
      } else {
        warn(`hover target missing or unreachable: ${scenario.hover}`);
      }
      return null;
    },
    clickNth: async () => {
      // Click the nth match, then check the click actually took effect.
      const { selector, index, expectClass } = scenario.clickNth;
      const locator = page.locator(selector).nth(index);
      if (!(await locator.count())) {
        return describeSkip("missing", { selector, index, action: "clickNth" });
      }
      // Moving the mouse here is what stops the auto-advance: the component
      // clears its interval on mouseenter, so the hover both stops the motion
      // and leaves the pointer where a hover state needs it to be. A raw mouse
      // move rather than `hover()`, whose stability wait could never pass on
      // this target (see `clickAtPoint`).
      const box = await locator.boundingBox().catch(() => null);
      if (!box) {
        return describeSkip("missing", { selector, index, action: "clickNth" });
      }
      const cx = box.x + box.width / 2;
      const cy = box.y + box.height / 2;
      await page.mouse.move(cx, cy);
      await page.waitForTimeout(250);
      // The click goes through the same coordinate path as a plain `click`, so
      // it cannot scroll the carousel out from under the pointer that just
      // paused it. The measured consequence of letting Playwright do this: the
      // carousel's 1px scroll jitter, which the capture then records as a
      // change in a 34px-tall band of the dots.
      const res = await clickAtPoint(page, locator);
      if (!res.clicked) {
        return describeSkip("missing", { selector, index, action: "clickNth" });
      }
      acts.push({ action: "clickNth", selector, index });
      if (expectClass) {
        if (!checkClassExpectation(await locator.getAttribute("class"), expectClass)) {
          // Photographing here would capture whatever slide happened to be
          // showing, which is the flake this whole field exists to remove.
          return describeSkip("clickNth", { selector, index, action: "clickNth" }, expectClass);
        }
        acts.push({ action: "assertClass", selector, index, name: expectClass });
      }
      return null;
    },
    assertAttr: async () => {
      // Post-condition for an interaction whose effect is a state change rather
      // than a visible one. Asserting it turns a silent flake into a loud skip:
      // a click that landed before React attached its handler, or a re-render
      // that undid it, used to be photographed as if it had worked.
      const { selector, attr, value } = scenario.assertAttr;
      const satisfied = await page
        .waitForFunction(
          ({ sel, a, v }) => document.querySelector(sel)?.getAttribute(a) === v,
          buildAttrWaitArgs(selector, attr, value),
          { timeout: scenario.assertMs ?? 2500 },
        )
        .then(() => true)
        .catch(() => false);
      if (!satisfied) {
        return describeSkip("assertAttr", { selector }, { attr, value });
      }
      acts.push({ action: "assertAttr", selector, attr, value });
      return null;
    },
    settle: async () => {
      // Wait for the page to stop moving before the shutter opens. Nothing else
      // here scrolls or clicks, so this can safely run last.
      const settled = await waitForStablePage(page, scenario);
      acts.push({ action: "settle", stable: settled });
      if (!settled) {
        // Photographing a page that is still moving is how the audit ends up
        // disagreeing with itself: the capture is a snapshot of a transient
        // frame, and the next run photographs a different one.
        return describeSkip("unsettled", { selector: settleSelector(scenario) ?? "page" }, {});
      }
      return null;
    },
  };

  // A step implemented here but absent from ORDER_AFTER_ACT could never run, and
  // its scenario would be photographed as if it had. Fail loudly at the first
  // scenario instead of shipping a wrong image into the pixel baseline.
  const unreachable = unreachableStepKeys(Object.keys(steps));
  if (unreachable.length) {
    throw new Error(
      `applyInteraction implements step(s) that can never run: ${unreachable.join(", ")} ` +
        "— add them to ORDER_AFTER_ACT in audit-interactions.mjs",
    );
  }

  for (const key of orderedStepKeys(scenario)) {
    const skip = await steps[key]();
    if (skip) return { acts, skip };
  }
  return { acts, skip: null };
}
/**
 * Hover a selector, coping with targets that never stop moving.
 *
 * Playwright's `hover()` waits for the element to be *stable* — same check that
 * makes `scrollIntoViewIfNeeded` time out on the auto-advancing carousel. A real
 * hover on a moving target is still perfectly meaningful (it is what a user
 * moving a mouse over an animating carousel does), so on timeout this falls back
 * to moving the actual mouse to the element's current centre.
 */
async function safeHover(page, selector, timeout = 4000) {
  const locator = page.locator(selector).first();
  if (!(await locator.count())) return false;
  try {
    await locator.hover({ timeout });
    return true;
  } catch {
    const box = await locator.boundingBox().catch(() => null);
    if (!box) return false;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.waitForTimeout(250);
    return true;
  }
}

/**
 * One route × viewport × theme: load once, then every state for that route on
 * the same page. Reusing the page is both much faster and far kinder to the rate
 * limiter than reloading per state.
 */
async function runRouteGroup(audit, group, route, viewport, theme) {
  const scenarios = GROUPS[group].filter((s) => s.route === route);
  if (!scenarios.length) return;

  const vp = VIEWPORTS[viewport];
  const context = await audit.browser.newContext({
    viewport: { width: vp.width, height: vp.height },
    isMobile: vp.isMobile,
    hasTouch: vp.isMobile,
    deviceScaleFactor: 1,
    // #485: stills are photographed with reduced motion requested.
    //
    // `animations: "disabled"` in shot() cancels an infinite animation to its
    // *initial* state, but the compositor still rasterises that cancelled state
    // at a sub-pixel offset that depends on frame timing — a 0.55% band across
    // the element, with a byte-identical DOM. That made `carousel-hover` and
    // `desktop-light-hero` flaky at 0.55%, which is right at the edge of the
    // diff threshold, so the audit could not tell a real regression from noise.
    //
    // Forcing the media feature is stronger than cancelling animations: the
    // stylesheet's own `@media (prefers-reduced-motion: reduce)` rules apply,
    // so decorative drifts stop at their resting transform and JS that checks
    // `matchMedia` (CountUp, ScreenshotCarousel) takes its reduced-motion
    // branch too. The page lands on its settled state, which is both the
    // correct thing to photograph and a deterministic one.
    //
    // The video capture context above deliberately does NOT set this: recording
    // motion is that path's entire purpose, and reduced motion would leave it a
    // clip of a still page. Animation is verified by that WebM instead.
    reducedMotion: "reduce",
  });
  if (audit.auth) await injectAuth(context, audit.auth.token, theme);

  const needsAuth = scenarios.some((s) => s.auth);
  if (needsAuth && !audit.auth) {
    warn(`skipping authenticated ${route} — no session`);
    audit.addEntry({ route, viewport, theme, state: group, type: "screenshot", file: null, skipped: "no auth session" });
    await context.close();
    return;
  }

  let page = null;
  for (const scenario of scenarios) {
    // Each state starts from a clean load: a leftover open modal or scrolled
    // position from the previous state would make the next capture a lie.
    if (page) await page.close().catch(() => {});
    // Sampled BEFORE the navigation, not at shot() time: the 429 that starves a
    // page (a refused /auth/me, a refused /qa/models) lands during the load, so
    // counting from here is the only point at which the capture can tell "the
    // element is missing" from "the limiter took it away mid-load" (#535).
    const throttledBefore = audit.rateLimited.length;
    page = await audit.open(context, scenario.route, {
      theme,
      expect: scenario.expect,
      requireAuth: scenario.auth,
    });
    if (!page) {
      // open() already recorded the skip for this route+theme; stop trying the
      // remaining states — they would all fail the same way.
      break;
    }
    const { acts, skip } = await applyInteraction(page, scenario);
    if (skip) {
      // A scenario whose post-condition did not hold is reported, never
      // photographed: the image would look plausible and be wrong, and a
      // plausible wrong image is worse than a missing one because pixel
      // diffing would happily report it as a real regression.
      warn(`SKIP ${route} [${viewport}/${theme}] ${scenario.state}: ${skip}`);
      audit.addEntry({
        route: scenario.route,
        viewport,
        theme,
        state: scenario.state,
        type: "screenshot",
        file: null,
        skipped: skip,
      });
      continue;
    }
    await audit.shot(page, {
      throttledBefore,
      route: scenario.route,
      viewport,
      theme,
      state: scenario.state,
      dir: routeSlug(scenario.route),
      require: scenario.require,
      fullPage: scenario.fullPage ?? false,
      requireMs: scenario.requireMs ?? null,
      action: acts.length ? acts : null,
    });
    log(`  ${route} [${viewport}/${theme}] ${scenario.state}`);
  }

  if (page) await page.close().catch(() => {});
  await context.close();
}

async function runVideos(audit) {
  // Animations are theme-agnostic mechanics, so they are recorded once in the
  // light theme; theme-specific appearance is already covered by two full sets
  // of stills per route. The crossfade scenario clicks the toggle twice, so its
  // single recording contains both directions of the transition.
  for (const scenario of GROUPS.videos) {
    if (scenario.auth && !audit.auth) {
      warn(`skipping video ${scenario.state} — no session`);
      continue;
    }
    for (const theme of audit.opts.videoThemes ?? ["light"]) {
      await audit.recordAnimation({
        route: scenario.route,
        viewport: scenario.viewport,
        theme,
        state: scenario.state,
        dir: routeSlug(scenario.route),
        action: { action: "record", description: scenario.description },
        expect: scenario.expect,
        requireAuth: Boolean(scenario.auth),
        run: (page) => scenario.run(page, theme),
      });
      log(`  video ${scenario.route} [${scenario.viewport}/${theme}] ${scenario.state}`);
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Summary
// ─────────────────────────────────────────────────────────────────────────────
async function summarise(audit, { pruned, runDir, opts, elapsedMs }) {
  const entries = audit.manifest;
  const screenshots = entries.filter((e) => e.type === "screenshot");
  const videos = entries.filter((e) => e.type === "video");
  const skipped = entries.filter((e) => e.skipped);

  // Worst contrast and the smallest target, as numbers, since a human cannot
  // open 300 PNGs in one sitting.
  let worstContrast = null;
  // Small targets are split by WCAG 2.5.8's own excuses, so the headline
  // number is a real lead-list rather than 200 inline prose links.
  const smallTargets = new Map();
  const smallTargetsExcused = new Map();
  const overflow = [];
  const unlabelled = [];
  const navProblems = [];
  for (const entry of entries) {
    for (const failure of entry.probeDetail?.contrastFailures ?? []) {
      if (!worstContrast || failure.ratio < worstContrast.ratio) {
        worstContrast = { ...failure, where: `${entry.route} [${entry.viewport}/${entry.theme}] ${entry.state}` };
      }
    }
    for (const target of entry.probeDetail?.smallTargetsRaw ?? []) {
      if (target.excused) {
        smallTargetsExcused.set(target.excused, (smallTargetsExcused.get(target.excused) ?? 0) + 1);
        continue;
      }
      const key = `${target.tag}.${target.className || "(no class)"}`;
      smallTargets.set(key, (smallTargets.get(key) ?? 0) + 1);
    }
    if (entry.probe?.overflowPx > 0) {
      overflow.push({ where: `${entry.route} [${entry.viewport}/${entry.theme}] ${entry.state}`, px: entry.probe.overflowPx });
    }
    for (const item of entry.probeDetail?.unlabelled ?? []) {
      unlabelled.push({ where: `${entry.route} ${entry.state}`, ...item });
    }
    if (entry.probe && (entry.probe.mainCount !== 1 || entry.probe.h1Count > 1)) {
      navProblems.push({
        where: `${entry.route} [${entry.viewport}/${entry.theme}] ${entry.state}`,
        mainCount: entry.probe.mainCount,
        h1Count: entry.probe.h1Count,
      });
    }
  }

  const summary = {
    run: path.basename(runDir),
    runDir,
    baseUrl: opts.baseUrl,
    elapsedMs,
    budget: {
      limitMb: opts.budgetMb,
      writtenMb: Number((audit.budget.written / 1e6).toFixed(1)),
      exhausted: audit.budget.exhausted,
    },
    retention: { kept: opts.keepRuns, pruned: pruned.removed, reclaimedMb: Number((pruned.bytes / 1e6).toFixed(1)) },
    rateLimit: {
      sleptMs: audit.pacer.sleptMs,
      sleptWindows: audit.pacer.sleptWindows,
      reserve: audit.pacer.reserve,
      throttled: rateLimitFindings(audit.rateLimited),
    },
    auth: audit.auth ? { username: audit.auth.username } : { username: null },
    counts: {
      screenshots: screenshots.filter((e) => e.file).length,
      videos: videos.filter((e) => e.file).length,
      gifs: videos.filter((e) => e.format === "gif").length,
      skipped: skipped.length,
    },
    consoleErrors: audit.consoleErrors.length,
    pageErrors: audit.pageErrors.length,
    networkFailures: (() => {
      const counts = new Map();
      for (const f of audit.networkFailures) counts.set(f, (counts.get(f) ?? 0) + 1);
      return [...counts.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 15)
        .map(([what, count]) => ({ count, what: what.replace(BASE_URL, "") }));
    })(),
    // The messages, not just the tally: "29 console errors" is unactionable.
    consoleErrorDetail: [...new Set(audit.consoleErrors.map((e) => String(e).slice(0, 200)))].slice(0, 15),
    pageErrorDetail: [...new Set(audit.pageErrors.map((e) => String(e).slice(0, 200)))].slice(0, 10),
    worstContrast,
    smallTargetsExcused: [...smallTargetsExcused.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([kind, count]) => ({ kind, count })),
    smallTargetsTop: [...smallTargets.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([selector, count]) => ({ selector, count })),
    horizontalOverflow: overflow,
    unlabelled: unlabelled.slice(0, 20),
    landmarkProblems: navProblems,
    skips: skipped.map((e) => ({
      where: `${e.route ?? "?"} ${e.state ?? "?"}`,
      reason: e.skipped ?? e.error,
    })),
  };

  // Measured after the manifest is written, so the figure covers the whole run
  // directory rather than just the captures. (This was `dirSizeBytes(runDir)`
  // without an await, which put a Promise into arithmetic and printed NaN.)
  const dirBytes = await dirSizeBytes(runDir);
  summary.runDirMb = Number((dirBytes / 1e6).toFixed(1));
  return summary;
}

function printSummary(summary) {
  log("");
  log("── run ".padEnd(60, "─"));
  log(`run dir          ${summary.runDir} (${summary.runDirMb} MB)`);
  log(`elapsed          ${Math.round(summary.elapsedMs / 1000)}s`);
  log(
    `captures         ${summary.counts.screenshots} screenshots, ` +
      `${summary.counts.videos} videos (${summary.counts.gifs} gifs), ` +
      `${summary.counts.skipped} skipped`,
  );
  log(
    `budget           ${summary.budget.writtenMb} / ${summary.budget.limitMb} MB` +
      (summary.budget.exhausted ? "  EXHAUSTED" : ""),
  );
  if (summary.retention.pruned.length) {
    log(`pruned           ${summary.retention.pruned.join(", ")} (${summary.retention.reclaimedMb} MB reclaimed)`);
  }
  if (summary.rateLimit.sleptMs) log(`rate-limit wait  ${Math.round(summary.rateLimit.sleptMs / 1000)}s`);
  log(`auth             ${summary.auth.username ?? "none (authenticated routes skipped)"}`);
  log(`console errors   ${summary.consoleErrors}`);
  log(`page errors      ${summary.pageErrors}`);
  if (summary.worstContrast) {
    const w = summary.worstContrast;
    log(
      `worst contrast   ${w.ratio}:1 (needs ${w.required}) ${w.color} on ${w.background} ` +
        `@${w.fontSize}px — ${w.where}`,
    );
  }
  if (summary.smallTargetsTop.length) {
    log(
      "small targets    (lead-list, not a verdict: the inline-text and form-control " +
        "excuses are heuristic, so this can disagree with a human audit)",
    );
    for (const item of summary.smallTargetsTop) log(`                 ${item.count}× ${item.selector}`);
  }
  for (const item of summary.horizontalOverflow) log(`OVERFLOW         ${item.px}px — ${item.where}`);
  for (const item of summary.unlabelled) log(`UNLABELLED       ${item.tag}.${item.className} — ${item.where}`);
  for (const item of summary.landmarkProblems) {
    log(`LANDMARK         main=${item.mainCount} h1=${item.h1Count} — ${item.where}`);
  }
  for (const item of summary.skips) log(`SKIPPED          ${item.where}: ${item.reason}`);
  log("─".repeat(64));
}

// ─────────────────────────────────────────────────────────────────────────────
// main
// ─────────────────────────────────────────────────────────────────────────────
async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log(USAGE);
    return 0;
  }
  BASE_URL = opts.baseUrl.replace(/\/$/, "");

  // Screenshots must come from the container's baked Chromium. Refuse to run
  // against a host browser rather than quietly producing unreproducible images.
  if (!fs.existsSync("/opt/ms-playwright")) {
    console.error(
      "This tool must run inside the dev container, which has the baked headless\n" +
        "Chromium. Run it as:\n" +
        "  docker compose exec dev node scripts/audit.mjs\n",
    );
    return 2;
  }

  if (!Number.isFinite(opts.budgetMb) || opts.budgetMb <= 0) throw new Error("--budget-mb must be > 0");
  if (!Number.isInteger(opts.keepRuns) || opts.keepRuns < 1) throw new Error("--keep-runs must be >= 1");
  if (opts.gate && opts.only) {
    throw new Error("--gate cannot be combined with --only: the baseline describes a full pass (see --help)");
  }

  const playwright = await loadPlaywright();
  const { chromium } = playwright;
  log(`playwright       v${playwright.version ?? "?"} (${playwright.source}, chromium-${playwright.revision ?? "?"})`);

  // Retention first: prune before writing, so the budget applies to this run only.
  // The new run directory has not been created yet, so pruning to `keepRuns`
  // here left the previous `keepRuns` runs *plus* this one. Trim to keep-1
  // up front, then re-trim to keepRuns once this run is on disk.
  const pruned = await pruneOldRuns(opts.outRoot, Math.max(0, opts.keepRuns - 1));
  if (pruned.removed.length) {
    log(`pruned ${pruned.removed.length} old run(s), reclaimed ${(pruned.bytes / 1e6).toFixed(1)} MB`);
  }

  const runDir = path.join(opts.outRoot, timestampSlug());
  await fsp.mkdir(runDir, { recursive: true });
  const budget = new Budget(opts.budgetMb * 1e6);
  const pacer = new Pacer();
  currentPacer = pacer;

  const audit = new Audit(opts, { chromium, runDir, budget, pacer });
  const started = Date.now();

  log(`output           ${runDir}`);
  log(`budget           ${opts.budgetMb} MB, keeping ${opts.keepRuns} run(s)`);
  if (!ffmpegSupportsGif()) {
    // Said once, here, instead of one scary ffmpeg error per video.
    log(`gif              unsupported — the container's ffmpeg is Playwright's screencast build`);
    log(`                 (webm/image2 only, no gif muxer). WebM is kept for every`);
    log(`                 animation; see scripts/audit.mjs ffmpegSupportsGif().`);
  }

  // Backend availability decides whether authenticated routes exist at all.
  // The preflight in resolvePlaywright() checks the full chromium build; a launch
  // can still pick the headless shell, so a failure here is re-raised as the same
  // revision diagnosis instead of a raw Playwright banner over the run's output.
  try {
    audit.browser = await chromium.launch({ headless: !opts.headed });
  } catch (err) {
    throw launchFailure(playwright, err, {
      baked: installedBrowsers(BROWSERS_ROOT, (dir) => fs.readdirSync(dir)),
    });
  }
  try {
    const health = await fetch(`${BASE_URL}/v1/health`).catch(() => null);
    const backendUp = health && health.status < 500;
    log(`backend          ${backendUp ? "reachable" : "UNREACHABLE — authenticated routes will be skipped"}`);

    if (backendUp) {
      try {
        audit.auth = await createAuditUser();
        log(`audit user       ${audit.auth.username}`);
        const uploaded = await seedDocuments(audit.auth.token);
        const failed = uploaded.filter((u) => !u.ok);
        if (failed.length) warn(`seed uploads rejected: ${failed.map((f) => `${f.filename} (${f.status})`).join(", ")}`);
        log(`seeded           ${uploaded.filter((u) => u.ok).length}/${uploaded.length} documents; waiting for the worker`);
        const settled = await waitForProcessing(audit.auth.token, { quiet: true });
        log(`settled          ${describeSettleStates(settled)}`);
      } catch (err) {
        warn(`could not prepare fixtures (${err.message}); continuing without auth`);
        audit.auth = null;
      }
    }

    const groups = opts.only ?? Object.keys(GROUPS).filter((g) => g !== "videos");
    for (const group of groups) {
      if (!GROUPS[group]) throw new Error(`unknown group "${group}". Known: ${Object.keys(GROUPS).join(", ")}`);
      const routes = [...new Set(GROUPS[group].map((s) => s.route))];
      const viewports = TIER[GROUP_TIERS[group] ?? "desktop"];
      for (const viewport of viewports) {
        for (const theme of ["light", "dark"]) {
          log(`${group} — ${viewport}/${theme}`);
          for (const route of routes) {
            await runRouteGroup(audit, group, route, viewport, theme);
          }
        }
      }
    }

    if (!opts.only || opts.only.includes("videos")) {
      log("videos — desktop/mobile, both themes");
      await runVideos(audit);
    }
  } finally {
    await audit.dispose();
  }

  const summary = await summarise(audit, { pruned, runDir, opts, elapsedMs: Date.now() - started });
  // `summarise` returns the summary *without* the per-capture entries; they are
  // only attached here, for the manifest file. The gate needs them (contrast
  // failures are per-capture), so it gets the same document the file gets.
  const manifestDoc = { ...summary, entries: audit.manifest };
  const manifestPath = path.join(runDir, "audit-manifest.json");
  const summaryPath = path.join(runDir, "summary.json");
  await fsp.writeFile(manifestPath, JSON.stringify(manifestDoc, null, 2));
  await fsp.writeFile(summaryPath, JSON.stringify(summary, null, 2));

  // The reports are part of what a run puts on disk, so they count against the
  // budget like captures do — otherwise "500 MB" quietly excludes the files a
  // reviewer actually opens first.
  //
  // Charging them is not enough on its own: the summary already written carries
  // a captures-only figure, so the number in the file would disagree with the
  // one the console prints. Rewrite it to include the reports. That rewrite
  // changes the file again, so the size is settled over two passes and the
  // residual few bytes are not chased further — chasing them exactly would mean
  // solving for a fixed point of a file that contains its own byte count.
  const manifestBytes = (await fsp.stat(manifestPath)).size;
  const firstSummaryBytes = (await fsp.stat(summaryPath)).size;
  const baseBytes = audit.budget.written - firstSummaryBytes;
  const budgetFor = (reportBytes) => ({
    ...summary.budget,
    captureMb: Number((baseBytes / 1e6).toFixed(1)),
    reportsBytes: manifestBytes + reportBytes,
    writtenMb: Number(((baseBytes + manifestBytes + reportBytes) / 1e6).toFixed(1)),
  });
  await fsp.writeFile(summaryPath, JSON.stringify({ ...summary, budget: budgetFor(firstSummaryBytes) }, null, 2));
  const settledBytes = (await fsp.stat(summaryPath)).size;
  await fsp.writeFile(summaryPath, JSON.stringify({ ...summary, budget: budgetFor(settledBytes) }, null, 2));
  const finalSummaryBytes = (await fsp.stat(summaryPath)).size;
  audit.budget.charge(finalSummaryBytes - firstSummaryBytes);
  log(`reports          ${(manifestBytes / 1e3).toFixed(0)} KB manifest + ${(finalSummaryBytes / 1e3).toFixed(0)} KB summary`);
  const finalPrune = await pruneOldRuns(opts.outRoot, opts.keepRuns);
  if (finalPrune.removed.length) {
    log(`retention        trimmed ${finalPrune.removed.length} more, keeping ${opts.keepRuns}`);
  }
  printSummary({ ...summary, budget: budgetFor(finalSummaryBytes) });
  log(`manifest         ${path.join(runDir, "audit-manifest.json")}`);

  if (!opts.gate && !opts.updateBaseline && !opts.pixelBaseline && !opts.updatePixelBaseline) {
    return 0;
  }
  if (opts.gate || opts.updateBaseline) {
    const code = await runGate(manifestDoc, opts, runDir);
    if (code !== 0) return code;
  }
  if (opts.pixelBaseline || opts.updatePixelBaseline) {
    await runPixelDiff(opts, runDir);
  }
  return 0;
}

/**
 * Pixel diff: compare this run's captures against a baseline directory (#470).
 *
 * The comparator is built here rather than imported by `audit-pixels.mjs` so the
 * decision logic in that module stays pure and unit-testable without an image
 * decoder — this is the only part that needs `pngjs`/`pixelmatch`, and it is
 * verified by a live run rather than by the unit tests.
 *
 * Never fails the run. A pixel difference is machine-specific by construction, so
 * the exit code is not a useful signal here; the report is the output.
 */
async function runPixelDiff(opts, runDir) {
  const thresholds = parseThresholds({
    pixelTolerance: opts.pixelTolerance,
    changedRatio: opts.changedRatio,
  });
  const runFiles = await listCaptures(runDir);
  const runKeys = runFiles.map((abs) => keyFor(runDir, abs));

  // ── Promote this run to be the baseline ────────────────────────────────────
  if (opts.updatePixelBaseline) {
    // No default path on purpose. A pixel baseline is ~26 MB of
    // machine-specific binaries that must not be committed, so there is no
    // sensible in-repo default to fall back to — the caller has to say where it
    // goes. Defaulting to a path inside the repo would put 26 MB in a diff.
    if (!opts.pixelBaseline) {
      throw new Error(
        "--update-pixel-baseline needs --pixel-baseline=DIR to say where the baseline goes. " +
          "It is a local directory by design and is never committed — see issue #470.",
      );
    }
    const target = opts.pixelBaseline;
    if (fs.existsSync(target) && !fs.readdirSync(target).length) {
      log(`pixels           baseline ${target} exists but is empty — using it`);
    } else if (fs.existsSync(target)) {
      throw new Error(
        `--update-pixel-baseline would overwrite the existing baseline at ${target}. ` +
          "Delete it first if that is what you mean, or pass --pixel-baseline=DIR to pick another path.",
      );
    }
    await fsp.mkdir(target, { recursive: true });
    for (const abs of runFiles) {
      // Only the PNGs: the run directory also holds JSON reports and WebM
      // screencasts, and a baseline of videos would be gigabytes of scratch.
      const dest = path.join(target, keyFor(runDir, abs));
      await fsp.mkdir(path.dirname(dest), { recursive: true });
      await fsp.copyFile(abs, dest);
    }
    log(`pixels           baseline written ${target} (${runFiles.length} PNGs)`);
    log("pixels           not committed by design — see issue #470 for why");
    return;
  }

  const baselineDir = opts.pixelBaseline;
  if (!baselineDir) return;
  if (!fs.existsSync(baselineDir)) {
    throw new Error(
      `--pixel-baseline directory not found: ${baselineDir}. ` +
        "Create one with --update-pixel-baseline.",
    );
  }

  const baselineFiles = await listCaptures(baselineDir);
  const plan = planComparison(baselineFiles.map((abs) => keyFor(baselineDir, abs)), runKeys);
  log(`pixels           ${plan.pairs.length} capture(s) in both, ${plan.added.length} added, ${plan.removed.length} removed`);

  const { PNG } = await import("pngjs");
  const pixelmatch = (await import("pixelmatch")).default;
  const fspLocal = fsp;
  const diffDir = path.join(runDir, "diff");
  const results = {};

  for (const key of plan.pairs) {
    const load = async (root) => PNG.sync.read(await fspLocal.readFile(path.join(root, key)));
    const a = await load(baselineDir);
    const b = await load(runDir);
    if (a.width !== b.width || a.height !== b.height) {
      results[key] = classifyCapture(
        { widthA: a.width, heightA: a.height, widthB: b.width, heightB: b.height, changedPixels: 0, totalPixels: 0 },
        thresholds,
      );
      continue;
    }
    const diff = new PNG({ width: a.width, height: a.height });
    const changedPixels = pixelmatch(a.data, b.data, diff.data, a.width, a.height, {
      threshold: thresholds.pixelTolerance,
    });
    const scored = classifyCapture(
      { widthA: a.width, heightA: a.height, widthB: b.width, heightB: b.height, changedPixels, totalPixels: a.width * a.height },
      thresholds,
    );
    if (scored.verdict === "changed") {
      // Write a reviewable image: changed pixels at full strength over a
      // desaturated, dimmed original. A raw diff mask is technically the diff
      // and practically unreadable — you cannot tell *what* moved without the
      // original underneath it.
      const overlay = new PNG({ width: a.width, height: a.height });
      for (let i = 0; i < a.data.length; i += 4) {
        const j = i / 4;
        const isChanged = diff.data[j] === 255 && diff.data[j + 1] === 0;
        const grey = Math.round((b.data[i] * 0.299 + b.data[i + 1] * 0.587 + b.data[i + 2] * 0.114) * 0.35 + 191);
        overlay.data[i] = isChanged ? 255 : grey;
        overlay.data[i + 1] = isChanged ? 0 : grey;
        overlay.data[i + 2] = isChanged ? 60 : grey;
        overlay.data[i + 3] = 255;
      }
      const dest = path.join(diffDir, key);
      await fsp.mkdir(path.dirname(dest), { recursive: true });
      await fsp.writeFile(dest, PNG.sync.write(overlay));
      scored.diff = path.relative(runDir, dest);
    }
    results[key] = scored;
  }

  const report = buildReport({ plan, results, thresholds, baselineDir, runDir });
  const reportPath = path.join(runDir, "pixel-diff.json");
  await fsp.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  for (const line of formatReport(report)) log(line);
  log(`pixels           report ${reportPath}`);
  if (report.changed.length) {
    log("pixels           this is NOT a gate — a pixel difference here is machine-specific. Look at the diff/ images before believing one.");
  }
}

/**
 * The gate: compare this run's signals against the committed baseline and fail
 * on anything new.
 *
 * `--update-baseline` is the deliberate escape hatch — it accepts whatever this
 * run found and exits 0, which is why it never fails: reviewing the baseline
 * diff in the PR is what makes that safe, not the command itself.
 */
async function runGate(summary, opts, runDir) {
  // `opts.gate` is `false` when only --update-baseline was passed and an array
  // when --gate was, so this must be an Array.isArray check and not `??`:
  // `false ?? DEFAULT` yields `false`, and `new Set(false)` throws.
  const signals = Array.isArray(opts.gate) ? opts.gate : DEFAULT_GATE_SIGNALS;
  const findings = collectFindings(summary, signals);
  log(`gating           ${signals.join(", ")}`);

  // A missing baseline is read as an error, never as an empty baseline: a gate
  // that silently passes because its config is absent is the bug #469 fixes.
  let baselineDoc = null;
  if (fs.existsSync(opts.baselineFile)) {
    baselineDoc = parseBaseline(await fsp.readFile(opts.baselineFile, "utf8"));
  } else if (!opts.updateBaseline) {
    log(`baseline         MISSING ${opts.baselineFile}`);
  }
  const baselineFindings = baselineDoc ? baselineDoc.findings : null;

  const result = compareFindings(findings, baselineFindings);
  for (const line of formatComparison(result)) log(line);

  if (opts.updateBaseline) {
    const previous = new Set((baselineFindings ?? []).map((f) => f.key));
    const next = new Set(findings.map((f) => f.key));
    log(`baseline         +${[...next].filter((k) => !previous.has(k)).length} new, -${[...previous].filter((k) => !next.has(k)).length} resolved`);
    // Carry the file's own explanatory fields forward, so the note explaining
    // what this file is does not get deleted by the first --update-baseline.
    const { findings: _dropped, ...meta } = baselineDoc ?? {};
    await fsp.writeFile(opts.baselineFile, serializeBaseline(findings, { ...meta, updatedAt: new Date().toISOString() }));
    log(`baseline         written ${opts.baselineFile} — review this diff in the PR`);
    return 0;
  }

  for (const f of result.isNew) warn(`NEW ${f.signal}  ${f.where}${f.detail?.sample ? ` — "${f.detail.sample}"` : ""}`);

  const reportPath = path.join(runDir, "gate-report.json");
  await fsp.writeFile(
    reportPath,
    JSON.stringify(
      {
        signals,
        baseline: path.relative(process.cwd(), opts.baselineFile) || opts.baselineFile,
        status: result.status,
        counts: { isNew: result.isNew.length, known: result.known.length, changed: result.changed.length, resolved: result.resolved.length },
        isNew: result.isNew,
        changed: result.changed.map((f) => ({ ...f, previousFingerprint: (baselineFindings ?? []).find((b) => b.key === f.key)?.fingerprint })),
        resolved: result.resolved,
      },
      null,
      2,
    ),
  );
  log(`gate report      ${reportPath}`);

  // A missing baseline fails even when this run was clean: an unconfigured gate
  // is not a passing gate.
  if (result.status === "missing-baseline") {
    warn("cannot gate without a baseline. Create one with --update-baseline and commit scripts/audit-baseline.json");
    return 1;
  }
  if (result.isNew.length) {
    warn(`${result.isNew.length} new finding(s) — see above, or accept with --update-baseline`);
    return 1;
  }
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error("[audit] FAILED:", err.message);
    process.exit(1);
  });
