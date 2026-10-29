import { readVerifiedGatewayCompositionRevision, readVerifiedGatewayScopeAssertion } from '@app/core-runtime';
import type { OperationalScope } from '@app/core-runtime';
import { acquireRelayedGatewayContext, GatewayRelaySourceError } from '@app/shared-contracts/gateway-context-server';
import { Effect } from 'effect';
import type { Crypto } from 'effect';

/** Extract only the original receiving carrier; payload identity is never relay authority. */
export const acquireOwnerGatewayContext = (
  scope: OperationalScope,
  crypto: Crypto.Crypto,
  target: { readonly audience: string; readonly operationKey: string },
) => {
  const assertion = readVerifiedGatewayScopeAssertion(scope);
  const compositionRevision = readVerifiedGatewayCompositionRevision(scope);
  if (assertion === undefined || compositionRevision === undefined || assertion.audience !== 'catalog') {
    return Effect.fail(new GatewayRelaySourceError({ reason: 'Verified owner admission is required' }));
  }
  return acquireRelayedGatewayContext(
    {
      assertion: assertion.assertion,
      audience: assertion.audience,
      compositionRevision,
      requestCorrelation: scope.correlationId,
    },
    target,
    crypto,
  );
};
