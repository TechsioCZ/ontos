import type {
  ActionHandlerContext,
  CoreSearchResourceRef,
  OperationalScope,
  OwnerAccessFacts,
} from '@app/core-runtime';
import { CoreSearchResourceRefSchema, OperationContextUnavailable } from '@app/core-runtime';
import { DateTime, Effect, Option, Schema, SchemaGetter } from 'effect';
import { PurchaseApprovalCurrentnessFactory } from '../../shared/domain/purchase-approval-currentness-port.ts';
import type { PurchaseApprovalCurrentnessService } from '../../shared/domain/purchase-approval-currentness-port.ts';
import { PurchaseLimitEvaluationCurrentnessPort } from '../../shared/domain/purchase-limit-evaluation-currentness-port.ts';
import {
  PurchaseLimitSellingLegalEntityIdSchema,
  PurchaseLimitStorefrontIdSchema,
  PurchaseLimitEvaluationSourceFactory,
} from '../../shared/domain/purchase-limit-evaluation.ts';
import type { PurchaseApprovalRequest } from '../../shared/domain/purchasing-approval.ts';
import { purchasingApprovalWorkflowForScope } from '../persistence/purchasing-approval-persistence.ts';
import type { PurchasingApprovalWorkflowService } from '../persistence/purchasing-approval-persistence.ts';
import { counterpartyOwnerFacts } from './owner-access-facts.ts';

type PurchasingApprovalDataAccessContext = Pick<
  ActionHandlerContext<Readonly<Record<string, never>>, unknown>,
  'recordDataAccess'
>;

export const purchasingApprovalAuditInstantSchema = Schema.toEncoded(
  Schema.String.check(
    Schema.makeFilter((value) => {
      const parsed = DateTime.make(value);
      return Option.isSome(parsed) && DateTime.formatIso(parsed.value) === value
        ? undefined
        : 'must be a canonical UTC instant';
    }),
  ).pipe(
    Schema.decodeTo(Schema.toType(Schema.DateTimeUtc), {
      decode: SchemaGetter.transform(DateTime.makeUnsafe),
      encode: SchemaGetter.transform(DateTime.formatIso),
    }),
  ),
);

export const recordPurchasingApprovalResourceAccess = (
  context: PurchasingApprovalDataAccessContext,
  input: {
    readonly queryHash: string;
    readonly resourceRef: Readonly<{
      readonly moduleId: string;
      readonly resourceId: string;
      readonly resourceType: string;
      readonly tenantId: string;
    }>;
    readonly resultCount?: number;
  },
) =>
  Schema.decodeEffect(CoreSearchResourceRefSchema)(input.resourceRef).pipe(
    Effect.orDie,
    Effect.flatMap((resourceRef) =>
      context.recordDataAccess({
        accessKind: 'read',
        queryHash: input.queryHash,
        resultCount: input.resultCount ?? 1,
        servingModuleKey: 'commerce.customer-context',
        targetModuleKey: resourceRef.moduleId,
        targetResourceId: resourceRef.resourceId,
        targetResourceType: resourceRef.resourceType,
      }),
    ),
  );

export const recordPurchasingApprovalRequestResources = (
  context: PurchasingApprovalDataAccessContext,
  request: PurchaseApprovalRequest,
  storefrontId: string | null,
) =>
  Effect.all(
    [
      recordPurchasingApprovalResourceAccess(context, {
        queryHash: `purchasing-approval-request:${request.requestRef.resourceId}:${storefrontId}`,
        resourceRef: request.requestRef,
      }),
      recordPurchasingApprovalResourceAccess(context, {
        queryHash: `purchasing-approval-proposal:${request.proposal.proposalRevisionRef.resourceId}:${storefrontId}`,
        resourceRef: request.proposal.proposalRevisionRef,
      }),
      recordPurchasingApprovalResourceAccess(context, {
        queryHash: `purchasing-approval-route:${request.route.routeRef.resourceId}:${storefrontId}`,
        resourceRef: request.route.routeRef,
      }),
      recordPurchasingApprovalResourceAccess(context, {
        queryHash: `purchasing-approval-hierarchy:${request.route.hierarchyRef.resourceId}:${storefrontId}`,
        resourceRef: request.route.hierarchyRef,
      }),
    ],
    { concurrency: 1, discard: true },
  );

/**
 * The purchasing-approval owner rule target: the counterparty whose own approval grant the overlay
 * checks, storefront-scoped when the request carries a Storefront (O67-Q1, O70).
 */
export const purchasingApprovalOwnerFacts = (input: {
  readonly counterpartyRef: CoreSearchResourceRef;
  readonly storefrontId: string | null;
}): OwnerAccessFacts => counterpartyOwnerFacts(input.counterpartyRef.resourceId, input.storefrontId);

export const trustedPurchasingContext = (
  counterpartyRef: CoreSearchResourceRef,
  storefrontId: string | null,
  scope: OperationalScope,
): boolean =>
  counterpartyRef.moduleId === 'party.registry' &&
  counterpartyRef.resourceType === 'party.registry.counterparty' &&
  counterpartyRef.tenantId === scope.tenantId &&
  (storefrontId === null || scope.trustedStorefrontId === storefrontId) &&
  scope.legalEntityId !== undefined;

const purchaseApprovalEvaluationUnavailable = (cause?: unknown): OperationContextUnavailable => {
  const failure = new OperationContextUnavailable({
    code: 'operation_context_unavailable',
    reason: 'Current Purchase Proposal evaluation evidence is unavailable',
  });
  if (cause !== undefined) {
    Object.defineProperty(failure, 'cause', { configurable: true, value: cause });
  }
  return failure;
};

interface PurchasingApprovalCurrentnessServices {
  readonly currentness: PurchaseApprovalCurrentnessService;
  readonly workflow: PurchasingApprovalWorkflowService;
}

type PurchasingApprovalTransaction = Parameters<typeof purchasingApprovalWorkflowForScope>[0];

// Narrow the original scope: spreading it would discard Core's object-identity provenance.
const hasPurchasingApprovalScope = Schema.is(
  Schema.Struct({
    legalEntityId: PurchaseLimitSellingLegalEntityIdSchema,
    trustedStorefrontId: PurchaseLimitStorefrontIdSchema,
  }),
);

export const purchasingApprovalCurrentnessServicesForScope = (
  transaction: PurchasingApprovalTransaction,
  scope: OperationalScope,
) =>
  Effect.all(
    {
      currentness: Effect.all(
        {
          currentnessFactory: PurchaseApprovalCurrentnessFactory,
          evaluationSourceFactory: PurchaseLimitEvaluationSourceFactory,
          purchaseLimitCurrentness: PurchaseLimitEvaluationCurrentnessPort,
        },
        { concurrency: 3 },
      ).pipe(
        Effect.flatMap(({ currentnessFactory, evaluationSourceFactory, purchaseLimitCurrentness }) =>
          hasPurchasingApprovalScope(scope)
            ? evaluationSourceFactory.make(transaction, scope).pipe(
                Effect.mapError(purchaseApprovalEvaluationUnavailable),
                Effect.map((evaluationSource) =>
                  currentnessFactory.make(transaction, scope, purchaseLimitCurrentness, evaluationSource),
                ),
              )
            : Effect.void,
        ),
      ),
      workflow: purchasingApprovalWorkflowForScope(transaction, scope),
    },
    { concurrency: 2 },
  ).pipe(
    Effect.flatMap(({ currentness, workflow }) =>
      currentness === undefined
        ? Effect.fail(
            new OperationContextUnavailable({
              code: 'operation_context_unavailable',
              reason: 'Current Purchasing Approval evidence requires trusted owner scope',
            }),
          )
        : Effect.succeed({ currentness, workflow } satisfies PurchasingApprovalCurrentnessServices),
    ),
  );
