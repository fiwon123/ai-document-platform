import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "./ToastProvider";
import { useToast } from "../hooks/useToast";

function Consumer() {
  const toast = useToast();
  return (
    <div>
      <button type="button" onClick={() => toast.success("Saved!")}>
        show success
      </button>
      <button type="button" onClick={() => toast.error("Failed!")}>
        show error
      </button>
      <button type="button" onClick={() => toast.info("Heads up")}>
        show info
      </button>
      <button type="button" onClick={() => toast.dismiss(1)}>
        dismiss id 1
      </button>
    </div>
  );
}

function renderWithToast(children = <Consumer />) {
  return render(<ToastProvider>{children}</ToastProvider>);
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("ToastProvider", () => {
  it("renders a success toast with the message", () => {
    renderWithToast();
    act(() => {
      screen.getByText("show success").click();
    });
    expect(screen.getByText("Saved!")).toBeTruthy();
  });

  it("renders error and info toasts", () => {
    renderWithToast();
    act(() => {
      screen.getByText("show error").click();
      screen.getByText("show info").click();
    });
    expect(screen.getByText("Failed!")).toBeTruthy();
    expect(screen.getByText("Heads up")).toBeTruthy();
  });

  it("dismisses a toast when its close button is clicked", () => {
    renderWithToast();
    act(() => {
      screen.getByText("show success").click();
    });
    const close = screen.getByLabelText("Dismiss notification");
    act(() => {
      close.click();
    });
    expect(screen.queryByText("Saved!")).toBeNull();
  });

  it("auto-dismisses a success toast after 4 seconds", () => {
    renderWithToast();
    act(() => {
      screen.getByText("show success").click();
    });
    expect(screen.getByText("Saved!")).toBeTruthy();
    act(() => {
      vi.advanceTimersByTime(4001);
    });
    expect(screen.queryByText("Saved!")).toBeNull();
  });

  it("auto-dismisses an error toast after 5 seconds", () => {
    renderWithToast();
    act(() => {
      screen.getByText("show error").click();
    });
    act(() => {
      vi.advanceTimersByTime(4000);
    });
    expect(screen.getByText("Failed!")).toBeTruthy();
    act(() => {
      vi.advanceTimersByTime(1001);
    });
    expect(screen.queryByText("Failed!")).toBeNull();
  });
});