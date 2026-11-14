import { OrderAddressSchema } from "@app/merchandise/domain/merchandise-model";
import { Schema } from "effect";
import type { Dictionary } from "@/i18n";
import type { CustomerAddress } from "@/ontos/customer-addresses";
import { customerAddressesForIdentity } from "@/ontos/customer-addresses-client";
import type {
  CustomerAddressIdentity,
  CustomerAddressesSnapshot,
} from "@/ontos/customer-addresses-client";

export interface CheckoutPostalFields {
  readonly city: string;
  readonly country: string;
  readonly postalCode: string;
  readonly street: string;
}
export interface CheckoutPostalDraft {
  readonly copiedForIdentity: CustomerAddressIdentity | null;
  readonly fields: CheckoutPostalFields;
  readonly selectedAddressId: string | null;
}
export type CheckoutSavedAddress =
  | { readonly fields: CheckoutPostalFields; readonly state: "available" }
  | {
      readonly reason: "country" | "extraFields" | "invalid" | "unresolved";
      readonly state: "unavailable";
    };
const nativeAddress = Schema.is(OrderAddressSchema);

export const checkoutSavedAddress = (
  address: CustomerAddress,
  countryCodes: readonly string[],
): CheckoutSavedAddress => {
  if (address.location.state !== "available") {
    return { reason: "unresolved", state: "unavailable" };
  }
  const postal = address.location.address;
  if ((postal.addressLine2?.trim().length ?? 0) > 0 || (postal.region?.trim().length ?? 0) > 0) {
    return { reason: "extraFields", state: "unavailable" };
  }
  if (!countryCodes.includes(postal.countryCode)) {
    return { reason: "country", state: "unavailable" };
  }
  const fields = {
    city: postal.city,
    country: postal.countryCode,
    postalCode: postal.postalCode,
    street: postal.addressLine1,
  };
  return nativeAddress(fields)
    ? { fields, state: "available" }
    : { reason: "invalid", state: "unavailable" };
};

export const initialCheckoutPostalDraft = (
  countryCodes: readonly string[],
): CheckoutPostalDraft => ({
  copiedForIdentity: null,
  fields: {
    city: "",
    country: countryCodes.length === 1 ? (countryCodes[0] ?? "") : "",
    postalCode: "",
    street: "",
  },
  selectedAddressId: null,
});

/** Copied postal data belongs to an exact admitted instance, even after a manual edit. */
export const checkoutPostalForIdentity = (
  draft: CheckoutPostalDraft,
  identity: CustomerAddressIdentity | null,
  countryCodes: readonly string[],
) =>
  draft.copiedForIdentity !== null &&
  (draft.copiedForIdentity !== identity || !countryCodes.includes(draft.fields.country))
    ? initialCheckoutPostalDraft(countryCodes)
    : draft;

export const editCheckoutPostal = (
  draft: CheckoutPostalDraft,
  identity: CustomerAddressIdentity | null,
  countryCodes: readonly string[],
  field: keyof CheckoutPostalFields,
  value: string,
): CheckoutPostalDraft => {
  const current = checkoutPostalForIdentity(draft, identity, countryCodes);
  return { ...current, fields: { ...current.fields, [field]: value }, selectedAddressId: null };
};

/** Selection re-resolves the row from the current fenced read; it never trusts an event's address. */
export const copyCheckoutSavedAddress = ({
  addressId,
  countryCodes,
  disabled,
  identity,
  snapshot,
}: {
  addressId: string;
  countryCodes: readonly string[];
  disabled: boolean;
  identity: CustomerAddressIdentity | null;
  snapshot: CustomerAddressesSnapshot | null;
}): CheckoutPostalDraft | null => {
  if (disabled || identity === null || addressId.length === 0) {
    return null;
  }
  const current = customerAddressesForIdentity(snapshot, identity);
  if (current.state !== "ready") {
    return null;
  }
  const matches = current.addresses.filter((address) => address.id === addressId);
  const [address] = matches;
  if (matches.length !== 1 || address === undefined) {
    return null;
  }
  const selected = checkoutSavedAddress(address, countryCodes);
  return selected.state === "available"
    ? { copiedForIdentity: identity, fields: selected.fields, selectedAddressId: address.id }
    : null;
};

/** Unique read-scoped values prevent a late Select event from selecting a newer read's row. */
export const checkoutSavedAddressItems = (
  addresses: readonly CustomerAddress[],
  countryCodes: readonly string[],
  generation: number,
  labels: Dictionary["checkout"]["savedAddresses"],
) => {
  const counts = new Map<string, number>();
  for (const address of addresses) {
    counts.set(address.id, (counts.get(address.id) ?? 0) + 1);
  }
  return addresses.map((address, index) => {
    const mapped = checkoutSavedAddress(address, countryCodes);
    let reason: keyof typeof labels.reasons | null =
      mapped.state === "unavailable" ? mapped.reason : null;
    if (address.id.length === 0 || counts.get(address.id) !== 1) {
      reason = "invalid";
    }
    const postal = address.location.state === "available" ? address.location.address : null;
    const lines = [
      address.label,
      postal?.addressLine1,
      postal?.addressLine2,
      postal === null ? undefined : `${postal.postalCode} ${postal.city}`,
      postal?.region,
      postal?.countryCode,
    ].filter((line) => line !== undefined && line.trim().length > 0);
    const displayValue =
      lines.join(", ") || labels.unnamed.replace("{number}", () => String(index + 1));
    return {
      addressId: address.id,
      disabled: reason !== null,
      displayValue,
      label: reason === null ? displayValue : `${displayValue} — ${labels.reasons[reason]}`,
      value: JSON.stringify([generation, index, address.id]),
    };
  });
};
