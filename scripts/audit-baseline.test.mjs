/**
 * Unit tests for the audit's signal baseline (#469).
 *
 * Runs on the bare Node test runner rather than vitest: this module lives in
 * scripts/ next to the tool it serves, and nothing in frontend/ imports it.
 * Wired into `npm test` so it runs with the rest of the JS gate (and therefore
 * under `make check` and CI) — see frontend/package.json.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  BASELINE_VERSION,
  DEFAULT_GATE_SIGNALS,
  KNOWN_SIGNALS,
  collectFindings,
  compareFindings,
  formatComparison,
  parseBaseline,
  parseGateSignals,
  serializeBaseline,
  whereOf,
} from "./audit-baseline.mjs";

/** A capture entry as the audit records it. */
const entry = (over = {}) => ({
  route: "/pricing",
  viewport: "desktop",
  theme: "light",
  state: "initial",
  type: "screenshot",
  file: "pricing/desktop-light-initial.png",
  probeDetail: {
    contrastFailures: [],
    unlabelled: [],
  },
  ...over,
});

/** A contrast failure as the probe records it. */
const contrast = (over = {}) => ({
  ratio: 1.67,
  required: 4.5,
  color: "rgb(255, 255, 255)",
  background: "rgb(30, 64, 175)",
  fontSize: 12,
  weight: 400,
  sample: "Get started",
  tag: "span",
  className: "cta-sub",
  ...over,
});

// ── whereOf ──────────────────────────────────────────────────────────────────

test("whereOf matches the format the audit summary prints", () => {
  assert.equal(whereOf(entry()), "/pricing [desktop/light] initial");
});

// ── parseGateSignals ─────────────────────────────────────────────────────────

test("parseGateSignals defaults when no value is given", () => {
  assert.deepEqual(parseGateSignals(undefined), DEFAULT_GATE_SIGNALS);
  assert.deepEqual(parseGateSignals(null), DEFAULT_GATE_SIGNALS);
  assert.deepEqual(parseGateSignals(true), DEFAULT_GATE_SIGNALS);
});

test("parseGateSignals trims, lowercases and dedupes", () => {
  assert.deepEqual(parseGateSignals(" Contrast , overflow ,contrast "), ["contrast", "overflow"]);
});

test("parseGateSignals rejects an empty list and unknown signals", () => {
  assert.throws(() => parseGateSignals(""), /at least one signal/);
  assert.throws(() => parseGateSignals(",,"), /at least one signal/);
  assert.throws(() => parseGateSignals("contrast,nope"), /unknown signal\(s\) nope/);
  assert.throws(() => parseGateSignals("contrast,nope"), new RegExp(KNOWN_SIGNALS.join(", ")));
});

test("parseGateSignals accepts every known signal", () => {
  assert.deepEqual(parseGateSignals(KNOWN_SIGNALS.join(",")), KNOWN_SIGNALS);
});

// ── collectFindings ──────────────────────────────────────────────────────────

test("collectFindings returns nothing for a clean summary", () => {
  const summary = { entries: [entry()], horizontalOverflow: [], unlabelled: [], skips: [], pageErrorDetail: [] };
  assert.deepEqual(collectFindings(summary, DEFAULT_GATE_SIGNALS), []);
});

test("collectFindings keys a contrast failure on the element, not the ratio", () => {
  const a = collectFindings({ entries: [entry({ probeDetail: { contrastFailures: [contrast()] } })] }, ["contrast"]);
  const b = collectFindings(
    { entries: [entry({ probeDetail: { contrastFailures: [contrast({ ratio: 4.2, background: "rgb(1, 2, 3)" })] } })] },
    ["contrast"],
  );
  // Retuning the colour must not read as a different finding.
  assert.equal(a[0].key, b[0].key);
  assert.equal(a[0].signal, "contrast");
  assert.equal(a[0].where, "/pricing [desktop/light] initial");
  assert.equal(a[0].fingerprint, "1.67");
  assert.equal(b[0].fingerprint, "4.2");
});

test("collectFindings distinguishes elements that differ in tag, class or required level", () => {
  const one = (c) => collectFindings({ entries: [entry({ probeDetail: { contrastFailures: [c] } })] }, ["contrast"])[0].key;
  assert.notEqual(one(contrast()), one(contrast({ className: "other" })));
  assert.notEqual(one(contrast()), one(contrast({ tag: "p" })));
  assert.notEqual(one(contrast()), one(contrast({ required: 3 })));
});

test("collectFindings deduplicates a repeated key and keeps the worst evidence", () => {
  const findings = collectFindings(
    {
      entries: [
        entry({
          probeDetail: {
            contrastFailures: [contrast({ ratio: 4.1 }), contrast({ ratio: 1.67, fontSize: 14 })],
          },
        }),
      ],
    },
    ["contrast"],
  );
  assert.equal(findings.length, 1);
  assert.equal(findings[0].fingerprint, "1.67");
  assert.equal(findings[0].detail.fontSize, 14);
});

test("collectFindings extracts the other signals with the shapes the summary uses", () => {
  const findings = collectFindings(
    {
      entries: [],
      horizontalOverflow: [{ where: "/app/documents [mobile/light] initial", px: 480 }],
      unlabelled: [{ where: "/app/documents initial", tag: "button", className: "icon" }],
      landmarkProblems: [{ where: "/pricing [desktop/light] initial", mainCount: 0, h1Count: 2 }],
      skips: [{ where: "/app/search initial", reason: "expect(selector) failed" }],
      pageErrorDetail: ["TypeError: x is not a function"],
    },
    KNOWN_SIGNALS,
  );
  const bySignal = Object.fromEntries(findings.map((f) => [f.signal, f]));
  assert.equal(findings.length, 5);
  assert.equal(bySignal.overflow.fingerprint, "480");
  assert.equal(bySignal.overflow.detail.px, 480);
  assert.equal(bySignal.unlabelled.key, "unlabelled|/app/documents initial|button|icon");
  assert.equal(bySignal.landmarks.fingerprint, "0/2");
  assert.equal(bySignal.skips.key, "skips|/app/search initial|expect(selector) failed");
  assert.equal(bySignal["page-errors"].key, "page-errors|page|TypeError: x is not a function");
});

test("collectFindings only collects the requested signals", () => {
  const summary = {
    entries: [entry({ probeDetail: { contrastFailures: [contrast()] } })],
    horizontalOverflow: [{ where: "w", px: 1 }],
    unlabelled: [{ where: "w", tag: "a", className: "" }],
    landmarkProblems: [{ where: "w", mainCount: 2, h1Count: 0 }],
    skips: [{ where: "w", reason: "r" }],
    pageErrorDetail: ["boom"],
  };
  assert.deepEqual(collectFindings(summary, ["overflow"]).map((f) => f.signal), ["overflow"]);
  assert.deepEqual(collectFindings(summary, []), []);
});

test("collectFindings tolerates a summary with no entries array when contrast is not requested", () => {
  assert.deepEqual(collectFindings({ horizontalOverflow: [{ where: "w", px: 1 }] }, ["overflow"]).length, 1);
  assert.deepEqual(collectFindings({}, ["overflow", "skips", "unlabelled", "landmarks", "page-errors"]), []);
});

test("collectFindings refuses a summary with no entries array when contrast is requested", () => {
  // summarise() returns the summary *without* per-capture entries. Collecting
  // contrast from that shape yields zero findings and the gate passes on a run
  // that found real failures, so it has to be an error.
  assert.throws(() => collectFindings({}, ["contrast"]), /needs summary\.entries/);
  assert.throws(() => collectFindings({}, KNOWN_SIGNALS), /needs summary\.entries/);
  assert.throws(() => collectFindings({ entries: null }, ["contrast"]), /needs summary\.entries/);
  // ...and it still works when the entries are there.
  assert.equal(
    collectFindings({ entries: [entry({ probeDetail: { contrastFailures: [contrast()] } })] }, ["contrast"]).length,
    1,
  );
});

test("collectFindings output is sorted, so a report diffs cleanly", () => {
  const findings = collectFindings(
    { entries: [], horizontalOverflow: [{ where: "z", px: 1 }, { where: "a", px: 2 }] },
    ["overflow"],
  );
  assert.deepEqual(findings.map((f) => f.where), ["a", "z"]);
});

// ── compareFindings ──────────────────────────────────────────────────────────

test("compareFindings fails the run on a finding absent from the baseline", () => {
  const run = collectFindings({ entries: [entry({ probeDetail: { contrastFailures: [contrast()] } })] }, ["contrast"]);
  const result = compareFindings(run, []);
  assert.equal(result.status, "ok");
  assert.equal(result.isNew.length, 1);
  assert.equal(result.known.length, 0);
  assert.equal(result.resolved.length, 0);
});

test("compareFindings does not fail on a finding the baseline already accepts", () => {
  const run = collectFindings({ entries: [entry({ probeDetail: { contrastFailures: [contrast()] } })] }, ["contrast"]);
  const result = compareFindings(run, run);
  assert.equal(result.isNew.length, 0);
  assert.equal(result.known.length, 1);
  assert.equal(result.resolved.length, 0);
});

test("compareFindings reports a finding that disappeared so the baseline can be pruned", () => {
  const run = collectFindings({ entries: [] }, ["contrast"]);
  const result = compareFindings(run, [
    { key: "contrast|/pricing [desktop/light] initial|span|cta-sub|4.5", signal: "contrast", fingerprint: "1.67" },
  ]);
  assert.equal(result.resolved.length, 1);
  assert.equal(result.isNew.length, 0);
});

test("compareFindings flags a known finding whose severity moved, without failing it", () => {
  const worse = collectFindings(
    { entries: [entry({ probeDetail: { contrastFailures: [contrast({ ratio: 1.67 })] } })] },
    ["contrast"],
  );
  const result = compareFindings(worse, [
    { key: worse[0].key, signal: "contrast", fingerprint: "3.9" },
  ]);
  assert.equal(result.isNew.length, 0);
  assert.equal(result.known.length, 1);
  assert.equal(result.changed.length, 1);
  assert.equal(result.changed[0].fingerprint, "1.67");
});

test("compareFindings reports a missing baseline instead of passing everything", () => {
  const run = collectFindings({ entries: [] }, ["contrast"]);
  const result = compareFindings(run, null);
  assert.equal(result.status, "missing-baseline");
  assert.deepEqual(result.isNew, run);
  // A missing baseline is a failure even when this run found nothing: the gate
  // is unconfigured, which is not the same as the gate passing.
  assert.equal(result.known.length, 0);
});

test("compareFindings treats a missing fingerprint as equal to an empty one", () => {
  // An unlabelled finding carries an empty fingerprint; a baseline record that
  // omits the field entirely must compare equal, not as a change.
  const run = collectFindings({ unlabelled: [{ where: "w", tag: "button", className: "icon" }] }, ["unlabelled"]);
  const result = compareFindings(run, [{ key: run[0].key, signal: "unlabelled" }]);
  assert.equal(result.changed.length, 0);
  assert.equal(result.known.length, 1);
});

test("compareFindings flags a known finding whose measured value differs from the baseline", () => {
  const run = collectFindings({ horizontalOverflow: [{ where: "w", px: 5 }] }, ["overflow"]);
  const result = compareFindings(run, [{ key: run[0].key, signal: "overflow" }]);
  assert.equal(result.changed.length, 1);
  assert.equal(result.isNew.length, 0);
});

// ── parseBaseline ────────────────────────────────────────────────────────────

test("parseBaseline accepts a well-formed baseline", () => {
  const parsed = parseBaseline(serializeBaseline([{ key: "k", signal: "contrast", where: "w", fingerprint: "1.6", detail: {} }]));
  assert.equal(parsed.version, BASELINE_VERSION);
  assert.equal(parsed.findings.length, 1);
  assert.equal(parsed.findings[0].key, "k");
});

test("parseBaseline rejects malformed input with an actionable message", () => {
  assert.throws(() => parseBaseline("{"), /not valid JSON/);
  assert.throws(() => parseBaseline("[]"), /must be a JSON object/);
  assert.throws(() => parseBaseline("null"), /must be a JSON object/);
  assert.throws(() => parseBaseline('{"version":99,"findings":[]}'), /unsupported baseline version 99/);
  assert.throws(() => parseBaseline(`{"version":${BASELINE_VERSION}}`), /"findings" must be an array/);
  assert.throws(
    () => parseBaseline(`{"version":${BASELINE_VERSION},"findings":[{"signal":"contrast"}]}`),
    /findings\[0\] is missing a string "key"/,
  );
  assert.throws(
    () => parseBaseline(`{"version":${BASELINE_VERSION},"findings":[{"key":"k"}]}`),
    /findings\[0\] is missing a string "signal"/,
  );
});

// ── serializeBaseline ────────────────────────────────────────────────────────

test("serializeBaseline round-trips through parseBaseline", () => {
  const findings = collectFindings(
    { entries: [entry({ probeDetail: { contrastFailures: [contrast()] } })] },
    ["contrast"],
  );
  const parsed = parseBaseline(serializeBaseline(findings));
  assert.equal(parsed.findings.length, 1);
  assert.equal(parsed.findings[0].key, findings[0].key);
});

test("serializeBaseline drops the heavy detail and sorts by key", () => {
  const text = serializeBaseline([
    { key: "z|1", signal: "contrast", where: "w", fingerprint: "1", detail: { color: "rgb(0, 0, 0)" } },
    { key: "a|1", signal: "overflow", where: "w", fingerprint: "", detail: { px: 9 } },
  ]);
  const parsed = parseBaseline(text);
  assert.deepEqual(parsed.findings.map((f) => f.key), ["a|1", "z|1"]);
  assert.equal(parsed.findings[0].detail, undefined);
  assert.ok(text.endsWith("\n"));
});

test("serializeBaseline preserves meta and stringifies a missing fingerprint", () => {
  const parsed = parseBaseline(serializeBaseline([{ key: "k", signal: "contrast" }], { note: "accepted" }));
  assert.equal(parsed.note, "accepted");
  assert.equal(parsed.findings[0].fingerprint, "");
});

test("an empty run serializes to a baseline that parses and gates nothing", () => {
  const parsed = parseBaseline(serializeBaseline([]));
  assert.deepEqual(parsed.findings, []);
  assert.equal(compareFindings([], parsed.findings).isNew.length, 0);
});

// ── formatComparison ─────────────────────────────────────────────────────────

test("formatComparison names the missing baseline and how to create one", () => {
  const lines = formatComparison(compareFindings([], null)).join("\n");
  assert.match(lines, /cannot gate: no baseline/);
  assert.match(lines, /--update-baseline/);
});

test("formatComparison summarises new, known and resolved counts by signal", () => {
  const run = collectFindings({ horizontalOverflow: [{ where: "w", px: 1 }] }, ["overflow"]);
  const lines = formatComparison(
    compareFindings(run, [
      // The same finding the run found, plus one that no longer reproduces.
      { key: run[0].key, signal: "overflow", fingerprint: "1" },
      { key: "skips|/app/search initial|disk budget", signal: "skips", fingerprint: "" },
    ]),
  ).join("\n");
  assert.match(lines, /new 0 \(none\)/);
  assert.match(lines, /known 1 {3}resolved 1/);
});

test("formatComparison reports an empty signal list as 'none'", () => {
  const result = compareFindings([], []);
  assert.match(formatComparison(result).join("\n"), /new 0 \(none\)/);
  assert.match(formatComparison(result).join("\n"), /known 0 {3}resolved 0/);
});

test("formatComparison surfaces known-but-changed without calling it new", () => {
  const run = collectFindings({ horizontalOverflow: [{ where: "w", px: 480 }] }, ["overflow"]);
  const lines = formatComparison(compareFindings(run, [{ key: run[0].key, signal: "overflow", fingerprint: "5" }])).join("\n");
  assert.match(lines, /new 0/);
  assert.match(lines, /known but changed: 1 overflow/);
});
