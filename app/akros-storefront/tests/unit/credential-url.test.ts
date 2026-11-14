import { NextRequest } from "next/server";
import { describe, expect, it, vi } from "vitest";
import { proxy } from "@/proxy";

vi.mock("@/ontos/market", () => ({ storefrontMarketKind: async () => "live" }));

describe("credential query guard", () => {
  it.each(["password", "newPassword", "Password", "api_key", "client_secret", "access_token"])(
    "strips %s before rendering an auth page",
    async (key) => {
      const url = new URL("https://store.test/sk/prihlaseni");
      url.searchParams.set(key, "query-probe");
      const response = await proxy(new NextRequest(url));
      expect(response.status).toBe(303);
      // The login page of the same market.
      expect(new URL(response.headers.get("location") ?? "").href).toBe(
        "https://store.test/sk/prihlaseni",
      );
      expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    },
  );
  it("does not redirect a Zerops request to Next's internal listener origin", async () => {
    const url = new URL("https://0.0.0.0:3070/prihlaseni");
    url.searchParams.set("password", "proxy-origin-probe");
    const response = await proxy(
      new NextRequest(url, {
        headers: { host: "ontos-stage-akros.web-revolution.cz", "x-forwarded-proto": "https" },
      }),
    );
    expect(response.status).toBe(303);
    expect(new URL(response.headers.get("location") ?? "").href).toBe(
      // A legacy URL without a market goes to the Czech market's login.
      "https://ontos-stage-akros.web-revolution.cz/cs/prihlaseni",
    );
  });
  it("preserves legitimate verification tokens and normal navigation", async () => {
    for (const path of ["/cs/overeni-emailu?token=one-use", "/cs/prihlaseni?returnTo=%2Fkosik"]) {
      const response = await proxy(new NextRequest(new URL(path, "https://store.test")));
      expect(response.status).toBe(200);
      expect(response.headers.get("x-middleware-rewrite")).toBe(
        new URL(path.slice(3), "https://store.test").href,
      );
    }
  });
});
