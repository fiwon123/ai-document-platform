import { act, render, screen } from "@testing-library/react";
import { useState, type ReactNode } from "react";
import {
  MemoryRouter,
  Route,
  Routes,
  useLocation,
  useNavigate,
} from "react-router-dom";
import { flushSync } from "react-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getViewTransitionStart,
  ignoreTransitionRejection,
} from "./lib/viewTransition";

/**
 * A skipped view transition is normal, not a failure.
 *
 * A skip rejects `ready` and `finished` with `AbortError`, and
 * `updateCallbackDone` rejects if the update callback throws. Because every
 * route is code-split, a second navigation routinely lands while the first
 * chunk is still loading, so skips are ordinary — but Chrome reports each
 * promise nobody listens to as an unhandled rejection, which is what flooded
 * the console with `AbortError: Transition was skipped` on plain navigation.
 *
 * These tests pin that all three are handled, not just `finished`.
 */

/** A transition whose every promise rejects, exactly as a skip does. */
function skippedTransition() {
  const skip = () =>
    new Promise<void>((_, reject) =>
      reject(new DOMException("Transition was skipped", "AbortError")),
    );
  return {
    updateCallbackDone: skip(),
    ready: skip(),
    finished: skip(),
  };
}

/**
 * Collects unhandled rejections raised while `fn` runs.
 *
 * Unhandled rejections surface on a later macrotask, not the next microtask,
 * so the event loop is given a turn to drain them before we look.
 */
async function watchUnhandledRejections(fn: () => Promise<void>) {
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => unhandled.push(reason);
  process.on("unhandledRejection", onUnhandled);
  try {
    await fn();
    await new Promise((resolve) => setTimeout(resolve, 0));
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
  return unhandled;
}

describe("ignoreTransitionRejection", () => {
  it("leaves nothing unhandled when all three promises reject", async () => {
    const unhandled = await watchUnhandledRejections(async () => {
      ignoreTransitionRejection(skippedTransition());
      await Promise.resolve();
    });

    expect(unhandled).toEqual([]);
  });

  it("handles a stub exposing only `finished`", async () => {
    // The API is feature-detected, so optional chaining must keep a partial
    // transition from throwing on a missing promise.
    const unhandled = await watchUnhandledRejections(async () => {
      ignoreTransitionRejection({
        finished: Promise.reject(
          new DOMException("Transition was skipped", "AbortError"),
        ),
      });
      await Promise.resolve();
    });

    expect(unhandled).toEqual([]);
  });

  it("does not throw for a transition with no promises at all", () => {
    expect(() => ignoreTransitionRejection({})).not.toThrow();
  });

  it("leaves a resolving transition untouched", async () => {
    // Nothing to silence: a normal transition must settle normally, so this
    // guards against a "fix" that swallows real failures.
    const transition = {
      updateCallbackDone: Promise.resolve(),
      ready: Promise.resolve(),
      finished: Promise.resolve(),
    };

    ignoreTransitionRejection(transition);
    await expect(
      Promise.all([
        transition.updateCallbackDone,
        transition.ready,
        transition.finished,
      ]),
    ).resolves.toEqual([undefined, undefined, undefined]);
  });
});

describe("getViewTransitionStart", () => {
  const doc = document as unknown as { startViewTransition?: unknown };
  const original = doc.startViewTransition;

  afterEach(() => {
    if (original === undefined) delete doc.startViewTransition;
    else doc.startViewTransition = original;
  });

  it("returns null where the API is unavailable", () => {
    delete doc.startViewTransition;
    expect(getViewTransitionStart()).toBeNull();
  });

  it("returns a bound starter when the API is present", () => {
    // A resolving transition, so invoking the starter here leaves nothing
    // unhandled for a later test to observe.
    const start = vi.fn(() => ({
      updateCallbackDone: Promise.resolve(),
      ready: Promise.resolve(),
      finished: Promise.resolve(),
    }));
    doc.startViewTransition = start;

    const bound = getViewTransitionStart();
    expect(bound).not.toBeNull();
    const update = vi.fn();
    bound?.(update);
    expect(start).toHaveBeenCalledTimes(1);
  });
});

/**
 * Integration: the real navigation path, so a regression in how the helper is
 * *called* is caught rather than only the helper in isolation. This mirrors
 * ViewTransitionRoutes' body.
 */
function ViewTransitionRoutesLike({ children }: { children: ReactNode }) {
  const location = useLocation();
  const [displayLocation, setDisplayLocation] = useState(location);

  if (location.key !== displayLocation.key) {
    const start = getViewTransitionStart();
    if (start) {
      const next = location;
      try {
        const transition = start(() => {
          flushSync(() => setDisplayLocation(next));
        });
        ignoreTransitionRejection(transition);
      } catch {
        setDisplayLocation(location);
      }
    } else {
      setDisplayLocation(location);
    }
  }

  return <Routes location={displayLocation}>{children}</Routes>;
}

function GoButton() {
  const navigate = useNavigate();
  return (
    <button type="button" onClick={() => navigate("/next")}>
      go
    </button>
  );
}

function Harness() {
  return (
    <MemoryRouter initialEntries={["/"]}>
      <ViewTransitionRoutesLike>
        <Route path="/" element={<div>home</div>} />
        <Route path="/next" element={<div>next page</div>} />
      </ViewTransitionRoutesLike>
      <GoButton />
    </MemoryRouter>
  );
}

describe("navigation under a skipped view transition", () => {
  const doc = document as unknown as { startViewTransition?: unknown };
  const original = doc.startViewTransition;

  afterEach(() => {
    if (original === undefined) delete doc.startViewTransition;
    else doc.startViewTransition = original;
  });

  it("navigates, and leaves no unhandled rejection", async () => {
    // The real API invokes the update callback itself; the mock must too, or
    // the location never advances and the test would not exercise the path.
    const start = vi.fn((update: () => void) => {
      update();
      return skippedTransition();
    });
    doc.startViewTransition = start;

    const unhandled = await watchUnhandledRejections(async () => {
      render(<Harness />);
      await act(async () => {
        screen.getByRole("button", { name: "go" }).click();
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(start).toHaveBeenCalledTimes(1);
    expect(screen.getByText("next page")).toBeTruthy();
    expect(unhandled).toEqual([]);
  });
});
