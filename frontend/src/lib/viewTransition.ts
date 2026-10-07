/**
 * View Transition plumbing.
 *
 * The route tree renders against a *stored* location so navigation can run
 * through the View Transition API: React renders the new page inside
 * `document.startViewTransition()` (flushed synchronously) and the browser
 * cross-fades the outgoing and incoming snapshots. Without API support the
 * location updates immediately and the app behaves exactly as before.
 */

/** A `ViewTransition` as this app uses it.
 *
 * Every promise is optional: the API is feature-detected, so a browser or stub
 * may expose only some of them and none of them are required to be present. */
export type ViewTransitionLike = {
  /** Settles when the update callback returns or throws. */
  updateCallbackDone?: Promise<void>;
  /** Settles when the browser has both snapshots and can play it. */
  ready?: Promise<void>;
  /** Settles when the transition finishes. */
  finished?: Promise<void>;
};

/**
 * Silences a transition that was skipped.
 *
 * A skip is the API's normal way of saying "a newer navigation preempts this
 * one": `ready` and `finished` reject with `AbortError` when it happens, and
 * `updateCallbackDone` rejects if the update callback throws. With every route
 * code-split, a second navigation routinely lands while the first chunk is
 * still loading, so skips are ordinary rather than exceptional. Chrome reports
 * each promise that nobody listens to as an unhandled rejection, which is what
 * filled the console with `AbortError: Transition was skipped` on navigation.
 *
 * Handling only `finished`, as this did before, left `ready` unobserved, so
 * every skipped navigation logged the error.
 *
 * Only rejections are swallowed — a promise that resolves is left alone, and
 * the returned transition object is not modified.
 */
export function ignoreTransitionRejection(transition: ViewTransitionLike): void {
  transition.updateCallbackDone?.catch(() => {});
  transition.ready?.catch(() => {});
  transition.finished?.catch(() => {});
}

/** Returns `document.startViewTransition`, or null where the API is absent. */
export function getViewTransitionStart(): ((update: () => void) => ViewTransitionLike) | null {
  const doc = document as unknown as {
    startViewTransition?: (update: () => void) => ViewTransitionLike;
  };
  return typeof doc.startViewTransition === "function" ? doc.startViewTransition.bind(doc) : null;
}
