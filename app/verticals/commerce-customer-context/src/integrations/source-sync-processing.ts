import type { OperationalScope } from '@app/core-runtime';
import { computeCanonicalValueHash } from '@app/core-runtime/access/enforcement';
import type { SourceProcessingEligibilityResponse } from '@app/privacy/api/source-processing-eligibility';
import { Config, DateTime, Effect, Option, Predicate } from 'effect';
import type { CommerceSourceProcessingRequest } from './source-processing-eligibility.ts';
import { CommerceSourceProcessingRejected } from './source-processing-rejected.ts';

export type CommerceSourceProcessingAuthority = Extract<SourceProcessingEligibilityResponse, { outcome: 'ALLOWED' }>;
export type SourceSyncProcessingPermit = Extract<
  CommerceSourceProcessingAuthority['evidence'],
  { _tag: 'SOURCE_SYNC_PROCESSING_POLICY' }
>;

/** Selects an owner path, never grants authority. Invalid configuration fails closed. */
export const sourceSyncProcessingSelected = Config.Boolean('ONTOS_PRIVACY_SOURCE_SYNC_PROCESSING_ENABLED').pipe(
  Config.withDefault(false),
  Effect.mapError((cause) =>
    Object.defineProperty(
      new CommerceSourceProcessingRejected({
        code: 'UNAVAILABLE',
        reason: 'Source-sync processing mode is invalid',
      }),
      'cause',
      { configurable: true, value: cause },
    ),
  ),
);

const denied = () =>
  Effect.fail(
    new CommerceSourceProcessingRejected({
      code: 'DENIED',
      reason: 'Exact current source-sync processing authority is required',
    }),
  );

const isCurrentDecision = (now: string, evaluatedAt: string, validUntil: string): boolean => {
  const current = DateTime.make(now);
  const evaluated = DateTime.make(evaluatedAt);
  if (Option.isNone(current) || Option.isNone(evaluated)) {
    return false;
  }
  const currentMillis = DateTime.toEpochMillis(current.value);
  const ageMillis = currentMillis - DateTime.toEpochMillis(evaluated.value);
  return (
    ageMillis >= 0 &&
    ageMillis <= 30_000 &&
    !Option.exists(DateTime.make(validUntil), (expiry) => DateTime.toEpochMillis(expiry) <= currentMillis)
  );
};

/** Only a fresh, exact Privacy source-sync decision can authorize the selected source-sync path. */
export const requireSourceSyncProcessingPermit = (
  scope: OperationalScope,
  request: CommerceSourceProcessingRequest,
  decision: SourceProcessingEligibilityResponse,
  now: string,
): Effect.Effect<SourceSyncProcessingPermit, CommerceSourceProcessingRejected> => {
  if (decision.outcome !== 'ALLOWED' || !Predicate.isTagged(decision.evidence, 'SOURCE_SYNC_PROCESSING_POLICY')) {
    return denied();
  }
  const { evidence } = decision;
  if (
    evidence.tenantId !== scope.tenantId ||
    evidence.legalEntityId !== scope.legalEntityId ||
    evidence.consumerModuleId !== 'commerce.customer-context' ||
    evidence.operation !== request.operation ||
    evidence.dataUse !== 'SOURCE_CUSTOMER_SYNC' ||
    evidence.purpose !== 'CUSTOMER_IMPORT' ||
    evidence.policyId !== 'akros-symmy-source-sync-v2' ||
    evidence.policyRevision !== 'v2' ||
    evidence.policyId !== decision.authorityIncarnation ||
    evidence.policyRevision !== decision.authorityRevision ||
    evidence.trustedDecisionTime !== decision.evaluatedAt ||
    !isCurrentDecision(now, decision.evaluatedAt, evidence.validUntil) ||
    request.source === null ||
    computeCanonicalValueHash(evidence.source) !== computeCanonicalValueHash(request.source) ||
    computeCanonicalValueHash(evidence.target) !== computeCanonicalValueHash(request.target)
  ) {
    return denied();
  }
  return Effect.succeed(evidence);
};

/** Run the deferred Privacy decision only in the selected mode, then validate its exact permit. */
export const acquireSourceSyncProcessingPermit = Effect.fn('Commerce.acquireSourceSyncProcessingPermit')(
  function* acquire(
    scope: OperationalScope,
    request: CommerceSourceProcessingRequest,
    decision: Effect.Effect<CommerceSourceProcessingAuthority, CommerceSourceProcessingRejected>,
  ) {
    if (!(yield* sourceSyncProcessingSelected)) {
      return yield* new CommerceSourceProcessingRejected({
        code: 'DENIED',
        reason: 'Source-sync processing mode is not selected',
      });
    }
    const authority = yield* decision;
    return yield* requireSourceSyncProcessingPermit(scope, request, authority, DateTime.formatIso(yield* DateTime.now));
  },
);
