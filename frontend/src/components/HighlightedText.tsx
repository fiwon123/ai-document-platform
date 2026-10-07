import { useMemo } from "react";

import { highlightParts } from "../utils/highlight";

interface HighlightedTextProps {
  text: string;
  query: string;
}

/**
 * Renders `text` with the query's terms wrapped in <mark>.
 * Text is rendered via React children, so it is inherently escaped — no
 * dangerouslySetInnerHTML, no HTML injection surface.
 */
export function HighlightedText({ text, query }: HighlightedTextProps) {
  const parts = useMemo(() => highlightParts(text, query), [text, query]);
  return (
    <>
      {parts.map((part, index) =>
        part.highlight ? (
          <mark key={index} className="result-highlight">
            {part.text}
          </mark>
        ) : (
          <span key={index}>{part.text}</span>
        ),
      )}
    </>
  );
}
