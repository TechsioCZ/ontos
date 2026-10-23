import { expect, it } from "vitest";
import { GET } from "@/app/commerce-customer-context-api/api/portal-auth/verify-email/route";

it.each(["http://localhost:3070", "https://ontos-stage-akros.bleeding.dev"])(
  "rejects malformed mail links at %s without calling the owner or following a callback",
  async (origin) => {
    for (const query of ["", "token=", "token=a&token=b", `token=${"a".repeat(2049)}`]) {
      const response = await GET(
        new Request(
          `${origin}/commerce-customer-context-api/api/portal-auth/verify-email?${query}&callbackURL=https://evil.example.test`,
        ),
      );
      expect(response.status).toBe(303);
      expect(response.headers.get("location")).toBe(`${origin}/overeni-emailu?stav=neplatne`);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(response.headers.get("referrer-policy")).toBe("no-referrer");
      expect(response.headers.has("set-cookie")).toBe(false);
    }
  },
);
