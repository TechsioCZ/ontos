import {
  CurrentMarketCatalogRequestSchema,
  executeCurrentMarketCatalogWithAuthorization,
} from '@app/commerce-market-catalog/api/client';
import { MarketRefSchema } from '@app/commerce-market-catalog/resources/market';
import { LegalEntityIdSchema } from '@app/core-runtime/access/ids';
import {
  CurrentSupportedCurrenciesRequestSchema,
  CurrentSupportedCurrenciesSuccessSchema,
  PricingCurrencyCodeSchema,
} from '@app/pricing-contracts/current-supported-currencies';
import { executeCurrentSupportedCurrenciesWithAuthorization } from '@app/pricing-contracts/current-supported-currencies/client';
import { SymmyRouteRefSchema, SymmySourceRecordRefSchema } from '@app/shared-contracts/symmy';
import { Crypto, DateTime, Effect, Match, Redacted, Schema } from 'effect';

import type { SymmyIngressProblem } from './contract.ts';
import { SymmyRegionSourceIdSchema } from './regions-projection-contract.ts';
import type { SymmyInternalRegionsProjection } from './regions-projection-contract.ts';
import { qualifySymmyReadId } from './read-projection-contracts.ts';

const scopeFields = {
  issuerId: SymmySourceRecordRefSchema.fields.issuerId,
  legalEntityId: LegalEntityIdSchema,
  route: SymmyRouteRefSchema,
  sourceNamespace: SymmySourceRecordRefSchema.fields.sourceNamespace,
};
export const SymmyRegionsProjectionScopeSchema = Schema.Struct(scopeFields);
export type SymmyRegionsProjectionScope = typeof SymmyRegionsProjectionScopeSchema.Type;

const configuredRegion = Schema.Struct({
  currencyCode: PricingCurrencyCodeSchema,
  marketRef: MarketRefSchema,
  sourceRegionId: SymmyRegionSourceIdSchema,
});
const configuredRoute = Schema.Struct({
  ...scopeFields,
  regions: Schema.Array(configuredRegion).check(Schema.isMaxLength(100)),
}).check(
  Schema.makeFilter(({ regions, route }) =>
    regions.every(({ marketRef }) => marketRef.tenantId === route.tenantId) &&
    new Set(regions.map(({ sourceRegionId }) => sourceRegionId)).size === regions.length
      ? undefined
      : 'Region sources must be distinct and reference Markets in the configured Tenant',
  ),
);

/** Operator-owned exact mappings, never accepted from the external query or body. */
export const SymmyRegionsProjectionConfigurationSchema = Schema.Struct({
  routes: Schema.Array(configuredRoute).check(Schema.isMaxLength(64)),
  schemaVersion: Schema.Literal(1),
});
export type SymmyRegionsProjectionConfiguration = typeof SymmyRegionsProjectionConfigurationSchema.Type;

export class SymmyRegionsProjectionError extends Schema.TaggedError<SymmyRegionsProjectionError>()(
  'SymmyRegionsProjectionError',
  {
    cause: Schema.optionalKey(Schema.Redacted(Schema.Defect())),
    reason: Schema.Literals([
      'configuration_invalid',
      'source_scope_mismatch',
      'market_missing',
      'currency_absent',
      'unsupported_jurisdiction',
      'owner_authentication_required',
      'owner_forbidden',
      'owner_unavailable',
    ]),
  },
) {}

export interface SymmyRegionOwnerAssertion {
  readonly apiBaseUrl: string;
  readonly assertion: Redacted.Redacted;
  readonly compositionRevision: string;
}
export type AcquireSymmyRegionOwnerAssertion = (target: {
  readonly audience: 'commerce-market-catalog' | 'pricing';
  readonly legalEntityId?: string;
}) => Effect.Effect<SymmyRegionOwnerAssertion, SymmyIngressProblem>;

const fail = (reason: typeof SymmyRegionsProjectionError.prototype.reason) =>
  Effect.fail(new SymmyRegionsProjectionError({ reason }));

const ownerFailure = (error: { readonly _tag: string }): SymmyRegionsProjectionError =>
  Match.value(error._tag).pipe(
    Match.whenOr(
      'CurrentMarketCatalogAuthenticationProblem',
      'CurrentSupportedCurrenciesAuthenticationProblem',
      () => new SymmyRegionsProjectionError({ cause: Redacted.make(error), reason: 'owner_authentication_required' }),
    ),
    Match.whenOr(
      'CurrentMarketCatalogForbiddenProblem',
      'CurrentSupportedCurrenciesForbiddenProblem',
      () => new SymmyRegionsProjectionError({ cause: Redacted.make(error), reason: 'owner_forbidden' }),
    ),
    Match.orElse(() => new SymmyRegionsProjectionError({ cause: Redacted.make(error), reason: 'owner_unavailable' })),
  );

const sameScope = (left: SymmyRegionsProjectionScope, right: SymmyRegionsProjectionScope): boolean =>
  left.route.tenantId === right.route.tenantId &&
  left.route.integrationRouteId === right.route.integrationRouteId &&
  left.issuerId === right.issuerId &&
  left.sourceNamespace === right.sourceNamespace &&
  left.legalEntityId === right.legalEntityId;

/** Real public owner Reads are independent observations; this is no cross-owner snapshot or Region aggregate. */
export const projectSymmyRegionsWithCrypto = Effect.fn('SymmyRegions.project')(function* projectRegions(
  input: {
    readonly compositionRevision: string;
    readonly configuration: SymmyRegionsProjectionConfiguration;
    readonly page: { readonly limit: number; readonly offset: number };
    readonly scope: SymmyRegionsProjectionScope;
  },
  acquire: AcquireSymmyRegionOwnerAssertion,
  crypto: Crypto.Crypto,
) {
  const configuration = yield* Schema.decodeUnknownEffect(Schema.toType(SymmyRegionsProjectionConfigurationSchema))(
    input.configuration,
  ).pipe(Effect.catchTag('SchemaError', () => fail('configuration_invalid')));
  const scope = yield* Schema.decodeUnknownEffect(Schema.toType(SymmyRegionsProjectionScopeSchema))(input.scope).pipe(
    Effect.catchTag('SchemaError', () => fail('configuration_invalid')),
  );
  const matching = configuration.routes.filter((route) => sameScope(route, scope));
  if (matching.length !== 1) {
    return yield* fail('source_scope_mismatch');
  }
  const [route] = matching;
  if (route === undefined) {
    return yield* fail('source_scope_mismatch');
  }
  const { limit, offset } = input.page;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100 || !Number.isSafeInteger(offset) || offset < 0) {
    return yield* fail('configuration_invalid');
  }
  const now = yield* DateTime.now;
  const marketCredential = yield* acquire({
    audience: 'commerce-market-catalog',
    legalEntityId: scope.legalEntityId,
  });
  if (marketCredential.compositionRevision !== input.compositionRevision) {
    return yield* fail('owner_unavailable');
  }
  const marketRequest = yield* Schema.decodeUnknownEffect(CurrentMarketCatalogRequestSchema)({
    at: DateTime.formatIso(now),
  }).pipe(Effect.catchTag('SchemaError', () => fail('configuration_invalid')));
  const markets = yield* executeCurrentMarketCatalogWithAuthorization(
    marketRequest,
    `Bearer ${Redacted.value(marketCredential.assertion)}`,
    yield* crypto
      .randomUUIDv4()
      .pipe(
        Effect.mapError(
          (cause) => new SymmyRegionsProjectionError({ cause: Redacted.make(cause), reason: 'owner_unavailable' }),
        ),
      ),
    { baseUrl: marketCredential.apiBaseUrl, compositionRevision: marketCredential.compositionRevision },
  ).pipe(Effect.mapError(ownerFailure));
  const currencyCredential = yield* acquire({ audience: 'pricing' });
  if (currencyCredential.compositionRevision !== input.compositionRevision) {
    return yield* fail('owner_unavailable');
  }
  const currencyRequest = yield* Schema.decodeUnknownEffect(CurrentSupportedCurrenciesRequestSchema)({
    effectiveAt: DateTime.formatIso(now),
    tenantId: scope.route.tenantId,
  }).pipe(Effect.catchTag('SchemaError', () => fail('configuration_invalid')));
  const currencyResult = yield* executeCurrentSupportedCurrenciesWithAuthorization(
    currencyRequest,
    `Bearer ${Redacted.value(currencyCredential.assertion)}`,
    yield* crypto
      .randomUUIDv4()
      .pipe(
        Effect.mapError(
          (cause) => new SymmyRegionsProjectionError({ cause: Redacted.make(cause), reason: 'owner_unavailable' }),
        ),
      ),
    { baseUrl: currencyCredential.apiBaseUrl, compositionRevision: currencyCredential.compositionRevision },
  ).pipe(Effect.mapError(ownerFailure));
  if (
    !Schema.is(CurrentSupportedCurrenciesSuccessSchema)(currencyResult) ||
    currencyResult.tenantId !== scope.route.tenantId ||
    currencyResult.effectiveAt !== currencyRequest.effectiveAt ||
    currencyResult.currentnessEvidence.evaluationMode !== 'CURRENT_WITH_REVALIDATION'
  ) {
    return yield* fail('owner_unavailable');
  }
  const qualifier = {
    issuerId: scope.issuerId,
    routeId: scope.route.integrationRouteId,
    sourceNamespace: scope.sourceNamespace,
    tenantId: scope.route.tenantId,
  };
  const regions = yield* Effect.forEach(
    route.regions.toSorted((left, right) => {
      if (left.sourceRegionId === right.sourceRegionId) {
        return 0;
      }
      return left.sourceRegionId < right.sourceRegionId ? -1 : 1;
    }),
    (mapping) => {
      const candidates = markets.markets.filter(
        ({ marketRef }) =>
          marketRef.tenantId === scope.route.tenantId && marketRef.resourceId === mapping.marketRef.resourceId,
      );
      const [market] = candidates;
      if (candidates.length !== 1 || market === undefined) {
        return fail('market_missing');
      }
      if (
        market.sellingLegalEntityRef.resourceId !== scope.legalEntityId ||
        market.sellingLegalEntityRef.tenantId !== scope.route.tenantId ||
        market.lifecycle !== 'ACTIVE' ||
        DateTime.toEpochMillis(market.effectivePeriod.startsAt) > DateTime.toEpochMillis(now) ||
        (market.effectivePeriod.endsAt !== undefined &&
          DateTime.toEpochMillis(market.effectivePeriod.endsAt) <= DateTime.toEpochMillis(now))
      ) {
        return fail('owner_unavailable');
      }
      const [jurisdiction] = market.jurisdictions;
      if (market.jurisdictions.length !== 1 || jurisdiction?.kind !== 'COUNTRY' || jurisdiction.code !== 'CZ') {
        return fail('unsupported_jurisdiction');
      }
      if (!currencyResult.supportedCurrencies.includes(mapping.currencyCode)) {
        return fail('currency_absent');
      }
      const result: SymmyInternalRegionsProjection['regions'][number] = {
        country_codes: ['CZ'],
        currency_code: mapping.currencyCode,
        id: qualifySymmyReadId(qualifier, 'REGION', mapping.sourceRegionId),
        market_code: market.marketCode,
        marketRef: market.marketRef,
        source_record_id: mapping.sourceRegionId,
      };
      return Effect.succeed(result);
    },
    { concurrency: 1 },
  );
  const result: SymmyInternalRegionsProjection = {
    contractVersion: 'INTERNAL_C14',
    count: regions.length,
    limit,
    offset,
    projection: 'regions',
    regions: regions.slice(offset, offset + limit),
    unsupported_fields: ['name', 'tax_rate', 'tax_included', 'payment_providers'],
  };
  return result;
});

export const projectSymmyRegions = Effect.fn('SymmyRegions.projectWithServices')(function* projectWithServices(
  input: Parameters<typeof projectSymmyRegionsWithCrypto>[0],
  acquire: AcquireSymmyRegionOwnerAssertion,
) {
  const crypto = yield* Crypto.Crypto;
  return yield* projectSymmyRegionsWithCrypto(input, acquire, crypto);
});
