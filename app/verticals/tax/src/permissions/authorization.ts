import { createOwnerPermissionAccessTarget, defineActionOwnerPermissions } from '@app/core-runtime';
import type { OperationalScope } from '@app/core-runtime';
import { Result, Schema } from 'effect';
import { taxRuleAuthorizationContract } from '../../shared/permissions/authorization-contract.ts';
import { taxRuleManagePermission } from '../../shared/permissions/tax-rule-manage.ts';

const identifier = Schema.String.check(Schema.isMinLength(1));
const TaxAuthorizationTenantIdSchema = identifier.pipe(
  Schema.brand('TaxAuthorizationTenantId'),
  Schema.decodeTo(identifier),
);
const TaxAuthorizationLegalEntityIdSchema = identifier.pipe(
  Schema.brand('TaxAuthorizationLegalEntityId'),
  Schema.decodeTo(identifier),
);
const TaxRuleAuthorizationTargetSchema = Schema.Struct({
  kind: Schema.Literal('tax_selling_legal_entity'),
  legalEntityId: TaxAuthorizationLegalEntityIdSchema,
  tenantId: TaxAuthorizationTenantIdSchema,
});
const encodeGrantParts = Schema.encodeResult(Schema.fromJsonString(Schema.Array(Schema.String)));
const PermissionIdentitySchema = identifier.check(Schema.isMaxLength(1024));

/** The target is exactly the independently verified Selling Legal Entity, never a Tax jurisdiction or rule. */
export const taxRuleOwnerPermissionTarget = (scope: OperationalScope) => {
  const target = Result.getOrThrow(
    Schema.decodeUnknownResult(TaxRuleAuthorizationTargetSchema)({
      kind: 'tax_selling_legal_entity',
      legalEntityId: scope.legalEntityId ?? '',
      tenantId: scope.tenantId,
    }),
  );
  const parts = [taxRuleManagePermission.key, target.tenantId, target.legalEntityId, target.kind];
  const objectId = Result.getOrThrow(
    Schema.decodeUnknownResult(PermissionIdentitySchema)(
      `ctx_${Buffer.from(Result.getOrThrow(encodeGrantParts(parts)), 'utf-8').toString('base64url')}`,
    ),
  );
  return createOwnerPermissionAccessTarget(taxRuleAuthorizationContract, {
    definition: taxRuleManagePermission,
    key: parts.join(':'),
    objectId,
    scope: { kind: 'legal_entity', legalEntityId: target.legalEntityId, tenantId: target.tenantId },
    scopeKind: target.kind,
    target: Object.freeze(target),
    transportModuleKey: taxRuleAuthorizationContract.owningModuleKey,
    transportObjectId: target.legalEntityId,
    transportResourceType: `${target.kind}:${taxRuleManagePermission.key}`,
  });
};

export const defineTaxRuleActionPermissions = <Payload>() =>
  defineActionOwnerPermissions(taxRuleAuthorizationContract, (_payload: Payload, scope) => [
    taxRuleOwnerPermissionTarget(scope),
  ]);
