import { LegalDocument } from "../components/LegalDocument";
import { legalDocumentProps } from "../content/legal";

/**
 * The `/terms` document — see `content/legal.ts` for the copy and why it
 * lives there.
 *
 * This file is a wrapper on purpose. It used to own its own `SECTIONS` array,
 * which meant the text a lawyer has to review was scattered across four page
 * components and nothing tied them together. Now the document is looked up by
 * route from one list, so the footer column, the navigation and the page itself
 * cannot disagree about what exists.
 */
export function TermsPage() {
  return <LegalDocument {...legalDocumentProps("/terms")} />;
}
