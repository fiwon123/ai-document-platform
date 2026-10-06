import { PageCard, PageLayout, PageSection } from "../components/PageLayout";
import { CompanyVisual } from "../components/company/PageVisuals";
import { balancedGridClass } from "../utils/gridCols";
import { NAV_COMPANY } from "../content/marketing";

const ACCENTS = ["/about", "/blog", "/careers", "/contact"] as const;

function accentFor(to: string) {
  const i = ACCENTS.indexOf(to as (typeof ACCENTS)[number]);
  return (["blue", "violet", "green", "amber"] as const)[i] ?? "blue";
}

const BLURBS: Record<string, string> = {
  "/about": "What AskDocs is, why it exists, and the principles behind how it is built.",
  "/blog": "Notes on retrieval, embeddings, and document pipelines.",
  "/careers": "Open roles and how the project is worked on.",
  "/contact": "Reach the maintainers, or file an issue on the repository.",
};

/** The hub's own entry, which this page therefore does not link to itself
 *  (#584). `NAV_COMPANY` starts with "General" → `/company` so the header
 *  menu, the footer column and the 404 all call the section the same thing;
 *  "Where to go next" is for the *other* pages. */
const COMPANY_OTHERS = NAV_COMPANY.filter((item) => item.to !== "/company");

/** Company hub — the header's "Company" destination. */
export function CompanyPage() {
  return (
    <PageLayout
      eyebrow="Company"
      title={
        <>
          The people behind <span className="gradient-text">AskDocs</span>
        </>
      }
      subtitle="A small open-source project built around a simple idea: your documents should be answerable by the people who own them."
    >
      <PageSection title="Where to go next">
        <div className={`${balancedGridClass(COMPANY_OTHERS.length)}`}>
          {COMPANY_OTHERS.map((item) => (
            <PageCard
              key={item.to}
              to={item.to}
              title={item.label}
              body={BLURBS[item.to] ?? ""}
              accent={accentFor(item.to)}
            />
          ))}
        </div>
      </PageSection>

      <PageSection title="What we care about">
        <div className="page-split">
          <div className="page-split-prose">
            <p>
              Three things run through most of the decisions in this codebase. First,{" "}
              <strong>grounding beats fluency</strong>: an answer that cites the passage it came
              from is worth more than a smoother answer with no provenance, so retrieval happens
              before generation and the retrieved context is what the model sees. Second,{" "}
              <strong>isolation is a property of the data model</strong>, not a filter someone
              remembers to apply — ownership is part of every query. Third,{" "}
              <strong>asynchronous work stays asynchronous</strong>: a slow embedding call belongs
              in a worker, not in someone's HTTP request.
            </p>
            <p>
              The project is open source and the full history is public. If something here is wrong
              or could be simpler, an issue is more useful than an email.
            </p>
          </div>
          <CompanyVisual />
        </div>
      </PageSection>
    </PageLayout>
  );
}
