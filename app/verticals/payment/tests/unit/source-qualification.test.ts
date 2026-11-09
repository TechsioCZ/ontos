import { DateTime, Option } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import type { PaymentExecutionBinding } from '../../shared/domain/payment-execution-binding.ts';
import type { PaymentMethod } from '../../shared/domain/payment-vocabulary.ts';
import {
  PaymentSourceQualification,
  qualifyPaymentSourceStatement,
  sourceAuthorityConfigurationProblem,
} from '../../src/domain/source-qualification.ts';
import type {
  PaymentRecordedObservationView,
  PaymentSourceAuthorityView,
  PaymentSourceQualificationCase,
  PaymentSourceQualificationInput,
  PaymentSourceStatement,
  PaymentSourceTargetView,
} from '../../src/domain/source-qualification.ts';

/**
 * Pure source qualification (#1152 "Authority by fact family", "Qualified source statement contract").
 * The bank, carrier, gateway and POS statements below are public-contract fixtures of external
 * sources; the Payment decision under test is the real owner implementation.
 */

/** An absent optional fact, spelled once so the fixtures stay explicit about what a source omits. */
const absent = <Value>(): Value | undefined => Option.getOrUndefined(Option.none<Value>());

const PAYMENT_ID = '10000000-0000-4000-8000-000000000001';
const COLLECT_ID = '20000000-0000-4000-8000-000000000001';
const REFUND_ID = '20000000-0000-4000-8000-000000000002';
const BANK_AUTHORITY_ID = '30000000-0000-4000-8000-000000000001';
const OTHER_AUTHORITY_ID = '30000000-0000-4000-8000-000000000002';

const bankSource = {
  accountRef: 'CZ6508000000192000145399',
  environment: 'production',
  sourceKind: 'BANK_ACCOUNTING',
  sourceSystem: 'erp-helios',
} as const;

const authority = (overrides: Partial<PaymentSourceAuthorityView> = {}): PaymentSourceAuthorityView => ({
  ...bankSource,
  factFamily: 'BANK_ACCOUNTING_RECEIPT',
  method: 'BANK_TRANSFER_ADVANCE',
  refundRoute: false,
  revision: 1,
  sourceAuthorityId: BANK_AUTHORITY_ID,
  status: 'ACTIVE',
  ...overrides,
});

const statement = (
  overrides: { readonly [Key in keyof PaymentSourceStatement]?: PaymentSourceStatement[Key] } = {},
): PaymentSourceStatement => ({
  amount: { amountMinor: 100_000, currency: 'CZK' },
  factFamily: 'BANK_ACCOUNTING_RECEIPT',
  factKind: 'COLLECTION_CONFIRMED',
  paymentId: PAYMENT_ID,
  source: bankSource,
  sourceOccurrenceId: 'bank-statement-line-1',
  sourceRevision: 1,
  ...overrides,
});

const target = (
  method: PaymentMethod,
  executionBinding: PaymentExecutionBinding,
  operations: PaymentSourceTargetView['operations'] = [
    { binding: executionBinding, kind: 'COLLECT', operationId: COLLECT_ID, outcome: 'PENDING' },
  ],
): PaymentSourceTargetView => ({
  operations,
  payment: { amount: { amountMinor: 100_000, currency: 'CZK' }, executionBinding, method, paymentId: PAYMENT_ID },
});

const bankTarget = target('BANK_TRANSFER_ADVANCE', { _tag: 'BANK_ACCOUNTING_RECEIPT' });
const codBinding: PaymentExecutionBinding = {
  _tag: 'COD_DELIVERY_OFFER',
  capabilityEvidenceRef: 'cod-capability-evidence-1',
  deliveryOfferRef: 'ppl-delivery-offer-1',
};
const gatewayBinding: PaymentExecutionBinding = {
  _tag: 'GATEWAY_ACCOUNT',
  environment: 'production',
  providerAccountRef: 'gopay-account-1',
  providerFamily: 'GOPAY',
};

const qualify = (overrides: Partial<PaymentSourceQualificationInput> = {}): PaymentSourceQualificationCase =>
  qualifyPaymentSourceStatement({
    authorities: [authority()],
    correctedObservation: absent(),
    entry: 'INTEGRATION',
    existingOccurrence: absent(),
    statement: statement(),
    target: bankTarget,
    ...overrides,
  });

const recorded = (overrides: Partial<PaymentRecordedObservationView> = {}): PaymentRecordedObservationView => ({
  acceptanceOutcome: 'ACCEPTED_OBSERVATION',
  amount: { amountMinor: 100_000, currency: 'CZK' },
  correctsObservationId: absent(),
  economicEffectKey: absent(),
  evidenceRef: absent(),
  factFamily: 'BANK_ACCOUNTING_RECEIPT',
  factKind: 'COLLECTION_CONFIRMED',
  observationId: '40000000-0000-4000-8000-000000000001',
  operationId: COLLECT_ID,
  paymentId: PAYMENT_ID,
  sourceAuthorityId: BANK_AUTHORITY_ID,
  sourceOccurredAt: absent(),
  ...overrides,
});

const tagOf = (decision: PaymentSourceQualificationCase) => decision._tag;

describe('#1152 exact source qualification', () => {
  it('#1152 ERP owns the exact accounting receipt: an authorized exact statement qualifies against the live COLLECT', () => {
    const decision = qualify();
    expect(tagOf(decision)).toBe('Qualified');
    if (PaymentSourceQualification.$is('Qualified')(decision)) {
      expect(decision.paymentId).toBe(PAYMENT_ID);
      expect(decision.observation.operationId).toBe(COLLECT_ID);
      expect(decision.observation.amount).toEqual({ amountMinor: 100_000, currency: 'CZK' });
      expect(decision.authority.sourceAuthorityId).toBe(BANK_AUTHORITY_ID);
    }
  });

  it('#1152 ERP owns the exact accounting receipt: Symmy transport identity is not the configured authority', () => {
    const decision = qualify({ statement: statement({ source: { ...bankSource, sourceSystem: 'symmy' } }) });
    expect(tagOf(decision)).toBe('Unauthorized');
  });

  it('#1152 no global ERP-wins: authority is per exact fact family', () => {
    // The same ERP binding is configured for deferred-invoice receipts only.
    const decision = qualify({
      authorities: [authority({ factFamily: 'DEFERRED_INVOICE_RECEIPT', method: absent() })],
    });
    expect(tagOf(decision)).toBe('Unauthorized');
  });

  it('#1152 a revoked authority is not authority', () => {
    expect(tagOf(qualify({ authorities: [authority({ status: 'REVOKED' })] }))).toBe('Unauthorized');
  });

  it('#1152 a receipt belongs to another account or environment: foreign binding never qualifies', () => {
    for (const source of [
      { ...bankSource, accountRef: 'CZ0000000000000000000001' },
      { ...bankSource, environment: 'sandbox' },
    ]) {
      expect(tagOf(qualify({ statement: statement({ source }) }))).toBe('Unauthorized');
    }
  });

  it('#1152 a receipt with the same amount but no exact Payment correlation stays unassigned', () => {
    const decision = qualify({ statement: statement({ paymentId: absent() }), target: absent() });
    expect(tagOf(decision)).toBe('HeldUnassigned');
  });

  it('#1152 the method must have the exact configured authority (method-specific authority mismatch)', () => {
    const decision = qualify({ authorities: [authority({ method: 'DEFERRED_INVOICE' })] });
    expect(tagOf(decision)).toBe('Unauthorized');
  });

  it('#1152 a bank receipt family is not evidence for a COD Payment', () => {
    const decision = qualify({
      authorities: [authority({ method: absent() })],
      target: target('CASH_ON_DELIVERY', codBinding),
    });
    expect(tagOf(decision)).toBe('Unauthorized');
  });

  it('#1152 QR exists without bank receipt: a QR/pending statement is not a fact the bank receipt family establishes', () => {
    expect(tagOf(qualify({ statement: statement({ factKind: 'COLLECTION_PENDING' }) }))).toBe('Unsupported');
  });

  it('#1152 unsupported fact families: an unrecognized fact is UNSUPPORTED_FACT', () => {
    expect(tagOf(qualify({ statement: statement({ factKind: 'UNRECOGNIZED' }) }))).toBe('Unsupported');
  });

  it('#1152 exact currency mismatch is refused, never converted', () => {
    const decision = qualify({ statement: statement({ amount: { amountMinor: 4000, currency: 'EUR' } }) });
    expect(tagOf(decision)).toBe('CurrencyMismatch');
  });

  it('#1152 duplicate source occurrences: same occurrence and content is DUPLICATE, changed content conflicts', () => {
    expect(tagOf(qualify({ existingOccurrence: recorded() }))).toBe('Duplicate');
    expect(tagOf(qualify({ existingOccurrence: recorded({ amount: { amountMinor: 90_000, currency: 'CZK' } }) }))).toBe(
      'OccurrenceConflict',
    );
    const occurredAt = DateTime.makeUnsafe('2026-11-09T10:00:00.000Z');
    expect(
      tagOf(
        qualify({
          existingOccurrence: recorded({ sourceOccurredAt: occurredAt }),
          statement: statement({ sourceOccurredAt: occurredAt }),
        }),
      ),
    ).toBe('Duplicate');
  });

  it('#1152 operator evidence cannot enter through the integration Action and vice versa', () => {
    const localSource = { ...bankSource, sourceKind: 'LOCAL_POS_OPERATOR' as const, sourceSystem: 'pos-1' };
    expect(tagOf(qualify({ statement: statement({ source: localSource }) }))).toBe('Unauthorized');
    expect(tagOf(qualify({ entry: 'LOCAL_EVIDENCE' }))).toBe('Unauthorized');
  });

  it('#1152 COD collection requires the exact selected Delivery Offer', () => {
    const carrierSource = {
      accountRef: 'ppl-cod-contract-1',
      environment: 'production',
      sourceKind: 'CARRIER',
      sourceSystem: 'ppl',
    } as const;
    const carrier = authority({
      ...carrierSource,
      factFamily: 'COD_CUSTOMER_COLLECTION',
      method: 'CASH_ON_DELIVERY',
    });
    const input = {
      authorities: [carrier],
      target: target('CASH_ON_DELIVERY', codBinding),
    };
    const codStatement = (deliveryOfferRef?: string) =>
      statement({ deliveryOfferRef, factFamily: 'COD_CUSTOMER_COLLECTION', source: carrierSource });
    expect(tagOf(qualify({ ...input, statement: codStatement() }))).toBe('Held');
    expect(tagOf(qualify({ ...input, statement: codStatement('ppl-delivery-offer-2') }))).toBe('Unauthorized');
    expect(tagOf(qualify({ ...input, statement: codStatement('ppl-delivery-offer-1') }))).toBe('Qualified');
    // Delivery does not prove collection: a generic DELIVERED signal is not a COD collection fact.
    expect(
      tagOf(qualify({ ...input, statement: { ...codStatement('ppl-delivery-offer-1'), factKind: 'UNRECOGNIZED' } })),
    ).toBe('Unsupported');
  });

  it('#1151 gateway statements must match the original provider account and environment binding', () => {
    const gatewaySource = {
      accountRef: 'gopay-account-1',
      environment: 'production',
      sourceKind: 'PAYMENT_GATEWAY',
      sourceSystem: 'GOPAY',
    } as const;
    const gateway = authority({ ...gatewaySource, factFamily: 'GATEWAY_OUTCOME', method: 'ONLINE_GATEWAY' });
    const input = { authorities: [gateway], target: target('ONLINE_GATEWAY', gatewayBinding) };
    expect(
      tagOf(qualify({ ...input, statement: statement({ factFamily: 'GATEWAY_OUTCOME', source: gatewaySource }) })),
    ).toBe('Qualified');
    const rotated = { ...gatewaySource, accountRef: 'gopay-account-2' };
    expect(
      tagOf(
        qualify({
          authorities: [authority({ ...rotated, factFamily: 'GATEWAY_OUTCOME', method: 'ONLINE_GATEWAY' })],
          statement: statement({ factFamily: 'GATEWAY_OUTCOME', source: rotated }),
          target: target('ONLINE_GATEWAY', gatewayBinding),
        }),
      ),
    ).toBe('Unauthorized');
  });

  it('#1152 refund evidence requires a configured refund route; a manual route cannot confirm returned money', () => {
    const refundTarget = target('BANK_TRANSFER_ADVANCE', { _tag: 'BANK_ACCOUNTING_RECEIPT' }, [
      {
        binding: { _tag: 'BANK_ACCOUNTING_RECEIPT' },
        kind: 'COLLECT',
        operationId: COLLECT_ID,
        outcome: 'EFFECT_CONFIRMED',
      },
      { binding: { _tag: 'BANK_ACCOUNTING_RECEIPT' }, kind: 'REFUND', operationId: REFUND_ID, outcome: 'PENDING' },
    ]);
    const refundStatement = statement({
      factFamily: 'REFUND_EXECUTION',
      factKind: 'REFUND_CONFIRMED',
      operationId: REFUND_ID,
    });
    expect(
      tagOf(
        qualify({
          authorities: [authority({ factFamily: 'REFUND_EXECUTION', refundRoute: false })],
          statement: refundStatement,
          target: refundTarget,
        }),
      ),
    ).toBe('Unauthorized');
    expect(
      tagOf(
        qualify({
          authorities: [authority({ factFamily: 'REFUND_EXECUTION', refundRoute: true })],
          statement: refundStatement,
          target: refundTarget,
        }),
      ),
    ).toBe('Qualified');
    const manualSource = {
      ...bankSource,
      sourceKind: 'MANUAL_EXTERNAL_REFUND' as const,
      sourceSystem: 'treasury-desk',
    };
    expect(
      tagOf(
        qualify({
          authorities: [authority({ ...manualSource, factFamily: 'REFUND_EXECUTION', refundRoute: true })],
          entry: 'LOCAL_EVIDENCE',
          statement: { ...refundStatement, source: manualSource },
          target: refundTarget,
        }),
      ),
    ).toBe('Unsupported');
  });

  it('#1150 #1152 refund evidence must come from the executor the REFUND was requested through', () => {
    const otherBank = { ...bankSource, accountRef: 'CZ0001000000000000000002' };
    const routedTarget = target('BANK_TRANSFER_ADVANCE', { _tag: 'BANK_ACCOUNTING_RECEIPT' }, [
      {
        binding: { _tag: 'BANK_ACCOUNTING_RECEIPT' },
        kind: 'COLLECT',
        operationId: COLLECT_ID,
        outcome: 'EFFECT_CONFIRMED',
      },
      {
        binding: { _tag: 'BANK_ACCOUNTING_RECEIPT' },
        kind: 'REFUND',
        operationId: REFUND_ID,
        outcome: 'PENDING',
        refundExecutionRoute: { sourceAuthorityId: BANK_AUTHORITY_ID, sourceKind: 'BANK_ACCOUNTING' },
      },
    ]);
    const refundStatement = statement({
      factFamily: 'REFUND_EXECUTION',
      factKind: 'REFUND_CONFIRMED',
      operationId: REFUND_ID,
    });
    const originalRoute = authority({ factFamily: 'REFUND_EXECUTION', refundRoute: true });
    const otherRoute = authority({
      ...otherBank,
      factFamily: 'REFUND_EXECUTION',
      refundRoute: true,
      sourceAuthorityId: OTHER_AUTHORITY_ID,
    });
    expect(tagOf(qualify({ authorities: [originalRoute], statement: refundStatement, target: routedTarget }))).toBe(
      'Qualified',
    );
    // Another configured bank account of the same executor kind never evidences the original REFUND.
    expect(
      tagOf(
        qualify({
          authorities: [originalRoute, otherRoute],
          statement: { ...refundStatement, source: otherBank },
          target: routedTarget,
        }),
      ),
    ).toBe('Unauthorized');
    // A revoked original route is explicit, never replaced by another configured route.
    expect(
      tagOf(
        qualify({
          authorities: [{ ...originalRoute, status: 'REVOKED' }],
          statement: refundStatement,
          target: routedTarget,
        }),
      ),
    ).toBe('Unauthorized');
  });

  it('#1151 a refund statement without its exact operation is passed on uncorrelated, never first-matched', () => {
    const decision = qualify({
      authorities: [authority({ factFamily: 'REFUND_EXECUTION', refundRoute: true })],
      statement: statement({ factFamily: 'REFUND_EXECUTION', factKind: 'REFUND_CONFIRMED' }),
    });
    expect(tagOf(decision)).toBe('Qualified');
    if (PaymentSourceQualification.$is('Qualified')(decision)) {
      expect(decision.observation.operationId).toBeUndefined();
    }
  });

  it('#1152 accounting corrects a mistaken receipt: only the issuing authority can correct, an unknown target is held', () => {
    const correction = statement({
      correctsObservationId: '40000000-0000-4000-8000-000000000001',
      factKind: 'SOURCE_CORRECTION',
      sourceOccurrenceId: 'bank-correction-1',
    });
    expect(tagOf(qualify({ correctedObservation: recorded(), statement: correction }))).toBe('Qualified');
    expect(
      tagOf(
        qualify({
          correctedObservation: recorded({ sourceAuthorityId: OTHER_AUTHORITY_ID }),
          statement: correction,
        }),
      ),
    ).toBe('Unauthorized');
    const held = qualify({ statement: correction });
    expect(tagOf(held)).toBe('Held');
    if (PaymentSourceQualification.$is('Held')(held)) {
      expect(held.reason).toBe('CORRECTION_TARGET_UNKNOWN');
      expect(Option.isSome(held.operationId)).toBe(false);
    }
  });
});

describe('#1152 source authority configuration matrix', () => {
  it('#1152 COD funds are refunded by the merchant: a carrier is never a refund route', () => {
    expect(
      sourceAuthorityConfigurationProblem({
        factFamily: 'REFUND_EXECUTION',
        method: 'CASH_ON_DELIVERY',
        refundRoute: true,
        sourceKind: 'CARRIER',
      }),
    ).toBeDefined();
    expect(
      sourceAuthorityConfigurationProblem({
        factFamily: 'REFUND_EXECUTION',
        method: 'CASH_ON_DELIVERY',
        refundRoute: true,
        sourceKind: 'BANK_ACCOUNTING',
      }),
    ).toBeUndefined();
  });

  it('#1150 every refund executor the refund Action selects can be configured as a refund route', () => {
    const routes = [
      ['ONLINE_GATEWAY', 'PAYMENT_GATEWAY'],
      ['BANK_TRANSFER_ADVANCE', 'BANK_ACCOUNTING'],
      ['DEFERRED_INVOICE', 'BANK_ACCOUNTING'],
      ['CASH_ON_DELIVERY', 'BANK_ACCOUNTING'],
      ['PAY_ON_PICKUP_OR_ON_SITE', 'LOCAL_POS_OPERATOR'],
      ['PAY_ON_PICKUP_OR_ON_SITE', 'BANK_ACCOUNTING'],
      ['PAY_ON_PICKUP_OR_ON_SITE', 'MANUAL_EXTERNAL_REFUND'],
    ] as const;
    for (const [method, sourceKind] of routes) {
      expect(
        sourceAuthorityConfigurationProblem({ factFamily: 'REFUND_EXECUTION', method, refundRoute: true, sourceKind }),
      ).toBeUndefined();
    }
    // A gateway executes only gateway refunds; it never becomes a route for a merchant-side method.
    expect(
      sourceAuthorityConfigurationProblem({
        factFamily: 'REFUND_EXECUTION',
        method: 'BANK_TRANSFER_ADVANCE',
        refundRoute: true,
        sourceKind: 'PAYMENT_GATEWAY',
      }),
    ).toBeDefined();
  });

  it('#1152 unsupported fact families: incompatible family, source kind, method or route are invalid', () => {
    expect(
      sourceAuthorityConfigurationProblem({
        factFamily: 'BANK_ACCOUNTING_RECEIPT',
        method: absent(),
        refundRoute: false,
        sourceKind: 'CARRIER',
      }),
    ).toBeDefined();
    expect(
      sourceAuthorityConfigurationProblem({
        factFamily: 'LOCAL_POS_COLLECTION',
        method: 'BANK_TRANSFER_ADVANCE',
        refundRoute: false,
        sourceKind: 'LOCAL_POS_OPERATOR',
      }),
    ).toBeDefined();
    expect(
      sourceAuthorityConfigurationProblem({
        factFamily: 'BANK_ACCOUNTING_RECEIPT',
        method: 'BANK_TRANSFER_ADVANCE',
        refundRoute: true,
        sourceKind: 'BANK_ACCOUNTING',
      }),
    ).toBeDefined();
    expect(
      sourceAuthorityConfigurationProblem({
        factFamily: 'LOCAL_POS_COLLECTION',
        method: 'PAY_ON_PICKUP_OR_ON_SITE',
        refundRoute: false,
        sourceKind: 'LOCAL_POS_OPERATOR',
      }),
    ).toBeUndefined();
  });
});
