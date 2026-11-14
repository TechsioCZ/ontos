export interface CustomerProfile {
  contactEmail: string;
  displayName: string;
  phone: string;
  version: string;
}

export function isCustomerProfile(value: unknown): value is CustomerProfile {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const data = value as Record<string, unknown>;
  return (
    typeof data.displayName === "string" &&
    typeof data.phone === "string" &&
    typeof data.contactEmail === "string" &&
    typeof data.version === "string" &&
    /^[a-f0-9]{64}$/.test(data.version)
  );
}

/** The browser never chooses a Party, Tenant, contact-point reference or login identity. */
export function profileInput(value: unknown): CustomerProfile | null {
  if (!isCustomerProfile(value)) {
    return null;
  }
  if (
    !value.displayName.trim() ||
    value.displayName.trim().length > 300 ||
    value.phone.length > 100 ||
    (value.phone.trim() !== "" && !/^\+?[()0-9 .-]{3,100}$/.test(value.phone.trim())) ||
    value.contactEmail.length > 320 ||
    (value.contactEmail.trim() !== "" &&
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.contactEmail.trim()))
  ) {
    return null;
  }
  return {
    contactEmail: value.contactEmail.trim(),
    displayName: value.displayName.trim(),
    phone: value.phone.trim(),
    version: value.version,
  };
}
