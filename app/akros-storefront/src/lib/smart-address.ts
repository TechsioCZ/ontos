/** Public v1 contract observed in the deployed Smart Suggest SDK, not the older /suggest SDK. */
// Same-origin transport supports protected previews without exposing cookies to the provider.
export const smartAddressEndpoint = "/api/address-suggestions";

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
export function parseAddressSuggestions(payload: unknown): AddressSuggestion[] {
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
      (address.countryCode !== undefined && address.countryCode !== "CZ") ||
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

export async function suggestAddresses(
  query: string,
  signal: AbortSignal,
): Promise<AddressSuggestion[]> {
  const params = new URLSearchParams({
    q: query.trim(),
    countryCode: "CZ",
    countryCodes: "CZ",
    kind: "address",
    language: "cs",
    limit: "20",
  });
  const response = await fetch(`${smartAddressEndpoint}?${params}`, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.any([signal, AbortSignal.timeout(10000)]),
    credentials: "same-origin",
  });
  if (!response.ok) throw new Error(`Address service: ${response.status}`);
  return parseAddressSuggestions(await response.json());
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
    ...(a.countryCode === "CZ" ? { country: "CZ" } : {}),
  };
}
