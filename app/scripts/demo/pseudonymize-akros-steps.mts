/** Governed owner writes of the pseudonym migration. Each write runs once; an uncertain write is never retried. */
import { Effect, Schema } from 'effect';

import {
  AssociateStorefrontPayloadSchema,
  CreateMarketPayloadSchema,
  CreateMarketResultSchema,
  RemoveStorefrontAssociationPayloadSchema,
  RetireMarketPayloadSchema,
  RetireMarketResultSchema,
  StorefrontAssociationResultSchema,
} from '../../verticals/commerce-market-catalog/shared/action-contracts.ts';
import {
  MarketAdministrationRequestSchema,
  MarketAdministrationResponseSchema,
} from '../../verticals/commerce-market-catalog/shared/apis/market-administration.ts';
import { MerchandiseCommandSchema } from '../../verticals/merchandise/shared/actions/apply-command.ts';
import {
  RegisterStorefrontApplicationPayloadSchema,
  RegisterStorefrontApplicationResultSchema,
} from '../../verticals/storefront-registry/shared/actions/register-storefront-application.ts';
import {
  ReviseStorefrontApplicationPayloadSchema,
  ReviseStorefrontApplicationResultSchema,
} from '../../verticals/storefront-registry/shared/actions/revise-storefront-application.ts';
import { demoId, demoTenantId } from './fixture-ids.mts';
import {
  legacyMarketPrefix,
  legacyStorefront,
  pseudonymMarketPairs,
  pseudonymStorefront,
} from './pseudonymize-akros-policy.mts';
import type { OfferException } from './pseudonymize-akros-policy.mts';
import {
  atNow,
  fail,
  legacyAssociations,
  marketOwner,
  merchandiseOwner,
  readMarketCatalog,
  readRecords,
  registryOwner,
  replacementMarket,
  sameSettingFields,
  settingFields,
} from './pseudonymize-akros-snapshot.mts';
import type { MarketDefinition, MarketPair, Snapshot } from './pseudonymize-akros-snapshot.mts';
import type { SeedClient } from './seed-client.mts';

const CommandPayload = Schema.toEncoded(MerchandiseCommandSchema);
const offerBatch = 250;
const sameException = (item: OfferException) => (other: OfferException) =>
  item.offered === other.offered && item.productId === other.productId;

const merchandiseAction = (client: SeedClient, command: typeof CommandPayload.Type) =>
  readRecords(client, { limit: 0, summary: true }).pipe(
    Effect.flatMap(({ revision }) => client.apply(merchandiseOwner, CommandPayload, command, revision)),
  );
const ownerAction = <P extends Schema.Top, R extends Schema.Top>(
  client: SeedClient,
  owner: string,
  slug: string,
  schemas: { readonly payload: P; readonly result: R },
  input: P['Type'],
) => client.call(owner, `/${owner}/actions/${slug}`, schemas.payload, input, schemas.result, true);
const createMarket = {
  payload: Schema.toEncoded(CreateMarketPayloadSchema),
  result: Schema.toEncoded(CreateMarketResultSchema),
};
const associateStorefront = {
  payload: Schema.toEncoded(AssociateStorefrontPayloadSchema),
  result: Schema.toEncoded(StorefrontAssociationResultSchema),
};
const removeAssociation = {
  payload: Schema.toEncoded(RemoveStorefrontAssociationPayloadSchema),
  result: Schema.toEncoded(StorefrontAssociationResultSchema),
};
const retireMarket = {
  payload: Schema.toEncoded(RetireMarketPayloadSchema),
  result: Schema.toEncoded(RetireMarketResultSchema),
};
const registerApplication = {
  payload: Schema.toEncoded(RegisterStorefrontApplicationPayloadSchema),
  result: Schema.toEncoded(RegisterStorefrontApplicationResultSchema),
};
const reviseApplication = {
  payload: Schema.toEncoded(ReviseStorefrontApplicationPayloadSchema),
  result: Schema.toEncoded(ReviseStorefrontApplicationResultSchema),
};

const registerPseudonymApplication = Effect.fn('Pseudonym.registerApplication')(function* registerPseudonymApplication(
  client: SeedClient,
  baseline: Snapshot,
  reason: string,
) {
  if (baseline.applications.some(({ storefrontAppId }) => storefrontAppId === pseudonymStorefront)) {
    return yield* Effect.void;
  }
  const source = baseline.applications.find(({ storefrontAppId }) => storefrontAppId === legacyStorefront);
  if (source === undefined) {
    return yield* fail('Legacy application missing');
  }
  yield* ownerAction(client, registryOwner, 'register-storefront-application', registerApplication, {
    allowedChannels: source.allowedChannels,
    effectiveInterval: source.effectiveInterval,
    lifecycle: 'ACTIVE',
    reason,
    storefrontAppId: pseudonymStorefront,
  });
  return yield* Effect.void;
});

const ensureTargetMarket = Effect.fn('Pseudonym.ensureTargetMarket')(function* ensureTargetMarket(
  client: SeedClient,
  baseline: Snapshot,
  source: MarketDefinition,
  pair: MarketPair,
  reason: string,
) {
  const existing = baseline.markets.find(({ marketCode }) => marketCode === pair.targetCode);
  if (existing !== undefined) {
    return existing;
  }
  yield* ownerAction(
    client,
    marketOwner,
    'create-market',
    createMarket,
    yield* replacementMarket(source, pair, reason),
  );
  const created = (yield* readMarketCatalog(client)).markets.find(({ marketCode }) => marketCode === pair.targetCode);
  if (created === undefined) {
    return yield* fail(`New market readback missing: ${pair.targetCode}`);
  }
  return created;
});

const copyAssociations = Effect.fn('Pseudonym.copyAssociations')(function* copyAssociations(
  client: SeedClient,
  baseline: Snapshot,
  source: MarketDefinition,
  target: MarketDefinition,
  reason: string,
) {
  for (const association of legacyAssociations(baseline, source.marketRef.resourceId)) {
    const present = baseline.associations.some(
      ({ channel, marketRef, storefrontRef }) =>
        channel === association.channel &&
        marketRef.resourceId === target.marketRef.resourceId &&
        storefrontRef.appId === pseudonymStorefront,
    );
    if (!present) {
      // Containment is projected asynchronously; a refused association stops the run for a fresh plan.
      yield* ownerAction(client, marketOwner, 'associate-storefront', associateStorefront, {
        associationId: demoId(
          'commerce.market-catalog.storefront-association',
          `${target.marketCode.toLowerCase()}:${pseudonymStorefront}:${association.channel}`,
        ),
        channel: association.channel,
        effectivePeriod: association.effectivePeriod,
        expectedMarketDefinitionRevisionRef: target.definitionRevisionRef,
        marketRef: target.marketRef,
        provenance: { kind: 'MIGRATION', reference: 'pseudonymize-akros-demo:v1' },
        reason,
        sellingLegalEntityRef: source.sellingLegalEntityRef,
        storefrontRef: { appId: pseudonymStorefront, tenantId: demoTenantId },
      });
    }
  }
  return yield* Effect.void;
});

const copyPricingAndOffers = Effect.fn('Pseudonym.copyPricingAndOffers')(function* copyPricingAndOffers(
  client: SeedClient,
  baseline: Snapshot,
  source: MarketDefinition,
  pair: MarketPair,
) {
  const sourceSetting = baseline.settings.find(({ marketId }) => marketId === source.marketRef.resourceId);
  if (sourceSetting === undefined) {
    return yield* fail(`Source pricing missing: ${pair.sourceCode}`);
  }
  const existingSetting = baseline.settings.find(({ marketId }) => marketId === pair.marketId);
  if (existingSetting !== undefined && !sameSettingFields(sourceSetting, existingSetting)) {
    return yield* fail(`Conflicting target pricing; no overwrite: ${pair.targetCode}`);
  }
  if (existingSetting === undefined) {
    yield* merchandiseAction(client, {
      _tag: 'ConfigureMarket',
      ...settingFields(sourceSetting),
      marketCode: pair.targetCode,
      marketId: pair.marketId,
    });
  }
  const expected = baseline.exceptions[source.marketRef.resourceId] ?? [];
  const existing = baseline.exceptions[pair.marketId] ?? [];
  if (existing.some((item) => !expected.some(sameException(item)))) {
    return yield* fail(`Conflicting target offer exceptions; no overwrite: ${pair.targetCode}`);
  }
  const missing = expected.filter((item) => !existing.some(sameException(item)));
  for (const offered of [false, true]) {
    const productIds = missing.filter((item) => item.offered === offered).map(({ productId }) => productId);
    for (let offset = 0; offset < productIds.length; offset += offerBatch) {
      yield* merchandiseAction(client, {
        _tag: 'SetMarketProductOffers',
        marketId: pair.marketId,
        offered,
        productIds: productIds.slice(offset, offset + offerBatch),
      });
    }
  }
  return yield* Effect.void;
});

/** New application, then per market: exact definition copy, associations, pricing and every offer exception. */
export const prepareMarkets = Effect.fn('Pseudonym.prepareMarkets')(function* prepareMarkets(
  client: SeedClient,
  baseline: Snapshot,
  reason: string,
) {
  yield* registerPseudonymApplication(client, baseline, reason);
  for (const pair of pseudonymMarketPairs) {
    const source = baseline.markets.find(({ marketCode }) => marketCode === pair.sourceCode);
    if (source === undefined) {
      return yield* fail(`Source missing: ${pair.sourceCode}`);
    }
    const target = yield* ensureTargetMarket(client, baseline, source, pair, reason);
    yield* copyAssociations(client, baseline, source, target, reason);
    yield* copyPricingAndOffers(client, baseline, source, pair);
  }
  return yield* Effect.void;
});

const retireLegacyMarket = Effect.fn('Pseudonym.retireMarket')(function* retireLegacyMarket(
  client: SeedClient,
  source: MarketDefinition,
  reason: string,
) {
  const { market } = yield* client.call(
    marketOwner,
    '/reads/market-administration',
    Schema.toEncoded(MarketAdministrationRequestSchema),
    { marketRef: source.marketRef },
    Schema.toEncoded(MarketAdministrationResponseSchema),
  );
  if (market === undefined || !market.canAdminister) {
    return yield* fail(`Market retirement not authorized: ${source.marketCode}`);
  }
  yield* ownerAction(client, marketOwner, 'retire-market', retireMarket, {
    effectiveAt: yield* atNow,
    expectedCurrentDefinitionRevisionRef: market.currentDefinitionRevisionRef,
    expectedRevision: market.revision,
    marketRef: source.marketRef,
    reason,
  });
  return yield* Effect.void;
});

const removeLegacyAssociation = (client: SeedClient, association: Snapshot['associations'][number], reason: string) =>
  Effect.gen(function* removeAssociationNow() {
    return yield* ownerAction(client, marketOwner, 'remove-storefront-association', removeAssociation, {
      associationRef: association.associationRef,
      effectiveAt: yield* atNow,
      expectedRevision: association.revision,
      marketRef: association.marketRef,
      reason,
      storefrontRef: association.storefrontRef,
    });
  });

/** Legacy associations end now, legacy markets retire with their pricing removed, the legacy application retires. */
export const retireLegacyCatalog = Effect.fn('Pseudonym.retireLegacyCatalog')(function* retireLegacyCatalog(
  client: SeedClient,
  baseline: Snapshot,
  reason: string,
) {
  const retired = new Set(
    baseline.markets.filter(({ lifecycle }) => lifecycle === 'RETIRED').map(({ marketRef }) => marketRef.resourceId),
  );
  const legacy = baseline.associations.filter(({ storefrontRef }) => storefrontRef.appId === legacyStorefront);
  for (const association of legacy) {
    if (!retired.has(association.marketRef.resourceId)) {
      yield* removeLegacyAssociation(client, association, reason);
    }
  }
  for (const source of baseline.markets) {
    if (source.marketCode.startsWith(legacyMarketPrefix) && source.lifecycle !== 'RETIRED') {
      yield* retireLegacyMarket(client, source, reason);
    }
  }
  // Pricing of every legacy market goes, including already retired QA markets, so no legacy code stays visible.
  for (const setting of baseline.settings) {
    if (setting.marketCode.startsWith(legacyMarketPrefix)) {
      yield* merchandiseAction(client, { _tag: 'RemoveMarket', marketId: setting.marketId });
    }
  }
  // Associations still current on already retired QA markets end last: a refusal there leaves only this gap.
  for (const association of legacy) {
    if (retired.has(association.marketRef.resourceId)) {
      yield* removeLegacyAssociation(client, association, reason);
    }
  }
  const application = baseline.applications.find(({ storefrontAppId }) => storefrontAppId === legacyStorefront);
  if (application !== undefined && application.lifecycle !== 'RETIRED') {
    yield* ownerAction(client, registryOwner, 'revise-storefront-application', reviseApplication, {
      allowedChannels: application.allowedChannels,
      effectiveInterval: application.effectiveInterval,
      expectedRevision: application.revision,
      lifecycle: 'RETIRED',
      reason,
      storefrontApplicationRef: application.storefrontApplicationRef,
    });
  }
  return yield* Effect.void;
});
