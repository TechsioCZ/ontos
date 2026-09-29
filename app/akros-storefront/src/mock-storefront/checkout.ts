import { type CartState, getCartSubtotal } from "./cart";
import { mockCustomer } from "./fixtures/account";
import {
  checkoutDeliveryMethods,
  checkoutPaymentMethods,
  checkoutPickupPoints,
  demoStoreAddress,
} from "./fixtures/checkout";

export const checkoutSteps = [
  { title: "Nákupní košík", href: "/kosik" },
  { title: "Doprava a platba", href: "/kosik/doprava-platba" },
  { title: "Dodací údaje", href: "/kosik/dodaci-udaje" },
  { title: "Shrnutí objednávky", href: "/kosik/shrnuti" },
] as const;

export interface CheckoutAddress {
  firstName: string;
  lastName: string;
  street: string;
  city: string;
  postalCode: string;
  country: string;
  phone: string;
}

export interface CheckoutDraft {
  deliveryId: string;
  paymentId: string;
  pickupPointId: string;
  email: string;
  company: string;
  companyId: string;
  vatId: string;
  billing: CheckoutAddress;
  delivery: CheckoutAddress;
  differentDeliveryAddress: boolean;
  newsletter: boolean;
}

export type CheckoutErrors = Record<string, string>;
export const createCheckoutDraft = (): CheckoutDraft => ({
  deliveryId: "",
  paymentId: "",
  pickupPointId: "",
  email: mockCustomer.email,
  company: mockCustomer.company,
  companyId: "12345678",
  vatId: "CZ12345678",
  billing: {
    firstName: "Jan",
    lastName: "Novák",
    street: "Průmyslová 1420",
    city: "Praha 10",
    postalCode: "102 00",
    country: "CZ",
    phone: "+420777123456",
  },
  delivery: {
    firstName: "",
    lastName: "",
    street: "",
    city: "",
    postalCode: "",
    country: "CZ",
    phone: "",
  },
  differentDeliveryAddress: false,
  newsletter: false,
});

export const getDelivery = (draft: CheckoutDraft) =>
  checkoutDeliveryMethods.find((method) => method.id === draft.deliveryId);
export const getPayment = (draft: CheckoutDraft) =>
  checkoutPaymentMethods.find((method) => method.id === draft.paymentId);
export const getDeliveryAddress = (draft: CheckoutDraft) =>
  draft.differentDeliveryAddress ? draft.delivery : draft.billing;

export function getDeliveryLocation(draft: CheckoutDraft): string {
  if (draft.deliveryId === "osobni") return demoStoreAddress;
  if (getDelivery(draft)?.pickup)
    return (
      checkoutPickupPoints.find((point) => point.id === draft.pickupPointId)?.label ??
      "Výdejní místo není vybráno"
    );
  const address = getDeliveryAddress(draft);
  return `${address.street}, ${address.postalCode} ${address.city}`;
}

export function selectDelivery(draft: CheckoutDraft, deliveryId: string): CheckoutDraft {
  return {
    ...draft,
    deliveryId,
    pickupPointId: draft.deliveryId === deliveryId ? draft.pickupPointId : "",
    paymentId: getPayment(draft)?.pickupOnly && deliveryId !== "osobni" ? "" : draft.paymentId,
  };
}

export function validateMethods(draft: CheckoutDraft): CheckoutErrors {
  const errors: CheckoutErrors = {};
  const delivery = getDelivery(draft);
  const payment = getPayment(draft);
  if (!delivery) errors.deliveryId = "Vyberte způsob dopravy.";
  if (!payment || (payment.pickupOnly && delivery?.id !== "osobni"))
    errors.paymentId = "Vyberte dostupný způsob platby.";
  if (
    delivery?.pickup &&
    !checkoutPickupPoints.some(
      (point) => point.id === draft.pickupPointId && point.deliveryId === delivery.id,
    )
  )
    errors.pickupPointId = "Vyberte výdejní místo.";
  return errors;
}

export function validateAddresses(draft: CheckoutDraft): CheckoutErrors {
  const errors: CheckoutErrors = {};
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(draft.email.trim()))
    errors.email = "Zadejte platný e-mail.";
  const validateAddress = (address: CheckoutAddress, prefix: string) => {
    for (const key of ["firstName", "lastName", "street", "city"] as const) {
      if (!address[key].trim()) errors[`${prefix}.${key}`] = "Vyplňte toto pole.";
    }
    if (!/^\d{3}\s?\d{2}$/.test(address.postalCode.trim()))
      errors[`${prefix}.postalCode`] = "Zadejte PSČ ve tvaru 123 45.";
    if (address.country !== "CZ")
      errors[`${prefix}.country`] = "Prototyp podporuje doručení pouze v České republice.";
    if (!/^(?:\+420)?\d{9}$/.test(address.phone.replace(/[\s()-]/g, "")))
      errors[`${prefix}.phone`] = "Zadejte platné české telefonní číslo.";
  };
  validateAddress(draft.billing, "billing");
  if (draft.differentDeliveryAddress) validateAddress(draft.delivery, "delivery");
  if (draft.companyId && !/^\d{8}$/.test(draft.companyId.trim()))
    errors.companyId = "IČ musí obsahovat 8 číslic.";
  return errors;
}

export function getReachableStep(target: number, cart: CartState, draft: CheckoutDraft): number {
  if (cart.lines.length === 0) return 0;
  if (target > 1 && Object.keys(validateMethods(draft)).length) return 1;
  if (target > 2 && Object.keys(validateAddresses(draft)).length) return 2;
  return Math.max(0, Math.min(target, 3));
}

export function getCheckoutTotals(cart: CartState, draft: CheckoutDraft) {
  const delivery = getDelivery(draft);
  const payment = getPayment(draft);
  const subtotal = getCartSubtotal(cart);
  const shipping = delivery?.priceMinor ?? null;
  const paymentPrice =
    payment && (!payment.pickupOnly || delivery?.id === "osobni") ? payment.priceMinor : 0;
  const total = subtotal + (shipping ?? 0) + paymentPrice;
  const hasNet = cart.lines.every((line) => line.priceExcludingVatMinor !== undefined);
  const net = hasNet
    ? cart.lines.reduce(
        (sum, line) => sum + Math.round((line.priceExcludingVatMinor ?? 0) * line.quantity),
        0,
      ) +
      (delivery?.priceExcludingVatMinor ?? 0) +
      (paymentPrice > 0 ? (payment?.priceExcludingVatMinor ?? 0) : 0)
    : null;
  return {
    subtotal,
    shipping,
    payment: paymentPrice,
    total,
    net,
    vat: net === null ? null : total - net,
  };
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;
const addressKeys = [
  "firstName",
  "lastName",
  "street",
  "city",
  "postalCode",
  "country",
  "phone",
] as const;
const draftKeys = [
  "deliveryId",
  "paymentId",
  "pickupPointId",
  "email",
  "company",
  "companyId",
  "vatId",
] as const;

export function isCheckoutDraft(value: unknown): value is CheckoutDraft {
  if (!isRecord(value)) return false;
  const addresses = [value.billing, value.delivery];
  return (
    draftKeys.every((key) => typeof value[key] === "string") &&
    typeof value.differentDeliveryAddress === "boolean" &&
    typeof value.newsletter === "boolean" &&
    addresses.every(
      (address) =>
        isRecord(address) && addressKeys.every((key) => typeof address[key] === "string"),
    )
  );
}

export function parseCheckoutDraft(value: string | null): CheckoutDraft {
  try {
    const parsed: unknown = JSON.parse(value ?? "null");
    if (isRecord(parsed) && parsed.version === 1 && isCheckoutDraft(parsed.draft))
      return parsed.draft;
  } catch {
    /* An incomplete/corrupt local draft is safe to replace with defaults. */
  }
  return createCheckoutDraft();
}
