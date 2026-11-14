import { afterEach, describe, expect, it, vi } from "vitest";
import { getConfig } from "@/ontos/config";

vi.mock("server-only", () => ({}));

afterEach(() => vi.unstubAllEnvs());

describe("storefront identity configuration", () => {
  it("keeps the original demo storefront when nothing is configured", () => {
    vi.stubEnv("ONTOS_STOREFRONT_APP_ID", undefined);
    vi.stubEnv("ONTOS_STOREFRONT_LEGAL_ENTITY_ID", "");
    expect(getConfig()).toMatchObject({
      appId: "akros-storefront",
      legalEntityId: "71000000-0000-4000-8000-000000000024",
    });
  });

  it("reads the app id and the selling legal entity at request time", () => {
    vi.stubEnv("ONTOS_STOREFRONT_APP_ID", "sroubshop-storefront");
    vi.stubEnv("ONTOS_STOREFRONT_LEGAL_ENTITY_ID", " 71000000-0000-4000-8000-000000000099 ");
    expect(getConfig()).toMatchObject({
      appId: "sroubshop-storefront",
      legalEntityId: "71000000-0000-4000-8000-000000000099",
    });
  });

  it.each([
    ["ONTOS_STOREFRONT_APP_ID", "Šroub Shop"],
    ["ONTOS_STOREFRONT_LEGAL_ENTITY_ID", "akros"],
  ])("fails loudly on an invalid %s", (name, value) => {
    vi.stubEnv(name, value);
    expect(() => getConfig()).toThrow(name);
  });
});
