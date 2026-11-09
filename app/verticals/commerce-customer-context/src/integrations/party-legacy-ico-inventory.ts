import type { OperationalScope } from '@app/core-runtime';
import {
  LegacyIcoInventoryRequestSchema,
  LegacyIcoInventoryResponseSchema,
} from '@app/party-registry/apis/legacy-ico-inventory';
import type { LegacyIcoInventoryResponse } from '@app/party-registry/apis/legacy-ico-inventory';
import { executeLegacyIcoInventoryWithAuthorization } from '@app/party-registry/apis/legacy-ico-inventory/client';
import {
  CounterpartyMigrationCorrelationRequestSchema,
  CounterpartyMigrationCorrelationResponseSchema,
} from '@app/party-registry/apis/counterparty-migration-correlation';
import { executeCounterpartyMigrationCorrelationWithAuthorization } from '@app/party-registry/apis/counterparty-migration-correlation/client';
import {
  CounterpartyOrganizationIcoFactsRequestSchema,
  CounterpartyOrganizationIcoFactsResponseSchema,
} from '@app/party-registry/apis/counterparty-organization-ico-facts';
import { executeCounterpartyOrganizationIcoFactsWithAuthorization } from '@app/party-registry/apis/counterparty-organization-ico-facts/client';
import { commerceSourceDelegationSubject } from './source-delegation-subject.ts';
import type { CounterpartyRef } from '@app/party-registry/resources/counterparty';
import { acquireDelegatedGatewayContext } from '@app/shared-contracts/gateway-context-server';
import { Context, Crypto, Effect, Layer, Option, Schema } from 'effect';
import { CustomerProfileIcoMigrationRejected } from '../../shared/domain/customer-profile-ico-migration.ts';

const partyAudience = 'party-registry';

type InventoryOptions = Readonly<{ operationRequirementKey: string; projection?: 'ORGANIZATION_ICO_FIELDS_V1' }>;
type CorrelationOptions = Readonly<{ operationRequirementKey: string; organizationOnly?: boolean }>;
type OrganizationCorrelation = typeof CounterpartyMigrationCorrelationResponseSchema.Type & {
  readonly organizationProof?: (typeof CounterpartyOrganizationIcoFactsResponseSchema.members)[1]['Type'];
};

export class CommerceLegacyIcoInventory extends Context.Service<
  CommerceLegacyIcoInventory,
  {
    readonly correlate: (
      scope: OperationalScope,
      ref: CounterpartyRef,
      options?: CorrelationOptions,
    ) => Effect.Effect<Option.Option<OrganizationCorrelation>>;
    readonly read: (
      scope: OperationalScope,
      options?: InventoryOptions,
    ) => Effect.Effect<LegacyIcoInventoryResponse, CustomerProfileIcoMigrationRejected>;
  }
>()('@app/commerce-customer-context/integrations/party-legacy-ico-inventory/CommerceLegacyIcoInventory') {}

export const commerceLegacyIcoInventoryLive = Layer.effect(
  CommerceLegacyIcoInventory,
  Effect.gen(function* legacyIcoInventory() {
    const crypto = yield* Crypto.Crypto;
    return {
      correlate: (scope, ref, options) =>
        options?.organizationOnly === true
          ? Effect.gen(function* organizationCorrelation() {
              const request = yield* Schema.decodeUnknownEffect(CounterpartyOrganizationIcoFactsRequestSchema)({
                counterpartyRef: ref,
              });
              const issued = yield* acquireDelegatedGatewayContext(
                {
                  audience: partyAudience,
                  legalEntityScope: 'subject',
                  requestCorrelation: scope.correlationId,
                  subject: commerceSourceDelegationSubject(
                    scope,
                    'party.registry.counterparty-organization-ico-facts.read',
                    request,
                    options.operationRequirementKey,
                  ),
                },
                crypto,
              );
              const raw = yield* executeCounterpartyOrganizationIcoFactsWithAuthorization(
                request,
                issued.authorization,
                scope.correlationId,
                { baseUrl: new URL(issued.apiBaseUrl), compositionRevision: issued.compositionRevision },
              );
              const result = yield* Schema.decodeUnknownEffect(CounterpartyOrganizationIcoFactsResponseSchema)(raw);
              return result.outcome === 'CURRENT_ORGANIZATION_CUSTOMER' &&
                result.counterpartyRef.resourceId === ref.resourceId &&
                result.counterpartyRef.tenantId === scope.tenantId &&
                result.partyRef.tenantId === scope.tenantId &&
                result.legalEntityRef.resourceId === scope.legalEntityId &&
                result.legalEntityRef.tenantId === scope.tenantId &&
                result.currentCustomerRoleRef.tenantId === scope.tenantId
                ? Option.some({
                    archived: false,
                    counterpartyRef: result.counterpartyRef,
                    organizationProof: result,
                    partyRef: result.partyRef,
                    revision: result.counterpartyRevision,
                  })
                : Option.none();
            }).pipe(Effect.orElseSucceed(Option.none))
          : Effect.gen(function* counterpartyCorrelation() {
              const request = yield* Schema.decodeUnknownEffect(CounterpartyMigrationCorrelationRequestSchema)({
                counterpartyRef: ref,
              });
              const issued = yield* acquireDelegatedGatewayContext(
                {
                  audience: partyAudience,
                  legalEntityScope: 'subject',
                  requestCorrelation: scope.correlationId,
                  subject:
                    options === undefined
                      ? { _tag: 'Assertion', scope }
                      : commerceSourceDelegationSubject(
                          scope,
                          'party.registry.counterparty-migration-correlation.read',
                          request,
                          options.operationRequirementKey,
                        ),
                },
                crypto,
              );
              const raw = yield* executeCounterpartyMigrationCorrelationWithAuthorization(
                request,
                issued.authorization,
                scope.correlationId,
                { baseUrl: new URL(issued.apiBaseUrl), compositionRevision: issued.compositionRevision },
              );
              const result = yield* Schema.decodeUnknownEffect(CounterpartyMigrationCorrelationResponseSchema)(raw);
              return result.counterpartyRef.resourceId === ref.resourceId &&
                result.counterpartyRef.tenantId === scope.tenantId &&
                result.partyRef.tenantId === scope.tenantId
                ? Option.some(result)
                : Option.none();
            }).pipe(Effect.orElseSucceed(Option.none)),
      read: Effect.fn('CommerceLegacyIcoInventory.read')(function* readInventory(scope, options) {
        const candidate = options?.projection === undefined ? {} : { projection: options.projection };
        const request = yield* Schema.decodeUnknownEffect(LegacyIcoInventoryRequestSchema)(candidate).pipe(
          Effect.mapError((cause) =>
            Object.defineProperty(
              new CustomerProfileIcoMigrationRejected({
                code: 'INVENTORY_UNAVAILABLE',
                reason: 'The requested complete inventory projection is unavailable',
              }),
              'cause',
              { value: cause },
            ),
          ),
        );
        if (
          options?.projection !== undefined &&
          (!('projection' in request) || request.projection !== options.projection)
        ) {
          return yield* new CustomerProfileIcoMigrationRejected({
            code: 'INVENTORY_UNAVAILABLE',
            reason: 'Party does not expose the bounded complete organization projection',
          });
        }
        const response = yield* acquireDelegatedGatewayContext(
          {
            audience: partyAudience,
            legalEntityScope: 'subject',
            requestCorrelation: scope.correlationId,
            subject:
              options === undefined
                ? { _tag: 'Assertion', scope }
                : commerceSourceDelegationSubject(
                    scope,
                    'party.registry.legacy-ico-inventory.read',
                    request,
                    options.operationRequirementKey,
                  ),
          },
          crypto,
        ).pipe(
          Effect.flatMap((issued) =>
            executeLegacyIcoInventoryWithAuthorization(request, issued.authorization, scope.correlationId, {
              baseUrl: new URL(issued.apiBaseUrl),
              compositionRevision: issued.compositionRevision,
            }),
          ),
          Effect.mapError((cause) =>
            Object.defineProperty(
              new CustomerProfileIcoMigrationRejected({
                code: 'INVENTORY_UNAVAILABLE',
                reason: 'Current complete Party IČO inventory is unavailable',
              }),
              'cause',
              { configurable: true, value: cause },
            ),
          ),
        );
        const inventory = yield* Schema.decodeUnknownEffect(LegacyIcoInventoryResponseSchema)(response).pipe(
          Effect.mapError((cause) =>
            Object.defineProperty(
              new CustomerProfileIcoMigrationRejected({
                code: 'INVENTORY_UNAVAILABLE',
                reason: 'Party returned invalid inventory evidence',
              }),
              'cause',
              { configurable: true, value: cause },
            ),
          ),
        );
        if (inventory.tenantId !== scope.tenantId) {
          return yield* new CustomerProfileIcoMigrationRejected({
            code: 'INVENTORY_UNAVAILABLE',
            reason: 'Party inventory does not match the trusted Tenant',
          });
        }
        return inventory;
      }),
    };
  }),
);
