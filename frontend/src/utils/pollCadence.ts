/**
 * Per-document backoff for the documents-page status poll (#589).
 *
 * The poll used to fire every `POLL_INTERVAL_MS` for *every* pending/processing
 * document for as long as the page stayed open — 20 requests/minute each, with
 * no ceiling, against a limiter that allows 100/minute per client IP. A document
 * stuck in `processing` for hours therefore consumed its share of that budget
 * indefinitely, and did so exactly when it was least likely to change: a
 * worker's timeout leaves the row in `processing` until the stale-document
 * recovery cron catches it.
 *
 * The cadence is **per document**, not global, so a freshly uploaded document is
 * still checked every `baseMs` while a neighbour that has been idle for minutes
 * has already slowed to a crawl. Any observed change resets that document to the
 * base cadence, which is what keeps a document that *is* progressing from ever
 * being slowed down — the backoff only ever applies to a document that is not
 * moving.
 */

/** One document's polling schedule. */
export interface PollCadence {
  /** Current polling period for this document, in milliseconds. */
  intervalMs: number;
  /**
   * Epoch milliseconds at which this document is next due.
   *
   * Absolute rather than a countdown on purpose: the scheduling effect re-runs
   * on every poll, because an active document always receives a fresh object
   * from the cache merge. A relative delay would restart a full period each time
   * and the backoff would never take effect.
   */
  nextDueAt: number;
}

export interface CadenceOptions {
  /** Period for a document that is moving (and for a freshly seen one). */
  baseMs: number;
  /** Ceiling for a document that is not moving. */
  maxMs: number;
}

/**
 * The cadence a newly seen document starts at: one full period from now, so a
 * fresh upload is checked on the same first-poll timing as before, and does not
 * inherit a slower neighbour's backoff.
 */
export function initialCadence(now: number, options: CadenceOptions): PollCadence {
  return { intervalMs: options.baseMs, nextDueAt: now + options.baseMs };
}

/**
 * Advance one document's cadence after a poll.
 *
 * `changed` returns it to the base period; an unchanged or failed poll doubles
 * the period, up to `maxMs`. Doubling from the base gives 3s → 6s → 12s → 24s →
 * 30s, so a document that never moves falls from 20 requests/minute to 2 within
 * the first minute and stays there, while a document that changes is immediately
 * back at full speed.
 *
 * The next due time is always a full period ahead, *including* after a change.
 * Scheduling `now` would make the document due immediately and spin the
 * scheduler in a tight loop.
 */
export function advanceCadence(
  previous: PollCadence,
  options: CadenceOptions & { changed: boolean; now: number },
): PollCadence {
  const { baseMs, maxMs, changed, now } = options;
  const intervalMs = changed ? baseMs : Math.min(maxMs, previous.intervalMs * 2);
  return { intervalMs, nextDueAt: now + intervalMs };
}

/**
 * Earliest due time across the tracked documents, or `null` when none are
 * tracked (nothing is active, so there is nothing to wake up for).
 */
export function earliestDue(cadences: Iterable<PollCadence>): number | null {
  let earliest: number | null = null;
  for (const { nextDueAt } of cadences) {
    if (earliest === null || nextDueAt < earliest) earliest = nextDueAt;
  }
  return earliest;
}
