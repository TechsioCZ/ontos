import { describe, expect, it } from "vitest";
import type { CartState } from "@/features/cart/cart-state";
import {
  createCheckoutDraft,
  getCheckoutTotals,
  getReachableStep,
  parseCheckoutDraft,
  selectDelivery,
  validateAddresses,
  validateMethods,
} from "@/features/checkout/checkout-state";

const cart: CartState = {
  version: 3,
  lines: [
    {
      productId: "chain",
      slug: "chain",
      name: "Řetěz",
      sku: "A4",
      imageSrc: "/chain.jpg",
      imageAlt: "Řetěz",
      unit: "m",
      minimumQuantity: 0.5,
      stockCount: 10,
      priceMinor: 121,
      priceExcludingVatMinor: 100,
      quantity: 0.5,
    },
  ],
};

const methods = [{ id: "PPL", title: "Doprava z owneru", priceMinor: 12900 }];
const validDraft = () => ({
  ...createCheckoutDraft(),
  deliveryId: "PPL",
  email: "customer@example.test",
  billing: {
    firstName: "Test",
    lastName: "Customer",
    street: "Test 1",
    city: "Brno",
    postalCode: "60200",
    country: "CZ",
    phone: "+420777123456",
  },
});
describe("checkout state with owner-supplied methods", () => {
  it("starts empty rather than inventing customer data", () => {
    const draft = createCheckoutDraft();
    expect(draft.email).toBe("");
    expect(draft.billing.firstName).toBe("");
    expect(draft.billing.street).toBe("");
    expect(validateAddresses(draft)).toHaveProperty("billing.street");
    expect(getCheckoutTotals(cart, draft, methods)).toMatchObject({
      subtotal: 61,
      shipping: null,
      net: null,
      vat: null,
    });
  });
  it("accepts only methods actually returned by OntOS", () => {
    expect(validateMethods(validDraft(), [])).toHaveProperty("deliveryId");
    expect(validateMethods(validDraft(), methods)).toEqual({});
    expect(validateMethods({ ...validDraft(), deliveryId: "zasilkovna" }, methods)).toHaveProperty(
      "deliveryId",
    );
    expect(selectDelivery(validDraft(), "CESKA_POSTA").deliveryId).toBe("CESKA_POSTA");
  });
  it("does not skip missing delivery or addresses", () => {
    const draft = validDraft();
    expect(getReachableStep(3, cart, draft, methods)).toBe(3);
    expect(getReachableStep(3, cart, draft, [])).toBe(1);
    expect(getReachableStep(3, cart, { ...draft, email: "invalid" }, methods)).toBe(2);
    expect(getReachableStep(3, { version: 3, lines: [] }, draft, methods)).toBe(0);
  });
  it("uses the owner shipping price but never fabricates tax", () => {
    expect(getCheckoutTotals(cart, validDraft(), methods)).toEqual({
      subtotal: 61,
      shipping: 12900,
      payment: 0,
      total: 12961,
      net: null,
      vat: null,
    });
  });
  it("validates another address only while enabled", () => {
    expect(validateAddresses(validDraft())).toEqual({});
    expect(validateAddresses({ ...validDraft(), differentDeliveryAddress: true })).toHaveProperty(
      "delivery.street",
    );
  });
  it("round trips incomplete drafts and rejects malformed storage", () => {
    const draft = createCheckoutDraft();
    expect(parseCheckoutDraft(JSON.stringify({ version: 1, draft }))).toEqual(draft);
    expect(parseCheckoutDraft("broken")).toEqual(draft);
    expect(
      parseCheckoutDraft(JSON.stringify({ version: 1, draft: { ...draft, billing: null } })),
    ).toEqual(draft);
  });
});
