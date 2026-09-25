import { LegalDocument, type LegalSection } from "../components/LegalDocument";
import { SITE } from "../content/marketing";

const SECTIONS: LegalSection[] = [
  {
    heading: "Agreement to these terms",
    body: [
      `These terms govern your use of the ${SITE.name} service and website. By creating an account or using the service you accept them. If you are accepting on behalf of an organisation, you confirm you have authority to bind it.`,
      "Where these terms conflict with a separate written agreement you have with us, that agreement wins for the scope it covers.",
    ],
  },
  {
    heading: "The service",
    body: [
      "AskDocs provides a workspace in which you may upload documents, search them semantically, and ask questions answered from their contents. Features and limits depend on your plan and may change; the Pricing page describes the current position.",
      "We may add, change, or remove features. We will not reduce the core functionality of a paid plan during its term without giving you notice and a refund option.",
    ],
  },
  {
    heading: "Your account",
    body: [
      "You are responsible for keeping your credentials confidential and for activity under your account. Tell us promptly if you believe someone else has access to it.",
      "You must be old enough to enter a contract where you live, and you may not create an account on behalf of someone else without their authority.",
    ],
  },
  {
    heading: "Your content",
    body: [
      "You keep all rights to the documents you upload. You grant us only the rights needed to operate the service for you: to store, process, index, and display that content to you and to answer your queries.",
      "You are responsible for having the right to upload what you upload, and for the lawfulness of that content. We do not claim ownership of your documents.",
      "We do not use your content to train models.",
    ],
  },
  {
    heading: "Acceptable use",
    body: ["You agree not to use the service to:"],
    items: [
      "Upload content you do not have the right to process, or that infringes someone else's rights.",
      "Store or distribute malware, or use the service to attack, probe, or disrupt it or any third party.",
      "Attempt to access another user's workspace, documents, or account.",
      "Circumvent plan limits, rate limits, or technical restrictions, including by automated means.",
      "Resell or provide the service to third parties as a substitute for our own, without a separate agreement.",
    ],
  },
  {
    heading: "Availability and support",
    body: [
      "We aim for high availability but do not guarantee uninterrupted service. We may suspend the service for maintenance, and we will restore it as soon as reasonably practicable.",
      "Support response times differ by plan and are described on the Pricing page. Enterprise customers should use their support channel rather than the public ones.",
    ],
  },
  {
    heading: "Suspension and termination",
    body: [
      "You may close your account at any time, which deletes your content as described in the Privacy Policy.",
      "We may suspend or terminate an account that breaches these terms, that puts the service at risk, or that we are required to act on by law. Where a suspension is not urgent or the account is paid for, we will normally warn you first and give an opportunity to fix the problem.",
    ],
  },
  {
    heading: "Our warranties and liability",
    body: [
      "The service is provided as is. We do not warrant that it will be uninterrupted, error-free, or fit for a particular purpose, and we do not warrant that generated answers are accurate — they are produced by a model from retrieved content and can be wrong.",
      "Nothing in these terms limits liability that cannot lawfully be limited. Subject to that, neither party is liable for indirect or consequential loss, and each party's total liability is limited to the amounts paid to us for the service in the twelve months before the claim.",
    ],
  },
  {
    heading: "Your content risk",
    body: [
      "The service is designed to be private per workspace, but no system is perfectly secure. Keep your own copies of anything you cannot afford to lose, and review the Security page before relying on it for material you cannot replace.",
    ],
  },
  {
    heading: "Changes, law, and contact",
    body: [
      "We may update these terms. Material changes take effect on the updated date above, and we will notify account holders through the product before they take effect.",
      `These terms are governed by the laws of ${SITE.jurisdiction}, and the courts of ${SITE.jurisdiction} have exclusive jurisdiction — this clause must be confirmed with a lawyer before publication. Questions go to ${SITE.legalEmail}.`,
    ],
  },
];

export function TermsPage() {
  return (
    <LegalDocument
      eyebrow="Legal"
      title="Terms of Service"
      intro="The agreement covering use of the platform, and the limits of what the service promises."
      sections={SECTIONS}
    />
  );
}
