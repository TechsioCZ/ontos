import { describe, expect, it } from "vitest";
import { inquiryTaskTitle, parseInquirySubmission } from "@/ontos/inquiry-model";
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
    for (const productId of ["akros-product-fh-ii", inquiry.requestId]) {
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
      { message: "x".repeat(1501) },
      { name: " " },
      { kind: "NEWSLETTER" },
    ])
      expect(parseInquirySubmission({ ...inquiry, ...patch })).toBeNull();
  });
  it("names complaint intake honestly instead of claiming a formal case", () => {
    expect(inquiryTaskTitle({ ...inquiry, kind: "COMPLAINT" })).toBe(
      "Podnět k reklamaci: Materiál",
    );
  });
});
