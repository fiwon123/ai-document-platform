import { useEffect } from "react";
import { useLocation } from "react-router-dom";
import { MARKETING_ROUTES } from "../content/marketing";

/** A route is a marketing route when it is one of `MARKETING_ROUTES` or a child
 *  of one (`/challenges/new` under `/challenges`). Read from the shared list
 *  rather than repeated here, so a new marketing page cannot be added to the
 *  router without also getting scroll-to-top. */
function isMarketingRoute(pathname: string): boolean {
  return MARKETING_ROUTES.some((route) => pathname === route || pathname.startsWith(`${route}/`));
}

/**
 * Scrolls to the top when the path changes. Client-side navigation keeps the
 * previous scroll position otherwise, so a footer link lands the visitor
 * mid-page — the marketing pages are long enough that this is disorienting
 * rather than merely untidy.
 *
 * Scoped to the marketing routes: the app views (documents, search, QA) manage
 * their own scroll behaviour around lists and results, and moving them to the
 * top on every navigation would fight that.
 */
export function useScrollToTop() {
  const { pathname } = useLocation();
  useEffect(() => {
    if (isMarketingRoute(pathname)) {
      window.scrollTo(0, 0);
    }
  }, [pathname]);
}
