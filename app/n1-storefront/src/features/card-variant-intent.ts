type ExpansionIntent = "activation" | "focus" | "pointer";

/** A Popover's restored trigger focus is dismissal completion, not fresh expansion intent. */
export const makeCardVariantIntent = () => {
  let active = false;
  let activated = false;
  let dismissedFocus = false;
  return {
    dismiss: (restoreFocus: boolean) => {
      active = false;
      activated = false;
      dismissedFocus = restoreFocus;
    },
    fail: () => {
      const announce = active && activated;
      active = false;
      activated = false;
      return announce;
    },
    isActive: () => active,
    leave: () => {
      active = false;
      activated = false;
      dismissedFocus = false;
    },
    request: (source: ExpansionIntent) => {
      if (source === "focus" && dismissedFocus) {
        return false;
      }
      active = true;
      if (source === "activation") {
        activated = true;
      }
      dismissedFocus = false;
      return true;
    },
  };
};
