/**
 * Playwright resolution for the visual audit (#529).
 *
 * ## The bug this exists to prevent
 *
 * The audit is a one-off tool, so Playwright is installed **globally** in the dev
 * image and deliberately not declared in `scripts/package.json`. The image also
 * bakes the browser downloads (`/opt/ms-playwright/chromium-<rev>`) to match the
 * version it installed.
 *
 * The old resolver tried a bare `import("playwright")` first and only fell back to
 * `npm root -g` if that **import** threw. In the container an undeclared leftover
 * tree sits at `scripts/node_modules/playwright` (1.56.1, expecting
 * `chromium-1194`), which shadows the global install (1.63.0, expecting
 * `chromium-1243`). The import *succeeded* — it is the **launch** that failed,
 * because the browser revision was wrong — so the fallback was unreachable and
 * the whole audit died with a raw Playwright banner.
 *
 * ## The rule
 *
 * **A candidate is accepted only if its browser is actually on disk.** The
 * preference order is unchanged (a resolvable local install first, then the
 * global one), but preference is not the same thing as acceptance: a Playwright
 * that cannot launch is skipped in favour of one that can, and the reason each
 * candidate was rejected is what the error reports.
 *
 * Order was deliberately *not* reversed to "global first". A declared local
 * install is the legitimate reason to prefer a bare import, and a stale global
 * install is as real a hazard as a stale local one. Validating instead of
 * reordering fixes the observed failure without codifying a second guess.
 *
 * Everything the resolver touches is injected, so this is testable without a
 * browser, without `npm`, and without the image's Playwright.
 */

import path from "node:path";
import { fileURLToPath } from "node:url";

/** Where Playwright's browser downloads live inside the dev image. */
export const BROWSERS_ROOT = "/opt/ms-playwright";

/** A Playwright install that cannot launch, with the diagnosis attached. */
export class PlaywrightUnavailableError extends Error {
  constructor(message, { candidates = [], baked = [] } = {}) {
    super(message);
    this.name = "PlaywrightUnavailableError";
    this.candidates = candidates;
    this.baked = baked;
  }
}

/**
 * The browser revision a Playwright build expects, read from the path it reports.
 *
 * `/opt/ms-playwright/chromium-1243/chrome-linux64/chrome` → `1243`. Returns
 * `null` for anything else, so an unexpected layout degrades to "unknown" rather
 * than throwing — the number is a diagnostic, never a load-bearing one.
 */
export function browserRevision(executablePath) {
  if (typeof executablePath !== "string") return null;
  const match = executablePath.match(/chromium[^/]*-(\d+)/);
  return match ? Number(match[1]) : null;
}

/**
 * The chromium builds actually present in a browser cache directory.
 *
 * Names come back with the revisions because `chromium-1243` and
 * `chromium_headless_shell-1243` are one build serving different launch paths,
 * and the error message should say which of them is present.
 */
export function installedBrowsers(root, readdirSync) {
  let entries;
  try {
    entries = readdirSync(root);
  } catch {
    return [];
  }
  return entries
    .map((name) => ({ name, revision: browserRevision(`${root}/${name}`) }))
    .filter((entry) => entry.revision !== null)
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Whether a candidate's browser is on disk.
 *
 * The full chromium build is the precise test. A headless-shell-only install of
 * the same revision also satisfies a launch, and Playwright reports the full
 * build's path whether or not it will use it — so a same-revision headless shell
 * counts rather than failing a run that would have worked.
 */
export function browserIsPresent({ executablePath, readdirSync, existsSync, root }) {
  if (typeof executablePath === "string" && existsSync(executablePath)) return true;
  const wanted = browserRevision(executablePath);
  if (wanted === null) return false;
  return installedBrowsers(root, readdirSync).some(
    (entry) => entry.revision === wanted && entry.name.startsWith("chromium"),
  );
}

/** Read a package's version, or `null` if the manifest cannot be read or parsed. */
function readVersion(manifestPath, readFileSync) {
  try {
    return JSON.parse(readFileSync(manifestPath, "utf8")).version ?? null;
  } catch {
    return null;
  }
}

/**
 * The manifest describing whatever a bare `import("playwright")` resolves to.
 *
 * Walking up from this file finds the *shadowing* tree in the #529 case rather
 * than the global install, which is the point: the version reported has to
 * describe the install that was actually loaded.
 */
export function bareManifestPath(existsSync, fromUrl = import.meta.url) {
  let dir = path.dirname(fileURLToPath(fromUrl));
  for (let depth = 0; depth < 12; depth += 1) {
    const candidate = path.join(dir, "node_modules", "playwright", "package.json");
    if (existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return null;
}

/**
 * Find a Playwright that can actually launch a browser here.
 *
 * Returns `{ chromium, source, version, executablePath, revision }`, or throws a
 * {@link PlaywrightUnavailableError} naming every candidate tried, the revision
 * each wanted, and the revisions the image actually has.
 *
 * @param {object} deps
 * @param {(specifier: string) => Promise<object>} deps.importModule Import hook.
 * @param {(() => string) | string | null} deps.globalRoot The global npm root, as
 *   a value or a thunk; `null` (or a thunk that throws) when it is unavailable.
 * @param {(p: string) => boolean} deps.existsSync
 * @param {(p: string, encoding?: string) => string} deps.readFileSync
 * @param {(dir: string) => string[]} deps.readdirSync
 * @param {string} [deps.root] Browser cache directory.
 */
export async function resolvePlaywright({
  importModule,
  globalRoot,
  existsSync,
  readFileSync,
  readdirSync,
  root = BROWSERS_ROOT,
}) {
  // Resolved once, and a throwing thunk is simply "no global install": the local
  // import may still satisfy the run, so failing here would repeat the mistake
  // this module exists to remove.
  let globalRootDir = null;
  try {
    globalRootDir = (typeof globalRoot === "function" ? globalRoot() : globalRoot) || null;
  } catch {
    globalRootDir = null;
  }

  const sources = [
    {
      source: "local",
      describe: 'local install (import "playwright")',
      // A bare specifier, because that is what Node resolves against
      // node_modules — the whole point is to see what *this* directory loads.
      specifiers: ["playwright"],
      manifest: () => bareManifestPath(existsSync),
    },
  ];
  if (globalRootDir) {
    const base = path.join(globalRootDir, "playwright");
    sources.push({
      source: "global",
      describe: `global install (${globalRootDir})`,
      // Older Playwright builds ship no `index.mjs`, so the directory is tried
      // second rather than assumed.
      specifiers: [path.join(base, "index.mjs"), base],
      manifest: () => path.join(base, "package.json"),
    });
  }

  const tried = [];
  for (const candidate of sources) {
    let mod = null;
    let lastImportError = null;
    for (const specifier of candidate.specifiers) {
      try {
        mod = await importModule(specifier);
        lastImportError = null;
        break;
      } catch (err) {
        lastImportError = err.message;
      }
    }
    if (!mod) {
      tried.push({ ...candidate, error: `import failed: ${lastImportError}` });
      continue;
    }
    const chromium = mod?.chromium;
    if (!chromium || typeof chromium.executablePath !== "function") {
      tried.push({ ...candidate, error: "module exposes no chromium browser" });
      continue;
    }
    let executablePath;
    try {
      executablePath = chromium.executablePath();
    } catch (err) {
      tried.push({ ...candidate, error: `executablePath() failed: ${err.message}` });
      continue;
    }
    const row = {
      source: candidate.source,
      describe: candidate.describe,
      version: readVersion(candidate.manifest(), readFileSync),
      executablePath,
      revision: browserRevision(executablePath),
    };
    if (browserIsPresent({ executablePath, readdirSync, existsSync, root })) {
      return { chromium, ...row };
    }
    tried.push({ ...row, error: `browser not installed (${executablePath})` });
  }

  const baked = installedBrowsers(root, readdirSync);
  throw new PlaywrightUnavailableError(formatUnavailable(tried, baked, root), {
    candidates: tried,
    baked,
  });
}

/** The message a failed resolution reports — also the tail of a failed launch. */
export function formatUnavailable(tried, baked, root = BROWSERS_ROOT) {
  const rows = tried.length
    ? tried
        .map((row) => {
          const which = row.version ? `v${row.version}` : "version unknown";
          const wants = row.revision ? `wants chromium-${row.revision}` : "browser unknown";
          const from = row.describe ?? row.source ?? "resolved Playwright";
          return `  ${from.padEnd(32)} ${which.padEnd(16)} ${wants} — ${row.error ?? "unusable"}`;
        })
        .join("\n")
    : "  (no Playwright install was found at all)";
  const have = baked.length ? baked.map((entry) => entry.name).join(", ") : "(none)";
  return [
    "No usable Playwright: every install found expects a browser this image does not have.",
    "",
    rows,
    "",
    `Baked under ${root}: ${have}`,
    "",
    "This is a Playwright/browser *revision* mismatch, not a missing dependency:",
    "each Playwright build looks for the exact chromium revision it shipped with.",
    "Install the matching browser for the version you intend to use",
    "(`npx playwright install chromium` in that version's tree), or remove the",
    "stale install so a usable one is found. `make dev-build` rebuilds the image",
    "with the browsers its own Playwright expects.",
  ].join("\n");
}

/**
 * Re-raise a launch failure with the resolution that produced it.
 *
 * The preflight checks the full chromium build's path, but Playwright may launch
 * the headless shell instead — a different file of the same revision, and on a
 * partially provisioned image a different revision again. So the launch itself
 * stays wrapped: a mismatch has to surface as this diagnosis, not as a raw
 * Playwright banner over the tool's own output.
 */
export function launchFailure(resolution, err, { baked = [], root = BROWSERS_ROOT } = {}) {
  const which = `${resolution?.source ?? "resolved"} Playwright` +
    `${resolution?.version ? ` v${resolution.version}` : ""}` +
    `${resolution?.revision ? ` (expects chromium-${resolution.revision})` : ""}`;
  return new PlaywrightUnavailableError(
    `Chromium failed to launch with the ${which}: ${err.message}\n\n` +
      formatUnavailable([{ ...resolution, error: err.message }], baked, root),
    { candidates: [resolution], baked },
  );
}
