import { mockCustomer } from "./fixtures/account";

export const accountProfileStorageKey = "akros-demo-account-profile-v1";
export const createAccountProfile = () => ({
  email: mockCustomer.email as string,
  firstName: "Jan",
  lastName: "Novák",
  billingEmail: mockCustomer.email as string,
  street: "Průmyslová 1420",
  city: "Praha 10",
  postalCode: "102 00",
  country: "CZ",
  phone: mockCustomer.phone as string,
  phone2: "",
  company: mockCustomer.company as string,
  companyId: "12345678",
  vatId: "CZ12345678",
  deliveryStreet: "",
  deliveryCity: "",
  deliveryPostalCode: "",
  newsletter: false,
  privacyConsent: false,
});
export type AccountProfile = ReturnType<typeof createAccountProfile>;
export type AccountProfileErrors = Partial<Record<keyof AccountProfile, string>>;

export function parseAccountProfile(raw: string | null): AccountProfile {
  const defaults = createAccountProfile();
  try {
    const parsed: unknown = JSON.parse(raw ?? "null");
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      !("version" in parsed) ||
      parsed.version !== 1 ||
      !("profile" in parsed)
    )
      return defaults;
    const profile = parsed.profile;
    if (typeof profile !== "object" || profile === null) return defaults;
    for (const key of Object.keys(defaults) as (keyof AccountProfile)[]) {
      if (!(key in profile) || typeof Reflect.get(profile, key) !== typeof defaults[key])
        return defaults;
    }
    // Copy only the known fields; never retain credentials or unknown stored properties.
    return Object.fromEntries(
      Object.keys(defaults).map((key) => [key, Reflect.get(profile, key)]),
    ) as AccountProfile;
  } catch {
    return defaults;
  }
}

export function validateAccountProfile(profile: AccountProfile): AccountProfileErrors {
  const errors: AccountProfileErrors = {};
  for (const key of ["email", "billingEmail"] as const)
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(profile[key].trim()))
      errors[key] = "Zadejte platný e-mail.";
  for (const key of ["firstName", "lastName", "street", "city"] as const)
    if (!profile[key].trim()) errors[key] = "Vyplňte toto pole.";
  if (!/^\d{3}\s?\d{2}$/.test(profile.postalCode))
    errors.postalCode = "Zadejte PSČ ve tvaru 123 45.";
  if (profile.country !== "CZ") errors.country = "Prototyp podporuje Českou republiku.";
  for (const key of ["phone", "phone2"] as const)
    if (
      (key === "phone" || profile[key]) &&
      !/^(?:\+420)?\d{9}$/.test(profile[key].replace(/[\s()-]/g, ""))
    )
      errors[key] = "Zadejte platné české telefonní číslo.";
  if (profile.companyId && !/^\d{8}$/.test(profile.companyId))
    errors.companyId = "IČ musí obsahovat 8 číslic.";
  if (profile.newsletter && !profile.privacyConsent)
    errors.privacyConsent = "Pro odběr novinek potvrďte souhlas se zpracováním osobních údajů.";
  if (profile.deliveryStreet || profile.deliveryCity || profile.deliveryPostalCode) {
    if (!profile.deliveryStreet.trim()) errors.deliveryStreet = "Vyplňte ulici.";
    if (!profile.deliveryCity.trim()) errors.deliveryCity = "Vyplňte město.";
    if (!/^\d{3}\s?\d{2}$/.test(profile.deliveryPostalCode))
      errors.deliveryPostalCode = "Zadejte platné PSČ.";
  }
  return errors;
}
