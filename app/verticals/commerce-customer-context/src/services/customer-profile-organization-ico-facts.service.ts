import {
  defineScopedRoutine,
  OperationContextUnavailable,
  ReadHandlerUnavailable,
  requireModuleOperation,
} from '@app/core-runtime';
import type { ReadServiceFactory } from '@app/core-runtime';
import {
  CounterpartyOrganizationIcoFactsRequestSchema,
  CounterpartyOrganizationIcoFactsResponseSchema,
} from '@app/party-registry/apis/counterparty-organization-ico-facts';
import { executeCounterpartyOrganizationIcoFactsWithAuthorization } from '@app/party-registry/apis/counterparty-organization-ico-facts/client';
import { CounterpartyRefSchema } from '@app/party-registry/resources/counterparty';
import { acquireDelegatedGatewayContext } from '@app/shared-contracts/gateway-context-server';
import { Crypto, Effect, Schema } from 'effect';
import type {
  CustomerProfileOrganizationIcoFactsRequest,
  CustomerProfileOrganizationIcoFactsResponse,
} from '../../shared/apis/customer-profile-organization-ico-facts.ts';
import { CommerceCustomerProfileStateSchema } from '../../shared/domain/profile-contracts.ts';
import { commerceSourceDelegationSubject } from '../integrations/source-delegation-subject.ts';

const organizationProfileFactsRoutine = defineScopedRoutine({
  name: 'read_customer_profile_organization_ico_facts',
  ownerModuleKey: 'commerce.customer-context',
  parameters: [
    { source: 'tenantId', type: 'uuid' },
    { source: 'legalEntityId', type: 'uuid' },
    { source: 'input', type: 'uuid' },
  ],
  resultSchema: Schema.Struct({ outcome: Schema.String, payload: Schema.Unknown }),
  routineKey: 'customer-profile-organization-ico-facts.read',
  schema: 'commerce_customer_context',
});
const organizationProfileHistoricalFactsRoutine = defineScopedRoutine({
  name: 'read_customer_profile_organization_business_facts',
  ownerModuleKey: 'commerce.customer-context',
  parameters: [
    { source: 'tenantId', type: 'uuid' },
    { source: 'legalEntityId', type: 'uuid' },
    { source: 'input', type: 'uuid' },
  ],
  resultSchema: Schema.Struct({ outcome: Schema.String, payload: Schema.Unknown }),
  routineKey: 'customer-profile-organization-business-facts.read',
  schema: 'commerce_customer_context',
});
const currentProfileFactsSchema = Schema.Struct({
  counterpartyResourceId: CounterpartyRefSchema.fields.resourceId,
  profileRevision: Schema.Int.check(Schema.isGreaterThan(0)),
});
const historicalProfileFactsSchema = Schema.Struct({
  ...currentProfileFactsSchema.fields,
  profileState: CommerceCustomerProfileStateSchema,
});
const unavailable = (cause: unknown) =>
  Object.defineProperty(
    new ReadHandlerUnavailable({
      code: 'read_handler_unavailable',
      reason: 'Current organization customer-profile facts are unavailable',
    }),
    'cause',
    { configurable: true, value: cause },
  );

export interface CustomerProfileOrganizationIcoFactsServices {
  readonly readFacts: (
    input: CustomerProfileOrganizationIcoFactsRequest,
  ) => Effect.Effect<CustomerProfileOrganizationIcoFactsResponse, ReadHandlerUnavailable>;
}

/** A snapshot of exact current owner references; it grants no write or IČO processing authority. */
export const customerProfileOrganizationIcoFactsServices: ReadServiceFactory<
  CustomerProfileOrganizationIcoFactsServices,
  Crypto.Crypto
> = Effect.fn('CustomerProfileOrganizationIcoFacts.services')(
  function* organizationIcoFactsServices(transaction, scope) {
    const crypto = yield* Crypto.Crypto;
    if (scope.legalEntityId === undefined) {
      return yield* new OperationContextUnavailable({
        code: 'operation_context_unavailable',
        reason: 'Organization customer-profile facts require a trusted Legal Entity',
      });
    }
    return {
      readFacts: Effect.fn('CustomerProfileOrganizationIcoFacts.read')(function* readFacts(input) {
        if (
          input.profileRef.tenantId !== scope.tenantId ||
          !Schema.is(Schema.String.check(Schema.isUUID()))(input.profileRef.resourceId)
        ) {
          return { _tag: 'NOT_ADMISSIBLE' as const };
        }
        const historical = input.identityState === 'HISTORICAL';
        const [row] = yield* transaction
          .invoke(historical ? organizationProfileHistoricalFactsRoutine : organizationProfileFactsRoutine, [
            input.profileRef.resourceId,
          ])
          .pipe(Effect.mapError(unavailable));
        if (row === undefined) {
          return yield* unavailable(row);
        }
        if (row.outcome === 'NOT_ADMISSIBLE') {
          return { _tag: 'NOT_ADMISSIBLE' as const };
        }
        if (row.outcome !== (historical ? 'CURRENT_HISTORICAL_IDENTITY' : 'CURRENT')) {
          return yield* unavailable(row);
        }
        const profile = yield* Schema.decodeUnknownEffect(
          historical ? historicalProfileFactsSchema : currentProfileFactsSchema,
          { onExcessProperty: 'error' },
        )(row.payload).pipe(Effect.mapError(unavailable));
        yield* requireModuleOperation(
          'commerce.customer-context.requirement.customer-profile-organization-ico-facts-party',
        ).pipe(Effect.mapError(unavailable));
        const request = yield* Schema.decodeUnknownEffect(CounterpartyOrganizationIcoFactsRequestSchema)({
          counterpartyRef: {
            moduleId: 'party.registry',
            resourceId: profile.counterpartyResourceId,
            resourceType: 'party.registry.counterparty',
            tenantId: scope.tenantId,
          },
        }).pipe(Effect.mapError(unavailable));
        const issued = yield* acquireDelegatedGatewayContext(
          {
            audience: 'party-registry',
            legalEntityScope: 'subject',
            requestCorrelation: scope.correlationId,
            subject: commerceSourceDelegationSubject(
              scope,
              'party.registry.counterparty-organization-ico-facts.read',
              request,
              'commerce.customer-context.requirement.customer-profile-organization-ico-facts-party',
            ),
          },
          crypto,
        ).pipe(Effect.mapError(unavailable));
        const response = yield* executeCounterpartyOrganizationIcoFactsWithAuthorization(
          request,
          issued.authorization,
          scope.correlationId,
          { baseUrl: new URL(issued.apiBaseUrl), compositionRevision: issued.compositionRevision },
        ).pipe(Effect.mapError(unavailable));
        const facts = yield* Schema.decodeUnknownEffect(CounterpartyOrganizationIcoFactsResponseSchema, {
          onExcessProperty: 'error',
        })(response).pipe(Effect.mapError(unavailable));
        if (
          facts.outcome !== 'CURRENT_ORGANIZATION_CUSTOMER' ||
          facts.counterpartyRef.resourceId !== profile.counterpartyResourceId ||
          facts.counterpartyRef.tenantId !== scope.tenantId ||
          facts.partyRef.tenantId !== scope.tenantId ||
          facts.legalEntityRef.tenantId !== scope.tenantId ||
          facts.legalEntityRef.resourceId !== scope.legalEntityId ||
          facts.currentCustomerRoleRef.tenantId !== scope.tenantId
        ) {
          return { _tag: 'NOT_ADMISSIBLE' as const };
        }
        const current = {
          counterpartyRef: facts.counterpartyRef,
          counterpartyRevision: facts.counterpartyRevision,
          currentCustomerRoleRef: facts.currentCustomerRoleRef,
          currentCustomerRoleRevision: facts.currentCustomerRoleRevision,
          legalEntityRef: facts.legalEntityRef,
          partyRef: facts.partyRef,
          partyRevision: facts.partyRevision,
          profileRef: input.profileRef,
          profileRevision: profile.profileRevision,
        };
        if (historical) {
          if (!Schema.is(historicalProfileFactsSchema)(profile)) {
            return yield* unavailable(profile);
          }
          return { _tag: 'CURRENT_HISTORICAL_IDENTITY' as const, ...current, profileState: profile.profileState };
        }
        return { _tag: 'CURRENT' as const, ...current };
      }),
    };
  },
);
