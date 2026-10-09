import { createHash } from 'node:crypto';

import { DateTime, Effect } from 'effect';

import type {
  PricingCurrentMarketEvidenceRequest,
  PricingCurrentMarketEvidenceResponse,
  PricingMarketSourceReceipt,
} from '../../shared/apis/pricing-current-market-evidence.ts';
import type {
  PricingCurrentMarketEvidencePersistence,
  PricingCurrentMarketSnapshot,
} from '../persistence/pricing-current-market-evidence-persistence.ts';

export interface PricingCurrentMarketEvidenceTrustedScope {
  readonly legalEntityId: string;
  readonly tenantId: string;
}

const fingerprint = (value: string): string => createHash('sha256').update(value).digest('hex');
const instant = (value: DateTime.Utc): string => DateTime.formatIso(value);
const sameInstant = (left: DateTime.Utc | undefined, right: DateTime.Utc | undefined): boolean =>
  left === undefined || right === undefined
    ? left === right
    : DateTime.toEpochMillis(left) === DateTime.toEpochMillis(right);

/**
 * A replay resolves the retained proof against the owner's stable source identity.
 * Observation time is deliberately excluded: every owner read has a fresh trusted
 * observation, while generation, predicate, set/fact revisions, and boundaries are
 * the material state the retained proof commits to.
 */
const sameRetainedSource = (retained: PricingMarketSourceReceipt, current: PricingMarketSourceReceipt): boolean => {
  if (
    retained.state !== current.state ||
    retained.authority.generation !== current.authority.generation ||
    retained.authority.ownerRootRef !== current.authority.ownerRootRef ||
    retained.authority.ownerSetRevisionRef !== current.authority.ownerSetRevisionRef ||
    retained.authority.predicateRef !== current.authority.predicateRef ||
    retained.authority.verificationRef !== current.authority.verificationRef ||
    !sameInstant(retained.authority.nextApplicabilityBoundary, current.authority.nextApplicabilityBoundary) ||
    retained.currentFacts.length !== current.currentFacts.length
  ) {
    return false;
  }
  return retained.currentFacts.every((fact, index) => {
    const currentFact = current.currentFacts[index];
    return (
      currentFact !== undefined &&
      fact.factRef === currentFact.factRef &&
      fact.factRevisionRef === currentFact.factRevisionRef &&
      fact.verificationRef === currentFact.verificationRef &&
      sameInstant(fact.effectivePeriod.startsAt, currentFact.effectivePeriod.startsAt) &&
      sameInstant(fact.effectivePeriod.endsAt, currentFact.effectivePeriod.endsAt)
    );
  });
};

const predicateRefFor = (
  request: PricingCurrentMarketEvidenceRequest,
  scope: PricingCurrentMarketEvidenceTrustedScope,
): string =>
  [
    'commerce.market-catalog.pricing-market:v1',
    scope.tenantId,
    scope.legalEntityId,
    request.commercialScope.channel,
    request.commercialScope.marketRef.resourceId,
    instant(request.effectiveAt),
  ].join(':');

const receiptFor = (
  request: PricingCurrentMarketEvidenceRequest,
  scope: PricingCurrentMarketEvidenceTrustedScope,
  snapshot: PricingCurrentMarketSnapshot,
): PricingMarketSourceReceipt | undefined => {
  if (snapshot.state !== 'PRESENT' && snapshot.state !== 'ABSENT') {
    return undefined;
  }
  const predicateRef = predicateRefFor(request, scope);
  const ownerRootRef = `commerce.market-catalog.pricing-market:v1:${scope.tenantId}:${scope.legalEntityId}`;
  const ownerSetRevisionRef = `commerce.market-catalog.pricing-market:v1:generation:${snapshot.generation}`;
  const verificationRef = `commerce.market-catalog.pricing-market:set:${fingerprint(
    `${ownerRootRef}|${predicateRef}|${ownerSetRevisionRef}|${
      snapshot.nextApplicabilityBoundary === undefined ? 'unbounded' : instant(snapshot.nextApplicabilityBoundary)
    }`,
  )}`;
  const authorityBase = {
    generation: snapshot.generation,
    observedAt: snapshot.observedAt,
    ownerRootRef,
    ownerSetRevisionRef,
    predicateRef,
    verificationRef,
  };
  const authority =
    snapshot.nextApplicabilityBoundary === undefined
      ? authorityBase
      : { ...authorityBase, nextApplicabilityBoundary: snapshot.nextApplicabilityBoundary };
  if (snapshot.state === 'ABSENT') {
    return { authority, currentFacts: [], state: 'ABSENT' };
  }
  if (
    snapshot.market === undefined ||
    snapshot.definitionRevisionRef === undefined ||
    snapshot.lifecycleRevisionRef === undefined ||
    snapshot.effectivePeriod === undefined
  ) {
    return undefined;
  }
  const factRef = snapshot.market.marketRef.resourceId;
  const factRevisionRef = `definition:${snapshot.definitionRevisionRef}:lifecycle:${snapshot.lifecycleRevisionRef}`;
  return {
    authority,
    currentFacts: [
      {
        effectivePeriod: snapshot.effectivePeriod,
        factRef,
        factRevisionRef,
        verificationRef: `commerce.market-catalog.pricing-market:fact:${fingerprint(
          `${predicateRef}|${factRef}|${factRevisionRef}|${verificationRef}`,
        )}`,
      },
    ],
    state: 'PRESENT',
  };
};

const checked = (response: PricingCurrentMarketEvidenceResponse): Effect.Effect<PricingCurrentMarketEvidenceResponse> =>
  Effect.succeed(response);

const unavailable = (
  request: PricingCurrentMarketEvidenceRequest,
): Effect.Effect<PricingCurrentMarketEvidenceResponse> =>
  checked({
    outcome: 'PRICING_MARKET_SOURCE_UNAVAILABLE',
    reason: 'Commerce Market owner evidence is temporarily unavailable',
    request,
    retryable: true,
  });

const classifySnapshot = (
  request: PricingCurrentMarketEvidenceRequest,
  scope: PricingCurrentMarketEvidenceTrustedScope,
  snapshot: PricingCurrentMarketSnapshot,
): Effect.Effect<PricingCurrentMarketEvidenceResponse> => {
  if (snapshot.state === 'CONFLICT') {
    return checked({
      observedAt: snapshot.observedAt,
      outcome: 'PRICING_MARKET_SOURCE_CONFLICT',
      reason: snapshot.reason ?? 'Multiple Current Market facts match the exact commercial scope',
      request,
    });
  }
  if (snapshot.state === 'MISSING') {
    return checked({
      observedAt: snapshot.observedAt,
      outcome: 'PRICING_MARKET_SOURCE_MISSING',
      reason: snapshot.reason ?? 'Required Commerce Market configuration is incomplete',
      request,
    });
  }
  if (snapshot.state === 'UNVERIFIABLE') {
    return checked({
      observedAt: snapshot.observedAt,
      outcome: 'PRICING_MARKET_SOURCE_UNVERIFIABLE',
      reason: snapshot.reason ?? 'Commerce Market currentness could not be verified',
      request,
      retryable: true,
    });
  }
  const receipt = receiptFor(request, scope, snapshot);
  if (receipt === undefined) {
    return checked({
      observedAt: snapshot.observedAt,
      outcome: 'PRICING_MARKET_SOURCE_UNVERIFIABLE',
      reason: 'Commerce Market owner state lacks a complete current-source receipt',
      request,
      retryable: true,
    });
  }
  if (DateTime.toEpochMillis(request.requestedAt) > DateTime.toEpochMillis(snapshot.observedAt)) {
    return checked({
      observedAt: snapshot.observedAt,
      outcome: 'PRICING_MARKET_SOURCE_UNVERIFIABLE',
      reason: 'Commerce Market owner observation predates the source request',
      request,
      retryable: true,
    });
  }
  if (
    request.verifyThrough !== undefined &&
    DateTime.toEpochMillis(snapshot.observedAt) < DateTime.toEpochMillis(request.verifyThrough)
  ) {
    return checked({
      observedAt: snapshot.observedAt,
      outcome: 'PRICING_MARKET_SOURCE_UNVERIFIABLE',
      reason: 'Commerce Market owner observation does not span the requested aggregate fence',
      request,
      retryable: true,
    });
  }
  if (request.retainedReceipt !== undefined && !sameRetainedSource(request.retainedReceipt, receipt)) {
    return checked({
      currentReceipt: receipt,
      observedAt: snapshot.observedAt,
      outcome: 'PRICING_MARKET_SOURCE_CHANGED',
      reason: 'Commerce Market owner generation or exact Current fact changed after evaluation',
      request,
      retryable: true,
    });
  }
  const verifiedThrough = request.verifyThrough === undefined ? {} : { verifiedThrough: request.verifyThrough };
  if (snapshot.state === 'ABSENT') {
    return checked({
      outcome: 'PRICING_MARKET_SOURCE_ABSENT',
      receipt,
      request,
      ...verifiedThrough,
    });
  }
  return snapshot.market === undefined
    ? checked({
        observedAt: snapshot.observedAt,
        outcome: 'PRICING_MARKET_SOURCE_UNVERIFIABLE',
        reason: 'Commerce Market present state omitted its authoritative definition',
        request,
        retryable: true,
      })
    : checked({
        market: snapshot.market,
        outcome: 'PRICING_MARKET_SOURCE_PRESENT',
        receipt,
        request,
        ...verifiedThrough,
      });
};

export const readPricingCurrentMarketEvidence = (
  persistence: PricingCurrentMarketEvidencePersistence,
  request: PricingCurrentMarketEvidenceRequest,
  scope: PricingCurrentMarketEvidenceTrustedScope,
): Effect.Effect<PricingCurrentMarketEvidenceResponse> =>
  persistence.readCurrent(request).pipe(
    Effect.matchEffect({
      onFailure: (cause) => unavailable(request).pipe(Effect.annotateLogs({ persistenceFailure: cause._tag })),
      onSuccess: (snapshot) => classifySnapshot(request, scope, snapshot),
    }),
  );
