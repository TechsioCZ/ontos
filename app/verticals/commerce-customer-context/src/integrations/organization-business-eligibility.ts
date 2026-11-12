import type { OperationalScope } from '@app/core-runtime';
import { requireModuleOperation } from '@app/core-runtime';
import {
  OrganizationBusinessApplicabilityRequestSchema,
  OrganizationBusinessApplicabilityResponseSchema,
} from '@app/privacy/api/organization-business-applicability';
import { executeOrganizationBusinessApplicabilityWithAuthorization } from '@app/privacy/api/organization-business-applicability/client';
import { acquireDelegatedGatewayContext } from '@app/shared-contracts/gateway-context-server';
import { Context, Crypto, Effect, Layer, Schema } from 'effect';
import { commerceSourceDelegationSubject } from './source-delegation-subject.ts';
import { CommerceSourceProcessingRejected } from './source-processing-rejected.ts';
import { validateOrganizationBusinessDecision } from './organization-business-decision.ts';
import type {
  CommerceOrganizationBusinessRequest,
  CommerceOrganizationBusinessAuthority,
} from './organization-business-decision.ts';

export type { CommerceOrganizationBusinessRequest } from './organization-business-decision.ts';

export interface CommerceOrganizationBusinessEligibilityService {
  readonly check: (
    scope: OperationalScope,
    input: CommerceOrganizationBusinessRequest,
    operationRequirementKey: string,
  ) => Effect.Effect<CommerceOrganizationBusinessAuthority, CommerceSourceProcessingRejected>;
}
export class CommerceOrganizationBusinessEligibility extends Context.Service<
  CommerceOrganizationBusinessEligibility,
  CommerceOrganizationBusinessEligibilityService
>()(
  '@app/commerce-customer-context/integrations/organization-business-eligibility/CommerceOrganizationBusinessEligibility',
) {}

const unavailable = (cause: unknown) =>
  Object.defineProperty(
    new CommerceSourceProcessingRejected({
      code: 'UNAVAILABLE',
      reason: 'Current Organization business authority is unavailable',
    }),
    'cause',
    { configurable: true, value: cause },
  );

export const commerceOrganizationBusinessEligibilityLive = Layer.effect(
  CommerceOrganizationBusinessEligibility,
  Effect.gen(function* organizationBusinessEligibility() {
    const crypto = yield* Crypto.Crypto;
    return {
      check: Effect.fn('CommerceOrganizationBusinessEligibility.check')(
        function* check(scope, input, operationRequirementKey) {
          yield* requireModuleOperation(operationRequirementKey).pipe(Effect.mapError(unavailable));
          const request = yield* Schema.decodeUnknownEffect(OrganizationBusinessApplicabilityRequestSchema, {
            onExcessProperty: 'error',
          })(input).pipe(Effect.mapError(unavailable));
          if (request.consumerModuleId !== 'commerce.customer-context') {
            return yield* new CommerceSourceProcessingRejected({
              code: 'DENIED',
              reason: 'Organization business authority must belong to this native owner',
            });
          }
          const issued = yield* acquireDelegatedGatewayContext(
            {
              audience: 'privacy',
              callingAppId: 'commerce-customer-context',
              legalEntityScope: 'subject',
              requestCorrelation: scope.correlationId,
              subject: commerceSourceDelegationSubject(
                scope,
                'privacy.core.organization-business-applicability.read',
                request,
                operationRequirementKey,
              ),
            },
            crypto,
          ).pipe(Effect.mapError(unavailable));
          const response = yield* executeOrganizationBusinessApplicabilityWithAuthorization(
            request,
            issued.authorization,
            scope.correlationId,
            { baseUrl: new URL(issued.apiBaseUrl), compositionRevision: issued.compositionRevision },
          ).pipe(Effect.mapError(unavailable));
          const decoded = yield* Schema.decodeUnknownEffect(OrganizationBusinessApplicabilityResponseSchema, {
            onExcessProperty: 'error',
          })(response).pipe(Effect.mapError(unavailable));
          return yield* validateOrganizationBusinessDecision(scope, request, decoded);
        },
      ),
    };
  }),
);
