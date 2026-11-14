import { afterEach, expect, it, rs } from "@rstest/core";
import { subscribePortalSessionRefresh } from "../src/features/portal-session-events";

afterEach(() => {
  rs.unstubAllGlobals();
});

it("requests immediate re-admission on visible refocus and visibility restoration, and cleans up both listeners", () => {
  const browser = new EventTarget();
  const page = new EventTarget();
  let visibility = "visible";
  Object.defineProperty(page, "visibilityState", { get: () => visibility });
  rs.stubGlobal("window", browser);
  rs.stubGlobal("document", page);
  let pending = false;
  let refreshes = 0;
  const unsubscribe = subscribePortalSessionRefresh(() => {
    pending = true;
    refreshes += 1;
  });
  browser.dispatchEvent(new Event("focus"));
  expect(pending).toBe(true);
  expect(refreshes).toBe(1);
  visibility = "hidden";
  pending = false;
  page.dispatchEvent(new Event("visibilitychange"));
  expect(pending).toBe(false);
  expect(refreshes).toBe(1);
  visibility = "visible";
  page.dispatchEvent(new Event("visibilitychange"));
  expect(pending).toBe(true);
  expect(refreshes).toBe(2);
  unsubscribe();
  browser.dispatchEvent(new Event("focus"));
  page.dispatchEvent(new Event("visibilitychange"));
  expect(refreshes).toBe(2);
});
