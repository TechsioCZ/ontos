import { expect, it } from 'effect-rstest';

import {
  counterpartyContextEvidenceIsSufficient,
  roleEvidenceIsSufficient,
  roleEndEvidenceIsSufficient,
  rolePeriodIsCurrentAt,
  rolePeriodStorageStateAt,
  rolePeriodsOverlap,
} from '../../shared/domain/counterparty-role-period.ts';

it('requires evidence that establishes a commercial context rather than mere discovery', () => {
  for (const method of ['ENGAGEMENT_LEAD', 'SEARCH_RESULT', 'TECHNICAL_REFERENCE']) {
    expect(counterpartyContextEvidenceIsSufficient(method)).toBe(false);
  }
  for (const method of ['SIGNED_CONTRACT', 'APPROVED_COMMERCIAL_RELATIONSHIP', 'BINDING_ORDER']) {
    expect(counterpartyContextEvidenceIsSufficient(method)).toBe(true);
  }
});

it('applies CUSTOMER and SUPPLIER evidence thresholds without waiting for first completion', () => {
  expect(roleEvidenceIsSufficient('CUSTOMER', 'ENGAGEMENT_PROSPECT')).toBe(false);
  expect(roleEvidenceIsSufficient('CUSTOMER', 'BINDING_ORDER')).toBe(true);
  expect(roleEvidenceIsSufficient('CUSTOMER', 'APPROVED_PURCHASING_RELATIONSHIP')).toBe(true);
  expect(roleEvidenceIsSufficient('SUPPLIER', 'VENDOR_CANDIDATE')).toBe(false);
  expect(roleEvidenceIsSufficient('SUPPLIER', 'COMPLETED_VENDOR_ONBOARDING')).toBe(true);
  expect(roleEvidenceIsSufficient('SUPPLIER', 'BINDING_PURCHASE_ORDER')).toBe(true);
});

it('requires explicit relationship-end evidence and rejects operational inactivity', () => {
  expect(roleEndEvidenceIsSufficient('CUSTOMER', 'ENGAGEMENT_INACTIVITY')).toBe(false);
  expect(roleEndEvidenceIsSufficient('CUSTOMER', 'TRANSACTION_INACTIVITY')).toBe(false);
  expect(roleEndEvidenceIsSufficient('CUSTOMER', 'CONFIRMED_CUSTOMER_RELATIONSHIP_END')).toBe(true);
  expect(roleEndEvidenceIsSufficient('SUPPLIER', 'TEMPORARY_PROCUREMENT_BLOCK')).toBe(false);
  expect(roleEndEvidenceIsSufficient('SUPPLIER', 'PURCHASE_SUSPENSION')).toBe(false);
  expect(roleEndEvidenceIsSufficient('SUPPLIER', 'CONFIRMED_SUPPLIER_RELATIONSHIP_END')).toBe(true);
});

it('derives current role state from lifecycle and effective time', () => {
  const active = {
    state: 'ACTIVE' as const,
    validFrom: '2026-01-01T00:00:00.000Z',
    validTo: '2027-01-01T00:00:00.000Z',
  };
  expect(rolePeriodIsCurrentAt(active, '2025-12-31T23:59:59.000Z')).toBe(false);
  expect(rolePeriodIsCurrentAt(active, '2026-06-01T00:00:00.000Z')).toBe(true);
  expect(rolePeriodIsCurrentAt(active, '2027-01-01T00:00:00.000Z')).toBe(false);
  expect(
    rolePeriodIsCurrentAt(
      {
        state: 'ACTIVE',
        validFrom: '2027-01-01T00:00:00.000Z',
        validTo: null,
      },
      '2026-06-01T00:00:00.000Z',
    ),
  ).toBe(false);
  expect(rolePeriodIsCurrentAt({ ...active, state: 'ENDED' }, '2026-06-01T00:00:00.000Z')).toBe(false);
});

it('stores future, current, future-ended, and historical periods by their interval', () => {
  expect(
    rolePeriodStorageStateAt({ validFrom: '2027-01-01T00:00:00.000Z', validTo: null }, '2026-06-01T00:00:00.000Z'),
  ).toEqual({ isCurrent: false, state: 'ACTIVE' });
  expect(
    rolePeriodStorageStateAt(
      {
        validFrom: '2026-01-01T00:00:00.000Z',
        validTo: '2027-01-01T00:00:00.000Z',
      },
      '2026-06-01T00:00:00.000Z',
    ),
  ).toEqual({ isCurrent: true, state: 'ACTIVE' });
  expect(
    rolePeriodStorageStateAt(
      {
        validFrom: '2026-01-01T00:00:00.000Z',
        validTo: '2027-01-01T00:00:00.000Z',
      },
      '2027-01-01T00:00:00.000Z',
    ),
  ).toEqual({ isCurrent: false, state: 'ENDED' });
});

it('rejects overlapping periods of the same role while allowing adjacent reactivation', () => {
  const historical = {
    validFrom: '2025-01-01T00:00:00.000Z',
    validTo: '2026-01-01T00:00:00.000Z',
  };
  expect(
    rolePeriodsOverlap(historical, {
      validFrom: '2025-12-01T00:00:00.000Z',
      validTo: null,
    }),
  ).toBe(true);
  expect(
    rolePeriodsOverlap(historical, {
      validFrom: '2026-01-01T00:00:00.000Z',
      validTo: null,
    }),
  ).toBe(false);
});
