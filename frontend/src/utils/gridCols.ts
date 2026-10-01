/**
 * Column counts for card grids that must never show a partial row.
 *
 * `repeat(auto-fit, minmax(250px, 1fr))` picks a column count from the
 * *available width* and nothing else — it cannot know how many cards it is
 * laying out. With five cards and a 250px track minimum that produced four
 * columns at 1440px, i.e. a full row of four and then one lone card on a second
 * row with three-quarters of it empty (#580). The identical mistake shipped the
 * "Where to go next" grids on /product and /company as three-across, because
 * three columns fit and the fourth card was simply left over.
 *
 * So the column count is derived from the item count instead: only counts that
 * divide the number of items are used, and the class name carries the count so
 * the rule for each grid is written out where it can be read and argued about
 * rather than being a divisor computed in JavaScript.
 */

/** Counts the stylesheet has a rule for, and what each one resolves to.
 *
 * 2 cols → 2 cols, then 1.  4 divides by 2, so a 2x2 block.
 * 3 cols → 3 cols, then 1.  A 3-item grid skips 2: it would strand one card.
 * 6 cols → 3, then 2, then 1.  6 divides by 3 and by 2, so every row is full
 *           at every width, which is the only count that needs the middle step.
 */
export const GRID_COUNTS = [2, 3, 4, 6] as const;

export type GridCount = (typeof GRID_COUNTS)[number];

function isGridCount(count: number): count is GridCount {
  return (GRID_COUNTS as readonly number[]).includes(count);
}

/**
 * The class that lays out `count` cards without a partial row.
 *
 * Throws for a count with no rule rather than falling back to something that
 * renders an orphan: a grid whose card count has changed should be a loud
 * failure in the test suite, not a layout defect found by looking at a
 * screenshot (#580).
 */
export function balancedGridClass(count: number): string {
  if (!isGridCount(count)) {
    throw new Error(
      `No balanced column rule for ${count} cards — add one to GRID_COUNTS and ` +
        `to the matching .page-grid--n${count} rule in App.css, or pick a ` +
        `card count that divides evenly.`,
    );
  }
  return `page-grid page-grid--n${count}`;
}