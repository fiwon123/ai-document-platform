import type { ReactNode } from "react";
import { PageLayout, TemplateNotice } from "./PageLayout";
import { SITE } from "../content/marketing";

export type LegalSection = {
  heading: string;
  /** One or more paragraphs. Kept as an array so a section can split content
   *  into lead + detail without nesting markup in the content module. */
  body: string[];
  /** Optional bullet list rendered under the paragraphs. */
  items?: string[];
};

/**
 * Shell shared by Privacy, Terms, Security and GDPR.
 *
 * All four are structured documents with the same shape — a title, a
 * last-updated line, a standing notice, and a numbered list of sections — so
 * the layout lives here rather than being copied four times with small
 * differences.
 *
 * The `TemplateNotice` is not decoration. These documents are written to be
 * realistic, and realistic legal text published under a brand name becomes a
 * legal position whether or not anyone reviewed it. The notice is in the
 * document body, above the content, where a reader cannot miss it.
 */
export function LegalDocument({
  eyebrow,
  title,
  intro,
  sections,
}: {
  eyebrow: string;
  title: string;
  intro: string;
  sections: LegalSection[];
}) {
  return (
    <PageLayout
      eyebrow={eyebrow}
      title={title}
      subtitle={intro}
    >
      <TemplateNotice>
        This page is a starting template, not a reviewed legal document. It
        describes how {SITE.name} is built and is not legal advice. Have a
        qualified lawyer adapt it — in particular the processor/subprocessor
        list, retention periods, and the jurisdiction and governing-law
        clauses — before publishing it or relying on it. Several placeholders
        below ({SITE.entity}, {SITE.jurisdiction}, the contact addresses) must
        be replaced first.
      </TemplateNotice>

      <p className="legal-updated">Last updated: {SITE.updated}</p>

      <div className="legal-body">
        {sections.map((section, index) => (
          <section key={section.heading} className="legal-section">
            <h2>
              <span className="legal-section-number">{index + 1}.</span>{" "}
              {section.heading}
            </h2>
            {section.body.map((paragraph) => (
              <p key={paragraph.slice(0, 40)}>{paragraph}</p>
            ))}
            {section.items && (
              <ul>
                {section.items.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            )}
          </section>
        ))}
      </div>
    </PageLayout>
  );
}

export function LegalContact({ children }: { children: ReactNode }) {
  return <p className="legal-contact">{children}</p>;
}
