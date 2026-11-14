import { describe, expect, it } from "vitest";

import { cs } from "@/i18n/cs";
import { en } from "@/i18n/en";
import { sk } from "@/i18n/sk";
import type { Dictionary } from "@/i18n";

type Leaves = ReadonlyMap<string, unknown>;

/** Every value of a dictionary by its dotted key (`product.stockStatus.in-stock`, `cart.issue.OUT_OF_STOCK`). */
function leaves(value: unknown, path = "", into = new Map<string, unknown>()): Leaves {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    for (const [key, child] of Object.entries(value))
      leaves(child, path ? `${path}.${key}` : key, into);
    return into;
  }
  into.set(path, value);
  return into;
}

/**
 * The sentence a template function produces. Functions are called with the arguments their arity
 * suggests (quantity numbers first, labels second); the first call that returns text wins.
 */
function renderTemplate(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (typeof value !== "function") return null;
  const attempts: unknown[][] = [
    [1234, "ks", 10],
    [1234, "ks"],
    ["Label", "ks", 10],
    ["Label"],
    [1234],
  ];
  for (const args of attempts) {
    try {
      const rendered = (value as (...rest: unknown[]) => unknown)(...args.slice(0, value.length));
      if (typeof rendered === "string") return rendered;
    } catch {
      // Wrong argument shape for this template; try the next one.
    }
  }
  return null;
}

const czechOnly = /[ěĚřŘůŮ]/;
const slovakOnly = /[äÄľĽĺĹŕŔôÔ]/;
const dictionaries: Record<"sk" | "en", Dictionary> = { sk, en };
const czech = leaves(cs);

describe("market dictionaries", () => {
  it("have the same keys as the Czech dictionary", () => {
    const keys = [...czech.keys()].sort();
    for (const [locale, dictionary] of Object.entries(dictionaries)) {
      expect({ locale, keys: [...leaves(dictionary).keys()].sort() }).toEqual({ locale, keys });
    }
  });

  it("hold no Czech-only letters outside the Czech dictionary", () => {
    for (const [locale, dictionary] of Object.entries(dictionaries)) {
      const offenders = [...leaves(dictionary)]
        .map(([key, value]) => ({ key, text: renderTemplate(value) }))
        .filter(({ text }) => text !== null && czechOnly.test(text))
        .map(({ key, text }) => `${locale}:${key} = ${text}`);
      expect(offenders).toEqual([]);
    }
  });

  it("hold no Slovak-only letters in the Czech dictionary", () => {
    const offenders = [...czech]
      .map(([key, value]) => ({ key, text: renderTemplate(value) }))
      .filter(({ text }) => text !== null && slovakOnly.test(text))
      .map(({ key, text }) => `cs:${key} = ${text}`);
    expect(offenders).toEqual([]);
  });

  it("translate the product detail, cart and filter copy", () => {
    const keys = [
      "product.netWeight",
      "product.minimumOrder",
      "product.variantCount",
      "product.askQuestion",
      "product.sendToFriend",
      "product.table.availability",
      "product.wholePackagesOnly",
      "cart.itemsTitle",
      "cart.availability",
      "cart.lineState.checking",
      "cart.issue.NOT_OFFERED_IN_MARKET",
      "cart.servicesNote",
      "cart.chooseDelivery",
      "filters.query",
      "filters.sortPriceDesc",
      "filters.clear",
      "filters.invalidRange",
    ];
    for (const key of keys) {
      expect(renderTemplate(leaves(sk).get(key))).not.toBe(renderTemplate(czech.get(key)));
      expect(renderTemplate(leaves(en).get(key))).not.toBe(renderTemplate(czech.get(key)));
    }
  });
});
