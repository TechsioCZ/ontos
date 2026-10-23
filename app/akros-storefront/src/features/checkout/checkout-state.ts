import { type CartState, getCartSubtotal } from "@/features/cart/cart-state";

export interface DeliveryMethod {
  id: string;
  title: string;
  priceMinor: number;
}

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
  email: string;
  company: string;
  companyId: string;
  vatId: string;
  billing: CheckoutAddress;
  delivery: CheckoutAddress;
  differentDeliveryAddress: boolean;
}

export type CheckoutErrors = Record<string, string>;
export const createCheckoutDraft = (): CheckoutDraft => ({
  deliveryId: "",
  email: "",
  company: "",
  companyId: "",
  vatId: "",
  billing: {
    firstName: "",
    lastName: "",
    street: "",
    city: "",
    postalCode: "",
    country: "CZ",
    phone: "",
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
});

export const getDelivery = (draft: CheckoutDraft, methods: readonly DeliveryMethod[]) =>
  methods.find((method) => method.id === draft.deliveryId);
export const getDeliveryAddress = (draft: CheckoutDraft) =>
  draft.differentDeliveryAddress ? draft.delivery : draft.billing;

export function getDeliveryLocation(draft: CheckoutDraft): string {
  const address = getDeliveryAddress(draft);
  return `${address.street}, ${address.postalCode} ${address.city}`;
}

export function selectDelivery(draft: CheckoutDraft, deliveryId: string): CheckoutDraft {
  return { ...draft, deliveryId };
}

export function validateMethods(
  draft: CheckoutDraft,
  methods: readonly DeliveryMethod[],
): CheckoutErrors {
  return getDelivery(draft, methods)
    ? {}
    : { deliveryId: "Vyberte způsob dopravy z nabídky OntOS." };
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
      errors[`${prefix}.country`] = "Doručení je podporováno pouze v České republice.";
    if (!/^(?:\+420)?\d{9}$/.test(address.phone.replace(/[\s()-]/g, "")))
      errors[`${prefix}.phone`] = "Zadejte platné české telefonní číslo.";
  };
  validateAddress(draft.billing, "billing");
  if (draft.differentDeliveryAddress) validateAddress(draft.delivery, "delivery");
  if (draft.companyId && !/^\d{8}$/.test(draft.companyId.trim()))
    errors.companyId = "IČ musí obsahovat 8 číslic.";
  return errors;
}

export function getReachableStep(
  target: number,
  cart: CartState,
  draft: CheckoutDraft,
  methods: readonly DeliveryMethod[],
): number {
  if (cart.lines.length === 0) return 0;
  if (target > 1 && Object.keys(validateMethods(draft, methods)).length) return 1;
  if (target > 2 && Object.keys(validateAddresses(draft)).length) return 2;
  return Math.max(0, Math.min(target, 3));
}

export interface CheckoutTotals {
  subtotal: number;
  shipping: number | null;
  payment: number;
  total: number;
  /** Net and VAT come only from the OntOS server quote; the browser never computes tax. */
  net: number | null;
  vat: number | null;
}

export function getCheckoutTotals(
  cart: CartState,
  draft: CheckoutDraft,
  methods: readonly DeliveryMethod[],
): CheckoutTotals {
  const subtotal = getCartSubtotal(cart);
  const shipping = getDelivery(draft, methods)?.priceMinor ?? null;
  const payment = 0;
  return {
    subtotal,
    shipping,
    payment,
    total: subtotal + (shipping ?? 0) + payment,
    net: null,
    vat: null,
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
const draftKeys = ["deliveryId", "email", "company", "companyId", "vatId"] as const;

export function isCheckoutDraft(value: unknown): value is CheckoutDraft {
  if (!isRecord(value)) return false;
  const addresses = [value.billing, value.delivery];
  return (
    draftKeys.every((key) => typeof value[key] === "string") &&
    typeof value.differentDeliveryAddress === "boolean" &&
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
