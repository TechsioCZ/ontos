import type { OperationalScope } from '@app/core-runtime';
import {
  readVerifiedGatewayRecovery,
  readVerifiedGatewayWorkload,
} from '@app/core-runtime/auth/system-principal-context-provenance';
import { acquireDelegatedGatewayContext } from '@app/shared-contracts/gateway-context-server';
import type { GatewayDelegationSubject } from '@app/shared-contracts/gateway-context-server';
import { Context, Crypto, Effect, Layer, Redacted, Schema } from 'effect';

import { PrivacyOperationPersistenceError } from './privacy-operation-persistence-error.ts';

export const PrivacyPartyOwnerRequirementSchema = Schema.Literals([
  'privacy.core.requirement.create-subject-party-detail',
  'privacy.core.requirement.create-subject-source-person',
  'privacy.core.requirement.read-subject-party-detail',
  'privacy.core.requirement.read-subject-source-person',
  'privacy.core.requirement.source-processing-source-person',
]);
export type PrivacyPartyOwnerRequirement = typeof PrivacyPartyOwnerRequirementSchema.Type;

/** Trusted transport assembly only. Each attempt needs a fresh Party-audience credential.
 * The Privacy bearer, business payload and stored admission evidence cannot provide it. */
export class PrivacySubjectPartyCredentials extends Context.Service<
  PrivacySubjectPartyCredentials,
  {
    readonly acquire: (
      scope: OperationalScope,
      declarationKey?: 'party.registry.party.read' | 'party.registry.source-person-admission.read',
      operationRequirementKey?: PrivacyPartyOwnerRequirement,
      recoveryRequestHash?: string,
    ) => Effect.Effect<
      {
        readonly authorization: Redacted.Redacted;
        readonly baseUrl: string;
        readonly compositionRevision: string;
      },
      PrivacyOperationPersistenceError
    >;
  }
>()('@app/privacy/persistence/privacy-subject-party-credentials/PrivacySubjectPartyCredentials') {}

export const PrivacySubjectPartyCredentialsLive = Layer.effect(
  PrivacySubjectPartyCredentials,
  Effect.gen(function* partyCredentials() {
    const crypto = yield* Crypto.Crypto;
    return {
      acquire: Effect.fn('PrivacySubjectPartyCredentials.acquire')(
        function* acquire(scope, declarationKey, operationRequirementKey, recoveryRequestHash) {
          let subject: GatewayDelegationSubject;
          const recovery = readVerifiedGatewayRecovery(scope);
          if (
            scope.authMethod === 'system' ||
            recovery !== undefined ||
            readVerifiedGatewayWorkload(scope) !== undefined
          ) {
            if (operationRequirementKey === undefined) {
              return yield* new PrivacyOperationPersistenceError({
                code: 'privacy_operation_persistence_unavailable',
                reason: 'Current conditional Party proof requirement is unavailable',
              });
            }
            subject = {
              _tag: 'RegisteredAssertion',
              declarationKey: declarationKey ?? 'party.registry.party.read',
              expectedPrincipalId: scope.principalId,
              operationRequirementKey,
              scope,
            };
            if (recovery !== undefined) {
              if (recoveryRequestHash === undefined) {
                return yield* new PrivacyOperationPersistenceError({
                  code: 'privacy_operation_persistence_unavailable',
                  reason: 'The exact current Party recovery read input is unavailable',
                });
              }
              subject = { ...subject, recoveryRequestHash };
            }
          } else {
            subject = { _tag: 'Assertion', scope };
          }
          return yield* acquireDelegatedGatewayContext(
            {
              audience: 'party-registry',
              legalEntityScope: 'subject',
              requestCorrelation: scope.correlationId,
              subject,
            },
            crypto,
          ).pipe(
            Effect.map((issued) => ({
              authorization: Redacted.make(issued.authorization),
              baseUrl: issued.apiBaseUrl,
              compositionRevision: issued.compositionRevision,
            })),
            Effect.mapError((cause) =>
              Object.defineProperty(
                new PrivacyOperationPersistenceError({
                  code: 'privacy_operation_persistence_unavailable',
                  reason: 'Fresh current Party admission credentials are unavailable',
                }),
                'cause',
                { configurable: true, value: cause },
              ),
            ),
          );
        },
      ),
    };
  }),
);
