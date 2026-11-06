import { describe, expect, it } from "@rstest/core";
import { contactActionFeedback, profileActionFeedback } from "../src/features/action-feedback";
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
