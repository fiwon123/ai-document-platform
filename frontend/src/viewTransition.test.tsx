import { act, render, screen } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { lazy, startTransition, Suspense, useState, type ReactNode } from "react";
import { MemoryRouter, Route, Routes, useLocation, useNavigate } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ViewTransitionRoutes } from "./App";
import { getViewTransitionStart, ignoreTransitionRejection } from "./lib/viewTransition";

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
        finished: Promise.reject(new DOMException("Transition was skipped", "AbortError")),
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
      Promise.all([transition.updateCallbackDone, transition.ready, transition.finished]),
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
 * ViewTransitionRoutes' body — kept in step with it because the real component
 * is exercised directly in the "keeps the page while a route loads" tests below.
 */
function ViewTransitionRoutesLike({ children }: { children: ReactNode }) {
  const location = useLocation();
  const [displayLocation, setDisplayLocation] = useState(location);

  if (location.key !== displayLocation.key) {
    const next = location;
    const commit = () => startTransition(() => setDisplayLocation(next));
    const start = getViewTransitionStart();
    if (start) {
      try {
        const transition = start(commit);
        ignoreTransitionRejection(transition);
      } catch {
        commit();
      }
    } else {
      commit();
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

/* ---------------------------------------------------------------------------
   #436: navigating to a route must not blank the page while its chunk loads.

   Measured in headless Chromium: with a 700ms chunk delay the old code showed
   the full-viewport "Loading page…" for 28 of 56 samples; with the commit in a
   transition it shows 0, and the page being read stays up for the whole wait.

   jsdom cannot reproduce that blank — React keeps the previous tree when a
   render-phase update suspends there, so a behavioural test passes against the
   broken code as readily as the fixed code. The first test below therefore pins
   the *mechanism* (the commit is a transition, and nothing forces it
   synchronously), and the second pins the behaviour that is observable here:
   the navigation still completes and the fallback still clears.
   --------------------------------------------------------------------------- */

describe("the location commit is a transition (#436)", () => {
  const source = readFileSync(resolve(__dirname, "App.tsx"), "utf8").replace(
    /\/\*[\s\S]*?\*\//g,
    "",
  );

  it("commits the new location inside startTransition", () => {
    // Synchronous commit => the suspension surfaces at the boundary above the
    // router and the whole tree becomes "Loading page…".
    expect(source).toMatch(/startTransition\s*\(\s*\(\s*\)\s*=>\s*setDisplayLocation\(/);
  });

  it("does not force the commit synchronous with flushSync", () => {
    // flushSync renders the new location immediately, which is exactly the
    // suspension that blanks the page. Its removal is the fix.
    expect(source).not.toMatch(/flushSync/);
  });

  it("has one full-viewport Suspense boundary around the route tree", () => {
    // The boundary above the router is why a synchronous commit blanks the
    // whole page: there is nothing to contain the fallback to the content area,
    // so the fix belongs in the commit rather than in the fallback markup.
    // Matched on the element (a `fallback` prop must follow) so the <Suspense>
    // mentioned in a comment is not counted as a second boundary.
    const boundaries = source.match(/<Suspense\b[^>]*fallback=[^>]*>/g) ?? [];
    expect(boundaries).toHaveLength(1);
    expect(boundaries[0]).toMatch(/fallback=\{pageFallback\}/);
    expect(source).toMatch(/const pageFallback = <div className="loading">/);
  });
});

describe("navigation still completes after the transition change (#436)", () => {
  it("reaches the new page and clears the fallback", async () => {
    // The opposite failure to guard against: a commit that never lands would
    // also keep "the old page" on screen, so the blank-free test above has to
    // be paired with one that proves the swap really happens.
    const Slow = lazy(async () => ({
      default: () => <h1>next page</h1>,
    }));
    function Harness() {
      return (
        <MemoryRouter initialEntries={["/"]}>
          <Suspense fallback={<div className="loading">Loading page…</div>}>
            <ViewTransitionRoutes>
              <Route path="/" element={<h1>home page</h1>} />
              <Route path="/next" element={<Slow />} />
            </ViewTransitionRoutes>
          </Suspense>
          <GoButton />
        </MemoryRouter>
      );
    }

    const { container } = render(<Harness />);
    await act(async () => {
      screen.getByRole("button", { name: "go" }).click();
    });

    expect(await screen.findByText("next page")).toBeTruthy();
    expect(container.querySelector(".loading")).toBeNull();
  });
});
