import { createServer, type IncomingMessage } from "node:http";
import { describe, expect, it } from "vitest";
import { browserAt, serveHttp } from "../support/http";
import {
  getSuggestedAddress,
  isSmartAddressCountry,
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
  it("offers suggestions only for address countries the provider covers", () => {
    expect(isSmartAddressCountry("CZ")).toBe(true);
    expect(isSmartAddressCountry("SK")).toBe(false);
    expect(isSmartAddressCountry("constructor")).toBe(false);
    expect(parseAddressSuggestions({ suggestions: [suggestion] }, "SK")).toEqual([]);
  });
  it("uses a relative endpoint with same-origin credentials for protected previews", async () => {
    const received = Promise.withResolvers<IncomingMessage>();
    const redirectedArrival = Promise.withResolvers<string | undefined>();
    const abortArrival = Promise.withResolvers<void>();
    const redirected = createServer((request, response) => {
      redirectedArrival.resolve(request.headers.cookie);
      response.writeHead(200, {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": request.headers.origin ?? "",
        "Access-Control-Allow-Credentials": "true",
      });
      response.end(JSON.stringify({ suggestions: [suggestion] }));
    });
    await new Promise<void>((resolve) => redirected.listen(0, "127.0.0.1", resolve));
    const redirectedAddress = redirected.address();
    if (!redirectedAddress || typeof redirectedAddress === "string")
      throw new Error("Missing redirect HTTP address");
    const redirectedOrigin = `http://127.0.0.1:${redirectedAddress.port}`;
    const network = createServer((request, response) => {
      const url = new URL(request.url ?? "", "http://localhost");
      if (url.pathname === "/session") {
        response.setHeader(
          "Set-Cookie",
          `smart-address-preview=authorized; HttpOnly; Path=/api/address-suggestions${
            request.method === "DELETE" ? "; Max-Age=0" : ""
          }`,
        );
        response.end();
      } else if (url.pathname !== "/api/address-suggestions") {
        response.writeHead(404).end("Unknown endpoint");
      } else if (url.searchParams.get("q") === "redirect") {
        response.writeHead(302, { Location: `${redirectedOrigin}/api/address-suggestions` }).end();
      } else if (url.searchParams.get("q") === "abort") {
        abortArrival.resolve();
      } else {
        received.resolve(request);
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ suggestions: [suggestion] }));
      }
    });
    await new Promise<void>((resolve) => network.listen(0, "127.0.0.1", resolve));
    const address = network.address();
    if (!address || typeof address === "string") throw new Error("Missing HTTP address");
    const origin = `http://127.0.0.1:${address.port}`;
    const previousUrl = window.location.href;
    browserAt(origin);
    try {
      await fetch("/session");
      const controller = new AbortController();
      expect(controller.signal).toBeInstanceOf(AbortSignal);
      expect(await suggestAddresses(" Praha 1 ", controller.signal)).toEqual([suggestion]);
      const request = await received.promise;
      const parsedUrl = new URL(request.url ?? "", origin);
      expect(request.headers.host).toBe(new URL(origin).host);
      expect(parsedUrl.pathname).toBe("/api/address-suggestions");
      expect(Object.fromEntries(parsedUrl.searchParams)).toEqual({
        q: "Praha 1",
        countryCode: "CZ",
        countryCodes: "CZ",
        kind: "address",
        language: "cs",
        limit: "20",
      });
      expect(request.headers.cookie).toContain("smart-address-preview=authorized");

      expect(await suggestAddresses("redirect", controller.signal)).toEqual([suggestion]);
      expect(await redirectedArrival.promise).toBeUndefined();

      const pending = suggestAddresses("abort", controller.signal);
      const aborted = expect(pending).rejects.toMatchObject({ name: "AbortError" });
      await abortArrival.promise;
      controller.abort();
      await aborted;
    } finally {
      await fetch("/session", { method: "DELETE" });
      network.closeAllConnections();
      redirected.closeAllConnections();
      await Promise.all([
        new Promise<void>((resolve) => network.close(() => resolve())),
        new Promise<void>((resolve) => redirected.close(() => resolve())),
      ]);
      browserAt(previousUrl);
    }
  });
  it("surfaces outage and malformed data instead of inventing address suggestions", async () => {
    const network = await serveHttp(() =>
      network.requests.length === 1
        ? new Response("offline", { status: 503 })
        : new Response("not JSON"),
    );
    const previousUrl = window.location.href;
    browserAt(network.origin);
    try {
      await expect(suggestAddresses("Praha", new AbortController().signal)).rejects.toThrow("503");
      await expect(suggestAddresses("Praha", new AbortController().signal)).rejects.toThrow(
        /Unexpected/,
      );
      await network.idle();
      expect(network.requests).toHaveLength(2);
    } finally {
      await network.idle();
      await network.close();
      browserAt(previousUrl);
    }
  });
});
