import { describe, expect, it } from "vitest";
import { isCustomerProfile, profileInput } from "@/ontos/profile-model";
import { POST } from "@/app/api/ontos/account/profile/route";

const profile = {
  contactEmail: "contact@example.test",
  displayName: "Customer One",
  phone: "+420777123456",
  version: "a".repeat(64),
};

describe("customer-owned profile input", () => {
  it("whitelists editable values and discards forged Party, tenant, contact and login identities", () => {
    expect(
      profileInput({
        ...profile,
        contactPointRef: { resourceId: "other-contact" },
        email: "attacker@example.test",
        partyId: "other-party",
        password: "untrusted",
        tenantId: "other-tenant",
      }),
    ).toEqual(profile);
    const parsed = profileInput({ ...profile, partyId: "other-party" });
    expect(parsed).not.toBeNull();
    expect(Object.keys(parsed ?? {})).toEqual(Object.keys(profile));
  });
  it("trims owner-bound contact values without rewriting the login identity", () => {
    expect(
      profileInput({
        ...profile,
        contactEmail: " contact@example.test ",
        displayName: " Customer One ",
        phone: " +420777123456 ",
      }),
    ).toEqual(profile);
  });
  it("rejects missing or malformed values and stale-version omissions", () => {
    for (const input of [
      null,
      [],
      {},
      { ...profile, displayName: " " },
      { ...profile, phone: "javascript:alert(1)" },
      { ...profile, contactEmail: "not-email" },
      { ...profile, version: "" },
      { ...profile, phone: "1".repeat(101) },
    ]) {
      expect(profileInput(input)).toBeNull();
    }
    expect(isCustomerProfile({ ...profile, version: "" })).toBe(false);
  });
});

describe("profile BFF request boundary", () => {
  it("rejects cross-origin updates before any owner request", async () => {
    const response = await POST(
      new Request("http://localhost:3070/api/ontos/account/profile", {
        body: JSON.stringify(profile),
        headers: { "content-type": "application/json", origin: "https://other.example" },
        method: "POST",
      }),
    );
    expect(response.status).toBe(403);
    expect(response.headers.get("cache-control")).toBe("no-store");
  });
  it("requires an explicit same-origin update and valid input before owner admission", async () => {
    for (const origin of [undefined, "http://localhost:3070"]) {
      const headers: Record<string, string> = { "content-type": "application/json" };
      if (origin) {
        headers.origin = origin;
      }
      const response = await POST(
        new Request("http://localhost:3070/api/ontos/account/profile", {
          body: JSON.stringify({ partyId: "forged" }),
          headers,
          method: "POST",
        }),
      );
      expect(response.status).toBe(origin ? 400 : 403);
      expect(response.headers.get("cache-control")).toBe("no-store");
    }
  });
});
