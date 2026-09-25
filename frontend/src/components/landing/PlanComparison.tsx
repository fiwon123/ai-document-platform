import { COMPARISON_ROWS, PLANS } from "../../content/marketing";
import { PlanCellValue } from "./FeatureIcon";

/**
 * Full plan comparison table.
 *
 * Shared by the landing page and `/pricing` so the limits quoted in a sales
 * conversation can only have one source. The Pro column is highlighted in both
 * because the landing page's "Most Popular" badge and this table's emphasis are
 * meant to agree.
 */
export function PlanComparison() {
  return (
    <div className="landing-table-wrap">
      <table className="landing-table">
        <thead>
          <tr>
            <th scope="col">Compare plans</th>
            {PLANS.map((plan) => (
              <th
                key={plan.name}
                scope="col"
                className={plan.featured ? "pro-head" : undefined}
              >
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
  );
}
