import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getSuggestedAddress,
  parseAddressSuggestions,
  suggestAddresses,
} from "@/lib/smart-address";
const suggestion = {
  id: "a",
  displayLabel: "Václavské náměstí 1, Praha",
  address: {
    street: "Václavské náměstí",
    houseNumber: "846",
    orientationNumber: "1",
    city: "Praha",
    postalCode: "110 00",
    countryCode: "CZ",
  },
};
describe("Smart Suggest public v1 integration", () => {
  afterEach(() => vi.unstubAllGlobals());
  it("maps separated Czech house numbers and preserves absent fields", () => {
    expect(getSuggestedAddress(suggestion)).toEqual({
      street: "Václavské náměstí 846/1",
      city: "Praha",
      postalCode: "110 00",
      country: "CZ",
    });
    expect(getSuggestedAddress({ ...suggestion, address: { city: "Brno" } })).toEqual({
      city: "Brno",
    });
    expect(
      getSuggestedAddress({ ...suggestion, address: { ...suggestion.address, line1: "Ulice 25" } })
        .street,
    ).toBe("Ulice 25");
  });
  it("rejects malformed responses, unsafe field types, duplicate IDs and other countries", () => {
    expect(() => parseAddressSuggestions({ html: "offline" })).toThrow("Invalid address response");
    expect(
      parseAddressSuggestions({
        suggestions: [
          suggestion,
          suggestion,
          { ...suggestion, id: "de", address: { countryCode: "DE" } },
          { ...suggestion, id: "bad", address: { city: {} } },
        ],
      }),
    ).toEqual([suggestion]);
  });
  it("uses a relative endpoint with same-origin credentials for protected previews", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(JSON.stringify({ suggestions: [suggestion] })));
    vi.stubGlobal("fetch", fetcher);
    expect(await suggestAddresses(" Praha 1 ", new AbortController().signal)).toEqual([suggestion]);
    const [url, options] = fetcher.mock.calls[0];
    const parsedUrl = new URL(String(url), "http://localhost:3000");
    expect(parsedUrl.pathname).toBe("/api/address-suggestions");
    expect(Object.fromEntries(parsedUrl.searchParams)).toEqual({
      q: "Praha 1",
      countryCode: "CZ",
      countryCodes: "CZ",
      kind: "address",
      language: "cs",
      limit: "20",
    });
    expect(options?.credentials).toBe("same-origin");
    expect(options?.signal).toBeInstanceOf(AbortSignal);
  });
  it("surfaces outage and malformed data instead of inventing address suggestions", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(new Response("offline", { status: 503 }))
        .mockResolvedValueOnce(new Response("not JSON")),
    );
    await expect(suggestAddresses("Praha", new AbortController().signal)).rejects.toThrow("503");
    await expect(suggestAddresses("Praha", new AbortController().signal)).rejects.toThrow(
      /Unexpected/,
    );
  });
});
