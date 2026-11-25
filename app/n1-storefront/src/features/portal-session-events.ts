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
  let activation: { time: number; type: string } | null = null;
  const reset = () => {
    activation = null;
  };
  const visible = (event: Event) => {
    if (activeTargets.document.visibilityState !== "visible") {
      reset();
      return;
    }
    const time = performance.now();
    // Browsers can report the same activation through both events, in either order.
    if (activation !== null && activation.type !== event.type && time - activation.time < 200) {
      reset();
      return;
    }
    activation = { time, type: event.type };
    refresh();
  };
  activeTargets.window.addEventListener("blur", reset);
  activeTargets.window.addEventListener("focus", visible);
  activeTargets.document.addEventListener("visibilitychange", visible);
  return () => {
    activeTargets.window.removeEventListener("blur", reset);
    activeTargets.window.removeEventListener("focus", visible);
    activeTargets.document.removeEventListener("visibilitychange", visible);
  };
};
