import { Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import {
  CustomerPriceGroupAssignmentSchema,
  PriceGroupCompatibilityEvidenceSchema,
} from '../../shared/domain/price-group-contracts.ts';

const tenantId = '91000000-0000-4000-8000-000000000001';
const priceGroupRef = {
  moduleId: 'pricing.catalog',
  resourceId: 'contract-pricing',
  resourceType: 'pricing.catalog.price-group',
  tenantId,
} as const;
const compatibility = {
  catalogRevision: 7,
  definitionEffectivePeriod: {
    effectiveFrom: '2026-09-01T00:00:00.000Z',
    effectiveTo: null,
  },
  definitionRevisionId: '92000000-0000-4000-8000-000000000001',
  definitionRevisionNumber: 4,
  meaningFingerprint: 'a'.repeat(64),
  priceGroupRef,
  requiredContract: {
    contractId: 'commerce.customer-price-group-assignment.v1',
    version: 1,
  },
  trustedOperationAt: '2026-09-09T10:00:00.000Z',
  verifiedAt: '2026-09-09T10:00:01.000Z',
} as const;
const legacyAssignment = {
  assignmentRef: {
    moduleId: 'commerce.customer-context',
    resourceId: '93000000-0000-4000-8000-000000000001',
    resourceType: 'commerce.customer-context.customer-price-group-assignment',
    tenantId,
  },
  effectiveFrom: compatibility.trustedOperationAt,
  effectiveTo: null,
  priceGroupRef,
  profile: {
    kind: 'RETAIL',
    moduleId: 'commerce.customer-context',
    resourceId: '94000000-0000-4000-8000-000000000001',
    resourceType: 'commerce.customer-context.retail-customer-profile',
    tenantId,
  },
  reason: 'Legacy accepted assignment',
  recordedAt: '2026-09-09T09:00:00.000Z',
  revision: 1,
  state: 'ACTIVE',
} as const;

it('accepts exact canonical evidence and preserves legacy assignments by omission', () => {
  expect(Schema.is(PriceGroupCompatibilityEvidenceSchema)(compatibility)).toBe(true);
  expect(Schema.decodeUnknownSync(CustomerPriceGroupAssignmentSchema)(legacyAssignment).compatibility).toBeUndefined();
  expect(
    Schema.decodeUnknownSync(CustomerPriceGroupAssignmentSchema)({ ...legacyAssignment, compatibility }).compatibility,
  ).toEqual(compatibility);
});

it('rejects legacy numeric identity as canonical evidence and mismatched Price Group references', () => {
  expect(
    Schema.is(PriceGroupCompatibilityEvidenceSchema)({
      catalogRevision: 7,
      contractId: 'commerce.customer-price-group-assignment.v1',
      contractRevision: 1,
      definitionRevision: 4,
    }),
  ).toBe(false);
  expect(
    Schema.is(CustomerPriceGroupAssignmentSchema)({
      ...legacyAssignment,
      compatibility: {
        ...compatibility,
        priceGroupRef: { ...priceGroupRef, resourceId: 'different-price-group' },
      },
    }),
  ).toBe(false);
});
