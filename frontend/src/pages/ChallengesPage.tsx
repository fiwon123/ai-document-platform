import { Link } from "react-router-dom";
import { PageLayout, PageSection } from "../components/PageLayout";
import { EmptyState } from "../components/EmptyState";
import {
  CHALLENGES_EMPTY,
  CHALLENGES_SUBTITLE,
  CHALLENGES_TITLE,
  NEW_CHALLENGE_CTA,
} from "../content/challenges";

/**
 * `/challenges` — the index.
 *
 * Frontend only for now, so this is a title, a subtitle, the create button, and
 * an honest empty state. There is no sample data on purpose: invented challenge
 * cards would look identical to real ones, and a visitor has no way to tell.
 *
 * The create button is passed as `heroAction` rather than being rendered in the
 * body, because it belongs to the title block: the hero is a centred column, and
 * a button beside a centred title is on the wrong axis. See `PageLayout`.
 */
export function ChallengesPage() {
  return (
    <PageLayout
      title={CHALLENGES_TITLE}
      subtitle={CHALLENGES_SUBTITLE}
      heroAction={
        <Link to="/challenges/new" className="btn btn-primary btn-lg">
          {/* Decorative. The `+` is not in the label, so the accessible name
              stays "New challenge" rather than "plus new challenge". */}
          <span className="hero-plus" aria-hidden="true">
            +
          </span>
          {NEW_CHALLENGE_CTA}
        </Link>
      }
    >
      <PageSection>
        {/* No `action` here on purpose: the create button is already in the
            hero, directly above this, and a second identical CTA a scroll
            away reads as two different offers rather than one. This block's
            job is to explain why the list is empty. */}
        <EmptyState title={CHALLENGES_EMPTY.title} description={CHALLENGES_EMPTY.body} />
      </PageSection>
    </PageLayout>
  );
}
