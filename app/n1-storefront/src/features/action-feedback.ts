import type { Dictionary } from "@/i18n";
import type { InquiryOutcome } from "@/ontos/inquiry";
import type { PasswordRecoveryOutcome } from "@/ontos/password-recovery";

export type ContactFeedbackState = InquiryOutcome["state"] | "idle" | "pending";
export type ProfileFeedbackState =
  | "idle"
  | "saving"
  | "saved"
  | "invalid"
  | "anonymous"
  | "forbidden"
  | "conflict"
  | "unavailable"
  | "unconfirmed";

interface ActionFeedback {
  statusText: string;
  successToast: { title: string; type: "success" } | null;
}

/** Presentation only; callers emit notifications at the confirmed completion event. */
export const contactActionFeedback = (
  state: ContactFeedbackState,
  copy: Dictionary["contact"],
): ActionFeedback => {
  const messages = {
    forbidden: copy.forbidden,
    idle: "",
    invalid: copy.invalid,
    pending: "",
    sent: "",
    unavailable: copy.formUnavailable,
    unconfirmed: copy.unconfirmed,
  } satisfies Record<ContactFeedbackState, string>;
  return {
    statusText: messages[state],
    successToast: state === "sent" ? { title: copy.sent, type: "success" } : null,
  };
};

export const profileActionFeedback = (
  state: ProfileFeedbackState,
  copy: Dictionary["accountPage"],
): ActionFeedback => ({
  statusText: state === "idle" || state === "saving" || state === "saved" ? "" : copy[state],
  successToast: state === "saved" ? { title: copy.saved, type: "success" } : null,
});

export const passwordRecoveryActionFeedback = (
  state: PasswordRecoveryOutcome["state"] | null,
  mode: "request" | "reset",
  d: Dictionary,
): ActionFeedback => {
  if (state === null) {
    return { statusText: "", successToast: null };
  }
  const copy = d.passwordRecovery;
  if (state === "completed" && mode === "reset") {
    return {
      statusText: copy.completedNextStep,
      successToast: { title: copy.states.completed, type: "success" },
    };
  }
  // The shared outcome union permits both steps; only confirm the current one.
  const messages = {
    ...copy.states,
    completed: copy.requestUnconfirmed,
    invalid: mode === "request" ? d.auth.errors.email : copy.states.invalid,
    requested: mode === "reset" ? copy.states.unconfirmed : copy.states.requested,
    unconfirmed: mode === "request" ? copy.requestUnconfirmed : copy.states.unconfirmed,
  };
  return { statusText: messages[state], successToast: null };
};
