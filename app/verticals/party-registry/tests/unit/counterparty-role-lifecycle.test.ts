import assert from 'node:assert/strict';
import test from 'node:test';
import {
  counterpartyContextEvidenceIsSufficient,
  roleEvidenceIsSufficient,
  roleEndEvidenceIsSufficient,
  rolePeriodIsCurrentAt,
  rolePeriodStorageStateAt,
  rolePeriodsOverlap,
} from '../../shared/domain/counterparty-role-period.ts';

test('requires evidence that establishes a commercial context rather than mere discovery', () => {
  for (const method of ['ENGAGEMENT_LEAD', 'SEARCH_RESULT', 'TECHNICAL_REFERENCE']) {
    assert.equal(counterpartyContextEvidenceIsSufficient(method), false);
  }
  for (const method of ['SIGNED_CONTRACT', 'APPROVED_COMMERCIAL_RELATIONSHIP', 'BINDING_ORDER']) {
    assert.equal(counterpartyContextEvidenceIsSufficient(method), true);
  }
});

test('applies CUSTOMER and SUPPLIER evidence thresholds without waiting for first completion', () => {
  assert.equal(roleEvidenceIsSufficient('CUSTOMER', 'ENGAGEMENT_PROSPECT'), false);
  assert.equal(roleEvidenceIsSufficient('CUSTOMER', 'BINDING_ORDER'), true);
  assert.equal(roleEvidenceIsSufficient('CUSTOMER', 'APPROVED_PURCHASING_RELATIONSHIP'), true);
  assert.equal(roleEvidenceIsSufficient('SUPPLIER', 'VENDOR_CANDIDATE'), false);
  assert.equal(roleEvidenceIsSufficient('SUPPLIER', 'COMPLETED_VENDOR_ONBOARDING'), true);
  assert.equal(roleEvidenceIsSufficient('SUPPLIER', 'BINDING_PURCHASE_ORDER'), true);
});

test('requires explicit relationship-end evidence and rejects operational inactivity', () => {
  assert.equal(roleEndEvidenceIsSufficient('CUSTOMER', 'ENGAGEMENT_INACTIVITY'), false);
  assert.equal(roleEndEvidenceIsSufficient('CUSTOMER', 'TRANSACTION_INACTIVITY'), false);
  assert.equal(
    roleEndEvidenceIsSufficient('CUSTOMER', 'CONFIRMED_CUSTOMER_RELATIONSHIP_END'),
    true,
  );
  assert.equal(roleEndEvidenceIsSufficient('SUPPLIER', 'TEMPORARY_PROCUREMENT_BLOCK'), false);
  assert.equal(roleEndEvidenceIsSufficient('SUPPLIER', 'PURCHASE_SUSPENSION'), false);
  assert.equal(
    roleEndEvidenceIsSufficient('SUPPLIER', 'CONFIRMED_SUPPLIER_RELATIONSHIP_END'),
    true,
  );
});

test('derives current role state from lifecycle and effective time', () => {
  const active = {
    state: 'ACTIVE' as const,
    validFrom: '2026-01-01T00:00:00.000Z',
    validTo: '2027-01-01T00:00:00.000Z',
  };
  assert.equal(rolePeriodIsCurrentAt(active, '2025-12-31T23:59:59.000Z'), false);
  assert.equal(rolePeriodIsCurrentAt(active, '2026-06-01T00:00:00.000Z'), true);
  assert.equal(rolePeriodIsCurrentAt(active, '2027-01-01T00:00:00.000Z'), false);
  assert.equal(
    rolePeriodIsCurrentAt(
      {
        state: 'ACTIVE',
        validFrom: '2027-01-01T00:00:00.000Z',
        validTo: null,
      },
      '2026-06-01T00:00:00.000Z',
    ),
    false,
  );
  assert.equal(
    rolePeriodIsCurrentAt({ ...active, state: 'ENDED' }, '2026-06-01T00:00:00.000Z'),
    false,
  );
});

test('stores future, current, future-ended, and historical periods by their interval', () => {
  assert.deepEqual(
    rolePeriodStorageStateAt(
      { validFrom: '2027-01-01T00:00:00.000Z', validTo: null },
      '2026-06-01T00:00:00.000Z',
    ),
    { isCurrent: false, state: 'ACTIVE' },
  );
  assert.deepEqual(
    rolePeriodStorageStateAt(
      {
        validFrom: '2026-01-01T00:00:00.000Z',
        validTo: '2027-01-01T00:00:00.000Z',
      },
      '2026-06-01T00:00:00.000Z',
    ),
    { isCurrent: true, state: 'ACTIVE' },
  );
  assert.deepEqual(
    rolePeriodStorageStateAt(
      {
        validFrom: '2026-01-01T00:00:00.000Z',
        validTo: '2027-01-01T00:00:00.000Z',
      },
      '2027-01-01T00:00:00.000Z',
    ),
    { isCurrent: false, state: 'ENDED' },
  );
});

test('rejects overlapping periods of the same role while allowing adjacent reactivation', () => {
  const historical = {
    validFrom: '2025-01-01T00:00:00.000Z',
    validTo: '2026-01-01T00:00:00.000Z',
  };
  assert.equal(
    rolePeriodsOverlap(historical, {
      validFrom: '2025-12-01T00:00:00.000Z',
      validTo: null,
    }),
    true,
  );
  assert.equal(
    rolePeriodsOverlap(historical, {
      validFrom: '2026-01-01T00:00:00.000Z',
      validTo: null,
    }),
    false,
  );
});
