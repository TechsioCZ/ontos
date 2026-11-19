"use client";

/** Recheck browser-shared Portal cookies when this document becomes active again. */
export const subscribePortalSessionRefresh = (
  refresh: () => void,
  targets?: {
    document: Pick<Document, "addEventListener" | "removeEventListener" | "visibilityState">;
    window: Pick<Window, "addEventListener" | "removeEventListener">;
  },
) => {
  const activeTargets = targets ?? { document, window };
  const visible = () => {
    if (activeTargets.document.visibilityState === "visible") {
      refresh();
    }
  };
  activeTargets.window.addEventListener("focus", visible);
  activeTargets.document.addEventListener("visibilitychange", visible);
  return () => {
    activeTargets.window.removeEventListener("focus", visible);
    activeTargets.document.removeEventListener("visibilitychange", visible);
  };
};
