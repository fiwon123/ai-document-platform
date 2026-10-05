import { useMemo } from "react";
import { tokenizeCode, type CodeLanguage, type CodeToken } from "../utils/codeTokens";

const LANGUAGE_LABELS: Record<CodeLanguage, string> = {
  python: "Python",
  javascript: "JavaScript",
};

/** Syntax-highlighted code block for the webhook tutorial. Renders the exact
 *  same text as a plain <pre><code> — tokens are only wrapped in colored
 *  spans (tok-keyword / tok-string / tok-comment / tok-function / tok-number),
 *  so copy-paste and text content stay intact. */
export function CodeBlock({
  code,
  language,
}: {
  code: string;
  language: CodeLanguage;
}) {
  const tokens = useMemo(() => tokenizeCode(code, language), [code, language]);

  return (
    <div className="code-block">
      <span className="code-block-label">{LANGUAGE_LABELS[language]}</span>
      <pre>
        <code>
          {tokens.map((token: CodeToken, index) =>
            token.type === "plain" ? (
              token.text
            ) : (
              <span key={index} className={`tok-${token.type}`}>
                {token.text}
              </span>
            ),
          )}
        </code>
      </pre>
    </div>
  );
}