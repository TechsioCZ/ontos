import { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";
import { proxy } from "@/proxy";

describe("credential query guard", () => {
  it.each(["password", "newPassword", "Password", "api_key", "client_secret", "access_token"])(
    "strips %s before rendering an auth page",
    (key) => {
      const url = new URL("https://store.test/prihlaseni");
      url.searchParams.set(key, "query-probe");
      const response = proxy(new NextRequest(url));
      expect(response.status).toBe(303);
      expect(new URL(response.headers.get("location") ?? "").href).toBe(
        "https://store.test/prihlaseni",
      );
      expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    },
  );
  it("does not redirect a Zerops request to Next's internal listener origin", () => {
    const url = new URL("https://0.0.0.0:3070/prihlaseni");
    url.searchParams.set("password", "proxy-origin-probe");
    const response = proxy(
      new NextRequest(url, {
        headers: { host: "ontos-stage-akros.web-revolution.cz", "x-forwarded-proto": "https" },
      }),
    );
    expect(response.status).toBe(303);
    expect(new URL(response.headers.get("location") ?? "").href).toBe(
      "https://ontos-stage-akros.web-revolution.cz/prihlaseni",
    );
  });
  it("preserves legitimate verification tokens and normal navigation", () => {
    for (const path of ["/overeni-emailu?token=one-use", "/prihlaseni?returnTo=%2Fkosik"]) {
      expect(proxy(new NextRequest(new URL(path, "https://store.test"))).status).toBe(200);
    }
  });
});
