import { useState } from "react";
import { Link } from "react-router-dom";
import { PageCta, PageLayout, PageSection } from "../components/PageLayout";
import { PlanComparison } from "../components/landing/PlanComparison";
import { FaqAccordion } from "../components/landing/FaqAccordion";
import { BillingToggle } from "../components/landing/BillingToggle";
import { PlanPrice } from "../components/landing/PlanPrice";
import { Reveal } from "../components/Reveal";
import { balancedGridClass } from "../utils/gridCols";
import { FAQ_ITEMS, PLAN_DETAILS, PLANS } from "../content/marketing";
import { useAuth } from "../hooks/useAuth";

/**
 * Full pricing page.
 *
 * The landing page shows three price cards and the comparison table. This page
 * adds what each limit is actually for, because "20 documents" is not a
 * meaningful objection or a meaningful approval — the reasoning is the part
 * worth reading before buying.
 */
export function PricingPage() {
  const { user } = useAuth();
  const [annual, setAnnual] = useState(false);

  return (
    <PageLayout
      eyebrow="Product"
      title={
        <>
          Pricing that <span className="gradient-text">grows with you</span>
        </>
      }
      subtitle="Start free. Upgrade when the free limits start costing you more than the subscription."
    >
      <PageSection>
        <BillingToggle annual={annual} onChange={setAnnual} />
      </PageSection>

      <PageSection title="Plans">
        <div className="landing-plans forced-dark">
          {PLANS.map((plan, i) => (
            <Reveal key={plan.name} variant="up" delay={Math.min(i * 80, 160)}>
              <article
                className={`landing-plan card-hover${plan.featured ? " landing-plan-featured" : ""}`}
              >
                {plan.featured && <span className="plan-badge">Most Popular</span>}
                <h2>{plan.name}</h2>
                <PlanPrice price={annual ? plan.annual : plan.monthly} period={plan.period} />
                <Link
                  to={user ? "/app" : "/register"}
                  className={`btn ${plan.featured ? "btn-primary" : "btn-secondary"}`}
                >
                  {user ? "Open workspace" : plan.cta}
                </Link>
              </article>
            </Reveal>
          ))}
        </div>
      </PageSection>

      <PageSection title="What each plan includes">
        <div
          className={`${balancedGridClass(PLAN_DETAILS.length)} page-grid-secondary forced-dark`}
        >
          {PLAN_DETAILS.map((plan) => (
            <article key={plan.name} className="page-card-static">
              <h3>{plan.name}</h3>
              <p className="plan-detail-price">
                <strong>{plan.price}</strong> <span>{plan.period}</span>
              </p>
              <p>{plan.blurb}</p>
              <ul className="plan-includes">
                {plan.includes.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            </article>
          ))}
        </div>
      </PageSection>

      <PageSection title="Compare every feature">
        <PlanComparison />
      </PageSection>

      <PageSection title="Questions people actually ask">
        <FaqAccordion items={FAQ_ITEMS} />
      </PageSection>

      <PageCta
        title="Start on the free plan"
        body="No card, no trial countdown. Upload documents, search them, and ask questions as long as the free limits hold."
        secondary={{ to: "/how-it-works", label: "How it works" }}
      />
    </PageLayout>
  );
}
