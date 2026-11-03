import { createHash } from 'node:crypto';

import type { v1 } from '@authzed/authzed-node';
import { Effect, Schema } from 'effect';

import { SetPeopleRoleRequestSchema } from '../../apps/shell-super-app/shared/people-api.ts';
import type { SetPeopleRoleRequest } from '../../apps/shell-super-app/shared/people-api.ts';
import { toLegalEntityAccessObjectId } from '../../packages/core-runtime/src/permissions/context-access.ts';
import {
  buildScopedRoleMembershipUpdates,
  toScopedRoleObjectId,
} from '../../packages/core-runtime/src/permissions/scoped-role.ts';
import {
  akrosPlaygroundAccounts,
  akrosPlaygroundLegalEntityId,
  akrosPlaygroundTenantId,
} from './akros-playground-policy.mts';

const [administrator] = akrosPlaygroundAccounts;
export const akrosAdminScope = {
  email: administrator.email,
  legalEntityId: akrosPlaygroundLegalEntityId,
  principalId: administrator.principalId,
  tenantId: akrosPlaygroundTenantId,
} as const;

export class AkrosAdminScopeRepairInvalid extends Schema.TaggedError<AkrosAdminScopeRepairInvalid>()(
  'AkrosAdminScopeRepairInvalid',
  { reason: Schema.String },
) {}

interface ScopeEvidence {
  readonly companyIds: readonly string[];
  readonly relationships: readonly v1.Relationship[];
  readonly session: typeof akrosAdminScope;
  readonly tenantIds: readonly string[];
}

const RequestSchema = Schema.Struct({
  method: Schema.Literal('POST'),
  path: Schema.Literal('/shell-super-app-api/auth/identity/people/tenant-role'),
  payload: SetPeopleRoleRequestSchema,
});

/** Prepare only. The coordinator must separately admit the public Action in a compatible native window. */
export const prepareAkrosAdminScopeRepair = (evidence: ScopeEvidence) =>
  Effect.gen(function* prepareExactAdminRevocation() {
    const { email, legalEntityId, principalId, tenantId } = akrosAdminScope;
    if (
      evidence.session.email !== email ||
      evidence.session.principalId !== principalId ||
      evidence.session.tenantId !== tenantId ||
      evidence.session.legalEntityId !== legalEntityId ||
      evidence.tenantIds.length !== 1 ||
      evidence.tenantIds[0] !== tenantId ||
      evidence.companyIds.length !== 1 ||
      evidence.companyIds[0] !== legalEntityId
    ) {
      return yield* new AkrosAdminScopeRepairInvalid({ reason: 'The exact independent AKROS session is required' });
    }
    const legalObjectId = toLegalEntityAccessObjectId(tenantId, legalEntityId);
    const roles = ['admin', 'administration'].map((roleKey) =>
      toScopedRoleObjectId({ legalEntityId, roleKey, tenantId }),
    );
    const tenantRole = toScopedRoleObjectId({ roleKey: 'superadmin', tenantId });
    const required = [
      { objectId: tenantId, objectType: 'tenant', relation: 'company_member' },
      { objectId: legalObjectId, objectType: 'legal_entity', relation: 'member' },
      ...[...roles, tenantRole].map((objectId) => ({ objectId, objectType: 'scoped_role', relation: 'member' })),
    ];
    const matches = (row: v1.Relationship, expected: (typeof required)[number]) =>
      row.resource?.objectType === expected.objectType &&
      row.resource.objectId === expected.objectId &&
      row.relation === expected.relation &&
      row.subject?.object?.objectType === 'principal' &&
      row.subject.object.objectId === principalId &&
      row.subject.optionalRelation === '' &&
      row.optionalCaveat === undefined &&
      row.optionalExpiresAt === undefined;
    if (
      evidence.relationships.length !== required.length ||
      required.some((expected) => evidence.relationships.filter((row) => matches(row, expected)).length !== 1)
    ) {
      return yield* new AkrosAdminScopeRepairInvalid({
        reason: 'Require exact native company admission and company roles, with no unexpected authority',
      });
    }
    const payload: SetPeopleRoleRequest = {
      operation: 'revoke',
      principalRef: { principalId, tenantId },
      reason: 'User item3: restrict AKROS administrator to its own company only',
      roleKey: 'superadmin',
    };
    // This is the same native builder used by the governed role projection, never a direct graph write.
    const expectedUpdates = yield* buildScopedRoleMembershipUpdates({
      operation: payload.operation,
      principal: payload.principalRef,
      role: { roleKey: payload.roleKey, tenantId },
    });
    const request = {
      method: 'POST' as const,
      path: '/shell-super-app-api/auth/identity/people/tenant-role' as const,
      payload,
    };
    const encoded = yield* Schema.encodeEffect(Schema.fromJsonString(RequestSchema))(request);
    const fingerprint = createHash('sha256').update(encoded).digest('hex');
    return {
      expectedUpdates,
      fingerprint,
      idempotencyKey: `akros-admin-company-only:${fingerprint}`,
      request,
    };
  });
