import { describe, expect, it } from "vitest";
import { advanceCadence, earliestDue, initialCadence } from "./pollCadence";

const OPTIONS = { baseMs: 3000, maxMs: 30_000 };

describe("initialCadence", () => {
  it("waits one full base period before the first poll", () => {
    expect(initialCadence(1000, OPTIONS)).toEqual({
      intervalMs: 3000,
      nextDueAt: 4000,
    });
  });

  it("does not inherit a slower cadence — a fresh upload polls at base", () => {
    // What a neighbour has backed off to after five unchanged polls.
    const backedOff = { intervalMs: 30_000, nextDueAt: 99_000 };
    expect(backedOff.intervalMs).toBe(30_000);
    expect(initialCadence(0, OPTIONS).intervalMs).toBe(3000);
  });
});

describe("advanceCadence", () => {
  it("doubles the period on an unchanged poll", () => {
    const first = initialCadence(0, OPTIONS);
    expect(advanceCadence(first, { ...OPTIONS, changed: false, now: 3000 })).toEqual({
      intervalMs: 6000,
      nextDueAt: 9000,
    });
  });

  it("schedules a full period ahead even after a change, never immediately", () => {
    // nextDueAt: now would make the document due again on the spot and spin the
    // scheduler in a tight loop.
    const backedOff = { intervalMs: 30_000, nextDueAt: 60_000 };
    expect(advanceCadence(backedOff, { ...OPTIONS, changed: true, now: 60_000 })).toEqual({
      intervalMs: 3000,
      nextDueAt: 63_000,
    });
  });

  it("resets to the base period when the document changes", () => {
    const backedOff = { intervalMs: 24_000, nextDueAt: 54_000 };
    expect(advanceCadence(backedOff, { ...OPTIONS, changed: true, now: 54_000 })).toEqual({
      intervalMs: 3000,
      nextDueAt: 57_000,
    });
  });

  it("caps the period at maxMs", () => {
    let cadence = initialCadence(0, OPTIONS);
    // Long enough for the doubling to reach the ceiling.
    for (let i = 0; i < 20; i += 1) {
      cadence = advanceCadence(cadence, {
        ...OPTIONS,
        changed: false,
        now: cadence.nextDueAt,
      });
      expect(cadence.intervalMs).toBeLessThanOrEqual(OPTIONS.maxMs);
    }
    expect(cadence.intervalMs).toBe(OPTIONS.maxMs);
  });

  it("walks the documented 3s → 6s → 12s → 24s → 30s schedule", () => {
    let cadence = initialCadence(0, OPTIONS);
    const seen = [cadence.intervalMs];
    for (let i = 0; i < 4; i += 1) {
      cadence = advanceCadence(cadence, {
        ...OPTIONS,
        changed: false,
        now: cadence.nextDueAt,
      });
      seen.push(cadence.intervalMs);
    }
    expect(seen).toEqual([3000, 6000, 12000, 24000, 30000]);
  });

  it("keeps a changing document at base while others back off", () => {
    // The point of a per-document cadence: progress never costs a document its
    // speed, because the backoff only ever applies to one that is not moving.
    let stuck = initialCadence(0, OPTIONS);
    for (let i = 0; i < 4; i += 1) {
      stuck = advanceCadence(stuck, {
        ...OPTIONS,
        changed: false,
        now: stuck.nextDueAt,
      });
    }
    expect(stuck.intervalMs).toBe(30_000);

    const moving = initialCadence(0, OPTIONS);
    for (let i = 0; i < 4; i += 1) {
      expect(advanceCadence(moving, { ...OPTIONS, changed: true, now: i * 3000 }).intervalMs).toBe(
        3000,
      );
    }
  });

  it("times the next poll from the answer, not from before the request", () => {
    // A slow response must not shorten the following wait: the caller passes
    // `now` after the request resolves.
    const previous = initialCadence(0, OPTIONS);
    const advanced = advanceCadence(previous, {
      ...OPTIONS,
      changed: false,
      now: 5000,
    });
    expect(advanced.nextDueAt).toBe(11_000);
  });
});

describe("earliestDue", () => {
  it("returns null when nothing is tracked", () => {
    expect(earliestDue([])).toBeNull();
  });

  it("picks the soonest due time across documents", () => {
    expect(
      earliestDue([
        { intervalMs: 30_000, nextDueAt: 90_000 },
        { intervalMs: 3000, nextDueAt: 12_000 },
        { intervalMs: 6000, nextDueAt: 45_000 },
      ]),
    ).toBe(12_000);
  });

  it("wakes the scheduler at the soonest due time, not the slowest", () => {
    // One fresh upload beside a document that has backed off to the ceiling:
    // the scheduler must still fire for the fresh one.
    const fresh = initialCadence(0, OPTIONS);
    const idle = { intervalMs: 30_000, nextDueAt: 30_000 };
    expect(earliestDue([idle, fresh])).toBe(3000);
  });
});

describe("request budget for a document that never changes", () => {
  it("falls from 20 requests/minute to 2 within the first minute", () => {
    // This is the acceptance criterion in #589, measured off the schedule
    // rather than off a live timer: count the polls a fixed 3s interval would
    // have made in 60s, and the polls the cadence actually makes.
    let cadence = initialCadence(0, OPTIONS);
    const pollTimes: number[] = [];
    let t = 0;
    while (t < 60_000) {
      t = cadence.nextDueAt;
      if (t >= 60_000) break;
      pollTimes.push(t);
      cadence = advanceCadence(cadence, {
        ...OPTIONS,
        changed: false,
        now: t,
      });
    }
    // The old fixed interval polled 20 times in that window.
    expect(60_000 / 3000).toBe(20);
    expect(pollTimes).toEqual([3000, 9000, 21_000, 45_000]);
    expect(pollTimes.length).toBeLessThan(20);

    // And it stays at 2/minute once at the ceiling.
    const steady = advanceCadence(
      { intervalMs: 30_000, nextDueAt: 75_000 },
      { ...OPTIONS, changed: false, now: 75_000 },
    );
    expect(steady.intervalMs).toBe(30_000);
    expect(60_000 / steady.intervalMs).toBe(2);
  });
});
