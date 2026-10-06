import { useState } from "react";

export type FaqItem = {
  question: string;
  answer: string;
};

type FaqAccordionProps = {
  items: FaqItem[];
};

/** Accessible expand/collapse FAQ list. Each button toggles its own panel
 *  (multiple panels may be open at once). */
export function FaqAccordion({ items }: FaqAccordionProps) {
  const [openQuestions, setOpenQuestions] = useState<Set<string>>(() => new Set());

  const toggle = (question: string) => {
    setOpenQuestions((previous) => {
      const next = new Set(previous);
      if (next.has(question)) {
        next.delete(question);
      } else {
        next.add(question);
      }
      return next;
    });
  };

  return (
    <div className="faq-accordion">
      {items.map((item, index) => {
        const isOpen = openQuestions.has(item.question);
        const panelId = `faq-panel-${index}`;
        const buttonId = `faq-button-${index}`;
        return (
          <div className={`faq-item${isOpen ? " open" : ""}`} key={item.question}>
            <h3 className="faq-question">
              <button
                type="button"
                id={buttonId}
                aria-expanded={isOpen}
                aria-controls={panelId}
                onClick={() => toggle(item.question)}
              >
                <span>{item.question}</span>
                <svg
                  className="faq-chevron"
                  viewBox="0 0 24 24"
                  width="18"
                  height="18"
                  aria-hidden="true"
                  focusable="false"
                >
                  <path
                    d="M6 9l6 6 6-6"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2.2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </button>
            </h3>
            <div id={panelId} role="region" aria-labelledby={buttonId} className="faq-answer">
              <p>{item.answer}</p>
            </div>
          </div>
        );
      })}
    </div>
  );
}
