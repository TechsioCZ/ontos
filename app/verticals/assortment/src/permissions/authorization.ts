import {
  createOwnerPermissionAccessTarget,
  defineActionOwnerPermissions,
  defineReadOwnerPermission,
  ReadPermissionUnavailable,
} from '@app/core-runtime';
import type { OperationalScope, OwnerPermissionAccessTarget } from '@app/core-runtime';
import { Result, Schema } from 'effect';
import { assortmentAuthorizationContract } from '../../shared/permissions/authorization-contract.ts';
import { AssortmentPolicyTargetInvariant } from '../../shared/domain/policy-errors.ts';
import {
  AssortmentPermissionTargetSchema,
  assortmentPermissionTargetIsValid,
  assortmentPermissionTargetRequiresLegalEntity,
  toAssortmentPermissionAccessKey,
  toAssortmentPermissionAccessObjectId,
  toAssortmentPermissionAccessObjectIdForTargets,
} from './authorization-targets.ts';
import type { AssortmentPermissionAccessTarget } from './authorization-targets.ts';

const invalid = (): never => {
  throw new AssortmentPolicyTargetInvariant({ reason: 'The exact Assortment authorization target is invalid' });
};

export const assortmentOwnerPermissionTarget = (
  scope: OperationalScope,
  requested: AssortmentPermissionAccessTarget,
  transportObjectId?: string,
): OwnerPermissionAccessTarget => {
  const target = Result.getOrThrow(Schema.decodeUnknownResult(AssortmentPermissionTargetSchema)(requested));
  const storefront =
    target.kind === 'assortment_decision' ||
    (target.kind === 'assortment_binding' && target.mode === 'create') ||
    (target.kind === 'assortment_boundary' && target.mode === 'create')
      ? target.commercialScope.storefront
      : undefined;
  // Meaning validation stays with the owner; Core independently verifies the required Storefront.
  const validationScope = storefront === undefined ? scope : { ...scope, trustedStorefrontId: storefront.resourceId };
  if (!assortmentPermissionTargetIsValid(target, validationScope)) {
    return invalid();
  }
  const definition = assortmentAuthorizationContract.permissions.find((entry) => entry.key === target.permission);
  const key = toAssortmentPermissionAccessKey(scope.tenantId, scope.legalEntityId, target);
  const objectId = toAssortmentPermissionAccessObjectId(scope.tenantId, scope.legalEntityId, target);
  if (definition === undefined || key === undefined || objectId === undefined) {
    return invalid();
  }
  const targetScope = assortmentPermissionTargetRequiresLegalEntity(target)
    ? { kind: 'legal_entity' as const, legalEntityId: scope.legalEntityId ?? '', tenantId: scope.tenantId }
    : { kind: 'tenant' as const, tenantId: scope.tenantId };
  const base = {
    definition,
    key,
    objectId,
    scope: targetScope,
    scopeKind: target.kind,
    target: Object.freeze(target),
    transportModuleKey: target.kind,
    transportObjectId: transportObjectId ?? objectId,
  };
  return createOwnerPermissionAccessTarget(
    assortmentAuthorizationContract,
    storefront === undefined ? base : { ...base, requiredStorefrontId: storefront.resourceId },
  );
};

export const defineAssortmentActionPermissions = <Payload>(
  resolver: (payload: Payload, scope: OperationalScope) => readonly AssortmentPermissionAccessTarget[],
) =>
  defineActionOwnerPermissions(assortmentAuthorizationContract, (payload: Payload, scope) => {
    const targets = resolver(payload, scope);
    const transportObjectId =
      targets.length === 1 && targets[0] !== undefined
        ? toAssortmentPermissionAccessObjectId(scope.tenantId, scope.legalEntityId, targets[0])
        : toAssortmentPermissionAccessObjectIdForTargets(scope.tenantId, scope.legalEntityId, targets);
    if (transportObjectId === undefined) {
      return invalid();
    }
    return Object.freeze(
      targets.map((target) =>
        Object.freeze({
          ...assortmentOwnerPermissionTarget(scope, target, transportObjectId),
          transportModuleKey: 'commerce.assortment',
        }),
      ),
    );
  });

export const defineAssortmentReadPermission = <Input>(
  resolver: (input: Input, scope: OperationalScope) => AssortmentPermissionAccessTarget,
) =>
  defineReadOwnerPermission(assortmentAuthorizationContract, (input: Input, scope) => {
    const target = Result.getOrThrow(
      Schema.decodeUnknownResult(AssortmentPermissionTargetSchema)(resolver(input, scope)),
    );
    const storefront =
      target.kind === 'assortment_decision' ||
      (target.kind === 'assortment_binding' && target.mode === 'create') ||
      (target.kind === 'assortment_boundary' && target.mode === 'create')
        ? target.commercialScope.storefront
        : undefined;
    const validationScope = storefront === undefined ? scope : { ...scope, trustedStorefrontId: storefront.resourceId };
    if (!assortmentPermissionTargetIsValid(target, validationScope)) {
      return invalid();
    }
    if (assortmentPermissionTargetRequiresLegalEntity(target) && scope.legalEntityId === undefined) {
      throw new ReadPermissionUnavailable({
        code: 'read_permission_unavailable',
        reason: 'The owner permission requires a selected Legal Entity',
      });
    }
    return assortmentOwnerPermissionTarget(scope, target);
  });
