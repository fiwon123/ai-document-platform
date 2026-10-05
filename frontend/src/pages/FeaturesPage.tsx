import { Link } from "react-router-dom";
import {
  PageCardIcon,
  PageCta,
  PageLayout,
  PageSection,
} from "../components/PageLayout";
import { FeatureIcon } from "../components/landing/FeatureIcon";
import { ArchitectureDiagram } from "../components/landing/ArchitectureDiagram";
import { balancedGridClass } from "../utils/gridCols";
import { CORE_FEATURES, SECONDARY_FEATURES } from "../content/marketing";

/**
 * Detailed feature catalogue.
 *
 * The landing page shows the same features as a compact grid; this page is the
 * version someone reads while deciding whether to adopt the product, so each
 * capability gets the "what it does / why it exists" split instead of a
 * one-line card.
 */
export function FeaturesPage() {
  return (
    <PageLayout
      eyebrow="Product"
      title={
        <>
          Everything you need to{" "}
          <span className="gradient-text">know your documents</span>
        </>
      }
      subtitle="Upload, search, and ask — one private workspace per user. This page is the long version of the feature grid on the home page."
    >
      <PageSection title="Core capabilities">
        <div className={`${balancedGridClass(CORE_FEATURES.length)}`}>
          {CORE_FEATURES.map((feature) => (
            <article key={feature.title} className="page-card-static" data-accent={feature.accent}>
              <PageCardIcon>
                <FeatureIcon path={feature.icon} />
              </PageCardIcon>
              <h3>{feature.title}</h3>
              <p>{feature.body}</p>
            </article>
          ))}
        </div>
      </PageSection>

      <PageSection title="More to explore">
        <div className={`${balancedGridClass(SECONDARY_FEATURES.length)} page-grid-secondary`}>
          {SECONDARY_FEATURES.map((feature) => (
            <article key={feature.title} className="page-card-static" data-accent={feature.accent}>
              <PageCardIcon>
                <FeatureIcon path={feature.icon} />
              </PageCardIcon>
              <h3>{feature.title}</h3>
              <p>{feature.body}</p>
            </article>
          ))}
        </div>
      </PageSection>

      <PageSection title="How the pieces fit together">
        {/* Two columns on desktop: prose left, the diagram right. The prose was
            in a 52ch column with the right half of the page empty (#581) — this
            is the section that explains the architecture, so it gets to show the
            shape rather than only describe it.

            `.page-split`, not a page-specific rule (#585): the five Company-family
            pages needed the same two-lane split, and a second copy of it is how
            the two drift apart. */}
        <div className="page-split">
          <div className="page-split-prose">
            <p>
              The features above are not independent add-ons — they are stages of one
              pipeline. Uploading starts an asynchronous job; extraction and chunking
              run in a background worker; embeddings are written to{" "}
              <code>pgvector</code>; search and Q&amp;A both read from that index.
              Nothing in the request path waits on a model call, which is what keeps
              the workspace responsive while a large upload is still being processed.
            </p>
        <p>
              The <Link to="/how-it-works">How it works</Link> page walks through
              each stage with the detail. If you are evaluating rather than
              learning, <Link to="/pricing">Pricing</Link> is usually the faster
              read.
            </p>
          </div>
          <ArchitectureDiagram />
        </div>
      </PageSection>

      <PageCta
        title="See it on your own documents"
        body="Create a workspace, upload a handful of files, and ask something only your documents can answer."
      />

    </PageLayout>
  );
}
