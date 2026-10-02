/**
 * Split a price into its currency mark and its figure.
 *
 * The prices are authored as whole strings in `content/marketing.ts` ("$12",
 * "Custom") because that is what marketing copy should look like. But #583 needs
 * the currency rendered smaller than the figure, and a single string cannot
 * carry two font sizes — so the string is split at render time rather than
 * being re-authored as an object in three places.
 *
 * The rule is "leading characters that are not digits or separators are the
 * currency", which covers "$12", "€10" and "£8" without a symbol table, and
 * leaves "Custom" and any future "Free" untouched as a word.
 */
export function splitPrice(price: string): { currency: string; amount: string } {
  const trimmed = price.trim();
  const match = /^([^\d.,]*)([\d.,].*)$/.exec(trimmed);
  if (!match) return { currency: "", amount: trimmed };
  return { currency: match[1] ?? "", amount: match[2] ?? "" };
}