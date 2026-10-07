import { COMPARISON_ROWS, PLANS } from "../../content/marketing";
import { PlanCellValue } from "./FeatureIcon";

/**
 * Full plan comparison table.
 *
 * Shared by the landing page and `/pricing` so the limits quoted in a sales
 * conversation can only have one source. The Pro column is highlighted in both
 * because the landing page's "Most Popular" badge and this table's emphasis are
 * meant to agree.
 *
 * The wrapper is a focusable scroll region: at 375px the table is 442px wide
 * inside a 330px column, and a scroll container that cannot be scrolled by
 * keyboard is unusable without a mouse. `role="region"` plus a label is the
 * pairing that makes it announceable rather than a mystery tab stop.
 */
export function PlanComparison() {
  return (
    <div className="landing-table-block">
      <div className="landing-table-wrap" tabIndex={0} role="region" aria-label="Plan comparison">
        <table className="landing-table">
          <thead>
            <tr>
              <th scope="col">Compare plans</th>
              {PLANS.map((plan) => (
                <th key={plan.name} scope="col" className={plan.featured ? "pro-head" : undefined}>
                  {plan.name}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {COMPARISON_ROWS.map((row) => (
              <tr key={row.feature}>
                <th scope="row">{row.feature}</th>
                <td>
                  <PlanCellValue value={row.free} />
                </td>
                <td className="pro-cell">
                  <PlanCellValue value={row.pro} />
                </td>
                <td>
                  <PlanCellValue value={row.enterprise} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {/* The table's minimum width is 442px and the column is ~330px on a
          phone, so Enterprise sits off-screen with nothing to say so. Outside
          the wrapper on purpose: inside it, the hint would scroll away with the
          columns. `aria-hidden` because the region above is already labelled
          and this would be a second description of the same table.

          "and down" is not padding. This component's own `max-height: 70vh`
          cap is what hides 8 of the 15 rows on a 375px screen, and a hint that
          only mentions sideways tells the reader the other way round about the
          axis they actually cannot see. No scrollbar is drawn, so the rows
          below the cap had no cue at all. */}
      <p className="landing-table-hint" aria-hidden="true">
        Scroll the table sideways and down to see every plan and feature.
      </p>
    </div>
  );
}
