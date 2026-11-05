"use client";

/** Recheck browser-shared Portal cookies when this document becomes active again. */
export const subscribePortalSessionRefresh = (refresh: () => void) => {
  const visible = () => {
    if (document.visibilityState === "visible") {
      refresh();
    }
  };
  window.addEventListener("focus", visible);
  document.addEventListener("visibilitychange", visible);
  return () => {
    window.removeEventListener("focus", visible);
    document.removeEventListener("visibilitychange", visible);
  };
};
