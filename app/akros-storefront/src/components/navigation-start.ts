export const NAVIGATION_START = "sf:navigation-start";

/** Shows the top progress bar at once; hash-only and same-URL navigations are skipped. UI-free, so links and the
 * metadata path that reach it load no component. */
export function startNavigationProgress(href?: string) {
  if (typeof window === "undefined") return;
  if (href !== undefined) {
    try {
      const target = new URL(href, window.location.href);
      if (
        target.origin === window.location.origin &&
        target.pathname === window.location.pathname &&
        target.search === window.location.search
      )
        return;
    } catch {
      // An unparsable href still navigates somewhere: show the bar.
    }
  }
  window.dispatchEvent(new CustomEvent(NAVIGATION_START, { detail: href }));
}
