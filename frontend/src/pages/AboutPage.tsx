import { Link } from "react-router-dom";
import { PageCta, PageLayout, PageSection } from "../components/PageLayout";
import { AboutVisual } from "../components/company/PageVisuals";
import { balancedGridClass } from "../utils/gridCols";
import { SITE } from "../content/marketing";

const PRINCIPLES = [
  {
    title: "Ground the answer",
    body: "Answers are generated from passages retrieved out of your own workspace. When the documents do not contain the answer, the honest outcome is that we did not find it — not a confident guess.",
  },
  {
    title: "Make isolation structural",
    body: "Documents are namespaced by owner in object storage, and every search and question filters on that owner. Privacy should not depend on remembering to add a where clause.",
  },
  {
    title: "Keep slow work off the request path",
    body: "Extraction, chunking, and embedding all run in a background worker. The API stays fast, and a large upload never becomes someone else's timeout.",
  },
  {
    title: "Show what failed",
    body: "A document that cannot be processed is marked failed with the reason attached, rather than retried quietly forever or silently omitted from results.",
  },
];

const STACK = [
  { label: "Backend", value: "Python · FastAPI · SQLAlchemy" },
  { label: "Frontend", value: "React 19 · TypeScript · Vite" },
  { label: "Database", value: "PostgreSQL · pgvector" },
  { label: "Cache & queue", value: "Redis · arq workers" },
  { label: "Storage", value: "S3-compatible object storage" },
  { label: "Models", value: "Groq, OpenAI, or a local server · bring your own key" },
];

export function AboutPage() {
  return (
    <PageLayout
      eyebrow="Company"
      title={
        <>
          About <span className="gradient-text">AskDocs</span>
        </>
      }
      subtitle="An AI document intelligence platform, built in the open because the interesting problems in retrieval are worth sharing."
    >
      <PageSection title="What this is">
        <div className="page-split">
          <div className="page-split-prose">
            <p>
              AskDocs turns a pile of documents into something you can query. You upload files, a
              background pipeline extracts and embeds their contents, and from that point you can
              search by meaning or ask questions that get answered from your own material.
            </p>
            <p>
              The interesting part is not the chat box. It is the pipeline underneath: asynchronous
              processing, chunking that preserves provenance, a vector index that supports
              filtering, and answers constrained to retrieved context. The interface is the smallest
              part of the problem.
            </p>
          </div>
          <AboutVisual />
        </div>
      </PageSection>

      <PageSection title="Principles">
        <div className={`${balancedGridClass(PRINCIPLES.length)} page-grid-secondary forced-dark`}>
          {PRINCIPLES.map((item) => (
            <article key={item.title} className="page-card-static">
              <h3>{item.title}</h3>
              <p>{item.body}</p>
            </article>
          ))}
        </div>
      </PageSection>

      <PageSection title="How it is built">
        <p>
          {SITE.name} is a full-stack monorepo: a FastAPI service with an asynchronous worker, a
          React front end, and a PostgreSQL database extended with <code>pgvector</code>. It runs
          locally under Docker Compose and deploys to Kubernetes.
        </p>
        <dl className="stack-list">
          {STACK.map((row) => (
            <div key={row.label} className="stack-row">
              <dt>{row.label}</dt>
              <dd>{row.value}</dd>
            </div>
          ))}
        </dl>
        <p>
          Everything is public in the{" "}
          <a href={SITE.repoUrl} target="_blank" rel="noopener noreferrer">
            repository on GitHub
          </a>{" "}
          — including the parts that are inconvenient.
        </p>
      </PageSection>

      <PageSection title="Where to go next">
        <p>
          <Link to="/how-it-works">How it works</Link> explains the pipeline,
          <Link to="/security"> Security</Link> covers how data is handled, and
          <Link to="/contact"> Contact</Link> is the best way to reach the maintainers.
        </p>
      </PageSection>

      <PageCta
        title="Read the code, not a pitch"
        body="Everything described on this page is in the repository, and the commit history is the actual record of the decisions."
        secondary={{ to: "/contact", label: "Ask a question" }}
      />
    </PageLayout>
  );
}
