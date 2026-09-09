import type {
  ActionBusinessPermissionTarget,
  ActionHandlerContext,
  CoreSearchResourceRef,
  OperationalScope,
} from '@app/core-runtime';
import { CoreSearchResourceRefSchema } from '@app/core-runtime';
import { Effect, Schema } from 'effect';

type PurchasingApprovalDataAccessContext = Pick<
  ActionHandlerContext<Readonly<Record<string, never>>, unknown>,
  'recordDataAccess'
>;

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
  Schema.decodeUnknownEffect(CoreSearchResourceRefSchema)(input.resourceRef).pipe(
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

export const purchasingApprovalPermissionTarget = (input: {
  readonly permission:
    | 'counterparty.approval.decide'
    | 'counterparty.approval_hierarchy.manage'
    | 'counterparty.approval.request.manage'
    | 'counterparty.purchase.submit';
  readonly counterpartyRef: CoreSearchResourceRef;
  readonly storefrontId: string | null;
  readonly scope: OperationalScope;
}): ActionBusinessPermissionTarget => ({
  permission: input.permission,
  target:
    input.storefrontId === null
      ? {
          counterpartyId: input.counterpartyRef.resourceId,
          kind: 'counterparty',
          legalEntityId: input.scope.legalEntityId ?? '',
          tenantId: input.scope.tenantId,
        }
      : {
          counterpartyId: input.counterpartyRef.resourceId,
          kind: 'counterparty_storefront',
          legalEntityId: input.scope.legalEntityId ?? '',
          storefrontId: input.storefrontId,
          tenantId: input.scope.tenantId,
        },
});

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
