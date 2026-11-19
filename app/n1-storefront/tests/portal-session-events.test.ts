import { expect, it } from "@rstest/core";
import { subscribePortalSessionRefresh } from "../src/features/portal-session-events";

it("requests immediate re-admission on visible refocus and visibility restoration, and cleans up both listeners", () => {
  const browser = new EventTarget();
  class SessionPage extends EventTarget {
    visibility: DocumentVisibilityState = "visible";

    get visibilityState(): DocumentVisibilityState {
      return this.visibility;
    }
  }
  const page = new SessionPage();
  let pending = false;
  let refreshes = 0;
  const unsubscribe = subscribePortalSessionRefresh(
    () => {
      pending = true;
      refreshes += 1;
    },
    { document: page, window: browser },
  );
  try {
    // Native dispatch completes every synchronous listener before the assertions.
    browser.dispatchEvent(new Event("focus"));
    expect(pending).toBe(true);
    expect(refreshes).toBe(1);
    page.visibility = "hidden";
    pending = false;
    page.dispatchEvent(new Event("visibilitychange"));
    expect(pending).toBe(false);
    expect(refreshes).toBe(1);
    browser.dispatchEvent(new Event("focus"));
    expect(pending).toBe(false);
    expect(refreshes).toBe(1);
    page.visibility = "visible";
    page.dispatchEvent(new Event("visibilitychange"));
    expect(pending).toBe(true);
    expect(refreshes).toBe(2);
    unsubscribe();
    pending = false;
    browser.dispatchEvent(new Event("focus"));
    expect(pending).toBe(false);
    expect(refreshes).toBe(2);
    page.dispatchEvent(new Event("visibilitychange"));
    expect(pending).toBe(false);
    expect(refreshes).toBe(2);
  } finally {
    unsubscribe();
  }
});
