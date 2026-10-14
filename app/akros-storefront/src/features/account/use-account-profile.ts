"use client";

import { useSyncExternalStore } from "react";
import { accountProfileStorageKey } from "@/mock-storefront/account-profile";

function subscribe(callback: () => void) {
  const onStorage = (event: StorageEvent) => {
    if (event.key === accountProfileStorageKey || event.key === null) callback();
  };
  window.addEventListener("storage", onStorage);
  return () => window.removeEventListener("storage", onStorage);
}
function getSnapshot() {
  try {
    return localStorage.getItem(accountProfileStorageKey);
  } catch {
    return null;
  }
}
export function useAccountProfileSnapshot() {
  return useSyncExternalStore(subscribe, getSnapshot, () => undefined);
}
