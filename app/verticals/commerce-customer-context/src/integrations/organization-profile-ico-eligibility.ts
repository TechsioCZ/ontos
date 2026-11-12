import type { OperationalScope } from '@app/core-runtime';
import { requireModuleOperation } from '@app/core-runtime';
import {
  OrganizationProfileIcoApplicabilityRequestSchema,
  OrganizationProfileIcoApplicabilityResponseSchema,
} from '@app/privacy/api/organization-profile-ico-applicability';
import type { OrganizationProfileIcoApplicabilityRequest } from '@app/privacy/api/organization-profile-ico-applicability';
import { executeOrganizationProfileIcoApplicabilityWithAuthorization } from '@app/privacy/api/organization-profile-ico-applicability/client';
import { acquireDelegatedGatewayContext } from '@app/shared-contracts/gateway-context-server';
import { Context, Crypto, Effect, Layer, Schema } from 'effect';
import {
  ORGANIZATION_PROFILE_ICO_FIELDS,
  OrganizationProfileIcoRejected,
} from '../../shared/domain/organization-profile-ico.ts';
import { commerceSourceDelegationSubject } from './source-delegation-subject.ts';

const [allowed] = OrganizationProfileIcoApplicabilityResponseSchema.members;
export type OrganizationProfileIcoAuthority = typeof allowed.Type;
export class CommerceOrganizationProfileIcoEligibility extends Context.Service<
  CommerceOrganizationProfileIcoEligibility,
  {
    readonly check: (
      scope: OperationalScope,
      input: Pick<OrganizationProfileIcoApplicabilityRequest, 'operation' | 'profileRef'>,
      requirementKey: string,
    ) => Effect.Effect<OrganizationProfileIcoAuthority, OrganizationProfileIcoRejected>;
  }
>()(
  '@app/commerce-customer-context/integrations/organization-profile-ico-eligibility/CommerceOrganizationProfileIcoEligibility',
) {}
const unavailable = (cause: unknown) =>
  Object.defineProperty(
    new OrganizationProfileIcoRejected({
      code: 'PRIVACY_DENIED',
      reason: 'Current native organization ICO field authority is unavailable',
    }),
    'cause',
    { value: cause },
  );
export const commerceOrganizationProfileIcoEligibilityLive = Layer.effect(
  CommerceOrganizationProfileIcoEligibility,
  Effect.gen(function* organizationIcoEligibility() {
    const crypto = yield* Crypto.Crypto;
    return {
      check: Effect.fn('OrganizationProfileIcoEligibility.check')(function* check(scope, input, requirementKey) {
        yield* requireModuleOperation(requirementKey).pipe(Effect.mapError(unavailable));
        const request = yield* Schema.decodeUnknownEffect(OrganizationProfileIcoApplicabilityRequestSchema)({
          ...input,
          fields: ORGANIZATION_PROFILE_ICO_FIELDS,
        }).pipe(Effect.mapError(unavailable));
        const issued = yield* acquireDelegatedGatewayContext(
          {
            audience: 'privacy',
            callingAppId: 'commerce-customer-context',
            legalEntityScope: 'subject',
            requestCorrelation: scope.correlationId,
            subject: commerceSourceDelegationSubject(
              scope,
              'privacy.core.organization-profile-ico-applicability.read',
              request,
              requirementKey,
            ),
          },
          crypto,
        ).pipe(Effect.mapError(unavailable));
        const raw = yield* executeOrganizationProfileIcoApplicabilityWithAuthorization(
          request,
          issued.authorization,
          scope.correlationId,
          { baseUrl: new URL(issued.apiBaseUrl), compositionRevision: issued.compositionRevision },
        ).pipe(Effect.mapError(unavailable));
        const response = yield* Schema.decodeUnknownEffect(OrganizationProfileIcoApplicabilityResponseSchema)(raw).pipe(
          Effect.mapError(unavailable),
        );
        if (
          !Schema.is(allowed)(response) ||
          response.profileRef.resourceId !== input.profileRef.resourceId ||
          response.profileRef.tenantId !== scope.tenantId ||
          response.partyRef.tenantId !== scope.tenantId ||
          response.allowedFields.length !== ORGANIZATION_PROFILE_ICO_FIELDS.length ||
          !ORGANIZATION_PROFILE_ICO_FIELDS.every((field) => response.allowedFields.includes(field))
        ) {
          return yield* new OrganizationProfileIcoRejected({
            code: 'PRIVACY_DENIED',
            reason: 'Current native organization ICO field authority does not permit this exact field projection',
          });
        }
        return response;
      }),
    };
  }),
);
