import { act, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ErrorBoundary } from "./ErrorBoundary";

let shouldThrow = false;

/** Throws on every render while `shouldThrow` is set — for recovery tests. */
function Flaky(): React.ReactNode {
  if (shouldThrow) {
    throw new Error("render exploded");
  }
  return <div>all good</div>;
}

function Good() {
  return <div>all good</div>;
}

afterEach(() => {
  vi.restoreAllMocks();
  shouldThrow = false;
});

describe("ErrorBoundary", () => {
  it("renders children when there is no error", () => {
    render(
      <ErrorBoundary>
        <Good />
      </ErrorBoundary>,
    );
    expect(screen.getByText("all good")).toBeTruthy();
  });

  it("shows the fallback UI when a child throws", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    shouldThrow = true;
    render(
      <ErrorBoundary label="Page error">
        <Flaky />
      </ErrorBoundary>,
    );
    expect(screen.getByRole("alert")).toBeTruthy();
    expect(screen.getByText("Page error")).toBeTruthy();
    expect(screen.getByText("render exploded")).toBeTruthy();
    spy.mockRestore();
  });

  it("recovers and re-renders children after retry", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    shouldThrow = true;
    render(
      <ErrorBoundary>
        <Flaky />
      </ErrorBoundary>,
    );
    expect(screen.getByRole("alert")).toBeTruthy();
    // The underlying condition clears; retry then renders the recovered child.
    shouldThrow = false;
    act(() => {
      screen.getByRole("button", { name: "Try again" }).click();
    });
    expect(screen.getByText("all good")).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
    spy.mockRestore();
  });
});