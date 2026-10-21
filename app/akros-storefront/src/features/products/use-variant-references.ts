"use client";

import { useCallback, useMemo, useSyncExternalStore } from "react";
import {
  parseVariantReferences,
  replaceProductReferences,
  type ProductVariantReference,
} from "@/mock-storefront/variant-references";

const changedEvent = "akros-variant-references-changed";
const unavailable = "storage-unavailable";
const getServerSnapshot = () => undefined;

export function replaceStoredProductReferences(
  storageKey: string,
  productId: string,
  selected: ProductVariantReference[],
) {
  const current = parseVariantReferences(localStorage.getItem(storageKey));
  localStorage.setItem(
    storageKey,
    JSON.stringify(replaceProductReferences(current, productId, selected)),
  );
  window.dispatchEvent(new CustomEvent(changedEvent, { detail: storageKey }));
}

export function useVariantReferences(storageKey: string) {
  const subscribe = useCallback(
    (callback: () => void) => {
      const onStorage = (event: StorageEvent) => {
        if (event.key === storageKey || event.key === null) callback();
      };
      const onChange = (event: Event) => {
        if (event instanceof CustomEvent && event.detail === storageKey) callback();
      };
      window.addEventListener("storage", onStorage);
      window.addEventListener(changedEvent, onChange);
      return () => {
        window.removeEventListener("storage", onStorage);
        window.removeEventListener(changedEvent, onChange);
      };
    },
    [storageKey],
  );
  const getSnapshot = useCallback(() => {
    try {
      return localStorage.getItem(storageKey);
    } catch {
      return unavailable;
    }
  }, [storageKey]);
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  const references = useMemo(() => parseVariantReferences(snapshot), [snapshot]);
  return { references, ready: snapshot !== undefined, available: snapshot !== unavailable };
}
