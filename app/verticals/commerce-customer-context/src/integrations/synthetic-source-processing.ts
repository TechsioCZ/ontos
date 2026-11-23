import type { OperationalScope } from '@app/core-runtime';
import { computeCanonicalValueHash } from '@app/core-runtime/access/enforcement';
import type { SourceProcessingEligibilityResponse } from '@app/privacy/api/source-processing-eligibility';
import { Config, DateTime, Effect } from 'effect';
import type { CommerceSourceProcessingRequest } from './source-processing-eligibility.ts';
import { CommerceSourceProcessingRejected } from './source-processing-rejected.ts';

export type CommerceSourceProcessingAuthority = Extract<SourceProcessingEligibilityResponse, { outcome: 'ALLOWED' }>;
export type SyntheticSourceProcessingPermit = Extract<
  CommerceSourceProcessingAuthority['evidence'],
  { _tag: 'DEMO_TEST_DATA_SOURCE_POLICY' }
>;

/** Selects an owner path, never grants authority. Invalid configuration fails closed. */
export const syntheticSourceProcessingSelected = Config.Boolean('ONTOS_PRIVACY_DEMO_SOURCE_PROCESSING_ENABLED').pipe(
  Config.withDefault(false),
  Effect.mapError(
    () =>
      new CommerceSourceProcessingRejected({
        code: 'UNAVAILABLE',
        reason: 'Synthetic source processing mode is invalid',
      }),
  ),
);

/** Only a fresh, exact Privacy testing decision can authorize the selected synthetic path. */
export const requireSyntheticSourceProcessingPermit = (
  scope: OperationalScope,
  request: CommerceSourceProcessingRequest,
  decision: SourceProcessingEligibilityResponse,
  now: string,
): Effect.Effect<SyntheticSourceProcessingPermit, CommerceSourceProcessingRejected> => {
  const denied = () =>
    Effect.fail(
      new CommerceSourceProcessingRejected({
        code: 'DENIED',
        reason: 'Exact current synthetic source processing authority is required',
      }),
    );
  if (
    decision.outcome !== 'ALLOWED' ||
    !('_tag' in decision.evidence) ||
    decision.evidence._tag !== 'DEMO_TEST_DATA_SOURCE_POLICY'
  )
    return denied();
  const evidence = decision.evidence;
  if (
    evidence.tenantId !== scope.tenantId ||
    evidence.legalEntityId !== scope.legalEntityId ||
    evidence.consumerModuleId !== 'commerce.customer-context' ||
    evidence.operation !== request.operation ||
    evidence.dataUse !== 'DEMO_TEST_DATA_ONLY' ||
    evidence.purpose !== 'DEMO_CUSTOMER_IMPORT_TESTING' ||
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

export const acquireSyntheticSourceProcessingPermit = Effect.fn('Commerce.acquireSyntheticSourceProcessingPermit')(
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
    if (!(yield* syntheticSourceProcessingSelected))
      return yield* new CommerceSourceProcessingRejected({
        code: 'DENIED',
        reason: 'Synthetic source processing mode is not selected',
      });
    const decision = yield* authority.check(scope, request, requirement);
    return yield* requireSyntheticSourceProcessingPermit(
      scope,
      request,
      decision,
      DateTime.formatIso(yield* DateTime.now),
    );
  },
);
