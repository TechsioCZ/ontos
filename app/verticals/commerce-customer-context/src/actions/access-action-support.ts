import type {
  ActionBusinessPermissionTarget,
  ActionHandlerContext,
  DomainEventContractMap,
  OperationalScope,
  TrustedPrincipalContext,
} from '@app/core-runtime';
import { Effect } from 'effect';
import type {
  AccessDeniedAuditEvidence,
  AccessAuditEvidence,
  CounterpartyAccessGrant,
  CounterpartyPermissionScope,
  CounterpartyRef,
  PrincipalRef,
} from '../../shared/domain/access-contract.ts';
import type { AccessAuthorizationMutationEvidence } from '../../shared/domain/access-authorization-mutation.ts';
import { CounterpartyAccessContractViolation } from '../../shared/domain/access-port.ts';
import { permissionAllowsScope, permissionDescriptor } from '../../shared/domain/permission-catalog.ts';
import type { CounterpartyPermissionCode } from '../../shared/domain/permission-catalog.ts';
import type { CounterpartyAccessInvitationRef } from '../../shared/resources/counterparty-access-invitation.ts';

export const principalRefFromContext = (context: TrustedPrincipalContext): PrincipalRef => ({
  principalId: context.principalId,
  tenantId: context.tenantId,
});

export const accessAuthorizationMutationEventPayload = <
  const Operation extends AccessAuthorizationMutationEvidence['operation'],
>(
  grant: CounterpartyAccessGrant,
  reconciliation: AccessAuthorizationMutationEvidence & { readonly operation: Operation },
  legalEntityId: string,
) => ({
  catalogVersion: grant.catalogVersion,
  counterpartyRef: grant.counterpartyRef,
  grantRef: grant.grantRef,
  legalEntityId,
  mutationId: reconciliation.mutationId,
  operation: reconciliation.operation,
  schemaVersion: '1' as const,
});

export const requireAccessLegalEntity = (
  scope: OperationalScope,
): Effect.Effect<string, CounterpartyAccessContractViolation> =>
  scope.legalEntityId === undefined
    ? Effect.fail(
        new CounterpartyAccessContractViolation({
          code: 'administrative_scope_exceeded',
          reason: 'Counterparty Commerce Access requires a trusted Legal Entity scope',
        }),
      )
    : Effect.succeed(scope.legalEntityId);

export const requireAccessScope = (input: {
  readonly counterpartyRef: CounterpartyRef;
  readonly permission: CounterpartyPermissionCode;
  readonly principalRefs: readonly PrincipalRef[];
  readonly reason?: string | undefined;
  readonly requireCustomerDelegable: boolean;
  readonly scope: CounterpartyPermissionScope;
  readonly tenantId: string;
}): Effect.Effect<void, CounterpartyAccessContractViolation> => {
  if (input.counterpartyRef.tenantId !== input.tenantId) {
    return Effect.fail(
      new CounterpartyAccessContractViolation({
        code: 'counterparty_scope_mismatch',
        reason: 'The Counterparty must belong to the trusted Tenant',
      }),
    );
  }
  if (input.principalRefs.some(({ tenantId }) => tenantId !== input.tenantId)) {
    return Effect.fail(
      new CounterpartyAccessContractViolation({
        code: 'principal_scope_mismatch',
        reason: 'Every Principal must belong to the trusted Tenant',
      }),
    );
  }
  const metadata = permissionDescriptor(input.permission);
  if (input.requireCustomerDelegable && !metadata.customerDelegable) {
    return Effect.fail(
      new CounterpartyAccessContractViolation({
        code: 'permission_not_delegable',
        reason: 'The requested permission is not customer-delegable',
      }),
    );
  }
  if (!permissionAllowsScope(input.permission, input.scope.kind)) {
    return Effect.fail(
      new CounterpartyAccessContractViolation({
        code: 'permission_scope_not_allowed',
        reason: 'The requested permission does not support this scope',
      }),
    );
  }
  if (metadata.reasonRequired && input.reason === undefined) {
    return Effect.fail(
      new CounterpartyAccessContractViolation({
        code: 'reason_required',
        reason: 'This permission change requires a reason',
      }),
    );
  }
  return Effect.void;
};

export const accessManagementPermissionTarget = (
  payload: {
    readonly counterpartyRef: CounterpartyRef;
    readonly scope: CounterpartyPermissionScope;
  },
  operationalScope: OperationalScope,
): ActionBusinessPermissionTarget => {
  if (payload.scope.kind === 'counterparty') {
    return {
      permission: 'counterparty.access.manage',
      target: {
        counterpartyId: payload.counterpartyRef.resourceId,
        kind: 'counterparty',
        legalEntityId: operationalScope.legalEntityId ?? '',
        tenantId: operationalScope.tenantId,
      },
    };
  }
  const target: ActionBusinessPermissionTarget = {
    permission: 'counterparty.access.manage',
    target: {
      counterpartyId: payload.counterpartyRef.resourceId,
      kind: 'counterparty_storefront',
      legalEntityId: operationalScope.legalEntityId ?? '',
      storefrontId: payload.scope.storefrontKey,
      tenantId: operationalScope.tenantId,
    },
  };
  if (operationalScope.trustedStorefrontId === undefined) {
    return target;
  }
  return { ...target, trustedStorefrontId: operationalScope.trustedStorefrontId };
};

export const auditEvidence = (input: {
  readonly actor: PrincipalRef;
  readonly claimAttestationReference?: string | undefined;
  readonly counterpartyRef: CounterpartyRef;
  readonly invitationRef?: CounterpartyAccessInvitationRef | undefined;
  readonly outcome: string;
  readonly permission?: CounterpartyPermissionCode;
  readonly reason?: string | undefined;
  readonly scope: CounterpartyPermissionScope;
  readonly target?: PrincipalRef | undefined;
}): AccessAuditEvidence => {
  let evidence: AccessAuditEvidence = {
    actorPrincipalId: input.actor.principalId,
    counterpartyId: input.counterpartyRef.resourceId,
    outcome: input.outcome,
    scopeKind: input.scope.kind,
  };
  if (input.claimAttestationReference !== undefined) {
    evidence = { ...evidence, claimAttestationReference: input.claimAttestationReference };
  }
  if (input.invitationRef !== undefined) {
    evidence = { ...evidence, invitationId: input.invitationRef.resourceId };
  }
  if (input.permission !== undefined) {
    evidence = { ...evidence, permission: input.permission };
  }
  if (input.reason !== undefined) {
    evidence = { ...evidence, reason: input.reason };
  }
  if (input.scope.kind === 'storefront') {
    evidence = { ...evidence, storefrontKey: input.scope.storefrontKey };
  }
  if (input.target !== undefined) {
    evidence = { ...evidence, targetPrincipalId: input.target.principalId };
  }
  return evidence;
};

/**
 * Build the minimal denial evidence shared by access-management Actions. The extractor is called
 * before Core authorization and therefore may only use decoded payload plus trusted scope. It
 * deliberately records recipient identity or delivery method, never a delivery reference or
 * invitation proof.
 */
export const deniedAccessAuditEvidence = (input: {
  readonly actor: PrincipalRef;
  readonly counterpartyRef: CounterpartyRef;
  readonly invitationId?: string | undefined;
  readonly operation: AccessDeniedAuditEvidence['operation'];
  readonly permission?: CounterpartyPermissionCode;
  readonly recipient:
    | Readonly<{ readonly kind: 'principal'; readonly principalId: string }>
    | Readonly<{ readonly invitationId: string; readonly kind: 'invitation' }>
    | Readonly<{
        readonly deliveryMethod: 'VERIFIED_CONTACT_POINT' | 'APPROVED_RECIPIENT_DISCOVERY';
        readonly kind: 'delivery';
      }>;
  readonly requestedPermissions?: readonly CounterpartyPermissionCode[];
  readonly requestedScope: CounterpartyPermissionScope;
}): AccessDeniedAuditEvidence => {
  let evidence: AccessDeniedAuditEvidence = {
    actorPrincipalId: input.actor.principalId,
    counterpartyId: input.counterpartyRef.resourceId,
    operation: input.operation,
    recipient: input.recipient,
    requestedScope: input.requestedScope,
  };
  if (input.invitationId !== undefined) {
    evidence = { ...evidence, invitationId: input.invitationId };
  }
  if (input.permission !== undefined) {
    evidence = { ...evidence, permission: input.permission };
  }
  if (input.requestedPermissions !== undefined) {
    evidence = { ...evidence, requestedPermissions: input.requestedPermissions };
  }
  return evidence;
};

export const recordAccessRead = <Events extends DomainEventContractMap, Services>(
  context: ActionHandlerContext<Events, Services>,
  counterpartyRef: CounterpartyRef,
  purpose: string,
) =>
  context.recordDataAccess({
    accessKind: 'read',
    queryHash: `${purpose}:${counterpartyRef.resourceId}`,
    resultCount: 1,
    servingModuleKey: 'commerce.customer-context',
    targetModuleKey: counterpartyRef.moduleId,
    targetResourceId: counterpartyRef.resourceId,
    targetResourceType: counterpartyRef.resourceType,
  });
