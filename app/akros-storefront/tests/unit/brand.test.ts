import { afterEach, describe, expect, it, vi } from "vitest";
import { brandLocale, getBrand, toClientBrand } from "@/brand";

vi.mock("server-only", () => ({}));

afterEach(() => vi.unstubAllEnvs());

describe("storefront brand resolution", () => {
  it("serves AKROS when STOREFRONT_BRAND is unset or empty", () => {
    vi.stubEnv("STOREFRONT_BRAND", undefined);
    expect(getBrand().id).toBe("akros");
    vi.stubEnv("STOREFRONT_BRAND", " ");
    expect(getBrand().id).toBe("akros");
  });

  it("reads the brand at request time", () => {
    vi.stubEnv("STOREFRONT_BRAND", "sroubshop");
    expect(getBrand()).toMatchObject({ id: "sroubshop", name: "ŠroubShop", logo: null });
    vi.stubEnv("STOREFRONT_BRAND", "akros");
    expect(getBrand()).toMatchObject({ id: "akros", name: "AKROS" });
  });

  it.each(["AKROS", "shop", "sroub-shop"])("fails loudly on the unknown brand %s", (value) => {
    vi.stubEnv("STOREFRONT_BRAND", value);
    expect(() => getBrand()).toThrow(/STOREFRONT_BRAND=.* is not a storefront brand/);
  });

  it("gives client components the chrome in the market's language, English for other markets", () => {
    vi.stubEnv("STOREFRONT_BRAND", "sroubshop");
    const brand = getBrand();
    expect(brandLocale("pl")).toBe("en");
    expect(toClientBrand(brand, "sk").copyright).toBe(
      "© 2026 Šroubárna Vysočina s.r.o. – fiktívna ukážková firma",
    );
    expect(toClientBrand(brand, "pl")).toEqual({
      name: "ŠroubShop",
      logo: null,
      contact: { email: "eshop@sroubarna.demo" },
      copyright: "© 2026 Šroubárna Vysočina s.r.o. – fictional demo company",
      production: null,
    });
  });

  it("keeps the AKROS chrome as before", () => {
    vi.stubEnv("STOREFRONT_BRAND", undefined);
    expect(toClientBrand(getBrand(), "cs")).toEqual({
      name: "AKROS",
      logo: { header: "/akros/logo-akros.png", footer: "/akros/footer/logo.png" },
      contact: {
        phone: { display: "737 591 849", href: "tel:+420737591849" },
        email: "akros@akros.cz",
      },
      copyright: "Copyright (c) 2014–2026 AKROS b2c",
      production: {
        path: "/kategorie/akroscz-vyroba",
        externalUrl: "https://www.akroscz.cz/",
        headerLabel: "AKROS CZ výroba",
        sidebarLabel: "AKROSCZ Výroba",
      },
    });
  });

  it("holds no AKROS text, link or asset in the ŠroubShop profile data", () => {
    vi.stubEnv("STOREFRONT_BRAND", "sroubshop");
    const { pages, production, ...data } = getBrand();
    const { about, ...pageData } = pages;
    expect(production).toBeNull();
    expect(JSON.stringify({ data, pageData })).not.toMatch(/akros/i);
    expect(about).toBeTruthy();
  });
});
