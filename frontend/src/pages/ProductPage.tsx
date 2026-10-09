import { PageCard, PageCta, PageLayout, PageSection } from "../components/PageLayout";
import { balancedGridClass } from "../utils/gridCols";
import { NAV_PRODUCT } from "../content/marketing";

/** Accent per hub card — matches the feature cards on /features. */
const ACCENTS = ["/features", "/how-it-works", "/pricing", "/demo"] as const;

function accentFor(to: string) {
  const i = ACCENTS.indexOf(to as (typeof ACCENTS)[number]);
  return (["blue", "violet", "green", "amber"] as const)[i] ?? "blue";
}

/**
 * Product hub.
 *
 * Exists so the header can link to a single "Product" destination instead of
 * three flat items, and so the section has a page of its own to explain what
 * the product is before sending someone into the detail pages.
 */
export function ProductPage() {
  return (
    <PageLayout
      eyebrow="Product"
      title={
        <>
          A private workspace for <span className="gradient-text">your documents</span>
        </>
      }
      subtitle="Upload files, search them by meaning, and ask questions that get answered from your own content — not from a model's memory."
    >
      <PageSection title="Where to go next">
        <div className={`${balancedGridClass(NAV_PRODUCT.length)} forced-dark`}>
          {NAV_PRODUCT.map((item) => (
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

      <PageSection title="The short version">
        <p>
          AskDocs is an AI document intelligence platform. You upload documents; a background
          pipeline extracts their text, splits it into passages, and embeds each passage into a
          vector index. After that, two things become possible: <strong>semantic search</strong>,
          which ranks passages by meaning rather than keyword overlap, and{" "}
          <strong>question answering</strong>, which retrieves the relevant passages and has a model
          answer strictly from them.
        </p>
        <p>
          The grounding matters more than the model. Because answers are generated from retrieved
          chunks in your workspace, the output can cite what it is based on instead of sounding
          confident about something it does not know.
        </p>
        <p>
          Everything is isolated per user. Object storage paths are namespaced by account, and both
          search and Q&amp;A filter on the owner, so one workspace cannot reach another's documents.
        </p>
      </PageSection>

      <PageSection title="Built on">
        <p>
          FastAPI and SQLAlchemy on the backend, React and TypeScript on the front, PostgreSQL with{" "}
          <code>pgvector</code> for storage and vector search, Redis for caching and the job queue,
          an asynchronous worker for document processing, and S3-compatible object storage for the
          files themselves. It is open source — the{" "}
          <a
            href="https://github.com/fiwon123/ai-document-platform"
            target="_blank"
            rel="noopener noreferrer"
          >
            repository is on GitHub
          </a>
          .
        </p>
      </PageSection>

      <PageCta
        title="Start with a document you already know"
        body="The fastest way to judge a retrieval system is to point it at something you can check the answer against."
      />
    </PageLayout>
  );
}

const BLURBS: Record<string, string> = {
  "/features":
    "The full capability list — ingestion, semantic search, question answering, exports, and webhooks.",
  "/how-it-works":
    "The six-stage pipeline from upload to answer, including why processing is asynchronous.",
  "/pricing": "Plans, limits, and what each limit is actually for.",
  "/demo": "Try the whole flow in a browser without creating an account.",
};
