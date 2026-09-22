import { useMemo } from "react";

export interface HighlightPart {
  text: string;
  highlight: boolean;
}

/**
 * Split `text` into plain/highlighted parts for the terms of `query`.
 *
 * Matching is case-insensitive, whitespace-split, de-duplicated, and the
 * query terms are regex-escaped so punctuation ("c++", "node.js") cannot
 * break the pattern. No match (or an empty query) yields the whole text as
 * a single plain part.
 */
export function highlightParts(text: string, query: string): HighlightPart[] {
  if (!query.trim()) return [{ text, highlight: false }];

  const terms = Array.from(
    new Set(
      query
        .trim()
        .split(/\s+/)
        .filter(Boolean)
        .map((term) => term.toLowerCase()),
    ),
  );
  if (terms.length === 0) return [{ text, highlight: false }];

  const escaped = terms.map((term) =>
    term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
  );
  const pattern = new RegExp(`(${escaped.join("|")})`, "gi");

  const parts: HighlightPart[] = [];
  let cursor = 0;
  for (const match of text.matchAll(pattern)) {
    const index = match.index ?? 0;
    if (index > cursor) {
      parts.push({ text: text.slice(cursor, index), highlight: false });
    }
    parts.push({ text: match[0], highlight: true });
    cursor = index + match[0].length;
  }
  if (cursor < text.length) {
    parts.push({ text: text.slice(cursor), highlight: false });
  }
  return parts.length > 0 ? parts : [{ text, highlight: false }];
}

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