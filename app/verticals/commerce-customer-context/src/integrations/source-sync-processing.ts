import type { OperationalScope } from '@app/core-runtime';
import { computeCanonicalValueHash } from '@app/core-runtime/access/enforcement';
import type { SourceProcessingEligibilityResponse } from '@app/privacy/api/source-processing-eligibility';
import { Config, DateTime, Effect } from 'effect';
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
  Effect.mapError(
    () =>
      new CommerceSourceProcessingRejected({
        code: 'UNAVAILABLE',
        reason: 'Source-sync processing mode is invalid',
      }),
  ),
);

/** Only a fresh, exact Privacy source-sync decision can authorize the selected source-sync path. */
export const requireSourceSyncProcessingPermit = (
  scope: OperationalScope,
  request: CommerceSourceProcessingRequest,
  decision: SourceProcessingEligibilityResponse,
  now: string,
): Effect.Effect<SourceSyncProcessingPermit, CommerceSourceProcessingRejected> => {
  const denied = () =>
    Effect.fail(
      new CommerceSourceProcessingRejected({
        code: 'DENIED',
        reason: 'Exact current source-sync processing authority is required',
      }),
    );
  if (
    decision.outcome !== 'ALLOWED' ||
    !('_tag' in decision.evidence) ||
    decision.evidence._tag !== 'SOURCE_SYNC_PROCESSING_POLICY'
  )
    return denied();
  const evidence = decision.evidence;
  if (
    evidence.tenantId !== scope.tenantId ||
    evidence.legalEntityId !== scope.legalEntityId ||
    evidence.consumerModuleId !== 'commerce.customer-context' ||
    evidence.operation !== request.operation ||
    evidence.dataUse !== 'SOURCE_CUSTOMER_SYNC' ||
    evidence.purpose !== 'CUSTOMER_IMPORT' ||
    evidence.policyId !== 'akros-symmy-source-sync' ||
    evidence.policyRevision !== 'v1' ||
    evidence.policyId !== decision.authorityIncarnation ||
    evidence.policyRevision !== decision.authorityRevision ||
    evidence.trustedDecisionTime !== decision.evaluatedAt ||
    !Number.isFinite(Date.parse(now)) ||
    !Number.isFinite(Date.parse(decision.evaluatedAt)) ||
    Date.parse(decision.evaluatedAt) > Date.parse(now) ||
    Date.parse(now) - Date.parse(decision.evaluatedAt) > 30_000 ||
    Date.parse(evidence.validUntil) <= Date.parse(now) ||
    request.source === null ||
    computeCanonicalValueHash(evidence.source) !== computeCanonicalValueHash(request.source) ||
    computeCanonicalValueHash(evidence.target) !== computeCanonicalValueHash(request.target)
  )
    return denied();
  return Effect.succeed(evidence);
};

export const acquireSourceSyncProcessingPermit = Effect.fn('Commerce.acquireSourceSyncProcessingPermit')(
  function* acquire(
    scope: OperationalScope,
    authority: {
      readonly check: (
        scope: OperationalScope,
        request: CommerceSourceProcessingRequest,
        requirement: string,
      ) => Effect.Effect<CommerceSourceProcessingAuthority, CommerceSourceProcessingRejected>;
    },
    request: CommerceSourceProcessingRequest,
    requirement: string,
  ) {
    if (!(yield* sourceSyncProcessingSelected))
      return yield* new CommerceSourceProcessingRejected({
        code: 'DENIED',
        reason: 'Source-sync processing mode is not selected',
      });
    const decision = yield* authority.check(scope, request, requirement);
    return yield* requireSourceSyncProcessingPermit(scope, request, decision, DateTime.formatIso(yield* DateTime.now));
  },
);
