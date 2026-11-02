/** Read-only snapshot, fail-closed validation and replacement proof of the fixed demo-company pseudonym migration. */
import { akrosDemoCompany } from '@app/core-runtime/demo-company-profiles';
import { DateTime, Effect, Option, Schema } from 'effect';

import {
  CurrentMarketCatalogRequestSchema,
  CurrentMarketCatalogResponseSchema,
} from '../../verticals/commerce-market-catalog/shared/apis/current-market-catalog.ts';
import {
  MarketDefinitionSchema,
  StorefrontAssociationDefinitionSchema,
} from '../../verticals/commerce-market-catalog/shared/market-contracts.ts';
import { RecordsRequestSchema, RecordsResponseSchema } from '../../verticals/merchandise/shared/apis/records.ts';
import { MarketSettingsSchema } from '../../verticals/merchandise/shared/domain/market-offers.ts';
import {
  StorefrontApplicationsRequestSchema,
  StorefrontApplicationsResponseSchema,
  StorefrontApplicationSummarySchema,
} from '../../verticals/storefront-registry/shared/apis/storefront-applications.ts';
import { AuthBindingIdSchema, PrincipalIdSchema } from '../../apps/shell-super-app/shared/api.ts';
import type { connectPseudonymShell } from './pseudonymize-akros-shell.mts';
import { akrosDemoLegalEntityId, demoTenantId } from './fixture-ids.mts';
import { DemoSeedError } from './seed-client.mts';
import type { SeedClient } from './seed-client.mts';
import {
  containsLegacyBrand,
  legacyMarketPrefix,
  legacyStorefront,
  legacyStorefrontPrincipalId,
  OfferExceptionSchema,
  orderedExceptions,
  pseudonymFingerprint,
  pseudonymMarketPairs,
  pseudonymPrincipalId,
  pseudonymStorefront,
  sameOfferExceptions,
  sortedBy,
} from './pseudonymize-akros-policy.mts';
import type { OfferException } from './pseudonymize-akros-policy.mts';

const legacyCompanyName = 'AKROS (demo)';
export const marketOwner = 'commerce-market-catalog';
export const registryOwner = 'storefront-registry';
export const merchandiseOwner = 'merchandise';
export const fail = (reason: string) => new DemoSeedError({ reason });
export const atNow = DateTime.now.pipe(Effect.map(DateTime.formatIso));

export const MarketEncoded = Schema.toEncoded(MarketDefinitionSchema);
export const SettingsEncoded = Schema.toEncoded(MarketSettingsSchema);
const AssociationEncoded = Schema.toEncoded(StorefrontAssociationDefinitionSchema);
const sameMarket = Schema.toEquivalence(MarketEncoded);
const sameAssociation = Schema.toEquivalence(AssociationEncoded);
export type MarketDefinition = typeof MarketEncoded.Type;
export type MarketSettings = typeof SettingsEncoded.Type;
export type MarketPair = (typeof pseudonymMarketPairs)[number];

/** Managed key projection; usage timestamps are excluded so live storefront traffic cannot invalidate a plan. */
export const ManagedServiceSchema = Schema.Struct({
  displayName: Schema.String,
  enabled: Schema.Boolean,
  keyBindingId: Schema.Union([Schema.Null, AuthBindingIdSchema]),
  keyStatus: Schema.Union([Schema.Null, Schema.Literals(['active', 'disabled'])]),
  principalId: PrincipalIdSchema,
  principalStatus: Schema.Literals(['active', 'disabled', 'archived']),
});
export const SnapshotSchema = Schema.Struct({
  applications: Schema.Array(Schema.toEncoded(StorefrontApplicationSummarySchema)),
  associations: Schema.Array(AssociationEncoded),
  companyName: Schema.String,
  exceptions: Schema.Record(Schema.String, Schema.Array(OfferExceptionSchema)),
  markets: Schema.Array(MarketEncoded),
  merchandiseRevision: Schema.Int,
  services: Schema.Array(ManagedServiceSchema),
  settings: Schema.Array(SettingsEncoded),
});
export type Snapshot = typeof SnapshotSchema.Type;
export const PseudonymPlanSchema = Schema.Struct({
  baseline: SnapshotSchema,
  compositionRevision: Schema.String,
  desiredGrants: Schema.Array(Schema.String),
  phase: Schema.Literals(['prepare', 'retire']),
  revokedMemberships: Schema.Array(Schema.String),
  schemaVersion: Schema.Literal(1),
});
export type Plan = typeof PseudonymPlanSchema.Type;
export const planCodec = Schema.fromJsonString(PseudonymPlanSchema);
export const encodePlan = (plan: Plan) => Schema.encodeEffect(planCodec)(plan);
export const pseudonymPlanFingerprint = (plan: Plan) => encodePlan(plan).pipe(Effect.map(pseudonymFingerprint));
/** The reviewed fingerprint must name the saved plan, and the live state must still encode identically. */
export const pseudonymPlanMatches = (saved: Plan, current: Plan, reviewed: Option.Option<string>) =>
  Effect.gen(function* planMatches() {
    const savedText = yield* encodePlan(saved);
    return Option.contains(reviewed, pseudonymFingerprint(savedText)) && savedText === (yield* encodePlan(current));
  });

const relevantCode = (code: string) =>
  pseudonymMarketPairs.some(({ sourceCode, targetCode }) => code === sourceCode || code === targetCode);
export const isActiveKey = (service: typeof ManagedServiceSchema.Type) =>
  service.keyStatus === 'active' && service.enabled;
export const hasActivePseudonymKey = (snapshot: Snapshot) =>
  snapshot.services.some(
    (service) =>
      service.principalId === pseudonymPrincipalId &&
      service.principalStatus === 'active' &&
      service.displayName === pseudonymStorefront &&
      isActiveKey(service),
  );

export const readRecords = (client: SeedClient, view: (typeof RecordsRequestSchema.Encoded)['view']) =>
  client.call(
    merchandiseOwner,
    '/reads/records',
    Schema.toEncoded(RecordsRequestSchema),
    { view },
    Schema.toEncoded(RecordsResponseSchema),
  );
export const readMarketCatalog = (client: SeedClient) =>
  Effect.gen(function* marketCatalog() {
    return yield* client.call(
      marketOwner,
      '/reads/current-market-catalog',
      Schema.toEncoded(CurrentMarketCatalogRequestSchema),
      { at: yield* atNow },
      Schema.toEncoded(CurrentMarketCatalogResponseSchema),
    );
  });

export const collectOfferExceptions = <E, R>(
  readPage: (
    offset: number,
  ) => Effect.Effect<{ readonly items: readonly OfferException[]; readonly total: number }, E, R>,
) =>
  Effect.gen(function* allExceptions() {
    const items: OfferException[] = [];
    let total = 0;
    do {
      const page = yield* readPage(items.length);
      if (page.items.length === 0 && items.length < page.total) {
        return yield* fail('Incomplete market exceptions page');
      }
      if (items.length > 0 && total !== page.total) {
        return yield* fail('Market exceptions changed while paginating');
      }
      ({ total } = page);
      items.push(...page.items.map(({ offered, productId }) => ({ offered, productId })));
    } while (items.length < total);
    if (items.length !== total || new Set(items.map(({ productId }) => productId)).size !== total) {
      return yield* fail('Duplicate or incomplete exceptions');
    }
    return orderedExceptions(items);
  });
const readExceptions = (client: SeedClient, marketId: string) =>
  collectOfferExceptions((offset) =>
    readRecords(client, { limit: 0, marketExceptions: { limit: 250, marketId, offset } }).pipe(
      Effect.flatMap(({ marketExceptions }) =>
        marketExceptions === undefined
          ? Effect.fail(fail('Exceptions page missing'))
          : Effect.succeed(marketExceptions),
      ),
    ),
  );

type Shell = Effect.Success<typeof connectPseudonymShell>;
const readServices = (shell: Shell) =>
  Effect.gen(function* services() {
    const result: (typeof ManagedServiceSchema.Type)[] = [];
    let offset = 0;
    for (;;) {
      const listed = yield* shell.identity.listManagedApiKeys({
        payload: { limit: 100, offset, scope: 'tenant-managed' },
      });
      for (const item of listed.items) {
        if (item.principalId === legacyStorefrontPrincipalId || item.principalId === pseudonymPrincipalId) {
          result.push({
            displayName: item.displayName,
            enabled: item.key?.enabled ?? false,
            keyBindingId: item.key?.authBindingId ?? null,
            keyStatus: item.key?.bindingStatus ?? null,
            principalId: item.principalId,
            principalStatus: item.principalStatus,
          });
        }
      }
      if (listed.nextOffset === null) {
        return sortedBy(result, ({ keyBindingId, principalId }) => `${principalId}:${keyBindingId ?? ''}`);
      }
      if (listed.nextOffset <= offset) {
        return yield* fail('Invalid managed key pagination');
      }
      offset = listed.nextOffset;
    }
  });

export const readSnapshot = (client: SeedClient, shell: Shell) =>
  Effect.gen(function* snapshot() {
    const { legalEntities } = yield* shell.legalEntities.availableLegalEntities({});
    const company = legalEntities.find(({ legalEntityId }) => legalEntityId === akrosDemoLegalEntityId);
    if (company === undefined || ![legacyCompanyName, akrosDemoCompany.legalName].includes(company.legalName)) {
      return yield* fail('Unexpected demo company identity');
    }
    const catalog = yield* readMarketCatalog(client);
    const markets = sortedBy(
      catalog.markets.filter(({ marketCode }) => relevantCode(marketCode)),
      ({ marketCode }) => marketCode,
    );
    if (
      markets.some(
        ({ marketRef, sellingLegalEntityRef }) =>
          sellingLegalEntityRef.resourceId !== akrosDemoLegalEntityId || marketRef.tenantId !== demoTenantId,
      )
    ) {
      return yield* fail('Foreign market in company catalog');
    }
    if (
      catalog.markets.some(({ marketCode }) => marketCode.startsWith(legacyMarketPrefix) && !relevantCode(marketCode))
    ) {
      return yield* fail('Unreviewed legacy market exists; extend the fixed migration before applying');
    }
    const ids = new Set(markets.map(({ marketRef }) => marketRef.resourceId));
    const associations = sortedBy(
      catalog.associations.filter(({ marketRef }) => ids.has(marketRef.resourceId)),
      ({ associationRef }) => associationRef.resourceId,
    );
    const { applications } = yield* client.call(
      registryOwner,
      '/reads/storefront-applications',
      Schema.toEncoded(StorefrontApplicationsRequestSchema),
      { at: yield* atNow },
      Schema.toEncoded(StorefrontApplicationsResponseSchema),
    );
    const before = yield* readRecords(client, { limit: 0, markets: true, summary: true });
    const settings = sortedBy(
      (before.markets ?? []).filter(({ marketId }) => ids.has(marketId)),
      ({ marketId }) => marketId,
    );
    const exceptions: Record<string, readonly OfferException[]> = {};
    for (const setting of settings) {
      exceptions[setting.marketId] = yield* readExceptions(client, setting.marketId);
    }
    const after = yield* readRecords(client, { limit: 0, summary: true });
    if (before.revision !== after.revision) {
      return yield* fail('Merchandise changed while planning; rerun plan');
    }
    return {
      applications: sortedBy(
        applications.filter(
          ({ storefrontAppId }) => storefrontAppId === legacyStorefront || storefrontAppId === pseudonymStorefront,
        ),
        ({ storefrontAppId }) => storefrontAppId,
      ),
      associations,
      companyName: company.legalName,
      exceptions,
      markets,
      merchandiseRevision: before.revision,
      services: yield* readServices(shell),
      settings,
    } satisfies Snapshot;
  });

const marketByCode = (snapshot: Snapshot, code: string) =>
  snapshot.markets.find(({ marketCode }) => marketCode === code);
const ownMarket = (market: MarketDefinition) =>
  market.sellingLegalEntityRef.resourceId === akrosDemoLegalEntityId && market.marketRef.tenantId === demoTenantId;
export const legacyAssociations = (snapshot: Snapshot, marketId: string) =>
  snapshot.associations.filter(
    ({ marketRef, storefrontRef }) => marketRef.resourceId === marketId && storefrontRef.appId === legacyStorefront,
  );

/** Fail closed on foreign IDs, missing source data, unreviewed brand text or conflicting pre-existing target data. */
export const validatePseudonymSnapshot = Effect.fn('Pseudonym.validateSnapshot')(function* validateSnapshot(
  snapshot: Snapshot,
) {
  for (const pair of pseudonymMarketPairs) {
    const source = marketByCode(snapshot, pair.sourceCode);
    const target = marketByCode(snapshot, pair.targetCode);
    if (source === undefined || !ownMarket(source)) {
      return yield* fail(`Source missing or foreign: ${pair.sourceCode}`);
    }
    if (target !== undefined && (target.marketRef.resourceId !== pair.marketId || !ownMarket(target))) {
      return yield* fail(`Conflicting target: ${pair.targetCode}`);
    }
    if (containsLegacyBrand(source.purpose)) {
      return yield* fail(`Source purpose names the legacy brand; edit it in the staff app first: ${pair.sourceCode}`);
    }
    if (!snapshot.settings.some(({ marketId }) => marketId === source.marketRef.resourceId)) {
      return yield* fail(`Source settings missing: ${pair.sourceCode}`);
    }
    if (
      snapshot.associations.some(
        ({ marketRef, storefrontRef }) =>
          marketRef.resourceId === source.marketRef.resourceId && storefrontRef.appId !== legacyStorefront,
      )
    ) {
      return yield* fail('Legacy market has another storefront; review manually');
    }
  }
  return snapshot;
});

/** The replacement definition: identical except for code and ID; a retired source cannot be replaced. */
export const replacementMarket = (source: MarketDefinition, pair: MarketPair, reason: string) =>
  source.lifecycle === 'RETIRED'
    ? Effect.fail(fail(`Cannot prepare from a retired source: ${pair.sourceCode}`))
    : Effect.succeed({
        channels: source.channels,
        effectivePeriod: source.effectivePeriod,
        jurisdictions: source.jurisdictions,
        lifecycle: source.lifecycle,
        marketCode: pair.targetCode,
        marketId: pair.marketId,
        purpose: source.purpose,
        reason,
        sellingLegalEntityRef: source.sellingLegalEntityRef,
        supportedLocales: source.supportedLocales,
      });
export const settingFields = ({ currency, exchangeRate, offerMode, roundingMinor }: MarketSettings) => ({
  currency,
  exchangeRate,
  offerMode,
  roundingMinor,
});
export const sameSettingFields = (left: MarketSettings, right: MarketSettings) =>
  left.currency === right.currency &&
  left.exchangeRate === right.exchangeRate &&
  left.offerMode === right.offerMode &&
  left.roundingMinor === right.roundingMinor;

const assertReplacement = Effect.fn('Pseudonym.assertReplacement')(function* assertReplacement(
  baseline: Snapshot,
  after: Snapshot,
  pair: MarketPair,
) {
  const source = marketByCode(baseline, pair.sourceCode);
  const target = marketByCode(after, pair.targetCode);
  if (source === undefined || target === undefined || target.marketRef.resourceId !== pair.marketId) {
    return yield* fail(`Target missing: ${pair.targetCode}`);
  }
  const { lifecycle } = yield* replacementMarket(source, pair, '');
  const expected = {
    ...target,
    channels: source.channels,
    effectivePeriod: source.effectivePeriod,
    jurisdictions: source.jurisdictions,
    lifecycle,
    purpose: source.purpose,
    supportedLocales: source.supportedLocales,
  };
  if (!sameMarket(target, expected)) {
    return yield* fail(`Target definition mismatch: ${pair.targetCode}`);
  }
  const sourceSetting = baseline.settings.find(({ marketId }) => marketId === source.marketRef.resourceId);
  const targetSetting = after.settings.find(({ marketId }) => marketId === pair.marketId);
  if (
    sourceSetting === undefined ||
    targetSetting === undefined ||
    targetSetting.marketCode !== pair.targetCode ||
    !sameSettingFields(sourceSetting, targetSetting)
  ) {
    return yield* fail(`Target settings mismatch: ${pair.targetCode}`);
  }
  if (
    !sameOfferExceptions(baseline.exceptions[source.marketRef.resourceId] ?? [], after.exceptions[pair.marketId] ?? [])
  ) {
    return yield* fail(`Target exception mismatch: ${pair.targetCode}`);
  }
  const oldAssociations = legacyAssociations(baseline, source.marketRef.resourceId);
  if (oldAssociations.length === 0) {
    return yield* fail(`Source association missing: ${pair.sourceCode}`);
  }
  const replaced = oldAssociations.every((association) =>
    after.associations.some(
      (candidate) =>
        candidate.marketRef.resourceId === pair.marketId &&
        candidate.storefrontRef.appId === pseudonymStorefront &&
        candidate.channel === association.channel &&
        sameAssociation(candidate, { ...candidate, effectivePeriod: association.effectivePeriod }),
    ),
  );
  if (!replaced) {
    return yield* fail(`Target association missing: ${pair.targetCode}`);
  }
  return target;
});

/** Proof of a complete replacement: company, active application, definitions, settings, exceptions, associations. */
export const assertPseudonymPrepared = Effect.fn('Pseudonym.assertPrepared')(function* assertPrepared(
  baseline: Snapshot,
  after: Snapshot,
) {
  if (after.companyName !== akrosDemoCompany.legalName) {
    return yield* fail('Company name not migrated');
  }
  if (
    !after.applications.some(
      ({ lifecycle, storefrontAppId }) => lifecycle === 'ACTIVE' && storefrontAppId === pseudonymStorefront,
    )
  ) {
    return yield* fail('New application not active');
  }
  for (const pair of pseudonymMarketPairs) {
    yield* assertReplacement(baseline, after, pair);
  }
  return after;
});

/** Everything the retirement phase must leave behind; asynchronous owner workers may lag, so verify can repeat. */
export const retirementGaps = (after: Snapshot): readonly string[] => {
  const checks: readonly (readonly [boolean, string])[] = [
    [
      after.associations.some(({ storefrontRef }) => storefrontRef.appId === legacyStorefront),
      'legacy storefront associations',
    ],
    [
      after.markets.some(
        ({ lifecycle, marketCode }) => marketCode.startsWith(legacyMarketPrefix) && lifecycle !== 'RETIRED',
      ),
      'legacy markets not retired',
    ],
    [after.settings.some(({ marketCode }) => marketCode.startsWith(legacyMarketPrefix)), 'legacy market pricing'],
    [
      after.applications.some(
        ({ lifecycle, storefrontAppId }) => storefrontAppId === legacyStorefront && lifecycle !== 'RETIRED',
      ),
      'legacy application not retired',
    ],
    [
      after.services.some(
        (service) =>
          service.principalId === legacyStorefrontPrincipalId &&
          (service.principalStatus === 'active' || isActiveKey(service)),
      ),
      'legacy storefront principal or key still active',
    ],
  ];
  return checks.filter(([open]) => open).map(([, gap]) => gap);
};
