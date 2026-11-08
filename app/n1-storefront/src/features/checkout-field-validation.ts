import type { Dictionary } from "@/i18n";

export const checkoutFieldAttributes = {
  city: { autoComplete: "address-level2", maxLength: 120, required: true, type: "text" },
  email: { autoComplete: "email", maxLength: 200, required: true, type: "email" },
  firstName: { autoComplete: "given-name", maxLength: 100, required: true, type: "text" },
  lastName: { autoComplete: "family-name", maxLength: 99, required: true, type: "text" },
  phone: { autoComplete: "tel", maxLength: 40, required: false, type: "tel" },
  postalCode: {
    autoComplete: "postal-code",
    maxLength: 12,
    minLength: 3,
    required: true,
    type: "text",
  },
  street: { autoComplete: "street-address", maxLength: 200, required: true, type: "text" },
} as const;
type Field = keyof typeof checkoutFieldAttributes;

export const checkoutFieldError = (
  field: Field,
  validity: Pick<ValidityState, "valid" | "valueMissing" | "patternMismatch">,
  d: Dictionary,
): string | undefined => {
  if (validity.valid) {
    return undefined;
  }
  if (field === "firstName" && (validity.valueMissing || validity.patternMismatch)) {
    return d.checkout.errors.firstName;
  }
  if (field === "email") {
    return d.checkout.errors.email;
  }
  return d.checkout.invalidField;
};
