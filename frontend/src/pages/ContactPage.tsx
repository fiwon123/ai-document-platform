import { Link } from "react-router-dom";
import { PageLayout, PageSection } from "../components/PageLayout";
import { SITE } from "../content/marketing";

/**
 * Contact page.
 *
 * Channels rather than a form: a contact form would need a backend endpoint,
 * spam handling, and a retention decision for the submissions — none of which
 * exist yet, and shipping a form that silently drops mail is worse than not
 * shipping one. GitHub issues are the primary channel because they are public
 * and searchable.
 */
export function ContactPage() {
  return (
    <PageLayout
      eyebrow="Company"
      title="Contact"
      subtitle="The fastest way to reach us is an issue on the repository. Everything else is slower to read and harder to search later."
      activePath="/contact"
    >
      <PageSection title="Where to go">
        <div className="contact-list">
          <div className="contact-row">
            <h3>Bugs and feature requests</h3>
            <p>
              Open an issue. Include what you expected, what happened, and the
              document status if processing failed — that last one usually
              identifies the problem immediately.
            </p>
            <a
              className="btn btn-primary"
              href={`${SITE.repoUrl}/issues`}
              target="_blank"
              rel="noopener noreferrer"
            >
              Open an issue on GitHub
            </a>
          </div>

          <div className="contact-row">
            <h3>Source code</h3>
            <p>
              The full stack is open source: backend, worker, front end,
              infrastructure, and CI.
            </p>
            <a
              className="btn btn-secondary"
              href={SITE.repoUrl}
              target="_blank"
              rel="noopener noreferrer"
            >
              View the repository
            </a>
          </div>

          <div className="contact-row">
            <h3>Security reports</h3>
            <p>
              Please report vulnerabilities privately rather than in a public
              issue, and give us a reasonable window to ship a fix before
              disclosure.
            </p>
            <a className="btn btn-secondary" href={`mailto:${SITE.securityEmail}`}>
              {SITE.securityEmail}
            </a>
          </div>

          <div className="contact-row">
            <h3>Everything else</h3>
            <p>General questions, partnerships, and anything that does not fit above.</p>
            <a className="btn btn-secondary" href={`mailto:${SITE.email}`}>
              {SITE.email}
            </a>
          </div>
        </div>
      </PageSection>

      <PageSection title="Before you write">
        <p>
          A few questions come up often enough to answer here.{" "}
          <Link to="/how-it-works">How it works</Link> covers what happens to an
          uploaded file and why documents can be <code>pending</code> for a
          while. <Link to="/pricing">Pricing</Link> covers limits. If a
          document is stuck in <code>processing</code>, the error field on the
          document detail view is the first thing to look at.
        </p>
        <p>
          Note that the email addresses above use a placeholder domain and must
          be replaced with a real mailbox before this page is published.
        </p>
      </PageSection>
    </PageLayout>
  );
}
