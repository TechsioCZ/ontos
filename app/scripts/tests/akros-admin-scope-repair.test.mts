import { v1 } from '@authzed/authzed-node';
import { Effect, Result } from 'effect';
import { expect, it } from 'effect-rstest';

import { akrosAdminScope, prepareAkrosAdminScopeRepair } from '../demo/akros-admin-scope-repair.mts';
import { akrosPlaygroundRelationships } from '../demo/akros-playground-policy.mts';
import {
  buildScopedRoleMembershipUpdates,
  toScopedRoleObjectId,
} from '../../packages/core-runtime/src/permissions/scoped-role.ts';

const evidence = Effect.gen(function* exactBeforeEvidence() {
  const companyRows = akrosPlaygroundRelationships([]).filter(
    (row) =>
      row.subject?.object?.objectType === 'principal' && row.subject.object.objectId === akrosAdminScope.principalId,
  );
  const tenantRole = yield* buildScopedRoleMembershipUpdates({
    operation: 'assign',
    principal: akrosAdminScope,
    role: { roleKey: 'superadmin', tenantId: akrosAdminScope.tenantId },
  });
  return {
    companyIds: [akrosAdminScope.legalEntityId],
    relationships: [...companyRows, ...tenantRole.flatMap((update) => update.relationship ?? [])].filter(
      (row) => row.subject?.object?.objectType === 'principal',
    ),
    session: akrosAdminScope,
    tenantIds: [akrosAdminScope.tenantId],
  };
});

it.effect('prepares one governed revoke and one exact DELETE, without changing the shared role or company', () =>
  Effect.gen(function* preparesSinglePrincipalRevoke() {
    const before = yield* evidence;
    const plan = yield* prepareAkrosAdminScopeRepair(before);
    expect(plan.request.path).toBe('/shell-super-app-api/auth/identity/people/tenant-role');
    expect(plan.request.payload.operation).toBe('revoke');
    expect(plan.request.payload.principalRef).toEqual({
      principalId: akrosAdminScope.principalId,
      tenantId: akrosAdminScope.tenantId,
    });
    expect(plan.expectedUpdates).toHaveLength(1);
    const [update] = plan.expectedUpdates;
    expect(update?.operation).toBe(v1.RelationshipUpdate_Operation.DELETE);
    expect(update?.relationship?.resource).toEqual({
      objectId: toScopedRoleObjectId({ roleKey: 'superadmin', tenantId: akrosAdminScope.tenantId }),
      objectType: 'scoped_role',
    });
    expect(update?.relationship?.subject?.object?.objectId).toBe(akrosAdminScope.principalId);
    expect(update?.relationship?.relation).toBe('member');
    expect((yield* prepareAkrosAdminScopeRepair(before)).idempotencyKey).toBe(plan.idempotencyKey);
  }),
);

it.effect('fails closed for missing company admission, unexpected authority, and a foreign session', () =>
  Effect.gen(function* rejectsUnprovedRepairScope() {
    const before = yield* evidence;
    const changed = [
      { ...before, relationships: before.relationships.filter((row) => row.resource?.objectType !== 'legal_entity') },
      { ...before, relationships: [...before.relationships, ...before.relationships] },
      { ...before, session: { ...before.session, email: 'eshop@akros.playground' } },
      { ...before, companyIds: [...before.companyIds, '71000000-0000-4000-8000-000000000024'] },
      { ...before, tenantIds: ['70000000-0000-4000-8000-000000000020'] },
    ];
    for (const input of changed) {
      expect(Result.isFailure(yield* Effect.result(prepareAkrosAdminScopeRepair(input)))).toBe(true);
    }
  }),
);
