import { Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import {
  ApplyCustomerGroupMembershipSourcePayloadSchema,
  ApplyCustomerGroupMembershipSourceResultSchema,
} from '../../shared/actions/apply-customer-group-membership-source.ts';
import { CustomerGroupMembershipSourceReceiptRequestSchema } from '../../shared/apis/customer-group-membership-source-receipt.ts';
import {
  OrganizationMembershipSourcePayloadSchema,
  OrganizationMembershipSourceResultSchema,
} from '../../shared/domain/organization-membership-source.ts';

const tenantId = '10000000-0000-4000-8000-000000000001';
const profile = {
  profileKind: 'COUNTERPARTY',
  profileRef: {
    moduleId: 'commerce.customer-context',
    resourceId: '20000000-0000-4000-8000-000000000001',
    resourceType: 'commerce.customer-context.counterparty-purchasing-profile',
    tenantId,
  },
};
const groupRef = {
  moduleId: 'commerce.customer-context',
  resourceId: '30000000-0000-4000-8000-000000000001',
  resourceType: 'commerce.customer-context.customer-group',
  tenantId,
};
const membershipRef = {
  ...groupRef,
  resourceId: '40000000-0000-4000-8000-000000000001',
  resourceType: 'commerce.customer-context.customer-group-membership',
};
const source = { assertionId: 'organization-1', effectId: 'organization-1', order: 1, sourceRecordId: 'company-1' };
const command = {
  effectiveAt: '2026-11-07T10:00:00.000Z',
  groupRef,
  manager: {
    factFamily: 'CUSTOMER_GROUP_MEMBERSHIP',
    issuer: 'internal-source',
    sourceNamespace: 'membership',
    tenantId,
  },
  operation: 'ASSIGN',
  processingKind: 'ORG_BUSINESS_REFERENCE',
  profile,
  reasonCode: 'SOURCE_MEMBERSHIP_ASSERTED',
  route: { id: 'internal-company-membership', revision: '1' },
  source,
};
const membership = {
  assignedAt: command.effectiveAt,
  effectiveFrom: command.effectiveAt,
  effectiveTo: null,
  groupRef,
  membershipRef,
  profile,
  removal: null,
  revision: 1,
  state: 'VALID',
};
const result = {
  items: [{ membership, outcome: 'ASSIGNED' }],
  processingKind: 'ORG_BUSINESS_REFERENCE',
  reasonCode: command.reasonCode,
  source,
};

it('requires an explicit organization class and exact operation-specific reason code', () => {
  const { processingKind: _processingKind, ...withoutKind } = command;
  const { reasonCode: _reasonCode, ...withoutCode } = command;
  expect(Schema.is(OrganizationMembershipSourcePayloadSchema)(command)).toBe(true);
  expect(Schema.is(ApplyCustomerGroupMembershipSourcePayloadSchema)(command)).toBe(true);
  for (const invalid of [
    withoutKind,
    withoutCode,
    { ...command, reasonCode: 'SOURCE_MEMBERSHIP_WITHDRAWN' },
    { ...command, reason: 'Arbitrary source notes must never enter the organization branch' },
    { ...command, profile: { ...profile, profileKind: 'RETAIL' } },
  ]) {
    expect(Schema.is(ApplyCustomerGroupMembershipSourcePayloadSchema)(invalid)).toBe(false);
  }
});

it('retains the personal reason-bearing contract while rejecting its organization exemption', () => {
  const { processingKind: _processingKind, reasonCode: _reasonCode, ...personalCommand } = command;
  expect(
    Schema.is(ApplyCustomerGroupMembershipSourcePayloadSchema)({
      ...personalCommand,
      reason: 'Explicit personal path',
    }),
  ).toBe(true);
  expect(
    Schema.is(ApplyCustomerGroupMembershipSourcePayloadSchema)({ ...command, reason: 'Forbidden mixed class' }),
  ).toBe(false);
});

it('admits only the safe organization receipt projection and rejects reason-bearing membership facts', () => {
  expect(Schema.is(OrganizationMembershipSourceResultSchema)(result)).toBe(true);
  expect(Schema.decodeUnknownSync(ApplyCustomerGroupMembershipSourceResultSchema)(result)).toEqual(result);
  expect(
    Schema.is(OrganizationMembershipSourceResultSchema)({
      ...result,
      items: [{ membership: { ...membership, assignmentReason: 'Private assignment notes' }, outcome: 'ASSIGNED' }],
    }),
  ).toBe(false);
  expect(
    Schema.is(ApplyCustomerGroupMembershipSourceResultSchema)({
      ...result,
      items: [
        {
          membership: { ...membership, assignmentReason: 'Must not fall through to the personal result codec' },
          outcome: 'ASSIGNED',
        },
      ],
    }),
  ).toBe(false);
  expect(
    Schema.is(OrganizationMembershipSourceResultSchema)({
      ...result,
      items: [
        {
          membership: {
            ...membership,
            removal: {
              effectiveAt: command.effectiveAt,
              kind: 'EXPLICIT_END',
              reason: 'Private removal notes',
              recordedAt: command.effectiveAt,
            },
          },
          outcome: 'ENDED',
        },
      ],
    }),
  ).toBe(false);
});

it('preserves explicit organization processing class on historical receipt requests', () => {
  const request = {
    effectId: source.effectId,
    manager: command.manager,
    processingKind: command.processingKind,
    profile,
    route: command.route,
  };
  expect(Schema.decodeUnknownSync(CustomerGroupMembershipSourceReceiptRequestSchema)(request)).toEqual(request);
  expect(
    Schema.is(CustomerGroupMembershipSourceReceiptRequestSchema)({
      ...request,
      profile: { ...profile, profileKind: 'RETAIL' },
    }),
  ).toBe(false);
});
