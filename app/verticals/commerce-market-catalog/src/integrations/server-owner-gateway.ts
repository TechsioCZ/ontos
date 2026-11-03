import { readVerifiedGatewayCompositionRevision, readVerifiedGatewayScopeAssertion } from '@app/core-runtime';
import type { OperationalScope } from '@app/core-runtime';
import { acquireRelayedGatewayContext, GatewayRelaySourceError } from '@app/shared-contracts/gateway-context-server';
import { Effect } from 'effect';
import type { Crypto } from 'effect';

/** Relay only the original Core-verified receiving carrier at its admitted revision. */
export const acquireOwnerGatewayContext = (
  scope: OperationalScope,
  crypto: Crypto.Crypto,
  target: { readonly audience: string; readonly operationKey: string },
  admittedRevision: string,
) => {
  const assertion = readVerifiedGatewayScopeAssertion(scope);
  const compositionRevision = readVerifiedGatewayCompositionRevision(scope);
  if (
    assertion === undefined ||
    compositionRevision === undefined ||
    compositionRevision !== admittedRevision ||
    assertion.audience !== 'commerce-market-catalog'
  ) {
    return Effect.fail(new GatewayRelaySourceError({ reason: 'Verified Market owner admission is required' }));
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
