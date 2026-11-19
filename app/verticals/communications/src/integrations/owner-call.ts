import type { OperationalScope } from '@app/core-runtime';
import { computeCanonicalValueHash } from '@app/core-runtime/access/enforcement';
import type { OutboxWorkerHandlerContext } from '@app/core-runtime/outbox/worker';
import {
  readVerifiedGatewayRecovery,
  readVerifiedGatewayWorkload,
} from '@app/core-runtime/auth/system-principal-context-provenance';
import type { GatewayDelegationSubject } from '@app/shared-contracts/gateway-context-server';
import { Context, Effect, Option } from 'effect';

/**
 * The authority under which Communications asks ANOTHER owner something Now. An owner is always asked under the
 * authority of the operation that needs the answer, never under a credential of its own: an intake Action asks as the
 * registered source workload it runs for, the pre-handoff worker asks as its verified Outbox delivery. The call names
 * the operation requirement the manifest declares for that question, so the issuer can check it again.
 */
export interface OwnerCall {
  readonly correlation: () => string;
  readonly subjectFor: (question: {
    readonly declarationKey: string;
    readonly decodedRequest: unknown;
    readonly operationRequirementKey: string;
  }) => GatewayDelegationSubject;
}

/**
 * The call of the operation in progress, carried by the fiber like Core's own current worker binding. A Current-gate
 * adapter reads it at each check, so it can only ever ask under the authority of the operation that is running; with no
 * call there is no authority to ask under and the gate fails closed.
 */
export const CurrentOwnerCall = Context.Reference<Option.Option<OwnerCall>>(
  '@app/communications/integrations/owner-call/CurrentOwnerCall',
  { defaultValue: () => Option.none() },
);

/** Runs a program under the authority of one operation: every Current gate it asks reads exactly this call. */
export const underOwnerCall = (call: OwnerCall) => Effect.updateService(CurrentOwnerCall, () => Option.some(call));

/** An Action runs as a human principal (delegated as itself) or as a registered workload / recovery (its requirement). */
export const actionOwnerCall = (scope: OperationalScope): OwnerCall => ({
  correlation: () => scope.correlationId,
  subjectFor: ({ declarationKey, decodedRequest, operationRequirementKey }) => {
    const recovery = readVerifiedGatewayRecovery(scope);
    if (scope.authMethod !== 'system' && readVerifiedGatewayWorkload(scope) === undefined && recovery === undefined) {
      return { _tag: 'Assertion', scope };
    }
    return recovery === undefined
      ? { _tag: 'RegisteredAssertion', declarationKey, operationRequirementKey, scope }
      : {
          _tag: 'RegisteredAssertion',
          declarationKey,
          operationRequirementKey,
          recoveryRequestHash: computeCanonicalValueHash(decodedRequest),
          scope,
        };
  },
});

/** The worker asks as its own verified, claimed delivery; the issuer re-proves the claim and the live lease. */
export const workerOwnerCall = (context: OutboxWorkerHandlerContext): OwnerCall => ({
  correlation: () => context.correlationId ?? context.deliveryId,
  subjectFor: ({ declarationKey, operationRequirementKey }) => ({
    _tag: 'RegisteredWorkload',
    context,
    declarationKey,
    operationRequirementKey,
  }),
});
