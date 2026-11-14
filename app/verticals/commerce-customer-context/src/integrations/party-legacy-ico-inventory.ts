import type { OperationalScope } from '@app/core-runtime';
import {
  LegacyIcoInventoryRequestSchema,
  LegacyIcoInventoryResponseSchema,
} from '@app/party-registry/apis/legacy-ico-inventory';
import type {
  IcoCorrelationWitness,
  LegacyIcoInventoryRequest,
  LegacyIcoInventoryResponse,
} from '@app/party-registry/apis/legacy-ico-inventory';
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
import { commerceCustomerContextEvidenceCall } from '../declared-evidence-calls.ts';

/** Delegated calls present this module's own credential. */
const OWN_APP_ID = 'commerce-customer-context';

const partyAudience = 'party-registry';

type InventoryOptions = Readonly<{
  commitFenceChallenge?: string;
  includeCorrelationWitness?: true;
  operationRequirementKey: string;
  projection?: 'ORGANIZATION_ICO_FIELDS_V1';
  verifyCorrelationWitnesses?: readonly IcoCorrelationWitness[];
}>;
type CorrelationOptions = Readonly<{
  includeCorrelationWitness?: true;
  operationRequirementKey: string;
  organizationOnly?: boolean;
}>;
/** Use the existing owner request unless this scope needs complete per-home proof. */
export const profileIcoInventoryOptions = (
  options: InventoryOptions,
  home: string | undefined,
  witnesses: readonly IcoCorrelationWitness[] | undefined,
  requireWitness: boolean,
  challenge: string | undefined,
): InventoryOptions => {
  if (!requireWitness) {
    return options;
  }
  const proof: InventoryOptions = {
    ...options,
    includeCorrelationWitness: true,
    verifyCorrelationWitnesses: (witnesses ?? []).filter((witness) => witness.legalEntityId !== home),
  };
  if (challenge !== undefined) {
    Object.assign(proof, { commitFenceChallenge: challenge });
  }
  return proof;
};

export const profileIcoCorrelationOptions = (
  options: CorrelationOptions,
  requireWitness: boolean,
): CorrelationOptions => (requireWitness ? { ...options, includeCorrelationWitness: true } : options);

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
              const candidate = { counterpartyRef: ref };
              if (options.includeCorrelationWitness === true) {
                Object.assign(candidate, { includeCorrelationWitness: true });
              }
              const request = yield* Schema.decodeUnknownEffect(CounterpartyOrganizationIcoFactsRequestSchema)(
                candidate,
              );
              // Declared in-transaction evidence call (demo divergence, DEPLOYMENT.md); see ../declared-evidence-calls.ts.
              const issued = yield* acquireDelegatedGatewayContext(
                {
                  audience: partyAudience,
                  callingAppId: OWN_APP_ID,
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
              ).pipe(commerceCustomerContextEvidenceCall.counterpartyOrganizationIcoFacts);
              const raw = yield* executeCounterpartyOrganizationIcoFactsWithAuthorization(
                request,
                issued.authorization,
                scope.correlationId,
                { baseUrl: new URL(issued.apiBaseUrl), compositionRevision: issued.compositionRevision },
              ).pipe(commerceCustomerContextEvidenceCall.counterpartyOrganizationIcoFacts);
              const result = yield* Schema.decodeUnknownEffect(CounterpartyOrganizationIcoFactsResponseSchema)(raw);
              if (
                result.outcome !== 'CURRENT_ORGANIZATION_CUSTOMER' ||
                result.counterpartyRef.resourceId !== ref.resourceId ||
                result.counterpartyRef.tenantId !== scope.tenantId ||
                result.partyRef.tenantId !== scope.tenantId ||
                result.legalEntityRef.resourceId !== scope.legalEntityId ||
                result.legalEntityRef.tenantId !== scope.tenantId ||
                result.currentCustomerRoleRef.tenantId !== scope.tenantId
              ) {
                return Option.none();
              }
              const correlation: OrganizationCorrelation = {
                archived: false,
                counterpartyRef: result.counterpartyRef,
                organizationProof: result,
                partyRef: result.partyRef,
                revision: result.counterpartyRevision,
              };
              if (result.correlationWitness !== undefined) {
                Object.assign(correlation, { correlationWitness: result.correlationWitness });
              }
              return Option.some(correlation);
            }).pipe(Effect.orElseSucceed(Option.none))
          : Effect.gen(function* counterpartyCorrelation() {
              const candidate = { counterpartyRef: ref };
              if (options?.includeCorrelationWitness === true) {
                Object.assign(candidate, { includeCorrelationWitness: true });
              }
              const request = yield* Schema.decodeUnknownEffect(CounterpartyMigrationCorrelationRequestSchema)(
                candidate,
              );
              const issued = yield* acquireDelegatedGatewayContext(
                {
                  audience: partyAudience,
                  callingAppId: OWN_APP_ID,
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
              ).pipe(commerceCustomerContextEvidenceCall.migrationCorrelation);
              const raw = yield* executeCounterpartyMigrationCorrelationWithAuthorization(
                request,
                issued.authorization,
                scope.correlationId,
                { baseUrl: new URL(issued.apiBaseUrl), compositionRevision: issued.compositionRevision },
              ).pipe(commerceCustomerContextEvidenceCall.migrationCorrelation);
              const result = yield* Schema.decodeUnknownEffect(CounterpartyMigrationCorrelationResponseSchema)(raw);
              return result.counterpartyRef.resourceId === ref.resourceId &&
                result.counterpartyRef.tenantId === scope.tenantId &&
                result.partyRef.tenantId === scope.tenantId
                ? Option.some(result)
                : Option.none();
            }).pipe(Effect.orElseSucceed(Option.none)),
      read: Effect.fn('CommerceLegacyIcoInventory.read')(function* readInventory(scope, options) {
        const candidate: LegacyIcoInventoryRequest = {};
        if (options?.commitFenceChallenge !== undefined) {
          Object.assign(candidate, { commitFenceChallenge: options.commitFenceChallenge });
        }
        if (options?.includeCorrelationWitness === true) {
          Object.assign(candidate, { includeCorrelationWitness: true });
        }
        if (options?.projection !== undefined) {
          Object.assign(candidate, { projection: options.projection });
        }
        if (options?.verifyCorrelationWitnesses !== undefined) {
          Object.assign(candidate, { verifyCorrelationWitnesses: options.verifyCorrelationWitnesses });
        }
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
            callingAppId: OWN_APP_ID,
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
          commerceCustomerContextEvidenceCall.legacyIcoInventory,
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
