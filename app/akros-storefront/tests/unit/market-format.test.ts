import { describe, expect, it } from "vitest";
import { dictionaryFor } from "@/i18n";
import { cs } from "@/i18n/cs";
import { en } from "@/i18n/en";
import { sk } from "@/i18n/sk";
import { currencySymbol, describeOfferPrice, formatPrice } from "@/lib/format";
import { formatCheckoutPrice } from "@/features/checkout/checkout-format";
import { isLocaleSegment, localizeHref, splitLocale, stripLocale } from "@/ontos/market-locale";
import { marketLabel } from "@/ontos/market-pages";

// Intl separates amounts with (narrow) no-break spaces.
const plain = (value: string) => value.replace(/[\u00a0\u202f]/gu, " ");

describe("market currency formatting", () => {
  it.each([
    [{ currency: "CZK" as const, locale: "cs" }, "1 234,50 Kč", "Kč"],
    [{ currency: "EUR" as const, locale: "sk" }, "1 234,50 €", "€"],
    [{ currency: "EUR" as const, locale: "en" }, "€1,234.50", "€"],
    [{ currency: "PLN" as const, locale: "pl" }, "1234,50 zł", "zł"],
  ])("formats %o", (money, price, symbol) => {
    expect(plain(formatPrice(123_450, money))).toBe(price);
    expect(currencySymbol(money)).toBe(symbol);
  });

  it("keeps Kai's CZK defaults outside a market", () => {
    expect(plain(formatPrice(12_100))).toBe("121,00 Kč");
    expect(plain(formatCheckoutPrice(12_100))).toBe("121 Kč");
    expect(plain(formatCheckoutPrice(1_230, { currency: "EUR", locale: "sk" }))).toBe("12,30 €");
  });

  it("refuses a price in another currency than the market's", () => {
    const eur = { currency: "EUR" as const, locale: "sk" };
    const offered = describeOfferPrice({ priceMinor: 1_230, currency: "EUR" }, eur);
    expect(offered.available && plain(offered.label)).toBe("12,30 €");
    expect(describeOfferPrice({ priceMinor: 12_100, currency: "CZK" }, eur)).toEqual({
      available: false,
      label: "Cena není dostupná",
      reason: "Cena je v nepodporované měně (CZK); e-shop prodává jen v €.",
    });
  });

  it("labels switcher entries with the market's country or locale and currency", () => {
    expect(marketLabel({ label: "CZ", locale: "cs", currency: "CZK" })).toBe("CZ · Kč");
    expect(marketLabel({ label: "SK", locale: "sk", currency: "EUR" })).toBe("SK · €");
    expect(marketLabel({ label: "EN", locale: "en", currency: "EUR" })).toBe("EN · €");
    expect(marketLabel({ label: "DE", locale: "de" })).toBe("DE");
  });
});

describe("market paths", () => {
  it.each([
    ["/sk/kategorie/srouby", "sk", "/kategorie/srouby"],
    ["/cs", "cs", "/"],
    ["/cs/", "cs", "/"],
    ["/de/produkt/x", "de", "/produkt/x"],
    ["/faq", undefined, "/faq"],
    ["/kategorie/x", undefined, "/kategorie/x"],
    ["/CS/x", undefined, "/CS/x"],
    ["/", undefined, "/"],
  ])("splits %s", (path, locale, rest) => {
    expect(splitLocale(path)).toEqual(locale ? { locale, rest } : { rest });
    expect(stripLocale(path)).toBe(rest);
  });

  it("accepts only 2–3 lowercase letters that are not an existing route", () => {
    expect(["cs", "sk", "en", "de", "fil"].every(isLocaleSegment)).toBe(true);
    expect(["faq", "api", "kosik", "c", "en-gb", "EN", ""].some(isLocaleSegment)).toBe(false);
  });

  it.each([
    ["/", "/sk"],
    ["/?q=x", "/sk?q=x"],
    ["/kosik", "/sk/kosik"],
    ["/produkt/vrut?variant=3", "/sk/produkt/vrut?variant=3"],
    ["/sk/kosik", "/sk/kosik"],
    ["/sk", "/sk"],
    ["/skladem", "/sk/skladem"],
    ["https://www.akroscz.cz/", "https://www.akroscz.cz/"],
    ["//cdn.test/x", "//cdn.test/x"],
    ["#primy-kontakt", "#primy-kontakt"],
    ["mailto:akros@akros.cz", "mailto:akros@akros.cz"],
  ])("prefixes %s for the Slovak market", (href, localized) => {
    expect(localizeHref(href, "sk")).toBe(localized);
  });

  it("leaves hrefs unprefixed outside a market", () => {
    expect(localizeHref("/kosik", undefined)).toBe("/kosik");
  });
});

describe("chrome dictionaries", () => {
  it("selects the market language and falls back to English", () => {
    expect(dictionaryFor("cs")).toBe(cs);
    expect(dictionaryFor("sk")).toBe(sk);
    expect(dictionaryFor("en")).toBe(en);
    expect(dictionaryFor("de")).toBe(en);
    expect(dictionaryFor("constructor")).toBe(en);
    expect(sk.market.unavailableTitle).toBe("Tento trh je dočasne nedostupný");
    expect(cs.market.notConfiguredTitle).toBe("Sortiment pro tento trh zatím není nastaven");
  });
});
