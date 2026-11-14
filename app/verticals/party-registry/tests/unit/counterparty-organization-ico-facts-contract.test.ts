import { Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import {
  CounterpartyOrganizationIcoFactsRequestSchema,
  CounterpartyOrganizationIcoFactsResponseSchema,
} from '../../shared/apis/counterparty-organization-ico-facts.ts';

const tenantId = 'dfb10000-0000-4000-8000-000000000001';
const resourceId = 'dfb20000-0000-4000-8000-000000000001';
const counterpartyRef = {
  moduleId: 'party.registry',
  resourceType: 'party.registry.counterparty',
  resourceId,
  tenantId,
};

it('requires the exact known Counterparty reference without inventing a source locator', () => {
  expect(Schema.decodeUnknownSync(CounterpartyOrganizationIcoFactsRequestSchema)({ counterpartyRef })).toEqual({
    counterpartyRef,
  });
  expect(() =>
    Schema.decodeUnknownSync(CounterpartyOrganizationIcoFactsRequestSchema)({ recordId: resourceId }),
  ).toThrow();
});

it('returns only current organization/customer identity and actual opaque owner row revisions', () => {
  const current = {
    outcome: 'CURRENT_ORGANIZATION_CUSTOMER',
    counterpartyRef,
    partyRef: { ...counterpartyRef, resourceType: 'party.registry.party' },
    legalEntityRef: { moduleId: 'core.identity', resourceType: 'core.identity.legal-entity', resourceId, tenantId },
    partyRevision: 7,
    counterpartyRevision: 'a'.repeat(64),
    currentCustomerRoleRef: { ...counterpartyRef, resourceType: 'party.registry.counterparty-role-period' },
    currentCustomerRoleRevision: 'b'.repeat(64),
  };
  expect(Schema.decodeUnknownSync(CounterpartyOrganizationIcoFactsResponseSchema)(current)).toEqual(current);
  expect(() =>
    Schema.decodeUnknownSync(CounterpartyOrganizationIcoFactsResponseSchema)({ ...current, counterpartyRevision: 1 }),
  ).toThrow();
  expect(() =>
    Schema.decodeUnknownSync(CounterpartyOrganizationIcoFactsResponseSchema)({
      ...current,
      currentCustomerRoleRef: null,
    }),
  ).toThrow();
  expect(
    Schema.decodeUnknownSync(CounterpartyOrganizationIcoFactsResponseSchema)({
      outcome: 'NOT_CURRENT_ORGANIZATION_CUSTOMER',
    }),
  ).toEqual({ outcome: 'NOT_CURRENT_ORGANIZATION_CUSTOMER' });
});
