import { Link } from "react-router-dom";
import {
  PageCta,
  PageLayout,
  PageSection,
} from "../components/PageLayout";
import { FeatureIcon } from "../components/landing/FeatureIcon";
import { PIPELINE_STAGES, STEPS } from "../content/marketing";

/**
 * Detailed pipeline walkthrough.
 *
 * The landing page compresses the pipeline into three steps (Upload → Search →
 * Ask). That is the right summary for a homepage and the wrong one for anyone
 * trying to understand what happens to their file, so this page describes all
 * six stages and what each one is actually for.
 */
export function HowItWorksPage() {
  return (
    <PageLayout
      eyebrow="Product"
      title={
        <>
          From upload to{" "}
          <span className="gradient-text">grounded answer</span>
        </>
      }
      subtitle="Six stages, one of which is slow on purpose. Here is what happens to a file after you drop it in."
    >
      <PageSection title="The short version">
        <p>
          Three steps cover most of how people use the product:{" "}
          {STEPS.map((step, i) => (
            <span key={step.title}>
              {i > 0 && " → "}
              <strong>{step.title}</strong>
            </span>
          ))}
          . The other three happen in the background, and they are what make
          the first three work.
        </p>
      </PageSection>

      <PageSection title="Stage by stage">
        <ol className="pipeline">
          {PIPELINE_STAGES.map((stage, index) => (
            <li key={stage.title} className="pipeline-stage" data-accent={stage.accent}>
              <div className="pipeline-stage-head">
                <span className="pipeline-stage-icon">
                  <FeatureIcon path={stage.icon} />
                </span>
                <div>
                  <h3>
                    {/* The ordinal is decoration — the list already conveys
                        order to assistive tech, and this only labels it. */}
                    <span className="pipeline-stage-number" aria-hidden="true">
                      {index + 1}
                    </span>
                    {stage.title}
                  </h3>
                  <p className="pipeline-summary">{stage.summary}</p>
                </div>
              </div>
              <p className="pipeline-detail">{stage.detail}</p>
              <ul className="pipeline-facts">
                {stage.facts.map((fact) => (
                  <li key={fact}>{fact}</li>
                ))}
              </ul>
            </li>
          ))}
        </ol>
      </PageSection>

      <PageSection title="Why processing is asynchronous">
        <p>
          Embedding a large PDF is the expensive step — it can take longer than
          the upload itself. Running it inside the request would mean either a
          timeout for the user or a slow API for everyone. Instead the upload
          returns immediately, a worker picks the job up, and the document
          reports <code>pending</code> → <code>processing</code> →{" "}
          <code>ready</code> (or <code>failed</code>, with the reason attached)
          as it moves.
        </p>
        <p>
          A failed document is never silently retried forever: the error is
          stored on the document so you can see what went wrong, and the rest of
          the workspace keeps working.
        </p>
      </PageSection>

      <PageSection title="What this means for privacy">
        <p>
          Chunks, embeddings, and answers are all scoped to the owning user, and
          object storage paths are namespaced per user ID. Search and Q&amp;A
          queries filter on that owner, so one account can never retrieve
          another account's documents — not through the UI, and not by guessing
          a document ID.
        </p>
        <p>
          The <Link to="/security">Security</Link> page covers this in more
          depth, and <Link to="/gdpr">GDPR</Link> covers the data-subject side.
        </p>
      </PageSection>

      <PageCta
        title="Run the pipeline on your own files"
        body="Nothing above is theoretical. Upload a document and watch it move through the six stages."
        secondary={{ to: "/features", label: "See all features" }}
      />
    </PageLayout>
  );
}
