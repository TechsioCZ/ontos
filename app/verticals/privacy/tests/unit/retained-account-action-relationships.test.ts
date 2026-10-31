import { toLegalEntityAccessObjectId, toSpiceDbActionObjectId } from '@app/core-runtime';
import { Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { toSpiceDbActionGrantObjectId } from '../../../../packages/core-runtime/src/permissions/service.ts';
import { toScopedRoleObjectId } from '../../../../packages/core-runtime/src/permissions/scoped-role.ts';
import {
  buildRetainedConsentAccountActionRelationships,
  retainedConsentAccountActionKeys,
  RetainedConsentAccountTransportSchema,
} from '../support/privacy-retained-purpose-self-service-http.ts';

const accountScopeSchema = Schema.Struct({
  legalEntityId: RetainedConsentAccountTransportSchema.fields.legalEntityId,
  principalId: RetainedConsentAccountTransportSchema.fields.principalId,
  tenantId: RetainedConsentAccountTransportSchema.fields.tenantId,
});
const account = Schema.decodeSync(accountScopeSchema)({
  legalEntityId: '10000000-0000-4000-8000-000000000001',
  principalId: '10000000-0000-4000-8000-000000000002',
  tenantId: '10000000-0000-4000-8000-000000000003',
});

it('provisions only exact company Action links, role grants and the real account membership', () => {
  const relationships = buildRetainedConsentAccountActionRelationships(account);
  const roleId = toScopedRoleObjectId({ ...account, roleKey: `retained-consent-account:${account.principalId}` });
  expect(relationships).toHaveLength(retainedConsentAccountActionKeys.length * 3 + 1);
  expect(relationships.filter(({ resource }) => resource?.objectType === 'scoped_role')).toEqual([
    expect.objectContaining({
      relation: 'member',
      resource: { objectId: roleId, objectType: 'scoped_role' },
      subject: { object: { objectId: account.principalId, objectType: 'principal' }, optionalRelation: '' },
    }),
  ]);
  for (const actionKey of retainedConsentAccountActionKeys) {
    const scope = { actionKey, legalEntityId: account.legalEntityId, tenantId: account.tenantId };
    const actionId = toSpiceDbActionObjectId(scope);
    const grantId = toSpiceDbActionGrantObjectId(scope);
    expect(relationships).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          relation: 'company_scope',
          resource: { objectId: actionId, objectType: 'action' },
          subject: {
            object: {
              objectId: toLegalEntityAccessObjectId(account.tenantId, account.legalEntityId),
              objectType: 'legal_entity',
            },
            optionalRelation: '',
          },
        }),
        expect.objectContaining({
          relation: 'grant',
          resource: { objectId: actionId, objectType: 'action' },
          subject: { object: { objectId: grantId, objectType: 'action_grant' }, optionalRelation: '' },
        }),
        expect.objectContaining({
          relation: 'role',
          resource: { objectId: grantId, objectType: 'action_grant' },
          subject: { object: { objectId: roleId, objectType: 'scoped_role' }, optionalRelation: 'member' },
        }),
      ]),
    );
  }
  expect(
    relationships.some(({ relation }) =>
      ['executor', 'executor_role', 'tenant_scope', 'self_credentials', 'superadmin'].includes(relation),
    ),
  ).toBe(false);
});

it('does not share the account role across another principal, Tenant or Legal Entity', () => {
  const ownRelationships = buildRetainedConsentAccountActionRelationships(account);
  const ownMembership = ownRelationships.filter(({ resource }) => resource?.objectType === 'scoped_role');
  for (const changes of [
    { legalEntityId: '20000000-0000-4000-8000-000000000001' },
    { principalId: '20000000-0000-4000-8000-000000000002' },
    { tenantId: '20000000-0000-4000-8000-000000000003' },
  ]) {
    const other = Schema.decodeSync(accountScopeSchema)({ ...account, ...changes });
    const otherRelationships = buildRetainedConsentAccountActionRelationships(other);
    expect(otherRelationships.filter(({ resource }) => resource?.objectType === 'scoped_role')).not.toEqual(
      ownMembership,
    );
    expect(
      otherRelationships
        .filter(({ relation }) => relation === 'role')
        .every(({ subject }) => subject?.object?.objectId !== ownMembership[0]?.resource?.objectId),
    ).toBe(true);
  }
});
