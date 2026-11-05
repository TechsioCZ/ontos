type ExpansionIntent = "activation" | "focus" | "pointer";

/** A Popover's restored trigger focus is dismissal completion, not fresh expansion intent. */
export const makeCardVariantIntent = () => {
  let active = false;
  let dismissedFocus = false;
  return {
    dismiss: (restoreFocus: boolean) => {
      active = false;
      dismissedFocus = restoreFocus;
    },
    isActive: () => active,
    leave: () => {
      active = false;
      dismissedFocus = false;
    },
    request: (source: ExpansionIntent) => {
      if (source === "focus" && dismissedFocus) {
        return false;
      }
      active = true;
      dismissedFocus = false;
      return true;
    },
  };
};
