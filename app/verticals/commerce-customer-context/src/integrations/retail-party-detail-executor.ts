import { executePartyDetailWithAuthorization } from '@app/party-registry/api/client';
import type { OperationalScope } from '@app/core-runtime';
import {
  readVerifiedGatewayCompositionRevision,
  readVerifiedGatewayScopeAssertion,
} from '@app/core-runtime/auth/system-principal-context-provenance';
import { acquireDelegatedGatewayContext } from '@app/shared-contracts/gateway-context-server';
import { Context, Crypto, Effect, Layer } from 'effect';
import { ProfilePersistenceDependencyFailure } from '../persistence/profile-persistence.ts';

export type RetailPartyResolutionExecutor = (
  payload: Parameters<typeof executePartyDetailWithAuthorization>[0],
  requestCorrelation: string,
) => Effect.Effect<
  Effect.Success<ReturnType<typeof executePartyDetailWithAuthorization>>,
  Effect.Error<ReturnType<typeof executePartyDetailWithAuthorization>> | ProfilePersistenceDependencyFailure
>;

/** Owner-composition transport seam. Production uses the audience-bound Party client. */
export class RetailPartyDetailExecutor extends Context.Service<
  RetailPartyDetailExecutor,
  {
    readonly execute: (
      payload: Parameters<RetailPartyResolutionExecutor>[0],
      requestCorrelation: string,
      authority: {
        readonly actionInvocationId: string;
        readonly compositionRevision: string;
        readonly scope: OperationalScope;
      },
    ) => ReturnType<RetailPartyResolutionExecutor>;
  }
>()('@app/commerce-customer-context/integrations/retail-party-detail-executor/RetailPartyDetailExecutor') {}

/** The source credential identifies this module; the verified scope retains the original requester. */
export const retailPartyDetailExecutorLive = Layer.effect(
  RetailPartyDetailExecutor,
  Effect.gen(function* retailPartyDetailExecutor() {
    const crypto = yield* Crypto.Crypto;
    return {
      execute: Effect.fn('RetailPartyDetailExecutor.execute')(
        function* execute(payload, requestCorrelation, authority) {
          const { scope } = authority;
          if (
            readVerifiedGatewayScopeAssertion(scope)?.audience !== 'commerce-customer-context' ||
            readVerifiedGatewayCompositionRevision(scope) !== authority.compositionRevision ||
            scope.legalEntityId === undefined ||
            scope.correlationId !== requestCorrelation ||
            payload.partyRef.tenantId !== scope.tenantId
          ) {
            return yield* new ProfilePersistenceDependencyFailure({
              reason: 'Retail Party read authority does not match the verified requester',
            });
          }
          const issued = yield* acquireDelegatedGatewayContext(
            {
              audience: 'party-registry',
              legalEntityScope: 'subject',
              requestCorrelation,
              subject: { _tag: 'Assertion', scope },
            },
            crypto,
          ).pipe(
            Effect.mapError((cause) =>
              Object.defineProperty(
                new ProfilePersistenceDependencyFailure({
                  reason: 'The original Retail requester could not be delegated to Party Registry',
                }),
                'cause',
                { value: cause },
              ),
            ),
          );
          return yield* executePartyDetailWithAuthorization(payload, issued.authorization, requestCorrelation, {
            baseUrl: new URL(issued.apiBaseUrl),
            compositionRevision: issued.compositionRevision,
          });
        },
      ),
    } satisfies typeof RetailPartyDetailExecutor.Service;
  }),
);
