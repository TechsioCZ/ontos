import { Effect, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import { PaymentMethodApplicabilityRequestSchema } from '../../shared/apis/payment-method-applicability.ts';
import type {
  PaymentMethodBranchApplicability,
  PaymentMethodBranchSelection,
  PaymentMethodEnablementState,
} from '../../shared/domain/applicability-contract.ts';
import { PaymentBankAccountingReceiptBindingSchema } from '../../shared/domain/payment-execution-binding.ts';
import type { PaymentMethod } from '../../shared/domain/payment-vocabulary.ts';
import { PAYMENT_METHODS } from '../../shared/domain/payment-vocabulary.ts';
import { evaluatePaymentMethodApplicability } from '../../src/domain/applicability-evaluation.ts';
import type { PaymentTermUseEvidence } from '../../src/ports/payment-term-evidence-port.ts';
import {
  applicabilityOwnerEvidenceFixture,
  codSupported,
  GOPAY_PRODUCTION,
  immediateSnapshot,
  legacyNetDaysSnapshot,
  netDaysSnapshot,
  notUsableTerm,
  OWNER_EVIDENCE_UNAVAILABLE,
  pickupSupported,
  STRIPE_PRODUCTION,
  termRefFor,
  usableTerm,
} from '../support/applicability-owner-evidence.fixture.ts';
import type { ApplicabilityOwnerEvidenceScript } from '../support/applicability-owner-evidence.fixture.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const scope = { legalEntityId: '22222222-2222-4222-8222-222222222222', tenantId };
const termRef = termRefFor(tenantId, '33333333-3333-4333-8333-333333333333');
const net14 = netDaysSnapshot(termRef, 14);
const immediate = immediateSnapshot(termRef);

const allEnabled: readonly PaymentMethodEnablementState[] = PAYMENT_METHODS.map((method) => ({
  enabled: true,
  method,
  revision: 1,
}));

const script = (overrides: Partial<ApplicabilityOwnerEvidenceScript> = {}): ApplicabilityOwnerEvidenceScript => ({
  codCapability: codSupported,
  enabledGatewayBindings: [GOPAY_PRODUCTION],
  pickupCapability: pickupSupported,
  termUse: () => usableTerm(net14, 'entitlement-A'),
  ...overrides,
});

const evaluate = (
  selections: readonly PaymentMethodBranchSelection[],
  owners: ApplicabilityOwnerEvidenceScript = script(),
  enablements: readonly PaymentMethodEnablementState[] = allEnabled,
  paymentTermRef = termRef,
) => {
  const fixture = applicabilityOwnerEvidenceFixture(owners);
  return evaluatePaymentMethodApplicability({
    amount: { amountMinor: 125_000, currency: 'CZK' },
    customerConfigurationId: 'customer-configuration-1',
    enablements,
    paymentTermRef,
    scope,
    selections,
  }).pipe(
    Effect.provide(fixture.layer),
    Effect.map((branches) => ({ branches, calls: fixture.calls })),
  );
};

const only = (branches: readonly PaymentMethodBranchApplicability[]) => {
  expect(branches).toHaveLength(1);
  const [branch] = branches;
  if (branch === undefined) {
    return expect.unreachable('one branch result');
  }
  return branch;
};

const findingsOf = (branch: PaymentMethodBranchApplicability) =>
  branch.outcome === 'AVAILABLE' ? [] : branch.findings.map(({ check, reason }) => `${check}:${reason}`);

describe('#1147 Payment method applicability — Gherkin acceptance', () => {
  it.effect('#1147 COD is unavailable on the selected carrier product', () =>
    Effect.gen(function* codUnsupportedOnSelectedOffer() {
      const { branches, calls } = yield* evaluate(
        [{ deliveryOfferRef: 'offer-ppl-parcel', method: 'CASH_ON_DELIVERY' }],
        script({
          codCapability: (deliveryOfferRef) => ({
            _tag: 'NOT_SUPPORTED',
            deliveryOfferRef,
            reason: 'OFFER_NOT_COD_CAPABLE',
          }),
        }),
      );
      const branch = only(branches);
      expect(branch.outcome).toBe('UNSUPPORTED_CAPABILITY');
      expect(findingsOf(branch)).toEqual(['DELIVERY_CAPABILITY:OFFER_NOT_COD_CAPABLE']);
      // Only the exact selected offer was asked about; no other offer or method was tried or returned.
      expect(calls.deliveryOffers).toEqual(['offer-ppl-parcel']);
      expect(branches.map(({ method }) => method)).toEqual(['CASH_ON_DELIVERY']);
    }),
  );

  it.effect('#1147 NET_DAYS customer pays early online', () =>
    Effect.gen(function* netDaysEarlyOnline() {
      const { branches } = yield* evaluate([{ method: 'ONLINE_GATEWAY', selectedBinding: GOPAY_PRODUCTION }]);
      const branch = only(branches);
      expect(branch.outcome).toBe('AVAILABLE');
      if (branch.outcome === 'AVAILABLE') {
        expect(branch.executionBinding).toEqual(GOPAY_PRODUCTION);
        // The resolved term stays NET_DAYS(14) under its unchanged Ref; method choice never replaces it.
        expect(branch.term.paymentTermRef).toEqual(termRef);
        expect(branch.term.semanticSnapshot.semantics).toEqual(net14.semantics);
      }
    }),
  );

  it.effect('#1147 Deferred invoice is requested with IMMEDIATE', () =>
    Effect.gen(function* deferredWithImmediate() {
      const { branches } = yield* evaluate(
        [{ method: 'DEFERRED_INVOICE' }],
        script({ termUse: () => usableTerm(immediate, 'entitlement-A') }),
      );
      const branch = only(branches);
      expect(branch.outcome).toBe('INCOMPATIBLE_TERM');
      expect(findingsOf(branch)).toEqual(['PAYMENT_TERM:TERM_NOT_DEFERRABLE']);
    }),
  );

  it.effect('#1147 QR instructions are generated: bank transfer applicability records no collection', () =>
    Effect.gen(function* bankTransferNoCollection() {
      const { branches } = yield* evaluate([{ method: 'BANK_TRANSFER_ADVANCE' }]);
      const branch = only(branches);
      expect(branch.outcome).toBe('AVAILABLE');
      if (branch.outcome === 'AVAILABLE') {
        // Receipt is evidenced later by bank/accounting authority; nothing here is a collection fact.
        expect(Schema.is(PaymentBankAccountingReceiptBindingSchema)(branch.executionBinding)).toBe(true);
        expect(new Set(Object.keys(branch))).toEqual(
          new Set(['enablementRevision', 'executionBinding', 'method', 'outcome', 'term']),
        );
      }
    }),
  );

  it.effect('#1147 Required COD evidence cannot be verified while bank transfer stays AVAILABLE (H1094-01=A)', () =>
    Effect.gen(function* codOutageIndependentBank() {
      const { branches, calls } = yield* evaluate(
        [{ deliveryOfferRef: 'offer-ppl-parcel', method: 'CASH_ON_DELIVERY' }, { method: 'BANK_TRANSFER_ADVANCE' }],
        script({ codCapability: () => OWNER_EVIDENCE_UNAVAILABLE }),
      );
      expect(branches.map(({ method, outcome }) => `${method}:${outcome}`)).toEqual([
        'CASH_ON_DELIVERY:UNAVAILABLE_TO_VERIFY',
        'BANK_TRANSFER_ADVANCE:AVAILABLE',
      ]);
      const [cod] = branches;
      expect(cod === undefined ? [] : findingsOf(cod)).toEqual(['DELIVERY_CAPABILITY:EVIDENCE_UNAVAILABLE']);
      // Neither branch is selected for the customer: the result carries no choice, only per-branch outcomes.
      expect(branches.every((branch) => !('selected' in branch))).toBe(true);
      expect(calls.deliveryOffers).toEqual(['offer-ppl-parcel']);
    }),
  );

  it.effect('#1147 A separate entitlement period is cancelled: unaffected A and pA stay usable', () =>
    Effect.gen(function* separatePeriodCancelled() {
      // The owner (CCC) still proves entitlement A and preference pA Current after cancelling future period B.
      let periodBCancelled = false;
      const owners = script({
        termUse: () => usableTerm(net14, periodBCancelled ? 'entitlement-A:after-B-cancel' : 'entitlement-A'),
      });
      const before = only((yield* evaluate([{ method: 'DEFERRED_INVOICE' }], owners)).branches);
      periodBCancelled = true;
      const after = only((yield* evaluate([{ method: 'DEFERRED_INVOICE' }], owners)).branches);
      expect(before.outcome).toBe('AVAILABLE');
      expect(after.outcome).toBe('AVAILABLE');
      if (after.outcome === 'AVAILABLE') {
        // Payment consumes the owner's exact Current decision; an equal term Ref alone invalidates nothing.
        expect(after.term.entitlementEvidenceRef).toBe('entitlement-A:after-B-cancel');
        expect(after.term.paymentTermRef).toEqual(termRef);
      }
    }),
  );

  it.effect('#1147 Cancelled entitlement cannot authorize deferred payment', () =>
    Effect.gen(function* cancelledEntitlement() {
      const { branches } = yield* evaluate(
        [{ method: 'DEFERRED_INVOICE' }],
        script({ termUse: () => notUsableTerm(termRef, 'ENTITLEMENT_NOT_CURRENT') }),
      );
      const branch = only(branches);
      expect(branch.outcome).not.toBe('AVAILABLE');
      expect(branch.outcome).toBe('INCOMPATIBLE_TERM');
      // Definition existence or a historical schedule is not Current entitlement.
      expect(findingsOf(branch)).toEqual(['PAYMENT_TERM:ENTITLEMENT_NOT_CURRENT']);
    }),
  );

  it.effect('#1147 Reusable term does not create an invoice due date', () =>
    Effect.gen(function* noFabricatedInvoiceDates() {
      const { branches } = yield* evaluate([{ method: 'DEFERRED_INVOICE' }]);
      const branch = only(branches);
      expect(branch.outcome).toBe('AVAILABLE');
      if (branch.outcome === 'AVAILABLE') {
        // The exact reusable owner snapshot passes through unchanged; Payment derives no concrete date.
        // The owner's reusable rule (dueDateAnchor INVOICE_ISSUE_DATE) is kept verbatim inside its snapshot.
        expect(branch.term.semanticSnapshot).toEqual(net14);
        const { semanticSnapshot: _ownerSnapshot, ...paymentTermFacts } = branch.term;
        const paymentOwned = JSON.stringify({ ...branch, term: paymentTermFacts });
        expect(paymentOwned).not.toMatch(/due|issue|\d{4}-\d{2}-\d{2}/iu);
        expect(new Set(Object.keys(branch.term))).toEqual(
          new Set(['entitlementEvidenceRef', 'paymentTermRef', 'semanticSnapshot']),
        );
      }
    }),
  );
});

describe('#1147 Payment method applicability — branch rules', () => {
  it.effect('#1147 gateway branch without an explicit selected binding is MISSING_REQUIRED_INPUT', () =>
    Effect.gen(function* gatewayWithoutSelection() {
      const { branches, calls } = yield* evaluate(
        [{ method: 'ONLINE_GATEWAY' }],
        script({ enabledGatewayBindings: [GOPAY_PRODUCTION, STRIPE_PRODUCTION] }),
      );
      const branch = only(branches);
      expect(branch.outcome).toBe('MISSING_REQUIRED_INPUT');
      // Row order of the enabled list never selects an account: C17 is not even asked.
      expect(calls.gatewayListings).toEqual([]);
      expect(calls.gatewayBindings).toEqual([]);
    }),
  );

  it.effect('#1147 gateway binding that is not enabled in its qualified environment is NOT_ENABLED', () =>
    Effect.gen(function* gatewayEnvironmentQualified() {
      const sandbox = { ...GOPAY_PRODUCTION, environment: 'sandbox' };
      const { branches, calls } = yield* evaluate([{ method: 'ONLINE_GATEWAY', selectedBinding: sandbox }]);
      const branch = only(branches);
      expect(branch.outcome).toBe('NOT_ENABLED');
      expect(findingsOf(branch)).toEqual(['GATEWAY_BINDING:BINDING_NOT_ENABLED']);
      expect(calls.gatewayBindings).toEqual([sandbox]);
    }),
  );

  it.effect('#1147 C17 gateway outage is UNAVAILABLE_TO_VERIFY, never NOT_ENABLED or empty', () =>
    Effect.gen(function* gatewayOutage() {
      const { branches } = yield* evaluate(
        [{ method: 'ONLINE_GATEWAY', selectedBinding: GOPAY_PRODUCTION }, { method: 'BANK_TRANSFER_ADVANCE' }],
        script({ enabledGatewayBindings: OWNER_EVIDENCE_UNAVAILABLE }),
      );
      expect(branches.map(({ outcome }) => outcome)).toEqual(['UNAVAILABLE_TO_VERIFY', 'AVAILABLE']);
    }),
  );

  it.effect('#1147 owner evidence about a different subject is CONFLICTING_CONFIGURATION', () =>
    Effect.gen(function* evidenceSubjectMismatch() {
      const otherTerm = termRefFor(tenantId, '44444444-4444-4444-8444-444444444444');
      const { branches } = yield* evaluate(
        [
          { method: 'BANK_TRANSFER_ADVANCE' },
          { deliveryOfferRef: 'offer-ppl-parcel', method: 'CASH_ON_DELIVERY' },
          { method: 'PAY_ON_PICKUP_OR_ON_SITE', pickupCapabilityRef: 'pickup-prague' },
        ],
        script({
          codCapability: () => codSupported('offer-other'),
          pickupCapability: () => pickupSupported('pickup-brno'),
          termUse: (method) =>
            method === 'BANK_TRANSFER_ADVANCE'
              ? usableTerm(netDaysSnapshot(otherTerm, 14), 'entitlement-A')
              : usableTerm(net14, 'entitlement-A'),
        }),
      );
      expect(branches.map((branch) => `${branch.outcome}:${findingsOf(branch).join(',')}`)).toEqual([
        'CONFLICTING_CONFIGURATION:PAYMENT_TERM:EVIDENCE_SUBJECT_MISMATCH',
        'CONFLICTING_CONFIGURATION:DELIVERY_CAPABILITY:EVIDENCE_SUBJECT_MISMATCH',
        'CONFLICTING_CONFIGURATION:PICKUP_CAPABILITY:EVIDENCE_SUBJECT_MISMATCH',
      ]);
    }),
  );

  it.effect('#1147 a foreign-tenant PaymentTermRef is never sent to the owner and is CONFLICTING_CONFIGURATION', () =>
    Effect.gen(function* foreignTermRef() {
      const foreign = termRefFor('99999999-9999-4999-8999-999999999999', termRef.resourceId);
      const { branches, calls } = yield* evaluate([{ method: 'BANK_TRANSFER_ADVANCE' }], script(), allEnabled, foreign);
      const branch = only(branches);
      expect(branch.outcome).toBe('CONFLICTING_CONFIGURATION');
      expect(findingsOf(branch)).toEqual(['PAYMENT_TERM:FOREIGN_TERM_REFERENCE']);
      expect(calls.termMethods).toEqual([]);
    }),
  );

  it.effect('#1147 merchant enablement: unconfigured, disabled and duplicated methods', () =>
    Effect.gen(function* merchantEnablement() {
      const enablements: readonly PaymentMethodEnablementState[] = [
        { enabled: false, method: 'BANK_TRANSFER_ADVANCE', revision: 2 },
        { enabled: true, method: 'DEFERRED_INVOICE', revision: 1 },
        { enabled: true, method: 'DEFERRED_INVOICE', revision: 3 },
      ];
      const { branches, calls } = yield* evaluate(
        [
          { method: 'BANK_TRANSFER_ADVANCE' },
          { method: 'DEFERRED_INVOICE' },
          { method: 'ONLINE_GATEWAY', selectedBinding: GOPAY_PRODUCTION },
        ],
        script(),
        enablements,
      );
      expect(branches.map((branch) => `${branch.outcome}:${findingsOf(branch).join(',')}`)).toEqual([
        'NOT_ENABLED:METHOD_ENABLEMENT:DISABLED',
        'CONFLICTING_CONFIGURATION:METHOD_ENABLEMENT:DUPLICATE_CONFIGURATION',
        'NOT_ENABLED:METHOD_ENABLEMENT:NOT_CONFIGURED',
      ]);
      // A method the merchant does not offer needs no owner evidence call.
      expect(calls.termMethods).toEqual([]);
      expect(calls.gatewayBindings).toEqual([]);
    }),
  );

  it.effect('#1147 term owner outage blocks every branch that genuinely requires the common term evidence', () =>
    Effect.gen(function* termOutage() {
      const { branches } = yield* evaluate(
        [{ method: 'BANK_TRANSFER_ADVANCE' }, { method: 'DEFERRED_INVOICE' }],
        script({ termUse: () => OWNER_EVIDENCE_UNAVAILABLE }),
      );
      expect(branches.map((branch) => `${branch.outcome}:${findingsOf(branch).join(',')}`)).toEqual([
        'UNAVAILABLE_TO_VERIFY:PAYMENT_TERM:EVIDENCE_UNAVAILABLE',
        'UNAVAILABLE_TO_VERIFY:PAYMENT_TERM:EVIDENCE_UNAVAILABLE',
      ]);
    }),
  );

  it.effect('#1147 every owner NOT_USABLE reason stays INCOMPATIBLE_TERM with the owner reason', () =>
    Effect.gen(function* notUsableReasons() {
      const reasons: Extract<PaymentTermUseEvidence, { _tag: 'NOT_USABLE' }>['reason'][] = [
        'TERM_NOT_FOUND',
        'TERM_RETIRED',
        'TERM_SEMANTICS_INCOMPATIBLE',
        'ENTITLEMENT_NOT_CURRENT',
        'POLICY_DENIED',
      ];
      for (const reason of reasons) {
        const branch = only(
          (yield* evaluate([{ method: 'DEFERRED_INVOICE' }], script({ termUse: () => notUsableTerm(termRef, reason) })))
            .branches,
        );
        expect(`${branch.outcome}:${findingsOf(branch).join(',')}`).toBe(`INCOMPATIBLE_TERM:PAYMENT_TERM:${reason}`);
      }
    }),
  );

  it.effect('#1147 retained v1 NET_DAYS meaning is preserved exactly, not relabelled as v2', () =>
    Effect.gen(function* legacySemanticsPreserved() {
      const legacy = legacyNetDaysSnapshot(termRef, 30);
      const branch = only(
        (yield* evaluate([{ method: 'DEFERRED_INVOICE' }], script({ termUse: () => usableTerm(legacy, 'ent-v1') })))
          .branches,
      );
      expect(branch.outcome).toBe('AVAILABLE');
      if (branch.outcome === 'AVAILABLE') {
        expect(branch.term.semanticSnapshot).toEqual(legacy);
        expect(branch.term.semanticSnapshot.semantics.calculationRuleVersion).toBe(1);
      }
    }),
  );

  it.effect('#1147 COD and pickup: supported capability yields the exact capability binding', () =>
    Effect.gen(function* capabilityBindings() {
      const { branches } = yield* evaluate([
        { deliveryOfferRef: 'offer-ppl-parcel', method: 'CASH_ON_DELIVERY' },
        { method: 'PAY_ON_PICKUP_OR_ON_SITE', pickupCapabilityRef: 'pickup-prague' },
      ]);
      expect(branches.map((branch) => (branch.outcome === 'AVAILABLE' ? branch.executionBinding : branch))).toEqual([
        {
          _tag: 'COD_DELIVERY_OFFER',
          capabilityEvidenceRef: 'cod-capability:offer-ppl-parcel',
          deliveryOfferRef: 'offer-ppl-parcel',
        },
        {
          _tag: 'PICKUP_CAPABILITY',
          capabilityEvidenceRef: 'pickup-capability:pickup-prague',
          pickupCapabilityRef: 'pickup-prague',
        },
      ]);
    }),
  );

  it.effect('#1147 pickup: missing selection, unsupported capability and outage stay distinct', () =>
    Effect.gen(function* pickupOutcomes() {
      const unsupported = only(
        (yield* evaluate(
          [{ method: 'PAY_ON_PICKUP_OR_ON_SITE', pickupCapabilityRef: 'pickup-prague' }],
          script({
            pickupCapability: (pickupCapabilityRef) => ({
              _tag: 'NOT_SUPPORTED',
              pickupCapabilityRef,
              reason: 'COLLECTION_NOT_SUPPORTED',
            }),
          }),
        )).branches,
      );
      const outage = only(
        (yield* evaluate(
          [{ method: 'PAY_ON_PICKUP_OR_ON_SITE', pickupCapabilityRef: 'pickup-prague' }],
          script({ pickupCapability: () => OWNER_EVIDENCE_UNAVAILABLE }),
        )).branches,
      );
      const missing = only((yield* evaluate([{ method: 'PAY_ON_PICKUP_OR_ON_SITE' }])).branches);
      const missingCod = only((yield* evaluate([{ method: 'CASH_ON_DELIVERY' }])).branches);
      expect([unsupported, outage, missing, missingCod].map((branch) => branch.outcome)).toEqual([
        'UNSUPPORTED_CAPABILITY',
        'UNAVAILABLE_TO_VERIFY',
        'MISSING_REQUIRED_INPUT',
        'MISSING_REQUIRED_INPUT',
      ]);
    }),
  );

  it.effect('#1147 a definitive owner fact outranks an outage of another required check; all findings kept', () =>
    Effect.gen(function* outcomePrecedence() {
      const branch = only(
        (yield* evaluate(
          [{ deliveryOfferRef: 'offer-ppl-parcel', method: 'CASH_ON_DELIVERY' }],
          script({
            codCapability: () => OWNER_EVIDENCE_UNAVAILABLE,
            termUse: () => notUsableTerm(termRef, 'POLICY_DENIED'),
          }),
        )).branches,
      );
      expect(branch.outcome).toBe('INCOMPATIBLE_TERM');
      expect(findingsOf(branch)).toEqual(['PAYMENT_TERM:POLICY_DENIED', 'DELIVERY_CAPABILITY:EVIDENCE_UNAVAILABLE']);
    }),
  );

  it.effect('#1147 all five Launch methods evaluate independently in request order', () =>
    Effect.gen(function* allLaunchMethods() {
      const { branches } = yield* evaluate([
        { method: 'ONLINE_GATEWAY', selectedBinding: GOPAY_PRODUCTION },
        { method: 'BANK_TRANSFER_ADVANCE' },
        { deliveryOfferRef: 'offer-ppl-parcel', method: 'CASH_ON_DELIVERY' },
        { method: 'DEFERRED_INVOICE' },
        { method: 'PAY_ON_PICKUP_OR_ON_SITE', pickupCapabilityRef: 'pickup-prague' },
      ]);
      expect(branches.map(({ method, outcome }) => `${method}:${outcome}`)).toEqual(
        PAYMENT_METHODS.map((method: PaymentMethod) => `${method}:AVAILABLE`),
      );
    }),
  );
});

describe('#1147 applicability request contract', () => {
  const decode = Schema.decodeUnknownSync(PaymentMethodApplicabilityRequestSchema);
  const valid = {
    amount: { amountMinor: 125_000, currency: 'CZK' },
    branches: [{ method: 'BANK_TRANSFER_ADVANCE' }],
    customerConfigurationId: 'customer-configuration-1',
    paymentTermRef: termRef,
  };

  it('#1147 accepts an exact CZK purchase context and rejects duplicate, empty or foreign-currency requests', () => {
    expect(decode(valid).branches).toEqual([{ method: 'BANK_TRANSFER_ADVANCE' }]);
    expect(() => decode({ ...valid, branches: [] })).toThrow();
    expect(() =>
      decode({ ...valid, branches: [{ method: 'BANK_TRANSFER_ADVANCE' }, { method: 'BANK_TRANSFER_ADVANCE' }] }),
    ).toThrow();
    expect(() => decode({ ...valid, amount: { amountMinor: 125_000, currency: 'EUR' } })).toThrow();
    expect(() => decode({ ...valid, amount: { amountMinor: 1250.5, currency: 'CZK' } })).toThrow();
    expect(() => decode({ ...valid, branches: [{ method: 'GOPAY' }] })).toThrow();
  });
});
