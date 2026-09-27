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
 * because a single pass is ~190 MB and an unpruned output directory is how a
 * visual audit quietly eats a disk. Note /tmp is not a mounted volume: a
 * container restart wipes the output, which is another reason to keep only a
 * shortlist.
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
 *    deliberately labelled: `smallTargetsRaw` does not apply WCAG 2.5.8's inline
 *    exception, and `contrastFailures` only covers solid backgrounds (see below).
 *    They are lead-lists for a human, not verdicts.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import process from "node:process";

// ─────────────────────────────────────────────────────────────────────────────
// Playwright resolution
//
// Playwright is installed globally in the dev image and is deliberately NOT a
// project dependency (the project uses Vitest; this is a one-off tool). So try a
// bare import first, then fall back to `npm root -g` — resolving that at runtime
// rather than hardcoding a path, because the image installs several Node
// versions side by side (`22`, `22.23.3`, `latest`, `lts`, ...).
// ─────────────────────────────────────────────────────────────────────────────
async function loadPlaywright() {
  try {
    return await import("playwright");
  } catch {
    /* fall through to the global install */
  }
  let globalRoot;
  try {
    globalRoot = execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim();
  } catch (err) {
    throw new Error(
      "Playwright not found, and `npm root -g` failed. Run this inside the dev " +
        `container (docker compose exec dev node scripts/audit.mjs). (${err.message})`,
    );
  }
  try {
    return await import(path.join(globalRoot, "playwright", "index.mjs"));
  } catch (err) {
    try {
      return await import(path.join(globalRoot, "playwright"));
    } catch {
      throw new Error(
        `Could not import Playwright from ${globalRoot}. ` +
          "The dev image ships it globally; rebuild with `make dev-build`. " +
          `(${err.message})`,
      );
    }
  }
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
  --headed           Run with a visible browser (debugging only)
  -h, --help         This message

GROUPS: public, landing, legal, auth, app, documents, search, qa, settings,
        webhooks, profile, admin, videos

KNOWN LIMITATIONS
  * GIF output needs an ffmpeg with a GIF muxer. The container ships
    Playwright's screencast build (webm/image2 only), so animations are
    recorded as WebM and the run says so once. See ffmpegSupportsGif().
  * The browser runs inside the container, where MinIO answers on minio:9000
    but presigned URLs are signed for localhost:9000 (correct for a browser on
    the host). Document thumbnails and download links therefore fail to load in
    these captures; every other image and style does.
  * The /app/admin capture is the access-denied branch: the fixture user is a
    customer and nothing in the public API can promote it to admin.
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
// - Small targets are a RAW count. WCAG 2.5.8 exempts targets inline in a
//   sentence, and applying that heuristic here would produce a list that
//   disagrees with the audited one. Named accordingly.
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

// ─────────────────────────────────────────────────────────────────────────────
// Rate-limit-aware pacing
//
// The limiter is per client IP, 100 requests per 60 s, and every response
// carries X-RateLimit-Remaining. Rather than hammer into a 429 (which makes
// /app/* silently redirect to /login, and an absent element then looks like a
// passing check), pace off the header and sleep out the window when it empties.
// ─────────────────────────────────────────────────────────────────────────────
class Pacer {
  constructor(windowSeconds = 60) {
    this.windowMs = windowSeconds * 1000;
    this.remaining = null;
    this.exhaustedAt = null;
    this.sleptMs = 0;
  }

  observe(headers) {
    const raw = headers["x-ratelimit-remaining"];
    if (raw === undefined) return;
    const value = Number(raw);
    if (!Number.isFinite(value)) return;
    this.remaining = value;
    if (value > 0) this.exhaustedAt = null;
  }

  async beforeRequest() {
    if (this.remaining === null || this.remaining > 0) return;
    if (this.exhaustedAt === null) this.exhaustedAt = Date.now();
    const elapsed = Date.now() - this.exhaustedAt;
    const wait = Math.max(0, this.windowMs - elapsed) + 500;
    if (wait > 1000) {
      warn(`rate limit reached — sleeping ${Math.round(wait / 1000)}s for the window`);
      this.sleptMs += wait;
      await sleep(wait);
    }
    this.remaining = null;
  }
}

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
    this.pageErrors = [];
  }

  // ── capture bookkeeping ────────────────────────────────────────────────
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
  async shot(page, { route, viewport, theme, state, dir, require: requireSelector, requireMs = null, fullPage = false, clipSelector = null, probe = true, action = null, note = null }) {
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
        warn(`SKIP ${route} [${viewport}/${theme}] ${state}: "${requireSelector}" not present`);
        this.addEntry({
          route, viewport, theme, state, type: "screenshot", file: null,
          skipped: `selector not present: ${requireSelector}`,
          note,
        });
        return false;
      }
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

    const buffer = clipSelector
      ? await page.locator(clipSelector).first().screenshot()
      : await page.screenshot({ fullPage });

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

    // The auth token has to be in place before the app's first script runs.
    if (this.auth) await injectAuth(context, this.auth.token, theme);

    let page = null;
    const started = Date.now();
    try {
      page = await context.newPage();
      wirePage(page, consoleErrors, pageErrors, this.networkFailures);
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
    wirePage(page, this.consoleErrors, this.pageErrors, this.networkFailures);
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
  await page.evaluate(() => document.fonts.ready).catch(() => {});
  await page
    .waitForFunction(() => [...document.images].every((img) => img.complete), null, { timeout: cap })
    .catch(() => {});
  // One frame for the compositor to flush the decoded assets.
  await page.waitForTimeout(120);
}

function wirePage(page, consoleErrors, pageErrors, networkFailures = []) {
  page.on("console", (msg) => {
    if (msg.type() === "error") consoleErrors.push(msg.text().slice(0, 300));
  });
  page.on("pageerror", (err) => pageErrors.push(String(err).slice(0, 300)));
  page.on("response", (res) => {
    // One hook for the pacer so every route's traffic counts, including XHR.
    if (res.headers()["x-ratelimit-remaining"] !== undefined) {
      currentPacer?.observe(res.headers());
    }
    // "28 console errors" is unactionable; the URL and status are the finding.
    if (res.status() >= 400) {
      networkFailures.push(`${res.status()} ${res.request().method()} ${res.url()}`);
    }
  });
  // A connection refused never produces a response, so it needs its own hook —
  // this is how an unreachable presigned-storage host shows up at all.
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
    route: "/", state: "pricing-annual", require: ".billing-toggle", expect: ".landing-navbar",
    scrollTo: "selector:.billing-toggle", click: '.billing-toggle [role="switch"]',
  },
  {
    route: "/", state: "pricing-monthly", require: ".billing-toggle", expect: ".landing-navbar",
    scrollTo: "selector:.billing-toggle",
  },
  {
    route: "/", state: "carousel-hover", require: ".screenshot-carousel", expect: ".landing-navbar",
    scrollTo: "selector:.screenshot-carousel", hover: ".carousel-dot",
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
async function applyInteraction(page, scenario) {
  const acts = [];
  if (scenario.fill) {
    for (const [selector, value] of Object.entries(scenario.fill)) {
      const locator = page.locator(selector).first();
      if (await locator.count()) {
        await locator.fill(value);
        acts.push({ action: "fill", selector, value: value.length > 8 ? `${value.slice(0, 4)}…` : value });
      } else {
        warn(`fill target missing: ${selector}`);
      }
    }
  }
  if (scenario.check) {
    const locator = page.locator(scenario.check).first();
    if (await locator.count()) {
      await locator.check();
      acts.push({ action: "check", selector: scenario.check });
    }
  }
  if (scenario.scrollTo === "bottom") {
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(500);
    acts.push({ action: "scrollTo", to: "bottom" });
  } else if (scenario.scrollTo === "middle") {
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight / 2));
    await page.waitForTimeout(500);
    acts.push({ action: "scrollTo", to: "middle" });
  } else if (typeof scenario.scrollTo === "string" && scenario.scrollTo.startsWith("selector:")) {
    const selector = scenario.scrollTo.slice("selector:".length);
    // Scrolled from inside the page rather than with locator.scrollIntoViewIfNeeded:
    // Playwright waits for the target to be *stable*, and the carousel is
    // auto-advancing, so its box never settles and the action times out.
    const found = await page.evaluate((sel) => {
      const el = document.querySelector(sel);
      if (!el) return false;
      el.scrollIntoView({ block: "center" });
      return true;
    }, selector);
    if (found) {
      await page.waitForTimeout(400);
      acts.push({ action: "scrollTo", selector });
    } else {
      warn(`scrollTo target missing: ${selector}`);
    }
  }
  if (scenario.click) {
    const locator = page.locator(scenario.click).first();
    if (await locator.count()) {
      await locator.click();
      await page.waitForTimeout(450);
      acts.push({ action: "click", selector: scenario.click });
      if (scenario.clickAgain) {
        await locator.click();
        await page.waitForTimeout(450);
        acts.push({ action: "click", selector: scenario.click, note: "toggled back" });
      }
    } else {
      warn(`click target missing: ${scenario.click}`);
    }
  }
  if (scenario.hover) {
    if (await safeHover(page, scenario.hover)) {
      await page.waitForTimeout(350);
      acts.push({ action: "hover", selector: scenario.hover });
    } else {
      warn(`hover target missing or unreachable: ${scenario.hover}`);
    }
  }
  return acts;
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
    const acts = await applyInteraction(page, scenario);
    await audit.shot(page, {
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
    rateLimit: { sleptMs: audit.pacer.sleptMs },
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
    log("small targets    (raw; WCAG 2.5.8's inline exception is NOT applied — lead-list, not a verdict)");
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

  const { chromium } = await loadPlaywright();

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
  const pacer = new Pacer(60);
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
  audit.browser = await chromium.launch({ headless: !opts.headed });
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
  const manifestPath = path.join(runDir, "audit-manifest.json");
  const summaryPath = path.join(runDir, "summary.json");
  await fsp.writeFile(manifestPath, JSON.stringify({ ...summary, entries: audit.manifest }, null, 2));
  await fsp.writeFile(summaryPath, JSON.stringify(summary, null, 2));

  // The reports are part of what a run puts on disk, so they count against the
  // budget like captures do — otherwise "500 MB" quietly excludes the files a
  // reviewer actually opens first. Measured after writing, and reported as the
  // authoritative on-disk figure alongside the capture-only total.
  const manifestBytes = (await fsp.stat(manifestPath)).size;
  const summaryBytes = (await fsp.stat(summaryPath)).size;
  audit.budget.charge(manifestBytes + summaryBytes);
  log(`reports          ${(manifestBytes / 1e3).toFixed(0)} KB manifest + ${(summaryBytes / 1e3).toFixed(0)} KB summary`);
  const finalPrune = await pruneOldRuns(opts.outRoot, opts.keepRuns);
  if (finalPrune.removed.length) {
    log(`retention        trimmed ${finalPrune.removed.length} more, keeping ${opts.keepRuns}`);
  }
  printSummary({ ...summary, budget: { ...summary.budget, writtenMb: Number((audit.budget.written / 1e6).toFixed(1)) } });
  log(`manifest         ${path.join(runDir, "audit-manifest.json")}`);

  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error("[audit] FAILED:", err.message);
    process.exit(1);
  });
