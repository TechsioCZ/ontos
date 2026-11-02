import { Effect, Option, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { akrosDemoLegalEntityId, demoId, demoTenantId } from './fixture-ids.mts';
import {
  deployedServiceSliceReady,
  legacyStorefront,
  legacyStorefrontMemberships,
  legacyStorefrontPrincipalId,
  pseudonymMarketPairs,
  pseudonymPrincipalId,
  pseudonymServiceRelationships,
  pseudonymStorefront,
} from './pseudonymize-akros-policy.mts';
import {
  assertPseudonymPrepared,
  collectOfferExceptions,
  PseudonymPlanSchema,
  pseudonymPlanFingerprint,
  pseudonymPlanMatches,
  retirementGaps,
  validatePseudonymSnapshot,
} from './pseudonymize-akros-snapshot.mts';
import type { Snapshot } from './pseudonymize-akros-snapshot.mts';
import { DemoSeedError } from './seed-client.mts';
import { eshopMarketSeed } from './seed-eshop-markets.mts';

const at = '2026-10-01T00:00:00.000Z';
const marketModule = 'commerce.market-catalog';
const marketResource = 'commerce.market-catalog.market';
const seller = {
  moduleId: 'core.identity',
  resourceId: akrosDemoLegalEntityId,
  resourceType: 'core.identity.legal-entity',
  tenantId: demoTenantId,
};
const marketRefOf = (id: string) => ({
  moduleId: marketModule,
  resourceId: id,
  resourceType: marketResource,
  tenantId: demoTenantId,
});
const sources = pseudonymMarketPairs.map((pair) => {
  const definition = eshopMarketSeed.flatMap(({ markets }) => markets).find(({ code }) => code === pair.targetCode);
  if (definition === undefined) {
    return expect.unreachable('Market seed missing');
  }
  return {
    channels: [definition.channel],
    definitionRevisionRef: {
      moduleId: marketModule,
      resourceId: demoId('definition', pair.sourceCode),
      resourceType: 'commerce.market-catalog.market-definition-revision',
      tenantId: demoTenantId,
    },
    effectivePeriod: { startsAt: at },
    jurisdictions: [definition.jurisdiction],
    lifecycle: definition.lifecycle,
    marketCode: pair.sourceCode,
    marketRef: marketRefOf(demoId(marketResource, pair.sourceCode.toLowerCase())),
    purpose: definition.purpose,
    revision: 1,
    sellingLegalEntityRef: seller,
    supportedLocales: [definition.locale],
  };
});
const isPolish = (code: string) => code === 'AKROS-PL';
const sourceSnapshot = () => ({
  applications: [],
  associations: sources.map((source) => ({
    associationRef: {
      moduleId: marketModule,
      resourceId: demoId('association', source.marketCode),
      resourceType: 'commerce.market-catalog.storefront-association',
      tenantId: demoTenantId,
    },
    channel: source.channels[0],
    effectivePeriod: { startsAt: at },
    marketDefinitionRevisionRef: source.definitionRevisionRef,
    marketRef: source.marketRef,
    provenance: { kind: 'CONFIGURATION_ACTION', reference: 'test' },
    revision: 1,
    sellingLegalEntityRef: seller,
    storefrontRef: { appId: legacyStorefront, tenantId: demoTenantId },
  })),
  companyName: 'AKROS (demo)',
  exceptions: Object.fromEntries(
    sources.map((source) => [
      source.marketRef.resourceId,
      [{ offered: isPolish(source.marketCode), productId: demoId('product', source.marketCode) }],
    ]),
  ),
  markets: sources,
  merchandiseRevision: 10,
  services: [],
  settings: sources.map((source) => ({
    currency: isPolish(source.marketCode) ? 'PLN' : 'CZK',
    exceptionCounts: { notOffered: 1, offered: 0 },
    exchangeRate: '0.17',
    marketCode: source.marketCode,
    marketId: source.marketRef.resourceId,
    offerMode: isPolish(source.marketCode) ? 'SELECTED_PRODUCTS' : 'WHOLE_CATALOGUE',
    revision: 1,
    roundingMinor: 10,
    updatedAt: at,
  })),
});
const plan = () =>
  Schema.decodeUnknownSync(PseudonymPlanSchema)({
    baseline: sourceSnapshot(),
    compositionRevision: 'a'.repeat(64),
    desiredGrants: ['new-bff-only'],
    phase: 'prepare',
    revokedMemberships: ['old-bff-memberships'],
    schemaVersion: 1,
  });
const failsClosed = <A, R>(effect: Effect.Effect<A, unknown, R>) =>
  effect.pipe(
    Effect.flip,
    Effect.map((error) => expect(Schema.is(DemoSeedError)(error)).toBe(true)),
  );

const targetIdOf = (baseline: Snapshot, sourceId: string) => {
  const source = baseline.markets.find(({ marketRef }) => marketRef.resourceId === sourceId);
  return pseudonymMarketPairs.find(({ sourceCode }) => sourceCode === source?.marketCode)?.marketId ?? '';
};
const preparedSnapshot = (baseline: Snapshot): Snapshot =>
  Schema.decodeUnknownSync(PseudonymPlanSchema)({
    ...plan(),
    baseline: {
      ...baseline,
      applications: [
        {
          allowedChannels: ['B2C', 'B2B'],
          effectiveInterval: { effectiveFrom: at },
          lifecycle: 'ACTIVE',
          revision: 1,
          storefrontAppId: pseudonymStorefront,
          storefrontApplicationRef: {
            moduleId: 'commerce.storefront-registry',
            resourceId: pseudonymStorefront,
            resourceType: 'commerce.storefront-registry.storefront-application',
            tenantId: demoTenantId,
          },
        },
      ],
      associations: [
        ...baseline.associations,
        ...baseline.associations
          .filter(({ marketRef }) => targetIdOf(baseline, marketRef.resourceId) !== '')
          .map((association) => ({
            ...association,
            marketRef: { ...association.marketRef, resourceId: targetIdOf(baseline, association.marketRef.resourceId) },
            storefrontRef: { ...association.storefrontRef, appId: pseudonymStorefront },
          })),
      ],
      companyName: 'Šroubárna Vysočina s.r.o.',
      exceptions: {
        ...baseline.exceptions,
        ...Object.fromEntries(
          Object.entries(baseline.exceptions)
            .filter(([id]) => targetIdOf(baseline, id) !== '')
            .map(([id, items]) => [targetIdOf(baseline, id), items]),
        ),
      },
      markets: [
        ...baseline.markets,
        ...baseline.markets.flatMap((source) => {
          const pair = pseudonymMarketPairs.find(({ sourceCode }) => sourceCode === source.marketCode);
          return pair === undefined
            ? []
            : [
                {
                  ...source,
                  marketCode: pair.targetCode,
                  marketRef: { ...source.marketRef, resourceId: pair.marketId },
                },
              ];
        }),
      ],
      settings: [
        ...baseline.settings,
        ...baseline.settings
          .filter(({ marketId }) => targetIdOf(baseline, marketId) !== '')
          .map((setting) => ({
            ...setting,
            marketCode: setting.marketCode.replace('AKROS-', 'SROUB-'),
            marketId: targetIdOf(baseline, setting.marketId),
          })),
      ],
    },
  }).baseline;

it.effect('validates the fixed five source markets, pricing, company scope and brand-free purposes', () =>
  Effect.gen(function* valid() {
    const { baseline } = plan();
    yield* validatePseudonymSnapshot(baseline);
    for (const invalid of [
      { ...baseline, markets: [] },
      { ...baseline, settings: [] },
      {
        ...baseline,
        markets: baseline.markets.map((market) => ({
          ...market,
          sellingLegalEntityRef: { ...market.sellingLegalEntityRef, resourceId: demoId('foreign', 'company') },
        })),
      },
      { ...baseline, markets: baseline.markets.map((market) => ({ ...market, purpose: 'Prodej Akrosu v Česku' })) },
    ]) {
      yield* failsClosed(validatePseudonymSnapshot(invalid));
    }
  }),
);

it.effect(
  'fingerprints definitions, offers, pricing, revisions, deployment and exact grants; refuses stale review',
  () =>
    Effect.gen(function* fingerprints() {
      const original = plan();
      const reviewed = Option.some(yield* pseudonymPlanFingerprint(original));
      expect(yield* pseudonymPlanMatches(original, plan(), reviewed)).toBe(true);
      for (const modified of [
        { ...original, compositionRevision: 'b'.repeat(64) },
        { ...original, desiredGrants: ['admin-forbidden'] },
        { ...original, revokedMemberships: [] },
        { ...original, baseline: { ...original.baseline, merchandiseRevision: 11 } },
        { ...original, baseline: { ...original.baseline, exceptions: {} } },
        {
          ...original,
          baseline: {
            ...original.baseline,
            settings: original.baseline.settings.map((setting) => ({ ...setting, exchangeRate: '2' })),
          },
        },
      ]) {
        expect(yield* pseudonymPlanMatches(original, modified, reviewed)).toBe(false);
      }
      expect(yield* pseudonymPlanMatches(original, original, Option.none())).toBe(false);
      expect(yield* pseudonymPlanMatches(original, original, Option.some('wrong'))).toBe(false);
    }),
);

it.effect('copies every exception across more than two pages, canonicalized by product ID', () =>
  Effect.gen(function* pagination() {
    const items = Array.from({ length: 501 }, (_, index) => ({
      offered: index % 2 === 0,
      productId: String(index).padStart(4, '0'),
    }));
    const offsets: number[] = [];
    const copied = yield* collectOfferExceptions((offset) =>
      Effect.sync(() => {
        offsets.push(offset);
        return { items: items.slice(offset, offset + 250), total: items.length };
      }),
    );
    expect(copied).toEqual(items);
    expect(offsets).toEqual([0, 250, 500]);
  }),
);

it.effect('fails closed on truncated, concurrently changed or duplicate exception pages', () =>
  Effect.gen(function* invalidPagination() {
    const duplicate = { offered: true, productId: 'same' };
    for (const read of [
      () => Effect.succeed({ items: [], total: 1 }),
      () => Effect.succeed({ items: [duplicate, duplicate], total: 2 }),
      (offset: number) =>
        Effect.succeed({ items: [{ offered: true, productId: String(offset) }], total: offset === 0 ? 2 : 3 }),
    ]) {
      yield* failsClosed(collectOfferExceptions(read));
    }
  }),
);

it.effect('verifies exact replacement definitions, lifecycle (PL suspended), settings, associations, exceptions', () =>
  Effect.gen(function* verification() {
    const { baseline } = plan();
    const after = preparedSnapshot(baseline);
    yield* assertPseudonymPrepared(baseline, after);
    yield* failsClosed(assertPseudonymPrepared(baseline, { ...after, exceptions: {} }));
    yield* failsClosed(assertPseudonymPrepared(baseline, { ...after, associations: [] }));
    yield* failsClosed(assertPseudonymPrepared(baseline, { ...after, companyName: 'AKROS (demo)' }));
    yield* failsClosed(
      assertPseudonymPrepared(baseline, {
        ...after,
        markets: after.markets.map((market) =>
          market.marketCode === 'SROUB-PL' ? { ...market, lifecycle: 'ACTIVE' as const } : market,
        ),
      }),
    );
  }),
);

it('reports every retirement gap until associations, markets, pricing, application and old key are gone', () => {
  const after = preparedSnapshot(plan().baseline);
  expect(retirementGaps(after)).toEqual([
    'legacy storefront associations',
    'legacy markets not retired',
    'legacy market pricing',
  ]);
  const retired: Snapshot = {
    ...after,
    associations: after.associations.filter(({ storefrontRef }) => storefrontRef.appId !== legacyStorefront),
    markets: after.markets.map((market) =>
      market.marketCode.startsWith('AKROS-') ? { ...market, lifecycle: 'RETIRED' as const } : market,
    ),
    settings: after.settings.filter(({ marketCode }) => !marketCode.startsWith('AKROS-')),
  };
  expect(retirementGaps(retired)).toEqual([]);
});

it.effect('includes retired QA markets without a replacement and removes their pricing on retirement', () =>
  Effect.gen(function* qaMarkets() {
    const { baseline } = plan();
    const [template] = baseline.markets;
    const [setting] = baseline.settings;
    const [association] = baseline.associations;
    if (template === undefined || setting === undefined || association === undefined) {
      return expect.unreachable('Fixture missing');
    }
    const qaId = demoId(marketResource, 'akros-qa-test');
    const qa = {
      ...template,
      lifecycle: 'RETIRED' as const,
      marketCode: 'AKROS-QA-MVYJJQ52',
      marketRef: { ...template.marketRef, resourceId: qaId },
    };
    const withQa: Snapshot = {
      ...baseline,
      markets: [...baseline.markets, qa],
      settings: [...baseline.settings, { ...setting, marketCode: qa.marketCode, marketId: qaId }],
    };
    yield* validatePseudonymSnapshot(withQa);
    yield* failsClosed(
      validatePseudonymSnapshot({
        ...withQa,
        associations: [
          ...withQa.associations,
          {
            ...association,
            marketRef: qa.marketRef,
            storefrontRef: { ...association.storefrontRef, appId: 'kavarna-doma-eshop' },
          },
        ],
      }),
    );
    const after = preparedSnapshot(withQa);
    const retired: Snapshot = {
      ...after,
      associations: after.associations.filter(({ storefrontRef }) => storefrontRef.appId !== legacyStorefront),
      markets: after.markets.map((market) =>
        market.marketCode.startsWith('AKROS-') ? { ...market, lifecycle: 'RETIRED' as const } : market,
      ),
    };
    expect(retirementGaps(retired)).toEqual(['legacy market pricing']);
    return yield* Effect.void;
  }),
);

it('retires the old principal only after the deployed startup reconciler stopped installing it', () => {
  expect(deployedServiceSliceReady([pseudonymPrincipalId, demoId('core.principal', 'commerce-portal')])).toBe(true);
  expect(deployedServiceSliceReady([legacyStorefrontPrincipalId])).toBe(false);
  expect(deployedServiceSliceReady([legacyStorefrontPrincipalId, pseudonymPrincipalId])).toBe(false);
});

it('keeps service roles human-admin-free and revokes only old principal memberships, never shared role grants', () => {
  const desired = pseudonymServiceRelationships([]);
  expect(desired.some(({ subject }) => subject?.object?.objectId === pseudonymPrincipalId)).toBe(true);
  expect(desired.some(({ relation }) => relation === 'superadmin' || relation === 'admin')).toBe(false);
  expect(desired.some(({ subject }) => subject?.object?.objectId === legacyStorefrontPrincipalId)).toBe(false);
  const removed = legacyStorefrontMemberships([]);
  expect(removed.length).toBeGreaterThan(0);
  expect(removed.every(({ subject }) => subject?.object?.objectId === legacyStorefrontPrincipalId)).toBe(true);
});
