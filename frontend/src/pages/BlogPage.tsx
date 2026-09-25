import { Link } from "react-router-dom";
import { PageLayout, PageSection } from "../components/PageLayout";
import { SITE } from "../content/marketing";

/**
 * Blog index.
 *
 * Deliberately a stub that says so, rather than a list of invented posts.
 * Faking an archive — or worse, placeholder posts with plausible dates — makes
 * the site look alive when it is not, and the first real post then has to
 * explain why three imaginary ones came before it.
 */
export function BlogPage() {
  return (
    <PageLayout
      eyebrow="Company"
      title="Blog"
      subtitle="Notes on retrieval, embeddings, and the parts of document processing that are harder than they look."
      activePath="/blog"
    >
      <PageSection>
        <div className="empty-state-panel">
          <h2>No posts yet</h2>
          <p>
            Nothing has been published. Rather than fill this page with
            placeholder entries, it stays empty until there is something worth
            reading — which is mostly about the parts of this problem that took
            a second attempt: chunk boundaries that do not break sentences,
            embeddings that stay comparable across model versions, and answers
            that admit when retrieval came back empty.
          </p>
          <p>
            In the meantime the{" "}
            <a href={SITE.repoUrl} target="_blank" rel="noopener noreferrer">
              repository
            </a>{" "}
            and its commit history tell the same story in more detail.
          </p>
        </div>
      </PageSection>

      <PageSection title="What will appear here">
        <ul className="plan-includes">
          <li>How chunking choice changes retrieval quality</li>
          <li>Grounding a model on retrieved context, and how to tell it to fail</li>
          <li>What semantic search gets right that keyword search cannot</li>
          <li>Running embeddings asynchronously without losing track of failures</li>
        </ul>
        <p>
          Questions about any of these are welcome via{" "}
          <Link to="/contact">contact</Link>.
        </p>
      </PageSection>
    </PageLayout>
  );
}
