import { describe, expect, it } from "@rstest/core";
import {
  contactActionFeedback,
  passwordRecoveryActionFeedback,
  profileActionFeedback,
} from "../src/features/action-feedback";
import { getDictionary } from "../src/i18n";

describe("confirmed action feedback", () => {
  for (const locale of ["cs", "en"]) {
    const d = getDictionary(locale);
    it(`announces a confirmed inquiry through a toast without an inline success (${locale})`, () => {
      expect(contactActionFeedback("sent", d.contact)).toEqual({
        statusText: "",
        successToast: { title: d.contact.sent, type: "success" },
      });
    });
    it(`announces a confirmed profile save through a toast without an inline success (${locale})`, () => {
      expect(profileActionFeedback("saved", d.accountPage)).toEqual({
        statusText: "",
        successToast: { title: d.accountPage.saved, type: "success" },
      });
    });
  }
  const d = getDictionary("cs");
  it("leaves pending feedback to the loading button without announcing success", () => {
    expect(contactActionFeedback("pending", d.contact)).toEqual({
      statusText: "",
      successToast: null,
    });
    expect(profileActionFeedback("saving", d.accountPage)).toEqual({
      statusText: "",
      successToast: null,
    });
  });
  it("does not announce anything while idle", () => {
    expect(contactActionFeedback("idle", d.contact)).toEqual({
      statusText: "",
      successToast: null,
    });
    expect(profileActionFeedback("idle", d.accountPage)).toEqual({
      statusText: "",
      successToast: null,
    });
  });
  for (const state of ["invalid", "forbidden", "unavailable", "unconfirmed"] as const) {
    it(`keeps an inquiry ${state} outcome available inline and never calls it success`, () => {
      expect(contactActionFeedback(state, d.contact)).toEqual({
        statusText: state === "unavailable" ? d.contact.formUnavailable : d.contact[state],
        successToast: null,
      });
    });
  }
  for (const state of [
    "invalid",
    "anonymous",
    "forbidden",
    "conflict",
    "unavailable",
    "unconfirmed",
  ] as const) {
    it(`keeps a profile ${state} outcome available inline and never calls it success`, () => {
      expect(profileActionFeedback(state, d.accountPage)).toEqual({
        statusText: d.accountPage[state],
        successToast: null,
      });
    });
  }
});

describe("password recovery action feedback", () => {
  for (const locale of ["cs", "en"]) {
    const d = getDictionary(locale);
    it(`maps a completed reset to a toast while retaining the next step (${locale})`, () => {
      expect(passwordRecoveryActionFeedback("completed", "reset", d)).toEqual({
        statusText: d.passwordRecovery.completedNextStep,
        successToast: { title: d.passwordRecovery.states.completed, type: "success" },
      });
    });
    it(`keeps conditional email guidance without claiming delivery (${locale})`, () => {
      expect(passwordRecoveryActionFeedback("requested", "request", d)).toEqual({
        statusText: d.passwordRecovery.states.requested,
        successToast: null,
      });
    });
    it(`does not confirm an outcome belonging to the other recovery step (${locale})`, () => {
      expect(passwordRecoveryActionFeedback("completed", "request", d)).toEqual({
        statusText: d.passwordRecovery.requestUnconfirmed,
        successToast: null,
      });
      expect(passwordRecoveryActionFeedback("requested", "reset", d)).toEqual({
        statusText: d.passwordRecovery.states.unconfirmed,
        successToast: null,
      });
    });
    for (const mode of ["request", "reset"] as const) {
      it(`does not announce idle ${mode} feedback (${locale})`, () => {
        expect(passwordRecoveryActionFeedback(null, mode, d)).toEqual({
          statusText: "",
          successToast: null,
        });
      });
      for (const state of [
        "invalid",
        "invalid-token",
        "forbidden",
        "rate-limited",
        "reconciliation",
        "unavailable",
        "unconfirmed",
      ] as const) {
        it(`keeps ${mode} ${state} guidance persistent without success (${locale})`, () => {
          let expected = d.passwordRecovery.states[state];
          if (mode === "request" && state === "invalid") {
            expected = d.auth.errors.email;
          }
          if (mode === "request" && state === "unconfirmed") {
            expected = d.passwordRecovery.requestUnconfirmed;
          }
          expect(passwordRecoveryActionFeedback(state, mode, d)).toEqual({
            statusText: expected,
            successToast: null,
          });
        });
      }
    }
  }
});
