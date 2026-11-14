/** Public v1 contract observed in the deployed Smart Suggest SDK, not the older /suggest SDK. */
// Same-origin transport supports protected previews without exposing cookies to the provider.
const smartAddressEndpoint = "/api/address-suggestions";

/**
 * Address countries the provider has data for, with the language of its labels. Checked against the live API:
 * CZ (RÚIAN) returns suggestions; SK and PL return none, so they stay manual entry until the provider covers them.
 */
const smartAddressCountries: Readonly<Record<string, string>> = { CZ: "cs" };
export const isSmartAddressCountry = (country: string) =>
  Object.hasOwn(smartAddressCountries, country);

export interface AddressSuggestion {
  id: string;
  displayLabel: string;
  address: {
    line1?: string;
    street?: string;
    houseNumber?: string;
    orientationNumber?: string;
    city?: string;
    postalCode?: string;
    countryCode?: string;
  };
  attribution?: { label: string; url?: string };
}

const record = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;
const optionalText = (v: unknown) => v === undefined || typeof v === "string";
export function parseAddressSuggestions(payload: unknown, country = "CZ"): AddressSuggestion[] {
  if (!record(payload) || !Array.isArray(payload.suggestions))
    throw new Error("Invalid address response");
  const seen = new Set<string>();
  return payload.suggestions.filter((s): s is AddressSuggestion => {
    const address = record(s) && record(s.address) ? s.address : undefined;
    if (
      !record(s) ||
      typeof s.id !== "string" ||
      !s.id ||
      typeof s.displayLabel !== "string" ||
      !s.displayLabel ||
      !address ||
      ![
        "line1",
        "street",
        "houseNumber",
        "orientationNumber",
        "city",
        "postalCode",
        "countryCode",
      ].every((key) => optionalText(address[key])) ||
      (address.countryCode !== undefined && address.countryCode !== country) ||
      seen.has(s.id)
    )
      return false;
    if (
      s.attribution !== undefined &&
      (!record(s.attribution) ||
        typeof s.attribution.label !== "string" ||
        !optionalText(s.attribution.url))
    )
      return false;
    seen.add(s.id);
    return true;
  });
}

/** Provider query for one address country; the route rebuilds it server-side from `q` and `countryCode` only. */
export const smartAddressParams = (query: string, country: string) =>
  new URLSearchParams({
    q: query.trim(),
    countryCode: country,
    countryCodes: country,
    kind: "address",
    language: smartAddressCountries[country] ?? "cs",
    limit: "20",
  });

export async function suggestAddresses(
  query: string,
  signal: AbortSignal,
  country = "CZ",
): Promise<AddressSuggestion[]> {
  const response = await fetch(`${smartAddressEndpoint}?${smartAddressParams(query, country)}`, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.any([signal, AbortSignal.timeout(10000)]),
    credentials: "same-origin",
  });
  if (!response.ok) throw new Error(`Address service: ${response.status}`);
  return parseAddressSuggestions(await response.json(), country);
}

/** Partial suggestions never erase fields the customer has already completed. */
export function getSuggestedAddress(suggestion: AddressSuggestion) {
  const a = suggestion.address;
  const number = [a.houseNumber, a.orientationNumber].filter(Boolean).join("/");
  const street = a.line1?.trim() || [a.street?.trim(), number].filter(Boolean).join(" ");
  return {
    ...(street ? { street } : {}),
    ...(a.city?.trim() ? { city: a.city.trim() } : {}),
    ...(a.postalCode?.trim() ? { postalCode: a.postalCode.trim() } : {}),
    ...(a.countryCode && isSmartAddressCountry(a.countryCode) ? { country: a.countryCode } : {}),
  };
}
