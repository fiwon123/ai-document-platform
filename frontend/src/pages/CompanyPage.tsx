import { PageCard, PageLayout, PageSection } from "../components/PageLayout";
import { NAV_COMPANY } from "../content/marketing";

const BLURBS: Record<string, string> = {
  "/about": "What AskDocs is, why it exists, and the principles behind how it is built.",
  "/blog": "Notes on retrieval, embeddings, and document pipelines.",
  "/careers": "Open roles and how the project is worked on.",
  "/contact": "Reach the maintainers, or file an issue on the repository.",
};

/** Company hub — the header's "Company" destination. */
export function CompanyPage() {
  return (
    <PageLayout
      eyebrow="Company"
      title="The people behind AskDocs"
      subtitle="A small open-source project built around a simple idea: your documents should be answerable by the people who own them."
      activePath="/company"
    >
      <PageSection title="Where to go next">
        <div className="page-grid">
          {NAV_COMPANY.map((item) => (
            <PageCard
              key={item.to}
              to={item.to}
              title={item.label}
              body={BLURBS[item.to] ?? ""}
            />
          ))}
        </div>
      </PageSection>

      <PageSection title="What we care about">
        <p>
          Three things run through most of the decisions in this codebase.
          First, <strong>grounding beats fluency</strong>: an answer that cites
          the passage it came from is worth more than a smoother answer with no
          provenance, so retrieval happens before generation and the retrieved
          context is what the model sees. Second,{" "}
          <strong>isolation is a property of the data model</strong>, not a
          filter someone remembers to apply — ownership is part of every query.
          Third, <strong>asynchronous work stays asynchronous</strong>: a slow
          embedding call belongs in a worker, not in someone's HTTP request.
        </p>
        <p>
          The project is open source and the full history is public. If
          something here is wrong or could be simpler, an issue is more useful
          than an email.
        </p>
      </PageSection>
    </PageLayout>
  );
}
