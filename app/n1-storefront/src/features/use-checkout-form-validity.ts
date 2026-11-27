"use client";

import { useSyncExternalStore } from "react";

/**
 * Native constraints also cover browser autofill, controlled defaults and saved-address copies.
 * Every field is a controlled React input, so validity is read after React commits a keystroke: the
 * commit rewrites the input's attributes, which the observer sees. A native "input" listener on the
 * form would run before React's own handler, re-render with the previous value and swallow the
 * keystroke whenever it changed the form's validity.
 */
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
    form.addEventListener("change", changed);
    return () => {
      observer.disconnect();
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
