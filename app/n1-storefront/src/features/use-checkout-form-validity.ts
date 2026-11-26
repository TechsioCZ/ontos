"use client";

import { useSyncExternalStore } from "react";

/** Native constraints also cover browser autofill, controlled defaults and saved-address copies. */
export const useCheckoutFormValidity = (form: HTMLFormElement | null) => {
  const subscribe = (changed: () => void) => {
    if (form === null) {
      return () => {
        // There is no DOM subscription before the form mounts.
      };
    }
    const observer = new MutationObserver(changed);
    observer.observe(form, {
      attributeFilter: [
        "value",
        "checked",
        "selected",
        "disabled",
        "required",
        "pattern",
        "minlength",
        "maxlength",
        "type",
      ],
      childList: true,
      subtree: true,
    });
    form.addEventListener("input", changed);
    form.addEventListener("change", changed);
    return () => {
      observer.disconnect();
      form.removeEventListener("input", changed);
      form.removeEventListener("change", changed);
    };
  };
  const snapshot = () => {
    const controls = form?.querySelectorAll<HTMLInputElement | HTMLSelectElement>(
      "input[name], select[name]",
    );
    return (
      controls !== undefined &&
      controls.length > 0 &&
      [...controls].every((control) => control.validity.valid)
    );
  };
  return useSyncExternalStore(subscribe, snapshot, () => false);
};
