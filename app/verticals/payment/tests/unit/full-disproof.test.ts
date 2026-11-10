import { describe, expect, it } from 'effect-rstest';

import { fullyDisprovenTargets } from '../../src/persistence/payment-full-disproof.ts';
import type { DisproofCorrectionRow, DisproofTargetRow } from '../../src/persistence/payment-full-disproof.ts';

const PAYMENT_ID = '10000000-0000-4000-8000-000000000001';
const AUTHORITY_ID = '30000000-0000-4000-8000-000000000001';
const RECEIPT_ID = '40000000-0000-4000-8000-000000000001';

const receipt: DisproofTargetRow = {
  amountMinor: 100_000,
  observationId: RECEIPT_ID,
  paymentId: PAYMENT_ID,
  sourceAuthorityId: AUTHORITY_ID,
};
const correction = (overrides: Partial<DisproofCorrectionRow> = {}): DisproofCorrectionRow => ({
  acceptanceOutcome: 'ACCEPTED_OBSERVATION',
  amountMinor: null,
  capabilityCorrelated: null,
  correctsObservationId: RECEIPT_ID,
  factKind: 'SOURCE_CORRECTION',
  paymentId: PAYMENT_ID,
  sourceAuthorityId: AUTHORITY_ID,
  ...overrides,
});
const disproves = (row: DisproofCorrectionRow, target: DisproofTargetRow = receipt) =>
  fullyDisprovenTargets([target], [row]).has(target.observationId);

describe('#1151 the one full-disproof rule', () => {
  it('a qualified full retraction disproves, whether accepted, held or conflicting', () => {
    expect(disproves(correction())).toBe(true);
    expect(disproves(correction({ amountMinor: 100_000 }))).toBe(true);
    expect(disproves(correction({ acceptanceOutcome: 'HELD_UNRESOLVED' }))).toBe(true);
    expect(disproves(correction({ acceptanceOutcome: 'CONFLICT' }))).toBe(true);
    expect(disproves(correction({ capabilityCorrelated: true }))).toBe(true);
  });

  it('a partial, foreign, unqualified or capability-unproven correction never disproves', () => {
    expect(disproves(correction({ amountMinor: 10_000 }))).toBe(false);
    expect(disproves(correction({ paymentId: '10000000-0000-4000-8000-0000000000ff' }))).toBe(false);
    expect(disproves(correction({ sourceAuthorityId: '30000000-0000-4000-8000-0000000000ff' }))).toBe(false);
    expect(disproves(correction({ acceptanceOutcome: 'UNAUTHORIZED_SOURCE' }))).toBe(false);
    expect(disproves(correction({ capabilityCorrelated: false }))).toBe(false);
    expect(disproves(correction({ factKind: 'COLLECTION_CONFIRMED' }))).toBe(false);
    expect(disproves(correction({ correctsObservationId: '40000000-0000-4000-8000-0000000000ff' }))).toBe(false);
  });

  it('a statement with no Payment or no issuing authority cannot be disproven by lineage', () => {
    expect(disproves(correction({ paymentId: null }), { ...receipt, paymentId: null })).toBe(false);
    expect(disproves(correction({ sourceAuthorityId: null }), { ...receipt, sourceAuthorityId: null })).toBe(false);
  });
});
