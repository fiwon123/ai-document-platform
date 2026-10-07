/** Tokenizes a code snippet for the tutorial's syntax-highlighted blocks.
 *  Deliberately tiny: only Python and JavaScript, and only the token kinds the
 *  verification snippets actually use (keywords, strings, comments, function
 *  calls, numbers). No parser, no dependency — good enough for short static
 *  examples. */

export type CodeLanguage = "python" | "javascript";

export interface CodeToken {
  type: "plain" | "keyword" | "string" | "comment" | "function" | "number";
  text: string;
}

const KEYWORDS: Record<CodeLanguage, string[]> = {
  python: [
    "import",
    "from",
    "def",
    "return",
    "class",
    "async",
    "await",
    "raise",
    "if",
    "elif",
    "else",
    "for",
    "while",
    "try",
    "except",
    "finally",
    "with",
    "lambda",
    "pass",
    "as",
    "in",
    "not",
    "and",
    "or",
    "is",
    "None",
    "True",
    "False",
  ],
  javascript: [
    "const",
    "let",
    "var",
    "function",
    "return",
    "require",
    "if",
    "else",
    "for",
    "while",
    "try",
    "catch",
    "finally",
    "new",
    "class",
    "async",
    "await",
    "import",
    "export",
    "typeof",
    "instanceof",
    "throw",
    "switch",
    "case",
    "break",
    "continue",
    "null",
    "undefined",
    "true",
    "false",
  ],
};

/** Builds one combined matcher for the given language. Ordered so that:
 *  1. comments (# … / // …) win inside a line,
 *  2. strings consume their whole content (keyword-looking text inside them
 *     must not colorize),
 *  3. numbers, then keywords, then identifier( function calls. */
function buildMatcher(language: CodeLanguage): RegExp {
  const keyword = KEYWORDS[language].join("|");
  return new RegExp(
    [
      "(#[^\\n]*|\\/\\/[^\\n]*)", // comment
      "(\"(?:[^\"\\\\\\n]|\\\\.)*\"|'(?:[^'\\\\\\n]|\\\\.)*')", // string
      "(\\b\\d+(?:\\.\\d+)?\\b)", // number
      `(\\b(?:${keyword})\\b)`, // keyword
      "(\\b[A-Za-z_]\\w*(?=\\s*\\())", // function call
    ].join("|"),
    "g",
  );
}

export function tokenizeCode(code: string, language: CodeLanguage): CodeToken[] {
  const tokens: CodeToken[] = [];
  const matcher = buildMatcher(language);
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = matcher.exec(code)) !== null) {
    if (match.index > lastIndex) {
      tokens.push({ type: "plain", text: code.slice(lastIndex, match.index) });
    }
    const [, comment, string, number, keyword, func] = match;
    if (comment) {
      tokens.push({ type: "comment", text: comment });
    } else if (string) {
      tokens.push({ type: "string", text: string });
    } else if (number) {
      tokens.push({ type: "number", text: number });
    } else if (keyword) {
      tokens.push({ type: "keyword", text: keyword });
    } else if (func) {
      tokens.push({ type: "function", text: func });
    }
    lastIndex = match.index + match[0].length;
  }

  if (lastIndex < code.length) {
    tokens.push({ type: "plain", text: code.slice(lastIndex) });
  }
  return tokens;
}
