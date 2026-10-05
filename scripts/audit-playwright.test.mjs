/**
 * Unit tests for the audit's Playwright resolution (#529).
 *
 * The bug these pin: `import("playwright")` **succeeds** while the browser it
 * wants is absent, so a resolver that only falls back when the *import* throws
 * never reaches a working install. The invariant under test is therefore not
 * "local before global" — it is **never return a Playwright whose browser is not
 * on disk**, and when nothing qualifies, say which versions wanted which
 * revisions.
 *
 * The image's real shapes are used verbatim: 1.56.1 wanting `chromium-1194`
 * (undeclared leftover in `scripts/node_modules`) and 1.63.0 wanting
 * `chromium-1243` (the global install, matching the baked browsers).
 */

import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  BROWSERS_ROOT,
  PlaywrightUnavailableError,
  bareManifestPath,
  browserIsPresent,
  browserRevision,
  formatUnavailable,
  installedBrowsers,
  launchFailure,
  resolvePlaywright,
} from "./audit-playwright.mjs";

const GLOBAL_ROOT = "/opt/mise/data/installs/node/22.23.3/lib/node_modules";
const GLOBAL_SPECIFIER = `${GLOBAL_ROOT}/playwright/index.mjs`;

/** A Playwright stand-in reporting the path a real one would report. */
const fakePlaywright = (executablePath) => ({ chromium: { executablePath: () => executablePath } });

/**
 * Build the injected environment. `installs` maps a specifier to either a
 * Playwright stand-in or an Error to throw; `dirs` is the browser cache listing.
 */
const env = ({
  installs = {},
  manifests = {},
  present = [],
  dirs = ["chromium-1243", "chromium_headless_shell-1243", "ffmpeg-1011"],
  browsersRoot = BROWSERS_ROOT,
  globalRoot = GLOBAL_ROOT,
} = {}) => {
  const files = new Set(present);
  return {
    importModule: async (specifier) => {
      const found = installs[specifier];
      if (found instanceof Error) throw found;
      if (!found) throw new Error(`Cannot find module '${specifier}'`);
      return found;
    },
    globalRoot: globalRoot === null ? null : () => globalRoot,
    existsSync: (p) => files.has(p),
    readFileSync: (p) => {
      if (!(p in manifests)) throw new Error(`ENOENT: ${p}`);
      return manifests[p];
    },
    readdirSync: (dir) => {
      if (dir !== browsersRoot) throw new Error(`ENOENT: ${dir}`);
      return dirs;
    },
    root: browsersRoot,
  };
};

const STALE = fakePlaywright(`${BROWSERS_ROOT}/chromium-1194/chrome-linux/chrome`);
const FRESH = fakePlaywright(`${BROWSERS_ROOT}/chromium-1243/chrome-linux64/chrome`);

test("skips a local install whose browser revision is not baked, and uses the global one", async () => {
  // The reported #529 failure, reproduced exactly: the local import resolves, so
  // an import-only fallback would stop here and die at launch.
  const resolved = await resolvePlaywright(
    env({
      installs: { playwright: STALE, [GLOBAL_SPECIFIER]: FRESH },
      manifests: {
        [`${GLOBAL_ROOT}/playwright/package.json`]: JSON.stringify({ version: "1.63.0" }),
      },
      present: [`${BROWSERS_ROOT}/chromium-1243/chrome-linux64/chrome`],
    }),
  );

  assert.equal(resolved.source, "global");
  assert.equal(resolved.version, "1.63.0");
  assert.equal(resolved.revision, 1243);
  assert.equal(resolved.chromium, FRESH.chromium);
});

test("prefers a local install when its browser is present", async () => {
  // The declared-dependency case the preference order exists for: a stale global
  // install must not win over a local one that can actually launch.
  const local = fakePlaywright(`${BROWSERS_ROOT}/chromium-1243/chrome-linux64/chrome`);
  const resolved = await resolvePlaywright(
    env({
      installs: { playwright: local, [GLOBAL_SPECIFIER]: STALE },
      present: [`${BROWSERS_ROOT}/chromium-1243/chrome-linux64/chrome`],
    }),
  );

  assert.equal(resolved.source, "local");
  assert.equal(resolved.chromium, local.chromium);
});

test("accepts a revision that is present only as the headless shell", async () => {
  // Playwright reports the full build's path but may launch the shell; rejecting
  // a run that would have launched would be a false alarm.
  const resolved = await resolvePlaywright(
    env({
      installs: { playwright: STALE },
      dirs: ["chromium_headless_shell-1194", "ffmpeg-1011"],
      present: [`${BROWSERS_ROOT}/chromium_headless_shell-1194/chrome-linux/headless_shell`],
    }),
  );

  assert.equal(resolved.source, "local");
  assert.equal(resolved.revision, 1194);
});

test("resolves without a global install when the local one works", async () => {
  // The fallback is reachable: a `npm root -g` that fails must not matter.
  const resolved = await resolvePlaywright(
    env({
      installs: { playwright: STALE },
      present: [`${BROWSERS_ROOT}/chromium-1194/chrome-linux/chrome`],
      globalRoot: null,
    }),
  );

  assert.equal(resolved.source, "local");
});

test("throws a diagnosis naming every version, the revision each wanted, and what is baked", async () => {
  const error = await resolvePlaywright(
    env({
      installs: { playwright: STALE, [GLOBAL_SPECIFIER]: FRESH },
      manifests: {
        [`${GLOBAL_ROOT}/playwright/package.json`]: JSON.stringify({ version: "1.63.0" }),
      },
      present: [],
      dirs: ["chromium-9000", "chromium_headless_shell-9000"],
    }),
  ).then(
    () => null,
    (err) => err,
  );

  assert.ok(error instanceof PlaywrightUnavailableError, "should reject, not resolve");
  // Every row has to be actionable: version, wanted revision, and why.
  assert.match(error.message, /1\.63\.0/);
  assert.match(error.message, /chromium-1194/);
  assert.match(error.message, /browser not installed/);
  assert.match(error.message, /9000/, "should report what the image actually has");
  assert.equal(error.candidates.length, 2);
  // Compared as a set: the listing order is locale collation, not a contract.
  assert.deepEqual(new Set(error.baked.map((entry) => entry.name)), new Set([
    "chromium-9000",
    "chromium_headless_shell-9000",
  ]));
});

test("reports an unreadable version without failing the resolution", async () => {
  // The version is a diagnostic in the message, never a load-bearing input.
  const resolved = await resolvePlaywright(
    env({
      installs: { playwright: STALE },
      manifests: {},
      present: [`${BROWSERS_ROOT}/chromium-1194/chrome-linux/chrome`],
    }),
  );

  assert.equal(resolved.version, null);
  assert.equal(resolved.revision, 1194);
});

test("skips a module that imports but exposes no chromium", async () => {
  const resolved = await resolvePlaywright(
    env({
      installs: { playwright: { notChromium: true }, [GLOBAL_SPECIFIER]: FRESH },
      present: [`${BROWSERS_ROOT}/chromium-1243/chrome-linux64/chrome`],
    }),
  );

  assert.equal(resolved.source, "global");
});

test("a failed launch is re-raised as the same diagnosis, not a raw banner", async () => {
  const resolution = {
    source: "global",
    version: "1.63.0",
    revision: 1243,
    executablePath: `${BROWSERS_ROOT}/chromium-1243/chrome-linux64/chrome`,
  };
  const error = launchFailure(resolution, new Error("Executable doesn't exist at /x/headless_shell"), {
    baked: installedBrowsers(BROWSERS_ROOT, () => ["chromium-1243"]),
  });

  assert.ok(error instanceof PlaywrightUnavailableError);
  assert.match(error.message, /1\.63\.0/);
  assert.match(error.message, /chromium-1243/);
  assert.match(error.message, /Executable doesn't exist/);
});

test("when both installs are usable, the local one still wins", async () => {
  // The preference order is unchanged by this fix, and that is a decision worth
  // pinning: a declared local dependency outranks whatever the image ships. Only
  // an *unusable* install loses its place.
  const local = fakePlaywright(`${BROWSERS_ROOT}/chromium-1243/chrome-linux64/chrome`);
  const resolved = await resolvePlaywright(
    env({
      installs: { playwright: local, [GLOBAL_SPECIFIER]: FRESH },
      manifests: {
        [`${GLOBAL_ROOT}/playwright/package.json`]: JSON.stringify({ version: "1.63.0" }),
      },
      present: [
        `${BROWSERS_ROOT}/chromium-1243/chrome-linux64/chrome`,
        `${BROWSERS_ROOT}/chromium_headless_shell-1243/chrome-linux64/headless_shell`,
      ],
      dirs: ["chromium-1243", "chromium_headless_shell-1243"],
    }),
  );

  assert.equal(resolved.source, "local");
});

test("imports the global install by directory when it ships no index.mjs", async () => {
  // Older Playwright builds have no ESM entry; a hardcoded index.mjs would make
  // the global candidate unimportable and the error would read as "no install".
  const resolved = await resolvePlaywright(
    env({
      installs: { playwright: STALE, [`${GLOBAL_ROOT}/playwright`]: FRESH },
      manifests: {
        [`${GLOBAL_ROOT}/playwright/package.json`]: JSON.stringify({ version: "1.63.0" }),
      },
      present: [`${BROWSERS_ROOT}/chromium-1243/chrome-linux64/chrome`],
    }),
  );

  assert.equal(resolved.source, "global");
  assert.equal(resolved.version, "1.63.0");
});

test("a global root that cannot be resolved is not fatal when the local install works", async () => {
  // `npm root -g` failing used to be a hard error. It is only needed as a fallback.
  const resolved = await resolvePlaywright({
    ...env({
      installs: { playwright: STALE },
      present: [`${BROWSERS_ROOT}/chromium-1194/chrome-linux/chrome`],
    }),
    globalRoot: () => {
      throw new Error("npm: command not found");
    },
  });

  assert.equal(resolved.source, "local");
});

test("browserRevision reads the revision and refuses to invent one", () => {
  assert.equal(browserRevision(`${BROWSERS_ROOT}/chromium-1243/chrome-linux64/chrome`), 1243);
  assert.equal(browserRevision(`${BROWSERS_ROOT}/chromium_headless_shell-1194/chrome-linux/headless_shell`), 1194);
  assert.equal(browserRevision("/usr/bin/chromium"), null);
  assert.equal(browserRevision(undefined), null);
});

test("browserIsPresent is a disk question, not a version question", () => {
  const probe = (executablePath, present, dirs = []) =>
    browserIsPresent({
      executablePath,
      readdirSync: () => dirs,
      existsSync: (p) => present.includes(p),
      root: BROWSERS_ROOT,
    });

  assert.equal(probe(`${BROWSERS_ROOT}/chromium-1243/chrome-linux64/chrome`, [
    `${BROWSERS_ROOT}/chromium-1243/chrome-linux64/chrome`,
  ]), true);
  assert.equal(probe(`${BROWSERS_ROOT}/chromium-1194/chrome-linux/chrome`, []), false);
  // Same revision, different build name, still a browser that can launch.
  assert.equal(probe(`${BROWSERS_ROOT}/chromium-1243/chrome-linux64/chrome`, [], [
    "chromium_headless_shell-1243",
  ]), true);
  // A same-revision ffmpeg is not a browser.
  assert.equal(probe(`${BROWSERS_ROOT}/chromium-1243/chrome-linux64/chrome`, [], ["ffmpeg-1011"]), false);
});

test("installedBrowsers survives a missing cache directory", () => {
  assert.deepEqual(installedBrowsers("/nope", () => {
    throw new Error("ENOENT");
  }), []);
  assert.deepEqual(installedBrowsers("/nope", () => {
    throw new Error("ENOENT");
  }), [], "must not throw when the directory is absent");
});

test("bareManifestPath describes the tree a bare import would load", () => {
  // Walking up from this file finds scripts/node_modules, i.e. the shadowing
  // install in the #529 case, not the global one.
  const expected = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    "node_modules",
    "playwright",
    "package.json",
  );
  assert.equal(bareManifestPath((p) => p === expected), expected);
  assert.equal(bareManifestPath(() => false), null);
});

test("formatUnavailable says so when there was nothing to try", () => {
  const message = formatUnavailable([], []);
  assert.match(message, /no Playwright install was found/i);
  assert.match(message, /\(none\)/, "should say the cache is empty too");
});
