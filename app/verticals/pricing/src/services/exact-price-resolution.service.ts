import type { ReadServiceFactory } from '@app/core-runtime';
import type { CurrentSupportedCurrenciesSuccess } from '@app/pricing-contracts/current-supported-currencies';
import type {
  ExactPriceLookupRequest,
  ExactPriceLookupResult,
  ExactPriceOwnerLookupResult,
} from '@app/pricing-contracts/domain/exact-price-lookup';
import {
  ExactPriceLookupRequestSchema,
  ExactPriceLookupResultSchema,
} from '@app/pricing-contracts/domain/exact-price-lookup';
import type {
  ExactPriceResolution,
  ExactPriceResolutionInput,
} from '@app/pricing-contracts/domain/exact-price-resolution';
import type {
  PriceGroupFallbackResolution,
  PriceGroupFallbackResolutionInput,
} from '@app/pricing-contracts/domain/price-group-fallback';
import type { PriceGroupInterpretationBasis } from '@app/pricing-contracts/domain/price-group-interpretation';
import { Context, DateTime, Effect, Match, Option, Schema } from 'effect';

import { currencySupportPersistenceForScope } from '../persistence/currency-support-persistence.ts';
import type { CurrencySupportPersistence, StoredCurrencySupport } from '../persistence/currency-support-persistence.ts';
import { pricePersistenceForScope } from './price-persistence.service.ts';
import type { PricePersistenceUnavailable } from './price-persistence.service.ts';
import { classifyExactPriceOwnerLookup } from './exact-price-conflict.service.ts';
import { makePriceGroupFallbackResolver } from './price-group-fallback.service.ts';

export interface ExactPriceResolutionTrustedContext {
  readonly legalEntityId: string;
  readonly tenantId: string;
  readonly trustedOperationAt: DateTime.Utc;
}

export interface ExactPriceResolutionDependencies {
  readonly loadCurrencySupport: CurrencySupportPersistence['loadCurrent'];
  readonly lookupExact: (
    request: ExactPriceLookupRequest,
  ) => Effect.Effect<ExactPriceLookupResult | ExactPriceOwnerLookupResult, PricePersistenceUnavailable>;
}

export interface ExactPriceResolutionService {
  readonly resolve: (
    input: ExactPriceResolutionInput,
    trusted: ExactPriceResolutionTrustedContext,
  ) => Effect.Effect<ExactPriceResolution>;
}

export class ExactPriceResolver extends Context.Service<ExactPriceResolver, ExactPriceResolutionService>()(
  '@app/pricing/services/exact-price-resolution.service/ExactPriceResolver',
) {}

const PreliminaryLookupFailureSchema = Schema.Literals([
  'CURRENTNESS_UNVERIFIABLE',
  'OWNER_STATE_UNAVAILABLE',
  'PRICE_KEY_MISMATCH',
]);
type PreliminaryLookupFailure = typeof PreliminaryLookupFailureSchema.Type;

const basisOf = (input: PriceGroupFallbackResolutionInput): PriceGroupInterpretationBasis =>
  Match.value(input).pipe(
    Match.tag('GUEST', ({ basis }) => basis),
    Match.tag('ASSIGNED', ({ interpretation }) => interpretation.basis),
    Match.tag('BLOCKED', ({ interpretation }) => interpretation.basis),
    Match.tag('OWNER_NONE', ({ interpretation }) => interpretation.basis),
    Match.exhaustive,
  );

const sameRef = (
  left: {
    readonly moduleId: string;
    readonly resourceId: string;
    readonly resourceType: string;
    readonly tenantId: string;
  },
  right: {
    readonly moduleId: string;
    readonly resourceId: string;
    readonly resourceType: string;
    readonly tenantId: string;
  },
): boolean =>
  left.moduleId === right.moduleId &&
  left.resourceId === right.resourceId &&
  left.resourceType === right.resourceType &&
  left.tenantId === right.tenantId;

const sameCurrencySet = (left: readonly string[], right: readonly string[]): boolean =>
  left.length === right.length &&
  [...left].toSorted().every((currency, index) => currency === [...right].toSorted()[index]);

const exactRequestEquivalence = Schema.toEquivalence(ExactPriceLookupRequestSchema);

const currencySupportMatchesFreshOwnerState = (
  claimed: CurrentSupportedCurrenciesSuccess,
  fresh: StoredCurrencySupport,
): boolean =>
  fresh.currentnessEvidence.evaluationMode === 'CURRENT_WITH_REVALIDATION' &&
  fresh.currentnessEvidence.revalidatedAt !== undefined &&
  claimed.generation === fresh.generation &&
  claimed.pricingRevision === fresh.pricingRevision &&
  claimed.scheduleRevision === fresh.scheduleRevision &&
  claimed.effectivePeriod.effectiveFrom === fresh.effectivePeriod.effectiveFrom &&
  claimed.effectivePeriod.effectiveTo === fresh.effectivePeriod.effectiveTo &&
  claimed.nextApplicabilityBoundary === fresh.nextApplicabilityBoundary &&
  sameCurrencySet(claimed.supportedCurrencies, fresh.supportedCurrencies) &&
  sameRef(claimed.supportRootRef, fresh.supportRootRef) &&
  sameRef(claimed.supportRevisionRef, fresh.supportRevisionRef) &&
  sameRef(claimed.currentnessEvidence.supportRootRef, fresh.currentnessEvidence.supportRootRef) &&
  sameRef(claimed.currentnessEvidence.supportRevisionRef, fresh.currentnessEvidence.supportRevisionRef) &&
  claimed.currentnessEvidence.scheduleRevision === fresh.currentnessEvidence.scheduleRevision;

const trustedInstant = (trusted: ExactPriceResolutionTrustedContext): string =>
  DateTime.formatIso(trusted.trustedOperationAt);

const sourceIsUsableAt = (input: PriceGroupFallbackResolutionInput): boolean =>
  Match.value(input).pipe(
    Match.tag('ASSIGNED', ({ effectiveAt, interpretation }) => {
      const { assignmentResolution, compatibilityEvidence } = interpretation;
      return (
        assignmentResolution.effectiveFrom <= effectiveAt &&
        (assignmentResolution.effectiveTo === null || effectiveAt < assignmentResolution.effectiveTo) &&
        compatibilityEvidence.trustedOperationAt === effectiveAt &&
        compatibilityEvidence.verifiedAt === effectiveAt
      );
    }),
    Match.orElse(() => true),
  );

const preliminaryFailure = (
  input: ExactPriceResolutionInput,
  trusted: ExactPriceResolutionTrustedContext,
): PreliminaryLookupFailure | undefined => {
  const basis = basisOf(input.resolutionInput);
  if (
    basis.catalogSelection.productRef.tenantId !== trusted.tenantId ||
    basis.commercialScope.sellingLegalEntityId !== trusted.legalEntityId
  ) {
    return 'PRICE_KEY_MISMATCH';
  }
  const effectiveAt = trustedInstant(trusted);
  if (effectiveAt !== input.resolutionInput.effectiveAt || !sourceIsUsableAt(input.resolutionInput)) {
    return 'CURRENTNESS_UNVERIFIABLE';
  }
  return undefined;
};

const terminalLookup = (request: ExactPriceLookupRequest, reason: PreliminaryLookupFailure): ExactPriceLookupResult => {
  if (reason === 'PRICE_KEY_MISMATCH') {
    return { _tag: 'INVALID', reason, request };
  }
  if (reason === 'OWNER_STATE_UNAVAILABLE') {
    return { _tag: 'UNAVAILABLE', reason, request };
  }
  return { _tag: 'UNVERIFIABLE', reason, request };
};

const decodedLookup = (request: ExactPriceLookupRequest, result: ExactPriceLookupResult): ExactPriceLookupResult => {
  const decoded = Schema.decodeOption(ExactPriceLookupResultSchema, { onExcessProperty: 'error' })(result);
  if (Option.isNone(decoded)) {
    return { _tag: 'UNVERIFIABLE', reason: 'SET_COMPLETENESS_UNVERIFIABLE', request };
  }
  return exactRequestEquivalence(decoded.value.request, request)
    ? decoded.value
    : { _tag: 'UNVERIFIABLE', reason: 'EXACT_KEY_BINDING_UNVERIFIABLE', request };
};

const wrapResolution = (
  currencySupport: CurrentSupportedCurrenciesSuccess,
  path: PriceGroupFallbackResolution,
): ExactPriceResolution =>
  Match.value(path).pipe(
    Match.tag('CONFIGURATION_ERROR', () => ({
      _tag: 'PRICING_CONFIGURATION_ERROR' as const,
      currencySupport,
      path,
    })),
    Match.tag('CONFLICT', () => ({ _tag: 'PRICING_CONFLICT' as const, currencySupport, path })),
    Match.tag('GROUP_PRICE', () => ({ _tag: 'PRICE_FOUND' as const, currencySupport, path })),
    Match.tag('INDETERMINATE', () => ({ _tag: 'PRICING_INDETERMINATE' as const, currencySupport, path })),
    Match.tag('NO_APPLICABLE_PRICE', () => ({ _tag: 'NO_APPLICABLE_PRICE' as const, currencySupport, path })),
    Match.tag('NO_GROUP_AFTER_PROVEN_GROUP_ABSENCE', () => ({
      _tag: 'PRICE_FOUND' as const,
      currencySupport,
      path,
    })),
    Match.tag('NO_GROUP_GUEST', () => ({ _tag: 'PRICE_FOUND' as const, currencySupport, path })),
    Match.tag('NO_GROUP_NONE', () => ({ _tag: 'PRICE_FOUND' as const, currencySupport, path })),
    Match.exhaustive,
  );

export const makeExactPriceResolutionService = (
  dependencies: ExactPriceResolutionDependencies,
): ExactPriceResolutionService => ({
  resolve: Effect.fn('ExactPriceResolution.resolve')(function* resolve(input, trusted) {
    const preliminary = preliminaryFailure(input, trusted);
    const isBlocked = Match.value(input.resolutionInput).pipe(
      Match.tag('BLOCKED', () => true),
      Match.orElse(() => false),
    );
    if (isBlocked) {
      const path = yield* makePriceGroupFallbackResolver({
        lookup: () => Effect.die('Blocked Price Group input must not perform an exact Price lookup'),
      }).resolve(input.resolutionInput);
      return wrapResolution(input.currencySupport, path);
    }

    let supportFailure = preliminary;
    if (supportFailure === undefined) {
      const support = yield* dependencies
        .loadCurrencySupport({
          effectiveAt: input.resolutionInput.effectiveAt,
          tenantId: trusted.tenantId,
        })
        .pipe(
          Effect.match({
            onFailure: (failure) => ({ failure, kind: 'UNAVAILABLE' as const }),
            onSuccess: (outcome) => ({ kind: 'OUTCOME' as const, outcome }),
          }),
        );
      supportFailure =
        support.kind === 'UNAVAILABLE'
          ? 'OWNER_STATE_UNAVAILABLE'
          : Match.value(support.outcome).pipe(
              Match.tags({
                absent: () => 'CURRENTNESS_UNVERIFIABLE' as const,
                conflict: () => 'CURRENTNESS_UNVERIFIABLE' as const,
                current: ({ current }) =>
                  currencySupportMatchesFreshOwnerState(input.currencySupport, current)
                    ? undefined
                    : ('CURRENTNESS_UNVERIFIABLE' as const),
                gap: () => 'CURRENTNESS_UNVERIFIABLE' as const,
              }),
              Match.exhaustive,
            );
    }

    const resolver = makePriceGroupFallbackResolver({
      lookup: (request) => {
        if (supportFailure !== undefined) {
          return Effect.succeed(terminalLookup(request, supportFailure));
        }
        return dependencies.lookupExact(request).pipe(
          Effect.map((result) => decodedLookup(request, classifyExactPriceOwnerLookup(request, result).lookup)),
          Effect.catchTag('PricePersistenceUnavailable', () =>
            Effect.succeed({ _tag: 'UNAVAILABLE', reason: 'EXACT_LOOKUP_UNAVAILABLE', request } as const),
          ),
        );
      },
    });
    const path = yield* resolver.resolve(input.resolutionInput);
    return wrapResolution(input.currencySupport, path);
  }),
});

/** Owner-local governed-read composition; Core retains transaction and trusted-scope ownership. */
export const exactPriceResolutionServiceForScope: ReadServiceFactory<ExactPriceResolutionService> = (
  transaction,
  scope,
  compositionRevision,
) =>
  Effect.all(
    {
      currencySupport: currencySupportPersistenceForScope(transaction, scope, compositionRevision),
      price: pricePersistenceForScope(transaction, scope),
    },
    { concurrency: 2 },
  ).pipe(
    Effect.map(({ currencySupport, price }) =>
      makeExactPriceResolutionService({
        loadCurrencySupport: currencySupport.loadCurrent,
        lookupExact: price.exactLookup,
      }),
    ),
  );
