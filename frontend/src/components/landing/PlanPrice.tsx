/**
 * A plan's price, split into the parts that need to be different sizes.
 *
 * #583 asked for a deliberate scale — currency smaller, amount dominant,
 * period small and de-emphasised. That is only expressible if the price is
 * three elements rather than one string, so this component does the split and
 * both the landing page and `/pricing` render it. The copy still lives in
 * `content/marketing.ts`; nothing here decides what a plan costs.
 *
 * "Custom" is a word, not a figure. Set at the amount's size it is wider than
 * the figures beside it but the same height, which is the point: it has to
 * read as a price being quoted rather than as loose text under the plan name.
 */
import { splitPrice } from "../../utils/splitPrice";

export interface PlanPriceProps {
  /** The price as written in `content/marketing.ts`, e.g. "$12" or "Custom". */
  price: string;
  /** The billing qualifier, e.g. "per month" or "forever". */
  period: string;
}

export function PlanPrice({ price, period }: PlanPriceProps) {
  const { currency, amount } = splitPrice(price);
  // A word carries no digits, so this is the "Custom" branch. It gets the
  // amount's size (optical parity with a figure) via its own class rather than
  // a `isWord` conditional on the amount element, so the class is assertable.
  const isWord = !/\d/.test(amount);

  return (
    <p className="landing-price">
      <span className="landing-price-figure">
        {currency && <span className="landing-price-currency">{currency}</span>}
        <span className={`landing-price-amount${isWord ? " landing-price-amount-word" : ""}`}>
          {amount}
        </span>
      </span>
      <span className="landing-price-period">{period}</span>
    </p>
  );
}