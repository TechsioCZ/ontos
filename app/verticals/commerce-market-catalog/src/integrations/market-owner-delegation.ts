import { readVerifiedGatewayCompositionRevision, readVerifiedGatewayScopeAssertion } from '@app/core-runtime';
import type { OperationalScope } from '@app/core-runtime';
import {
  acquireDelegatedGatewayContext,
  GatewayDelegationSourceError,
} from '@app/shared-contracts/gateway-context-server';
import { Effect } from 'effect';
import type { Crypto } from 'effect';

/**
 * Acts for the requester whose Market admission this scope carries, toward another module. The
 * requester is the subject; this module is the actor the Shell records. The admitted composition
 * revision must still be the one the action was admitted under.
 */
export const acquireMarketOwnerDelegation = (
  scope: OperationalScope,
  crypto: Crypto.Crypto,
  audience: string,
  admittedRevision: string,
) => {
  const assertion = readVerifiedGatewayScopeAssertion(scope);
  if (
    assertion === undefined ||
    assertion.audience !== 'commerce-market-catalog' ||
    readVerifiedGatewayCompositionRevision(scope) !== admittedRevision
  ) {
    return Effect.fail(new GatewayDelegationSourceError({ reason: 'Verified Market owner admission is required' }));
  }
  return acquireDelegatedGatewayContext(
    {
      audience,
      legalEntityScope: 'subject',
      requestCorrelation: scope.correlationId,
      subject: { _tag: 'Assertion', scope },
    },
    crypto,
  );
};
