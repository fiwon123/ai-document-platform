import { Link } from "react-router-dom";
import { PageLayout, PageSection } from "../components/PageLayout";
import { SITE } from "../content/marketing";

const ROLES = [
  {
    title: "Full-stack engineer",
    type: "Contract or part-time",
    body: "Own features end to end across the FastAPI backend, the arq worker, and the React front end. Comfortable moving between a SQLAlchemy query and a component without needing a hand-off.",
  },
  {
    title: "Retrieval / ML engineer",
    type: "Contract or part-time",
    body: "Work on chunking strategy, embedding quality, and ranking. The interesting problems are all here: what to chunk, what to embed, and how to measure whether an answer is actually grounded.",
  },
  {
    title: "Technical writer",
    type: "Volunteer",
    body: "Documentation, examples, and the blog. The README and the docs in the repository are the current baseline and need to be substantially better.",
  },
];

const WORKING_HERE = [
  "Remote-first, async by default. Overlap of a few hours with European working days is expected, nothing more.",
  "The work is public. Decisions, trade-offs, and mistakes are all visible in the repository history.",
  "Scope is set by whoever is doing the work, not by a roadmap handed down. If something is a bad idea, saying so is a contribution.",
  "No on-call. This is a small project; the ambition is a good product, not a 24/7 operation.",
];

export function CareersPage() {
  return (
    <PageLayout
      eyebrow="Company"
      title="Careers"
      subtitle="AskDocs is a small open-source project. There is no org chart, no hiring process, and no recruiter — just a repository and a list of things that need doing."
      activePath="/careers"
    >
      <PageSection title="Open roles">
        <div className="contact-list">
          {ROLES.map((role) => (
            <div key={role.title} className="contact-row">
              <h3>
                {role.title} <span className="role-type">{role.type}</span>
              </h3>
              <p>{role.body}</p>
              <a className="btn btn-secondary" href={`mailto:${SITE.email}?subject=${encodeURIComponent(role.title)}`}>
                Express interest
              </a>
            </div>
          ))}
        </div>
      </PageSection>

      <PageSection title="What it is like to work here">
        <ul className="plan-includes">
          {WORKING_HERE.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
      </PageSection>

      <PageSection title="How to start">
        <p>
          Open the repository and pick something up. The{" "}
          <Link to="/blog">blog</Link> page lists the areas that are least
          covered by documentation, and the issue tracker is the best place to
          find something that is both wanted and small enough to be a first
          contribution. If you would rather not start from an issue, the{" "}
          <Link to="/contact">contact page</Link> has an email address.
        </p>
        <p>
          These listings are illustrative. They describe work that genuinely
          exists in this project, but the project is small enough that "hiring"
          means collaborating — so please check before treating them as
          openings.
        </p>
      </PageSection>
    </PageLayout>
  );
}
