import type { OperationalScope } from '@app/core-runtime';
import {
  SourceProcessingEligibilityResponseSchema,
  SourceProcessingEligibilityRequestSchema,
} from '@app/privacy/api/source-processing-eligibility';
import type { SourceProcessingEligibilityRequest } from '@app/privacy/api';
import { executeSourceProcessingEligibilityWithAuthorization } from '@app/privacy/api/source-processing-eligibility/client';
import { acquireDelegatedGatewayContext } from '@app/shared-contracts/gateway-context-server';
import { Context, Crypto, Effect, Layer, Schema } from 'effect';
import { commerceSourceDelegationSubject } from './source-delegation-subject.ts';
import { CommerceSourceProcessingRejected } from './source-processing-rejected.ts';
import { commerceCustomerContextEvidenceCall } from '../declared-evidence-calls.ts';

export { CommerceSourceProcessingRejected } from './source-processing-rejected.ts';

export type CommerceSourceProcessingRequest = Omit<SourceProcessingEligibilityRequest, 'consumerModuleId'>;

export interface CommerceSourceProcessingEligibilityService {
  readonly check: (
    scope: OperationalScope,
    input: CommerceSourceProcessingRequest,
    operationRequirementKey: string,
  ) => Effect.Effect<void, CommerceSourceProcessingRejected>;
}

export class CommerceSourceProcessingEligibility extends Context.Service<
  CommerceSourceProcessingEligibility,
  CommerceSourceProcessingEligibilityService
>()('@app/commerce-customer-context/integrations/source-processing-eligibility/CommerceSourceProcessingEligibility') {}

/** Each attempt asks Privacy with fresh delegated authority; a retained positive result is never reused. */
export const commerceSourceProcessingEligibilityLive = Layer.effect(
  CommerceSourceProcessingEligibility,
  Effect.gen(function* commerceSourceProcessingEligibility() {
    const crypto = yield* Crypto.Crypto;
    return {
      check: Effect.fn('CommerceSourceProcessingEligibility.check')(
        function* check(scope, input, operationRequirementKey) {
          const request = yield* Schema.decodeUnknownEffect(SourceProcessingEligibilityRequestSchema, {
            onExcessProperty: 'error',
          })({
            ...input,
            consumerModuleId: 'commerce.customer-context',
          }).pipe(
            Effect.mapError((cause) =>
              Object.defineProperty(
                new CommerceSourceProcessingRejected({
                  code: 'UNAVAILABLE',
                  reason: 'The exact current source processing request is invalid',
                }),
                'cause',
                { value: cause },
              ),
            ),
          );
          // Declared in-transaction evidence call (demo divergence, DEPLOYMENT.md); see ../declared-evidence-calls.ts.
          const response = yield* acquireDelegatedGatewayContext(
            {
              audience: 'privacy',
              callingAppId: 'commerce-customer-context',
              legalEntityScope: 'subject',
              requestCorrelation: scope.correlationId,
              subject: commerceSourceDelegationSubject(
                scope,
                'privacy.core.source-processing-eligibility.read',
                request,
                operationRequirementKey,
              ),
            },
            crypto,
          ).pipe(
            Effect.flatMap((issued) =>
              executeSourceProcessingEligibilityWithAuthorization(request, issued.authorization, scope.correlationId, {
                baseUrl: new URL(issued.apiBaseUrl),
                compositionRevision: issued.compositionRevision,
              }),
            ),
            commerceCustomerContextEvidenceCall.sourceProcessingEligibility,
            Effect.mapError((cause) =>
              Object.defineProperty(
                new CommerceSourceProcessingRejected({
                  code: 'UNAVAILABLE',
                  reason: 'Current source Privacy authority is unavailable',
                }),
                'cause',
                { configurable: true, value: cause },
              ),
            ),
          );
          const decision = yield* Schema.decodeUnknownEffect(SourceProcessingEligibilityResponseSchema)(response).pipe(
            Effect.mapError((cause) =>
              Object.defineProperty(
                new CommerceSourceProcessingRejected({
                  code: 'UNAVAILABLE',
                  reason: 'Privacy returned invalid source processing evidence',
                }),
                'cause',
                { configurable: true, value: cause },
              ),
            ),
          );
          if (decision.outcome !== 'ALLOWED') {
            return yield* new CommerceSourceProcessingRejected({
              code: 'DENIED',
              reason: 'Current source processing is not permitted',
            });
          }
          return yield* Effect.void;
        },
      ),
    };
  }),
);
