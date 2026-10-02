import type { ReadServiceFactory } from '@app/core-runtime';
import type {
  PricingExplicitInputContext,
  PricingExplicitInputEvaluationRequest,
} from '@app/pricing-contracts/domain/broken-explicit-input';
import { PricingExplicitInputEvaluationRequestSchema } from '@app/pricing-contracts/domain/broken-explicit-input';
import { DateTime, Effect, Match, Option, Schema } from 'effect';

import { resolveCurrentSupportedCurrencies } from '../api/current-supported-currencies.read.ts';
import { currencySupportPersistenceForScope } from '../persistence/currency-support-persistence.ts';
import type { CurrencySupportPersistence } from '../persistence/currency-support-persistence.ts';
import type {
  BrokenExplicitInputObservationPort,
  BrokenExplicitInputTrustedContext,
} from '../services/broken-explicit-input.service.ts';

type TrustedObservation<A> = (
  context: PricingExplicitInputContext,
  trusted: BrokenExplicitInputTrustedContext,
) => Effect.Effect<A>;
type PriceGroupObservation = NonNullable<PricingExplicitInputEvaluationRequest['priceGroupResolutionInput']>;
type QuantityBasisObservation = NonNullable<PricingExplicitInputEvaluationRequest['quantityBasis']>;
type SourceAssessmentObservation = NonNullable<PricingExplicitInputEvaluationRequest['sourceAssessment']>;

/**
 * These ports are deliberately server-side and receive only the bounded public context plus trusted
 * operation scope. Their adapters must resolve candidate identifiers from owner-issued state. A
 * caller can never submit a Price Group interpretation, quantity assessment, or source assessment.
 *
 * The current #765 read context does not contain the profile/Guest subject, purchase occurrence and
 * quantity, or source assertion identity required to call the respective owners. Until the whole
 * candidate read supplies those trusted identifiers, leaving a port absent is intentional: the
 * classifier returns a typed indeterminate result instead of manufacturing evidence.
 */
export interface BrokenExplicitInputCandidateObservationPorts {
  readonly priceGroup?: TrustedObservation<PriceGroupObservation>;
  readonly quantityBasis?: TrustedObservation<QuantityBasisObservation>;
  readonly sourceAssessment?: TrustedObservation<SourceAssessmentObservation>;
}

export interface BrokenExplicitInputObservationDependencies {
  readonly candidates?: BrokenExplicitInputCandidateObservationPorts;
  readonly loadCurrencySupport: CurrencySupportPersistence['loadCurrent'];
}

interface CandidateObservations {
  priceGroupResolutionInput?: PriceGroupObservation;
  quantityBasis?: QuantityBasisObservation;
  sourceAssessment?: SourceAssessmentObservation;
}

const failClosedRequest = (context: PricingExplicitInputContext): PricingExplicitInputEvaluationRequest => ({
  context,
});

const decodeObservationRequest = (
  context: PricingExplicitInputContext,
  candidate: unknown,
): PricingExplicitInputEvaluationRequest => {
  const decoded = Schema.decodeUnknownOption(PricingExplicitInputEvaluationRequestSchema, {
    onExcessProperty: 'error',
  })(candidate);
  return Option.isSome(decoded) ? decoded.value : failClosedRequest(context);
};

const trustedScopeMatches = (
  context: PricingExplicitInputContext,
  trusted: BrokenExplicitInputTrustedContext,
): boolean => {
  if (
    context.tenantId !== trusted.tenantId ||
    DateTime.toEpochMillis(DateTime.makeUnsafe(context.effectiveAt)) !==
      DateTime.toEpochMillis(trusted.trustedOperationAt)
  ) {
    return false;
  }
  const { exactKey } = context;
  return (
    exactKey === undefined ||
    (exactKey.catalogSelection.productRef.tenantId === trusted.tenantId &&
      exactKey.commercialScope.sellingLegalEntityId === trusted.legalEntityId)
  );
};

const loadCurrencyObservation = Effect.fn('BrokenExplicitInputObservation.loadCurrencyObservation')(
  function* loadCurrencyObservation(
    context: PricingExplicitInputContext,
    trusted: BrokenExplicitInputTrustedContext,
    loadCurrent: CurrencySupportPersistence['loadCurrent'],
  ) {
    const input = { effectiveAt: context.effectiveAt, tenantId: context.tenantId };
    const loaded = yield* loadCurrent(input).pipe(
      Effect.match({
        onFailure: (failure) => ({ failure, kind: 'failure' as const }),
        onSuccess: (value) => ({ kind: 'success' as const, value }),
      }),
    );
    const currencySupport = yield* resolveCurrentSupportedCurrencies(input, { tenantId: trusted.tenantId }, () =>
      loaded.kind === 'failure' ? Effect.fail(loaded.failure) : Effect.succeed(loaded.value),
    ).pipe(
      Effect.catchTag('ReadPermissionDenied', () =>
        Effect.succeed({
          code: 'pricing_currency_support_context_unverifiable',
          outcome: 'SUPPORTED_CURRENCIES_UNVERIFIABLE' as const,
          reason: 'Pricing Currency Support could not be bound to the trusted Tenant context',
          retryable: true as const,
        }),
      ),
    );
    const candidateRevisionIds =
      loaded.kind === 'failure'
        ? Option.none<readonly string[]>()
        : Match.value(loaded.value).pipe(
            Match.tags({
              absent: () => Option.none<readonly string[]>(),
              conflict: ({ candidateRevisionIds: revisionIds }) => Option.fromNullishOr(revisionIds),
              current: () => Option.none<readonly string[]>(),
              gap: () => Option.none<readonly string[]>(),
            }),
            Match.exhaustive,
          );
    const distinctConflictRefs = Option.isNone(candidateRevisionIds)
      ? []
      : [...new Set(candidateRevisionIds.value)].slice(0, 32);
    return distinctConflictRefs.length < 2
      ? { currencySupport }
      : { currencySupport, currencySupportConflictRefs: distinctConflictRefs };
  },
);

const acquireCandidateObservations = Effect.fn('BrokenExplicitInputObservation.acquireCandidates')(
  function* acquireCandidateObservations(
    context: PricingExplicitInputContext,
    trusted: BrokenExplicitInputTrustedContext,
    ports: BrokenExplicitInputCandidateObservationPorts | undefined,
  ) {
    if (ports === undefined) {
      return {};
    }
    const [priceGroupResolutionInput, quantityBasis, sourceAssessment] = yield* Effect.all(
      [
        ports.priceGroup === undefined
          ? Effect.succeed(Option.none<PriceGroupObservation>())
          : ports.priceGroup(context, trusted).pipe(Effect.asSome),
        ports.quantityBasis === undefined
          ? Effect.succeed(Option.none<QuantityBasisObservation>())
          : ports.quantityBasis(context, trusted).pipe(Effect.asSome),
        ports.sourceAssessment === undefined
          ? Effect.succeed(Option.none<SourceAssessmentObservation>())
          : ports.sourceAssessment(context, trusted).pipe(Effect.asSome),
      ],
      { concurrency: 3 },
    );
    const result: CandidateObservations = {};
    if (Option.isSome(priceGroupResolutionInput)) {
      result.priceGroupResolutionInput = priceGroupResolutionInput.value;
    }
    if (Option.isSome(quantityBasis)) {
      result.quantityBasis = quantityBasis.value;
    }
    if (Option.isSome(sourceAssessment)) {
      result.sourceAssessment = sourceAssessment.value;
    }
    return result;
  },
);

export const makeBrokenExplicitInputObservationPort = (
  dependencies: BrokenExplicitInputObservationDependencies,
): BrokenExplicitInputObservationPort => ({
  acquire: Effect.fn('BrokenExplicitInputObservation.acquire')(function* acquire(context, trusted) {
    if (!trustedScopeMatches(context, trusted)) {
      return failClosedRequest(context);
    }
    const [currency, candidates] = yield* Effect.all(
      [
        loadCurrencyObservation(context, trusted, dependencies.loadCurrencySupport),
        acquireCandidateObservations(context, trusted, dependencies.candidates),
      ],
      { concurrency: 2 },
    );
    return decodeObservationRequest(context, { context, ...currency, ...candidates });
  }),
});

/**
 * Production owner-local composition for #765. Currency Support is available from Pricing's scoped
 * transaction today. Candidate-only observations remain absent until the trusted whole-candidate
 * read provides their non-public identifiers; the runtime therefore fails closed.
 */
export const brokenExplicitInputObservationPortForScope: ReadServiceFactory<BrokenExplicitInputObservationPort> = (
  transaction,
  scope,
  compositionRevision,
) =>
  currencySupportPersistenceForScope(transaction, scope, compositionRevision).pipe(
    Effect.map((currencySupport) =>
      makeBrokenExplicitInputObservationPort({ loadCurrencySupport: currencySupport.loadCurrent }),
    ),
  );
