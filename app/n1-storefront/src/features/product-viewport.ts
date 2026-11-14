"use client";

import { useSyncExternalStore } from "react";

// Match the canonical N1 md token. Kit variant props are scalar, so the same
// link receives new props after hydration/resizing instead of being duplicated.
export const productViewport = {
  getServerSnapshot: () => false,
  getSnapshot: () => window.matchMedia("(min-width: 768px)").matches,
  subscribe: (listener: () => void) => {
    const media = window.matchMedia("(min-width: 768px)");
    media.addEventListener("change", listener);
    return () => media.removeEventListener("change", listener);
  },
};

export const useDesktopProduct = () =>
  useSyncExternalStore(
    productViewport.subscribe,
    productViewport.getSnapshot,
    productViewport.getServerSnapshot,
  );
