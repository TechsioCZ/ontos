import { describe, expect, it } from "vitest";
import {
  inquiryActionPayload,
  inquiryTaskTitle,
  parseInquirySubmission,
  type InquirySubmission,
} from "@/ontos/inquiry-model";
const inquiry = {
  requestId: "97672670-44ed-4de3-915d-e40e2cebe99c",
  kind: "CONTACT",
  name: "Pavel",
  email: "pavel@example.com",
  subject: "Materiál",
  message: "Prosím o informaci.",
};
describe("governed inquiry input", () => {
  it("keeps actual contact data and discards caller-owned tenant, owner and product labels", () => {
    expect(
      parseInquirySubmission({
        ...inquiry,
        legalEntityId: "foreign",
        ownerPrincipalRef: {},
        productName: "invented",
      }),
    ).toEqual(inquiry);
  });
  it("accepts bounded opaque catalog identities, not only UUIDs, for a product inquiry", () => {
    expect(parseInquirySubmission({ ...inquiry, kind: "PRODUCT_QUESTION" })).toBeNull();
    for (const productId of ["sf-product-fh-ii", inquiry.requestId]) {
      expect(
        parseInquirySubmission({ ...inquiry, kind: "PRODUCT_QUESTION", productId })?.productId,
      ).toBe(productId);
    }
    for (const productId of ["", " ", "p".repeat(301), 123]) {
      expect(
        parseInquirySubmission({ ...inquiry, kind: "PRODUCT_QUESTION", productId }),
      ).toBeNull();
    }
    expect(parseInquirySubmission({ ...inquiry, productId: inquiry.requestId })).toBeNull();
  });
  it("refuses invalid email, missing replay identity and oversized messages", () => {
    for (const patch of [
      { email: "no-address" },
      { requestId: "" },
      // The task owner accepts only a versioned RFC UUID as the request id.
      { requestId: "97672670-44ed-0de3-915d-e40e2cebe99c" },
      { requestId: "97672670-44ed-4de3-715d-e40e2cebe99c" },
      { email: `${"e".repeat(243)}@example.com` },
      { subject: "s".repeat(161) },
      { name: "n".repeat(121) },
      { message: "x".repeat(1501) },
      { name: " " },
      { kind: "NEWSLETTER" },
    ])
      expect(parseInquirySubmission({ ...inquiry, ...patch })).toBeNull();
  });
  it("trims customer text and keeps values at the owner's limits", () => {
    const edge = {
      name: "n".repeat(120),
      email: `${"e".repeat(242)}@example.com`,
      subject: "s".repeat(160),
      message: "m".repeat(1500),
    };
    expect(
      parseInquirySubmission({
        ...inquiry,
        name: ` ${edge.name}\n`,
        email: ` ${edge.email} `,
        subject: `\t${edge.subject} `,
        message: ` ${edge.message} `,
      }),
    ).toEqual({ ...inquiry, ...edge });
  });
  it("builds exactly the submit-storefront-inquiry payload", () => {
    const question = {
      ...inquiry,
      kind: "PRODUCT_QUESTION",
      productId: "sf-product",
    } as InquirySubmission;
    expect(inquiryActionPayload(inquiry as InquirySubmission)).toEqual({
      title: "Kontaktní dotaz: Materiál",
      description: "Kontakt: Pavel <pavel@example.com>\n\nProsím o informaci.",
      storefrontInquiry: inquiry,
    });
    expect(
      inquiryActionPayload(question, {
        productId: "sf-product",
        productName: " Šroub M8 ",
        productSlug: "sroub-m8",
      }),
    ).toEqual({
      title: "Dotaz na produkt: Materiál",
      description: "Kontakt: Pavel <pavel@example.com>\nProdukt: Šroub M8\n\nProsím o informaci.",
      storefrontInquiry: { ...question, productName: "Šroub M8", productSlug: "sroub-m8" },
    });
  });
  it("refuses instead of clipping when the task text would exceed the owner's limits", () => {
    const question = {
      ...inquiry,
      kind: "PRODUCT_QUESTION",
      productId: "sf-product",
      name: "N".repeat(120),
      email: `${"e".repeat(88)}@example.com`,
      message: "m".repeat(1500),
    } as InquirySubmission;
    const product = (productName: string) => ({
      productId: "sf-product",
      productName,
      productSlug: "sroub-m8",
    });
    const prefix = `Kontakt: ${question.name} <${question.email}>\nProdukt: \n\n`.length;
    const fitting = inquiryActionPayload(question, product("P".repeat(2000 - 1500 - prefix)));
    expect(fitting?.description).toHaveLength(2000);
    expect(fitting?.storefrontInquiry.message).toBe(question.message);
    expect(inquiryActionPayload(question, product("P".repeat(2001 - 1500 - prefix)))).toBeNull();
    expect(
      inquiryActionPayload({ ...question, message: "?" }, product("P".repeat(301))),
    ).toBeNull();
    expect(inquiryActionPayload({ ...question, message: "?" }, product(" "))).toBeNull();
    // A product question without its owner product (or the reverse) is never sent.
    expect(inquiryActionPayload(question)).toBeNull();
    expect(inquiryActionPayload(inquiry as InquirySubmission, product("Šroub"))).toBeNull();
  });
  it("names complaint intake honestly instead of claiming a formal case", () => {
    expect(inquiryTaskTitle({ ...inquiry, kind: "COMPLAINT" })).toBe(
      "Podnět k reklamaci: Materiál",
    );
  });
});
