import { expect, it } from 'effect-rstest';
import { invitationAdministratorRoleInput } from '../support/counterparty-invitation-acceptance.ts';

const realm = {
  counterpartyPurchasingProfileId: '11111111-1111-4111-8111-111111111111',
  counterpartyResourceId: 'counterparty',
  inviterAuthBindingId: '99999999-9999-4999-8999-999999999999',
  inviterPrincipalId: '22222222-2222-4222-8222-222222222222',
  legalEntityId: '33333333-3333-4333-8333-333333333333',
  recipientAuthBindingId: '44444444-4444-4444-8444-444444444444',
  recipientPrincipalId: '55555555-5555-4555-8555-555555555555',
  storefrontAuthBindingId: '66666666-6666-4666-8666-666666666666',
  storefrontPrincipalId: '77777777-7777-4777-8777-777777777777',
  tenantId: '88888888-8888-4888-8888-888888888888',
};

it('provisions only the current administrator capability keys in the selected company and tenant', () => {
  expect(invitationAdministratorRoleInput(realm)).toEqual({
    holders: [
      {
        capabilityKeys: [
          'commerce.customer-context.counterparty-commerce-access.grant',
          'commerce.customer-context.counterparty-commerce-access.revoke',
        ],
        principalId: realm.inviterPrincipalId,
      },
    ],
    legalEntityIds: [realm.legalEntityId],
    tenantId: realm.tenantId,
  });
  const changed = invitationAdministratorRoleInput({
    ...realm,
    legalEntityId: 'other-company',
    tenantId: 'other-tenant',
  });
  expect(changed.legalEntityIds).toEqual(['other-company']);
  expect(changed.tenantId).toBe('other-tenant');
  expect(changed.holders.map(({ principalId }) => principalId)).not.toContain(realm.recipientPrincipalId);
  expect(changed.holders.map(({ principalId }) => principalId)).not.toContain(realm.storefrontPrincipalId);
});
