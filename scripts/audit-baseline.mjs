/**
 * Signal baseline for the visual audit (#469).
 *
 * The audit computes every signal a regression gate needs — contrast failures,
 * page errors, skips, horizontal overflow, unlabelled controls, landmark
 * problems — and then threw all of it away, returning 0 no matter what it
 * found. A run that caught a 1.67:1 contrast failure was indistinguishable from
 * a clean one to anything reading the exit code, so the tool could report a
 * regression but never *fail* one.
 *
 * This module is the comparison that was missing. It is deliberately pure and
 * browser-free — no Playwright, no filesystem, no clock — so it can be unit
 * tested (scripts/audit-baseline.test.mjs) and so the gate's behaviour is a
 * property of the data rather than of the environment.
 *
 * ## What a finding is
 *
 * A finding is one *thing that is wrong*, identified by a stable key. The key
 * deliberately excludes the measured values: if `.btn` fails contrast on the
 * pricing page, that is one finding whether the ratio is 1.67 or 4.2, and
 * retuning a colour must not look like a brand-new regression. Measured values
 * live in `fingerprint` instead, which is how "same finding, but it got worse"
 * is reported without inflating the new/resolved sets.
 *
 * ## Why the default signal list excludes console and network errors
 *
 * The audit's headless Chromium runs *inside* the dev container, and third-party
 * font CDNs are frequently unreachable from there. Every marketing page
 * therefore logs a request error that no user on the host ever sees. Gating on
 * console or network errors would fail on a known environment artifact, so they
 * stay report-only. `consoleErrors`/`networkFailures` are still in the summary.
 *
 * Document thumbnails used to be a second such artifact (#536): the object store
 * was addressed by a browser-facing URL that only resolved in one topology.
 * The API streams those bytes itself now, so this is the only known one.
 */

export const BASELINE_VERSION = 1;

/** Every signal the collector knows how to extract. */
export const KNOWN_SIGNALS = [
  "contrast",
  "page-errors",
  "skips",
  "overflow",
  "unlabelled",
  "landmarks",
  "rate-limited",
];

/**
 * What `--gate` fails on with no explicit list.
 *
 * `landmarks` is extracted but opt-in: a wrong `main`/`h1` count is a real
 * structural regression, but it is a different class of problem from the
 * rendering signals above and was not part of the issue's stated default.
 */
export const DEFAULT_GATE_SIGNALS = [
  "contrast",
  "page-errors",
  "skips",
  "overflow",
  "unlabelled",
  "rate-limited",
];

/** `where` string for an entry, matching the format the summary already prints. */
export function whereOf(entry) {
  return `${entry.route} [${entry.viewport}/${entry.theme}] ${entry.state}`;
}

/**
 * Parse a `--gate=` signal list.
 *
 * @param {string|undefined|null} raw comma list, or null/undefined for the default
 * @returns {string[]}
 */
export function parseGateSignals(raw) {
  if (raw === undefined || raw === null || raw === true) return [...DEFAULT_GATE_SIGNALS];
  const list = String(raw)
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  if (!list.length) throw new Error("--gate= needs at least one signal");
  const unknown = list.filter((s) => !KNOWN_SIGNALS.includes(s));
  if (unknown.length) {
    throw new Error(`--gate: unknown signal(s) ${unknown.join(", ")}. Known: ${KNOWN_SIGNALS.join(", ")}`);
  }
  return [...new Set(list)];
}

/**
 * Extract the requested signals from a run summary as normalised findings.
 *
 * Findings are deduplicated by key, keeping the worst instance of each as the
 * evidence: two elements of the same class on one page are one regression, and
 * a summary that counted them twice would overstate the damage.
 *
 * @param {object} summary an audit summary (or full manifest, which is a superset)
 * @param {string[]} signals
 * @returns {Array<{key: string, signal: string, where: string, fingerprint: string, detail: object}>}
 */
export function collectFindings(summary, signals = DEFAULT_GATE_SIGNALS) {
  const want = new Set(signals);
  const byKey = new Map();

  const push = (signal, where, discriminator, fingerprint, detail) => {
    const key = `${signal}|${where}|${discriminator}`;
    const existing = byKey.get(key);
    // Keep the worst evidence for a repeated key. Lower contrast ratio is worse;
    // for the other signals the first sighting is as good as any.
    if (existing && Number(existing.fingerprint) <= Number(fingerprint)) return;
    byKey.set(key, { key, signal, where, fingerprint, detail });
  };

  if (want.has("contrast")) {
    // Contrast failures live on the per-capture entries, not on the summary, so
    // a caller that passes the summary alone would collect zero of them and the
    // gate would pass on a run that found real failures. That is precisely the
    // silent-pass this comparison exists to prevent, so it is an error, not an
    // empty list.
    if (!Array.isArray(summary.entries)) {
      throw new Error(
        "collectFindings: the contrast signal needs summary.entries — pass the manifest " +
          "(summary + entries), not the bare summary",
      );
    }
    for (const entry of summary.entries) {
      for (const f of entry.probeDetail?.contrastFailures ?? []) {
        push(
          "contrast",
          whereOf(entry),
          `${f.tag}|${f.className}|${f.required}`,
          String(f.ratio),
          {
            ratio: f.ratio,
            required: f.required,
            color: f.color,
            background: f.background,
            fontSize: f.fontSize,
            weight: f.weight,
            sample: f.sample,
          },
        );
      }
    }
  }

  if (want.has("overflow")) {
    for (const item of summary.horizontalOverflow ?? []) {
      push("overflow", item.where, "overflow", String(item.px), { px: item.px });
    }
  }

  if (want.has("unlabelled")) {
    for (const item of summary.unlabelled ?? []) {
      push("unlabelled", item.where, `${item.tag}|${item.className}`, "", {});
    }
  }

  if (want.has("landmarks")) {
    for (const item of summary.landmarkProblems ?? []) {
      push("landmarks", item.where, "landmark", `${item.mainCount}/${item.h1Count}`, {
        mainCount: item.mainCount,
        h1Count: item.h1Count,
      });
    }
  }

  if (want.has("skips")) {
    for (const item of summary.skips ?? []) {
      push("skips", item.where, String(item.reason ?? ""), "", {});
    }
  }

  if (want.has("rate-limited")) {
    // A 429 is the tool starving itself, never a UI regression. It gets its own
    // signal so it can never be filed under `skips` as a missing element, which
    // is exactly the misdiagnosis #535 was opened for. Keyed on method+path so
    // three 429s on one endpoint is one finding with a count of 3.
    for (const item of summary.rateLimit?.throttled ?? []) {
      push("rate-limited", "page", item.what, String(item.count), { count: item.count });
    }
  }

  if (want.has("page-errors")) {
    for (const message of summary.pageErrorDetail ?? []) {
      push("page-errors", "page", String(message), "", {});
    }
  }

  return [...byKey.values()].sort((a, b) => a.key.localeCompare(b.key));
}

/**
 * Compare this run's findings against the baseline.
 *
 * A `null` baseline is reported as its own status rather than treated as an
 * empty baseline: a gate that cannot find its baseline must fail loudly, not
 * pass everything, because that is precisely the failure mode #469 fixes.
 *
 * @param {Array} findings from {@link collectFindings}
 * @param {Array|null} baseline findings, or null when no baseline exists
 */
export function compareFindings(findings, baseline) {
  if (baseline === null) {
    return {
      status: "missing-baseline",
      isNew: [...findings],
      known: [],
      changed: [],
      resolved: [],
    };
  }
  const baseMap = new Map(baseline.map((f) => [f.key, f]));
  const runKeys = new Set(findings.map((f) => f.key));
  const known = findings.filter((f) => baseMap.has(f.key));
  return {
    status: "ok",
    isNew: findings.filter((f) => !baseMap.has(f.key)),
    known,
    // Known findings whose measured value moved: the same element still failing,
    // but at a different severity. Informational, never a gate failure.
    changed: known.filter((f) => String(f.fingerprint ?? "") !== String(baseMap.get(f.key).fingerprint ?? "")),
    resolved: baseline.filter((f) => !runKeys.has(f.key)),
  };
}

/**
 * Parse and validate a baseline file.
 *
 * Throws with an actionable message on anything malformed. A silently-accepted
 * broken baseline is a gate that stops gating.
 *
 * @param {string} text file contents
 */
export function parseBaseline(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch (err) {
    throw new Error(`baseline is not valid JSON: ${err.message}`);
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new Error("baseline must be a JSON object");
  }
  if (data.version !== BASELINE_VERSION) {
    throw new Error(
      `unsupported baseline version ${JSON.stringify(data.version)} (this tool understands ${BASELINE_VERSION})`,
    );
  }
  if (!Array.isArray(data.findings)) {
    throw new Error('baseline "findings" must be an array');
  }
  data.findings.forEach((f, i) => {
    if (!f || typeof f.key !== "string" || !f.key) {
      throw new Error(`baseline findings[${i}] is missing a string "key"`);
    }
    if (typeof f.signal !== "string" || !f.signal) {
      throw new Error(`baseline findings[${i}] is missing a string "signal"`);
    }
  });
  // Unknown top-level fields are preserved: the baseline is a reviewed artefact
  // and a future `note` or `updatedAt` must survive a read/write round trip.
  return { ...data, version: data.version, findings: data.findings };
}

/**
 * Render a baseline file.
 *
 * Only the key, signal, where and fingerprint are persisted. The heavy `detail`
 * (colours, font sizes, text samples) is recomputed on every run and would make
 * the baseline a noisy diff for no gain; the fingerprint preserves the accepted
 * severity so `--update-baseline` diffs stay reviewable.
 */
export function serializeBaseline(findings, meta = {}) {
  const payload = {
    version: BASELINE_VERSION,
    ...meta,
    findings: findings
      .map((f) => ({
        key: f.key,
        signal: f.signal,
        where: f.where,
        fingerprint: String(f.fingerprint ?? ""),
      }))
      .sort((a, b) => a.key.localeCompare(b.key)),
  };
  return `${JSON.stringify(payload, null, 2)}\n`;
}

/** Human-readable lines describing a comparison. */
export function formatComparison(result) {
  const lines = [];
  const bySignal = (list) => {
    const counts = new Map();
    for (const f of list) counts.set(f.signal, (counts.get(f.signal) ?? 0) + 1);
    return [...counts.entries()].map(([signal, n]) => `${n} ${signal}`).join(", ") || "none";
  };
  if (result.status === "missing-baseline") {
    lines.push(`GATE             cannot gate: no baseline. ${result.isNew.length} finding(s) this run.`);
    lines.push("                 create one with --update-baseline and commit the result.");
    return lines;
  }
  lines.push(`GATE             new ${result.isNew.length} (${bySignal(result.isNew)})`);
  lines.push(`GATE             known ${result.known.length}   resolved ${result.resolved.length}`);
  if (result.changed.length) lines.push(`GATE             known but changed: ${bySignal(result.changed)}`);
  return lines;
}
