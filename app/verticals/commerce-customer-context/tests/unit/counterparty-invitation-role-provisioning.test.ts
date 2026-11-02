import { expect, it } from 'effect-rstest';
import { invitationFixtureRoleRelationships } from '../support/counterparty-invitation-acceptance.ts';

const realm = {
  counterpartyPurchasingProfileId: '11111111-1111-4111-8111-111111111111',
  counterpartyResourceId: 'counterparty',
  inviterPrincipalId: '22222222-2222-4222-8222-222222222222',
  legalEntityId: '33333333-3333-4333-8333-333333333333',
  recipientAuthBindingId: '44444444-4444-4444-8444-444444444444',
  recipientPrincipalId: '55555555-5555-4555-8555-555555555555',
  storefrontAuthBindingId: '66666666-6666-4666-8666-666666666666',
  storefrontPrincipalId: '77777777-7777-4777-8777-777777777777',
  tenantId: '88888888-8888-4888-8888-888888888888',
};

it('provisions explicit scoped Action grants and memberships without action executor tuples', () => {
  const company = invitationFixtureRoleRelationships(
    realm.recipientPrincipalId,
    ['commerce.customer-context.claim-counterparty-access-invitation'],
    realm,
  );
  expect(company).toHaveLength(4);
  expect(
    company.filter(({ relation, resourceType }) => resourceType === 'action' && relation === 'company_scope'),
  ).toHaveLength(1);
  expect(
    company.filter(
      ({ relation, resourceType, subjectRelation }) =>
        resourceType === 'action_grant' && relation === 'role' && subjectRelation === 'member',
    ),
  ).toHaveLength(1);
  expect(
    company.filter(
      ({ relation, resourceType, subjectId }) =>
        resourceType === 'scoped_role' && relation === 'member' && subjectId === realm.recipientPrincipalId,
    ),
  ).toHaveLength(1);
  expect(company.some(({ relation, resourceType }) => resourceType === 'action' && relation === 'executor')).toBe(
    false,
  );
  const optional = invitationFixtureRoleRelationships(
    realm.storefrontPrincipalId,
    ['commerce.customer-context.start-portal-enrollment'],
    realm,
  );
  expect(optional).toHaveLength(8);
  expect(
    optional.filter(({ relation, resourceType }) => resourceType === 'action' && relation === 'tenant_scope'),
  ).toHaveLength(1);
  expect(
    optional.filter(({ relation, resourceType }) => resourceType === 'action' && relation === 'company_scope'),
  ).toHaveLength(1);
  expect(invitationFixtureRoleRelationships(realm.recipientPrincipalId, [], realm)).toEqual([]);
  expect(() => invitationFixtureRoleRelationships(realm.recipientPrincipalId, ['unknown.action'], realm)).toThrow();
});
