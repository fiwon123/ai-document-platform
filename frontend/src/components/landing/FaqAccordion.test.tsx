import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { FaqAccordion } from "./FaqAccordion";

const ITEMS = [
  { question: "Is there a free plan?", answer: "Yes, free forever for individuals." },
  { question: "Can I bring my own API key?", answer: "Yes, in the Pro plan." },
];

describe("FaqAccordion", () => {
  it("lists every question with a collapsed answer", () => {
    render(<FaqAccordion items={ITEMS} />);
    expect(screen.getByText("Is there a free plan?")).toBeTruthy();
    const button = screen.getByRole("button", { name: /Is there a free plan/ });
    expect(button.getAttribute("aria-expanded")).toBe("false");
  });

  it("expands a panel on click and collapses it on a second click", () => {
    render(<FaqAccordion items={ITEMS} />);
    const button = screen.getByRole("button", { name: /Is there a free plan/ });
    fireEvent.click(button);
    expect(button.getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(button);
    expect(button.getAttribute("aria-expanded")).toBe("false");
  });

  it("keeps panels independent — opening one does not close another", () => {
    render(<FaqAccordion items={ITEMS} />);
    fireEvent.click(screen.getByRole("button", { name: /Is there a free plan/ }));
    fireEvent.click(screen.getByRole("button", { name: /bring my own API key/ }));
    expect(
      screen.getByRole("button", { name: /Is there a free plan/ }).getAttribute("aria-expanded"),
    ).toBe("true");
    expect(
      screen.getByRole("button", { name: /bring my own API key/ }).getAttribute("aria-expanded"),
    ).toBe("true");
  });
});