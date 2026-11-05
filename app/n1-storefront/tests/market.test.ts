import { Effect } from "effect";
import { describe, expect, it } from "effect-rstest";
import { selectMarket } from "../src/ontos/market";

const config = { appId: "n1-storefront", legalEntityId: "n1-seller", tenantId: "demo" };
const now = Date.parse("2026-11-02T12:00:00Z");
const period = { startsAt: "2026-01-01T00:00:00Z" };
const market = {
  effectivePeriod: period,
  lifecycle: "ACTIVE",
  marketCode: "N1-CZ",
  marketRef: { resourceId: "N1-CZ" },
  sellingLegalEntityRef: { resourceId: config.legalEntityId },
  supportedLocales: ["cs-CZ"],
};
const association = {
  channel: "B2C",
  effectivePeriod: period,
  marketRef: market.marketRef,
  sellingLegalEntityRef: market.sellingLegalEntityRef,
  storefrontRef: { appId: config.appId, tenantId: config.tenantId },
};

describe("N1 market admission", () => {
  for (const supportedLocales of [
    ["cs-CZ", "en-CZ"],
    ["en-CZ", "cs-CZ"],
  ]) {
    for (const locale of ["cs", "en"]) {
      it.effect(
        `uses explicit ${locale} support regardless of locale ordering ${supportedLocales.join(",")}`,
        () =>
          Effect.gen(function* explicitLocaleSupport() {
            const candidate = { ...market, supportedLocales };
            const result = yield* selectMarket(
              { associations: [association], markets: [candidate] },
              config,
              locale,
              now,
            );
            expect(result).toEqual(candidate);
          }),
      );
    }
  }
  for (const [supportedLocales, locale] of [
    [["cs-CZ"], "en"],
    [["cs-CZ", "en-CZ"], "de"],
  ] as const) {
    it.effect(`does not substitute another language for unsupported ${locale}`, () =>
      Effect.gen(function* noLanguageFallback() {
        const failure = yield* Effect.flip(
          selectMarket(
            { associations: [association], markets: [{ ...market, supportedLocales }] },
            config,
            locale,
            now,
          ),
        );
        expect(failure.reason).toBe("missing");
      }),
    );
  }
  it.effect("treats two explicitly supported secondary-locale markets as ambiguous", () =>
    Effect.gen(function* ambiguousSecondaryLocales() {
      const second = {
        ...market,
        marketRef: { resourceId: "second" },
        supportedLocales: ["sk-SK", "en-GB"],
      };
      const failure = yield* Effect.flip(
        selectMarket(
          {
            associations: [association, { ...association, marketRef: second.marketRef }],
            markets: [{ ...market, supportedLocales: ["cs-CZ", "en-CZ"] }, second],
          },
          config,
          "en",
          now,
        ),
      );
      expect(failure.reason).toBe("ambiguous");
    }),
  );
  it.effect("counts the market once when it supports two tags of the same language", () =>
    Effect.gen(function* oneMarketMultipleEnglishTags() {
      const candidate = { ...market, supportedLocales: ["cs-CZ", "en-CZ", "en-GB"] };
      expect(
        yield* selectMarket(
          { associations: [association], markets: [candidate] },
          config,
          "en",
          now,
        ),
      ).toEqual(candidate);
    }),
  );
  it.effect("keeps lifecycle admission when English is a secondary supported tag", () =>
    Effect.gen(function* secondaryLocaleLifecycle() {
      const candidate = { ...market, supportedLocales: ["cs-CZ", "en-CZ"] };
      const suspended = {
        ...candidate,
        lifecycle: "SUSPENDED",
        marketRef: { resourceId: "suspended" },
      };
      const result = yield* selectMarket(
        {
          associations: [association, { ...association, marketRef: suspended.marketRef }],
          markets: [candidate, suspended],
        },
        config,
        "en",
        now,
      );
      expect(result).toEqual(candidate);
    }),
  );
  it.effect("does not admit an inactive secondary-locale market", () =>
    Effect.gen(function* inactiveSecondaryLocale() {
      const failure = yield* Effect.flip(
        selectMarket(
          {
            associations: [association],
            markets: [{ ...market, lifecycle: "SUSPENDED", supportedLocales: ["cs-CZ", "en-CZ"] }],
          },
          config,
          "en",
          now,
        ),
      );
      expect(failure.reason).toBe("inactive");
    }),
  );
  it.effect("resolves only its associated active market", () =>
    Effect.gen(function* resolvesMarket() {
      const result = yield* selectMarket(
        { associations: [association], markets: [market] },
        config,
        "cs",
        now,
      );
      expect(result).toEqual(market);
    }),
  );
  const changes = [
    { storefrontRef: { appId: "akros-storefront", tenantId: "demo" } },
    { storefrontRef: { appId: config.appId, tenantId: "another-tenant" } },
    { sellingLegalEntityRef: { resourceId: "another-seller" } },
    { channel: "B2B" },
    { effectivePeriod: { startsAt: "2027-01-01T00:00:00Z" } },
  ];
  for (const [index, change] of changes.entries()) {
    it.effect(`refuses foreign or inactive association ${index}`, () =>
      Effect.gen(function* rejectsAssociation() {
        const error = yield* Effect.flip(
          selectMarket(
            { associations: [{ ...association, ...change }], markets: [market] },
            config,
            "cs",
            now,
          ),
        );
        expect(error.reason).toBe("missing");
      }),
    );
  }
  it.effect("never reopens the unfiltered catalogue when no market exists", () =>
    Effect.gen(function* rejectsMissingMarket() {
      const error = yield* Effect.flip(
        selectMarket({ associations: [], markets: [] }, config, "cs", now),
      );
      expect(error.reason).toBe("missing");
    }),
  );
  for (const lifecycle of ["SUSPENDED", "RETIRED"]) {
    it.effect(`refuses ${lifecycle}`, () =>
      Effect.gen(function* rejectsInactiveMarket() {
        const error = yield* Effect.flip(
          selectMarket(
            { associations: [association], markets: [{ ...market, lifecycle }] },
            config,
            "cs",
            now,
          ),
        );
        expect(error.reason).toBe("inactive");
      }),
    );
  }
  it.effect("rejects ambiguous markets", () =>
    Effect.gen(function* rejectsAmbiguity() {
      const error = yield* Effect.flip(
        selectMarket(
          { associations: [association], markets: [market, { ...market, marketCode: "N1-OTHER" }] },
          config,
          "cs",
          now,
        ),
      );
      expect(error.reason).toBe("ambiguous");
    }),
  );
});
