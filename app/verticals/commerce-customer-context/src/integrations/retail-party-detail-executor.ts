import { executePartyDetailWithAuthorization } from '@app/party-registry/api/client';
import type { OperationalScope } from '@app/core-runtime';
import { acquireDelegatedGatewayContext } from '@app/shared-contracts/gateway-context-server';
import { ProfilePersistenceDependencyFailure } from '../persistence/profile-persistence.ts';
import { Context, Crypto, Effect, Layer, Schema } from 'effect';

export type RetailPartyResolutionExecutor = (
  payload: Parameters<typeof executePartyDetailWithAuthorization>[0],
  requestCorrelation: string,
) => Effect.Effect<
  Effect.Success<ReturnType<typeof executePartyDetailWithAuthorization>>,
  Effect.Error<ReturnType<typeof executePartyDetailWithAuthorization>> | ProfilePersistenceDependencyFailure
>;

interface RetailPartyDetailAuthority {
  readonly actionInvocationId: string;
  readonly compositionRevision: string;
  readonly scope: OperationalScope;
}

interface RetailPartyDetailExecutorService {
  readonly execute: (
    payload: Parameters<RetailPartyResolutionExecutor>[0],
    requestCorrelation: string,
    authority: RetailPartyDetailAuthority,
  ) => ReturnType<RetailPartyResolutionExecutor>;
}

/** Owner-composition transport seam. Production reads Party for the Action's own actor. */
export class RetailPartyDetailExecutor extends Context.Service<
  RetailPartyDetailExecutor,
  RetailPartyDetailExecutorService
>()('@app/commerce-customer-context/integrations/retail-party-detail-executor/RetailPartyDetailExecutor') {}

const transportUnavailable = (reason: string) => new ProfilePersistenceDependencyFailure({ reason });

/**
 * Reads the Party with a delegated gateway context: Commerce's module credential asks the Shell to act for the
 * verified actor of the Action, so Party authorizes and audits that actor, never a Commerce workload principal.
 */
export const makeRetailPartyDetailExecutor = (
  acquire: typeof acquireDelegatedGatewayContext,
  crypto: Crypto.Crypto,
): RetailPartyDetailExecutorService => ({
  execute: Effect.fn('RetailPartyDetail.execute')(
    function* execute(payload, requestCorrelation, authority) {
      const issued = yield* acquire(
        {
          audience: 'party-registry',
          callingAppId: 'commerce-customer-context',
          legalEntityScope: 'subject',
          requestCorrelation,
          subject: { _tag: 'Assertion', scope: authority.scope },
        },
        crypto,
      );
      if (issued.compositionRevision !== authority.compositionRevision) {
        return yield* transportUnavailable('The delegated Party Registry context names another release');
      }
      return yield* executePartyDetailWithAuthorization(payload, issued.authorization, requestCorrelation, {
        baseUrl: new URL(issued.apiBaseUrl),
        compositionRevision: issued.compositionRevision,
      });
    },
    // Do not keep transport causes: they can retain bearer headers and request bodies.
    Effect.mapError((cause) =>
      Schema.is(ProfilePersistenceDependencyFailure)(cause)
        ? cause
        : new ProfilePersistenceDependencyFailure({ reason: 'The actor-bound Party Registry read is unavailable' }),
    ),
  ),
});

export const retailPartyDetailExecutorLive = Layer.effect(
  RetailPartyDetailExecutor,
  Effect.gen(function* makeLiveRetailPartyDetailExecutor() {
    const crypto = yield* Crypto.Crypto;
    return RetailPartyDetailExecutor.of(makeRetailPartyDetailExecutor(acquireDelegatedGatewayContext, crypto));
  }),
);
