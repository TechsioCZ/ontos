import { expect, it } from 'effect-rstest';
import { paymentTermSemanticFingerprint } from '../../src/persistence/payment-term-catalog-persistence.ts';
import {
  correctPaymentTermRoutine,
  createPaymentTermRoutine,
  getCurrentPaymentTermRoutine,
  getPaymentTermHistoryRoutine,
  listCurrentPaymentTermsRoutine,
  reconcilePaymentTermRoutine,
  resolvePaymentTermReferenceRoutine,
  retirePaymentTermRoutine,
} from '../../src/persistence/scoped-routine.ts';

it('fingerprints approved semantics deterministically without conflating contractual meaning', () => {
  const immediate = paymentTermSemanticFingerprint(
    { calculationRuleVersion: 1, calendarRule: 'NOT_APPLICABLE', kind: 'IMMEDIATE' },
    'immediate.v1',
  );
  const net14 = paymentTermSemanticFingerprint(
    {
      calculationRuleVersion: 1,
      calendarRule: 'CALENDAR_DAYS_UTC',
      days: 14,
      dueDateAnchor: 'INVOICE_ISSUED_AT',
      kind: 'NET_DAYS',
    },
    'net_days.invoice_issued_at.calendar_days_utc.v1',
  );
  const net30 = paymentTermSemanticFingerprint(
    {
      calculationRuleVersion: 1,
      calendarRule: 'CALENDAR_DAYS_UTC',
      days: 30,
      dueDateAnchor: 'INVOICE_ISSUED_AT',
      kind: 'NET_DAYS',
    },
    'net_days.invoice_issued_at.calendar_days_utc.v1',
  );
  expect(immediate).toMatch(/^[0-9a-f]{64}$/u);
  expect(net14).toMatch(/^[0-9a-f]{64}$/u);
  expect(new Set([immediate, net14, net30]).size).toBe(3);
});

it('declares every catalog operation as an immutable scope-injected routine', () => {
  const routines = [
    correctPaymentTermRoutine,
    createPaymentTermRoutine,
    getCurrentPaymentTermRoutine,
    getPaymentTermHistoryRoutine,
    listCurrentPaymentTermsRoutine,
    reconcilePaymentTermRoutine,
    resolvePaymentTermReferenceRoutine,
    retirePaymentTermRoutine,
  ];
  expect(new Set(routines.map(({ routineKey }) => routineKey)).size).toBe(routines.length);
  for (const routine of routines) {
    expect(Object.isFrozen(routine)).toBe(true);
    expect(routine.ownerModuleKey).toBe('payment.term-catalog');
    expect(routine.schema).toBe('payment_term_catalog');
    expect(routine.parameters.slice(0, 2)).toEqual([
      { source: 'tenantId', type: 'uuid' },
      { source: 'legalEntityId', type: 'uuid' },
    ]);
  }
  expect(listCurrentPaymentTermsRoutine.parameters).toEqual([
    { source: 'tenantId', type: 'uuid' },
    { source: 'legalEntityId', type: 'uuid' },
    { source: 'input', type: 'integer' },
    { source: 'input', type: 'timestamptz' },
  ]);
});
