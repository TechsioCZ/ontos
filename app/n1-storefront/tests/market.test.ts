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
