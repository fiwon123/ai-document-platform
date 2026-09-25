import { LegalDocument, type LegalSection } from "../components/LegalDocument";
import { SITE } from "../content/marketing";

const SECTIONS: LegalSection[] = [
  {
    heading: "Scope",
    body: [
      "This page summarises how the service handles personal data in relation to the GDPR and equivalent regimes. It is a summary in plain language; the enforceable obligations sit in the Privacy Policy and in the data processing agreement we sign with business customers.",
      `Nothing here is legal advice, and the roles described below must be confirmed against how ${SITE.entity} is actually contracted before this page is published.`,
    ],
  },
  {
    heading: "Controller and processor",
    body: [
      "For account data — username, password hash, role, session state — we are the controller: we decide why it is collected and how long it is kept.",
      "For documents you upload to a workspace, and for the chunks, embeddings, and answers derived from them, you are the controller and we are the processor. That means you decide what is uploaded and why, and our job is to process it only on your instructions.",
      "Where a business customer signs a data processing agreement, that agreement defines our obligations as processor in detail, including subprocessor approval.",
    ],
  },
  {
    heading: "Lawful basis",
    body: [
      "Account and session data: performance of a contract with you. Security and rate-limiting data: our legitimate interests in operating and protecting the service. Your documents and derived data: performance of the contract, on your instruction. Marketing email: consent, withdrawable at any time.",
      "We do not rely on legitimate interests for the content of your documents. If you ask us to delete it, we delete it.",
    ],
  },
  {
    heading: "Your rights",
    body: ["Where the GDPR applies you have the right to:"],
    items: [
      "be informed about how your data is used (Articles 13–14)",
      "access a copy of your personal data (Article 15)",
      "correct inaccurate data (Article 16)",
      "request erasure (Article 17)",
      "restrict processing (Article 18)",
      "receive data in a portable, machine-readable form (Article 20)",
      "object to processing based on legitimate interests (Article 21)",
      "withdraw consent at any time where consent is the basis",
      "lodge a complaint with your supervisory authority (Article 77)",
    ],
  },
  {
    heading: "How to exercise them",
    body: [
      "Most rights can be exercised directly in the workspace. Deleting a document removes the file from object storage and its chunks from the vector index. Closing the account removes account data and, as described in the Privacy Policy, the content associated with it.",
      `Requests the interface cannot satisfy — access requests spanning many documents, for example — go to ${SITE.legalEmail}. We respond within one month, extendable by two further months for complex requests, and we will tell you if we need to verify your identity first.`,
    ],
  },
  {
    heading: "Automated decision-making",
    body: [
      "The service does not make decisions with legal or similarly significant effects about you. Semantic ranking and generated answers are automated, but they produce search results and text, not decisions about a person, and nothing in the product is intended to be used that way.",
      "Answers are produced by a model and can be wrong. The Privacy Policy and Terms both say so explicitly, because an inaccurate answer presented as authoritative is a risk to you, not just an inconvenience.",
    ],
  },
  {
    heading: "International transfers",
    body: [
      "Our infrastructure and model providers may process data outside the EEA and UK. Where that happens we rely on an appropriate transfer mechanism, such as the Standard Contractual Clauses, and we will publish the specific providers and locations here once they are confirmed.",
      "The Privacy Policy lists the subprocessors we rely on. That list is the authoritative version and must be kept current.",
    ],
  },
  {
    heading: "Breach notification",
    body: [
      "If we become aware of a personal data breach we will notify the supervisory authority within 72 hours where the threshold is met, and notify affected users without undue delay where the breach is likely to result in a high risk to them.",
      "As a processor, our obligation is to notify the controller without undue delay so that the notification clock can be met. The specific timing agreed in the data processing agreement should be stated explicitly before signing.",
    ],
  },
  {
    heading: "Data minimisation and retention",
    body: [
      "We collect what the features need and no more. Search queries and question/answer pairs are retained because they are the queries themselves; they are not used to build advertising profiles or to train models.",
      "Retention periods are listed in the Privacy Policy. Data is deleted or anonymised when it is no longer needed, and deletion of a document propagates to derived data rather than leaving embeddings behind.",
    ],
  },
  {
    heading: "Complaints",
    body: [
      `If you are unhappy with how we handle your data, raise it with us first at ${SITE.legalEmail} so we can investigate. If the outcome does not satisfy you, you have the right to complain to the data protection authority in your country of residence, place of work, or the place of the alleged infringement.`,
    ],
  },
];

export function GdprPage() {
  return (
    <LegalDocument
      eyebrow="Legal"
      title="GDPR"
      intro="How the platform handles personal data under the GDPR, in plain language."
      sections={SECTIONS}
    />
  );
}
