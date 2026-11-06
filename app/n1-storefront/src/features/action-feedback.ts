import type { Dictionary } from "@/i18n";
import type { InquiryOutcome } from "@/ontos/inquiry";

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
