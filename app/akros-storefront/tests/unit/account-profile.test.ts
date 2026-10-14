import { describe, expect, it } from "vitest";
import {
  createAccountProfile,
  parseAccountProfile,
  validateAccountProfile,
} from "@/mock-storefront/account-profile";

describe("local account profile", () => {
  it("restores known profile fields without storing credentials or unknown properties", () => {
    const profile = { ...createAccountProfile(), city: "Brno" };
    expect(
      parseAccountProfile(
        JSON.stringify({ version: 1, profile: { ...profile, password: "secret", extra: true } }),
      ),
    ).toEqual(profile);
    expect(parseAccountProfile("broken")).toEqual(createAccountProfile());
    expect(
      parseAccountProfile(
        JSON.stringify({ version: 1, profile: { ...profile, newsletter: "true" } }),
      ),
    ).toEqual(createAccountProfile());
  });
  it("validates contact data and consent before accepting newsletter subscription", () => {
    expect(validateAccountProfile(createAccountProfile())).toEqual({});
    const errors = validateAccountProfile({
      ...createAccountProfile(),
      email: "broken",
      phone: "123",
      newsletter: true,
      privacyConsent: false,
    });
    expect(errors).toHaveProperty("email");
    expect(errors).toHaveProperty("phone");
    expect(errors).toHaveProperty("privacyConsent");
    expect(
      validateAccountProfile({ ...createAccountProfile(), newsletter: true, privacyConsent: true }),
    ).toEqual({});
  });
  it("requires a complete optional delivery address and rejects unsupported countries", () => {
    expect(
      validateAccountProfile({ ...createAccountProfile(), deliveryStreet: "Lipová 1" }),
    ).toHaveProperty("deliveryCity");
    expect(validateAccountProfile({ ...createAccountProfile(), country: "US" })).toHaveProperty(
      "country",
    );
    expect(
      validateAccountProfile({
        ...createAccountProfile(),
        deliveryStreet: "Lipová 1",
        deliveryCity: "Brno",
        deliveryPostalCode: "60200",
      }),
    ).toEqual({});
  });
});
