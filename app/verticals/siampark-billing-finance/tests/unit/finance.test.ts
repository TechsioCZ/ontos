import { describe, expect, it } from 'effect-rstest';
import { bindActionTestServices, makeActionTestHarness } from '@app/core-runtime/testing/actions';
import { applyCommandAction } from '../../src/actions/apply-command.action.ts';
import { ActionPermissionCheckError, OperationContextUnavailable } from '@app/core-runtime';
import { ActionPermission } from '@app/core-runtime/actions/runtime-wiring';
import { financeWriteCapability } from '../../src/api/records.read.ts';
import { DateTime, Effect, Exit, Layer, Schema } from 'effect';
import { ActiveApplicationCompositionService } from '@app/core-runtime/modules/active-application-composition';
import { GatewayPrincipalVerifierConfiguration } from '@app/gateway-principal-verifier/server';
import { HttpServerRequest } from 'effect/unstable/http';
import type { FinanceCommand } from '../../shared/actions/apply-command.ts';
import {
  FinanceConflict,
  FinancePersistenceUnavailable,
  FinanceRejected,
  FinanceCommandSchema,
} from '../../shared/actions/apply-command.ts';
import {
  CalendarDateSchema,
  FinanceStateSchema,
  InvoiceDraftFields,
  RecordsResponseSchema,
} from '../../shared/apis/records.ts';
import type { FinanceState, Invoice } from '../../shared/apis/records.ts';
import {
  projectFinanceRecords,
  requireFinanceRevision,
  transitionFinance,
} from '../../src/services/persistence.service.ts';
import type { FinanceValidators } from '../../src/services/persistence.service.ts';

const tenantId = 'a0000000-0000-4000-8000-000000000001';
const legalEntityId = 'a0000000-0000-4000-8000-000000000002';
const now = DateTime.makeUnsafe('2026-10-06T12:00:00Z');
const capabilityScope = { correlationId: 'finance-read-capability', principalId: 'finance-actor' };
const input = { attemptId: 'attempt-retry', now, resourceId: 'invoice-new' };
const scope = { legalEntityId, tenantId };
const ref = {
  moduleId: 'siampark.billing-finance' as const,
  resourceId: 'invoice-b201',
  resourceType: 'siampark.billing-finance.invoice' as const,
  tenantId,
};
const propertyRef = {
  moduleId: 'siampark.property' as const,
  resourceId: 'a0000000-0000-4000-8000-000000000010',
  resourceType: 'siampark.property.property' as const,
  tenantId,
};
const counterpartyRef = {
  moduleId: 'party.registry' as const,
  resourceId: 'a0000000-0000-4000-8000-000000000012',
  resourceType: 'party.registry.counterparty' as const,
  tenantId,
};
const invoice: Invoice = {
  accountingCorrelation: 'accounting-b201',
  accountingSyncState: 'FAILED',
  businessState: 'CONFIRMED',
  counterpartyRef,
  createdAt: now,
  currency: 'CZK',
  direction: 'OUTGOING',
  documentNumber: 'B201-2026-10',
  dueDate: '2026-10-01',
  issueDate: '2026-10-01',
  paidMinor: 0,
  paymentState: 'UNPAID',
  propertyRef,
  ref,
  totalMinor: 1_800_000,
  updatedAt: now,
};
const state: FinanceState = {
  accountingObservations: [
    {
      attemptedAt: now,
      attemptId: 'attempt-failed',
      completedAt: now,
      correlation: invoice.accountingCorrelation,
      integrationKind: 'ACCOUNTING',
      invoiceRef: ref,
      latest: true,
      mode: 'SIMULATED',
      providerLabel: 'DEMO',
      requestSummary: 'Existing invoice export',
      resultId: 'failed-result',
      resultSummary: 'Simulated export failed',
      revision: 2,
      status: 'FAILED',
    },
  ],
  financialPlanEntries: [],
  invoices: [invoice],
  paymentObservations: [],
};
const validators: FinanceValidators = { invoice: () => Effect.void };
const run = (snapshot: FinanceState, command: FinanceCommand) =>
  transitionFinance(snapshot, command, scope, validators, input);
const fails = (snapshot: FinanceState, command: FinanceCommand) =>
  transitionFinance(snapshot, command, scope, validators, input).pipe(
    Effect.exit,
    Effect.tap((exit) => Effect.sync(() => expect(Exit.isFailure(exit)).toBe(true))),
    Effect.asVoid,
  );

it.effect('rejects stale aggregate revisions before applying a fresh command', () =>
  Effect.gen(function* rejectStaleRevision() {
    expect(Exit.isSuccess(yield* Effect.exit(requireFinanceRevision(4, 4)))).toBe(true);
    expect(Exit.isFailure(yield* Effect.exit(requireFinanceRevision(5, 4)))).toBe(true);
  }),
);

describe('Finance owner transitions', () => {
  it.effect(
    'retries one failed invoice, preserves failure and correlation, and only a receipt resolves the pending attempt',
    () =>
      Effect.gen(function* financeCase1() {
        const retry = yield* run(state, { _tag: 'RetryAccountingSync', invoiceRef: ref });
        expect(retry.invoice.accountingSyncState).toBe('PENDING');
        expect(retry.invoice.paymentState).toBe('UNPAID');
        expect(retry.state.invoices).toHaveLength(1);
        expect(retry.state.accountingObservations).toHaveLength(2);
        expect(retry.state.accountingObservations[0]?.latest).toBe(false);
        expect(retry.state.accountingObservations[0]?.status).toBe('FAILED');
        expect(retry.state.accountingObservations[1]?.integrationKind).toBe('ACCOUNTING');
        expect(retry.state.accountingObservations[1]?.correlation).toBe(invoice.accountingCorrelation);
        expect(projectFinanceRecords(retry.state, 1, {}).indicators.integrationWarnings).toBe(0);
        yield* fails(retry.state, {
          _tag: 'ApplyAccountingObservation',
          correlation: invoice.accountingCorrelation,
          invoiceRef: ref,
          resultId: 'missing-receipt',
          status: 'SUCCESS',
        });
        const observed = yield* run(retry.state, {
          _tag: 'ApplyAccountingObservation',
          correlation: invoice.accountingCorrelation,
          invoiceRef: ref,
          receipt: 'demo-ext-b201',
          resultId: 'success-result',
          status: 'SUCCESS',
        });
        expect(observed.invoice.accountingSyncState).toBe('SYNCED');
        expect(observed.invoice.externalAccountingReference).toBe('demo-ext-b201');
        expect(observed.invoice.paidMinor).toBe(0);
        expect(observed.state.accountingObservations[1]?.revision).toBe(2);
        const duplicate = yield* run(observed.state, {
          _tag: 'ApplyAccountingObservation',
          correlation: invoice.accountingCorrelation,
          invoiceRef: ref,
          receipt: 'demo-ext-b201',
          resultId: 'success-result',
          status: 'SUCCESS',
        });
        expect(duplicate.changed).toBe(false);
        expect(duplicate.state).toBe(observed.state);
        expect((yield* run(observed.state, { _tag: 'RetryAccountingSync', invoiceRef: ref })).changed).toBe(false);
        yield* fails(observed.state, {
          _tag: 'ApplyAccountingObservation',
          correlation: invoice.accountingCorrelation,
          invoiceRef: ref,
          receipt: 'different-receipt',
          resultId: 'success-result',
          status: 'SUCCESS',
        });
        expect(Schema.is(FinanceStateSchema)(observed.state)).toBe(true);
      }),
  );
  it.effect(
    'cumulative partial/full payments preserve accounting failure, reject overpayment and regressions, and replay without another observation',
    () =>
      Effect.gen(function* financeCase2() {
        const command: FinanceCommand = {
          _tag: 'ApplyPaymentObservation',
          confirmedPaidMinor: 900_000,
          correlation: 'payment-b201',
          currency: 'CZK',
          invoiceRef: ref,
          resultId: 'payment-half',
        };
        const half = yield* run(state, command);
        expect(half.invoice.paymentState).toBe('PARTIALLY_PAID');
        expect(half.invoice.accountingSyncState).toBe('FAILED');
        expect(half.state.paymentObservations).toHaveLength(1);
        expect(projectFinanceRecords(half.state, 1, {}).indicators.receivablesOutstandingMinor).toBe(900_000);
        expect(projectFinanceRecords(half.state, 1, {}).indicators.overdueInvoices).toBe(1);
        expect((yield* run(half.state, command)).changed).toBe(false);
        yield* fails(half.state, {
          ...command,
          correlation: 'changed-payment-correlation',
          resultId: 'new-correlation',
        });
        yield* fails(half.state, { ...command, confirmedPaidMinor: 800_000, resultId: 'regression' });
        yield* fails(half.state, { ...command, confirmedPaidMinor: 1_800_001, resultId: 'overpayment' });
        yield* fails(half.state, { ...command, confirmedPaidMinor: 800_000 });
        const paid = yield* run(half.state, { ...command, confirmedPaidMinor: 1_800_000, resultId: 'payment-full' });
        expect(paid.invoice.paymentState).toBe('PAID');
        expect(paid.invoice.accountingSyncState).toBe('FAILED');
        expect(projectFinanceRecords(paid.state, 2, {}).indicators.overdueInvoices).toBe(0);
        expect(projectFinanceRecords(paid.state, 2, {}).indicators.integrationWarnings).toBe(1);
      }),
  );
  it.effect('late duplicate failed result after a retry does not replace a newer pending outcome', () =>
    Effect.gen(function* financeCase3() {
      const pending = yield* run(state, { _tag: 'RetryAccountingSync', invoiceRef: ref });
      const replay = yield* run(pending.state, {
        _tag: 'ApplyAccountingObservation',
        correlation: invoice.accountingCorrelation,
        invoiceRef: ref,
        resultId: 'failed-result',
        status: 'FAILED',
      });
      expect(replay.changed).toBe(false);
      expect(replay.invoice.accountingSyncState).toBe('PENDING');
      yield* fails(pending.state, {
        _tag: 'ApplyAccountingObservation',
        correlation: 'foreign-correlation',
        invoiceRef: ref,
        resultId: 'foreign-result',
        status: 'FAILED',
      });
    }),
  );
  it.effect(
    'creates and updates only drafts, requires valid supplier property anchors, and rejects unavailable/foreign references',
    () =>
      Effect.gen(function* financeCase4() {
        const create: FinanceCommand = {
          _tag: 'CreateInvoiceDraft',
          counterpartyRef,
          currency: 'CZK',
          direction: 'INCOMING',
          documentNumber: 'SUP-NEW',
          dueDate: '2026-10-15',
          issueDate: '2026-10-05',
          note: 'Preserve the supplier note',
          totalMinor: 420_000,
        };
        const draft = yield* run(state, create);
        expect(draft.invoice.businessState).toBe('DRAFT');
        expect(draft.invoice.accountingSyncState).toBe('NOT_SYNCED');
        yield* fails(draft.state, { _tag: 'ConfirmInvoice', invoiceRef: draft.invoice.ref });
        const updated = yield* run(draft.state, {
          ...create,
          _tag: 'UpdateInvoiceDraft',
          invoiceRef: draft.invoice.ref,
          propertyRef,
        });
        const editFields = yield* Schema.decodeEffect(Schema.Struct(InvoiceDraftFields))(updated.invoice);
        const edited = yield* run(updated.state, {
          ...editFields,
          _tag: 'UpdateInvoiceDraft',
          documentNumber: 'SUP-EDITED',
          dueDate: '2026-10-20',
          invoiceRef: updated.invoice.ref,
          issueDate: '2026-10-06',
          totalMinor: 425_000,
        });
        expect(edited.invoice).toMatchObject({
          accountingSyncState: 'NOT_SYNCED',
          businessState: 'DRAFT',
          counterpartyRef,
          currency: 'CZK',
          direction: 'INCOMING',
          documentNumber: 'SUP-EDITED',
          dueDate: '2026-10-20',
          issueDate: '2026-10-06',
          note: 'Preserve the supplier note',
          paymentState: 'UNPAID',
          propertyRef,
          totalMinor: 425_000,
        });
        const confirmed = yield* run(edited.state, { _tag: 'ConfirmInvoice', invoiceRef: draft.invoice.ref });
        expect(confirmed.invoice.businessState).toBe('CONFIRMED');
        yield* fails(confirmed.state, {
          ...create,
          _tag: 'UpdateInvoiceDraft',
          invoiceRef: draft.invoice.ref,
          propertyRef,
        });
        yield* fails(state, {
          ...create,
          counterpartyRef: { ...counterpartyRef, tenantId: 'b0000000-0000-4000-8000-000000000001' },
        });
        yield* fails(state, { ...create, dueDate: '2026-10-04' });
        const unavailable: FinanceValidators = {
          invoice: () =>
            Effect.fail(new FinanceRejected({ code: 'finance_rejected', reason: 'counterparty_not_usable' })),
        };
        expect(Exit.isFailure(yield* Effect.exit(transitionFinance(state, create, scope, unavailable, input)))).toBe(
          true,
        );
        yield* fails(state, { _tag: 'VoidInvoice', invoiceRef: { ...ref, resourceId: 'missing' } });
      }),
  );
  it.effect('requires explicit request state and protects paid or synchronized invoices from voiding', () =>
    Effect.gen(function* financeCase5() {
      yield* fails(state, { _tag: 'RequestAccountingSync', invoiceRef: ref });
      const unsent = {
        ...state,
        accountingObservations: [],
        invoices: [{ ...invoice, accountingSyncState: 'NOT_SYNCED' as const }],
      };
      const pending = yield* run(unsent, { _tag: 'RequestAccountingSync', invoiceRef: ref });
      yield* fails(pending.state, { _tag: 'VoidInvoice', invoiceRef: ref });
      yield* fails(pending.state, { _tag: 'RetryAccountingSync', invoiceRef: ref });
      const paid = yield* run(state, {
        _tag: 'ApplyPaymentObservation',
        confirmedPaidMinor: invoice.totalMinor,
        correlation: 'payment-b201',
        currency: 'CZK',
        invoiceRef: ref,
        resultId: 'paid',
      });
      yield* fails(paid.state, { _tag: 'VoidInvoice', invoiceRef: ref });
      const voided = yield* run(unsent, { _tag: 'VoidInvoice', invoiceRef: ref });
      expect(projectFinanceRecords(voided.state, 1, {}).indicators.revenueMinor).toBe(0);
    }),
  );
});
describe('Finance calendar and projection', () => {
  it('rejects impossible dates and fractional, negative or oversized amounts at the public contract', () => {
    expect(Schema.is(CalendarDateSchema)('2026-02-29')).toBe(false);
    expect(Schema.is(CalendarDateSchema)('2024-02-29')).toBe(true);
    for (const totalMinor of [-1, 1.5, 1_000_000_000_001]) {
      expect(Schema.is(FinanceCommandSchema)({ _tag: 'CreateInvoiceDraft', ...invoice, totalMinor })).toBe(false);
    }
  });
  it('derives exact baseline/golden totals, calendar inclusion, property filters and outgoing/incoming balances', () => {
    const outgoingPaid: Invoice = {
      ...invoice,
      accountingSyncState: 'SYNCED',
      paidMinor: 1_600_000,
      paymentState: 'PAID',
      ref: { ...ref, resourceId: 'a102' },
      totalMinor: 1_600_000,
    };
    const incomingPark: Invoice = {
      ...invoice,
      accountingSyncState: 'SYNCED',
      direction: 'INCOMING',
      dueDate: '2026-10-10',
      propertyRef: { ...propertyRef, resourceId: 'a0000000-0000-4000-8000-000000000011' },
      ref: { ...ref, resourceId: 'park-cost' },
      totalMinor: 420_000,
    };
    const incomingRiver: Invoice = {
      ...incomingPark,
      propertyRef,
      ref: { ...ref, resourceId: 'river-cost' },
      totalMinor: 260_000,
    };
    const baseline: FinanceState = {
      ...state,
      financialPlanEntries: [
        {
          category: 'rent',
          currency: 'CZK',
          kind: 'REVENUE',
          periodEndExclusive: '2027-01-01',
          periodStart: '2026-01-01',
          plannedMinor: 10_000_000,
          propertyRef,
          ref: {
            moduleId: 'siampark.billing-finance',
            resourceId: 'plan-revenue',
            resourceType: 'siampark.billing-finance.financial-plan-entry',
            tenantId,
          },
          state: 'CONFIRMED',
        },
        {
          category: 'cost',
          currency: 'CZK',
          kind: 'COST',
          periodEndExclusive: '2027-01-01',
          periodStart: '2026-01-01',
          plannedMinor: 1_000_000,
          propertyRef,
          ref: {
            moduleId: 'siampark.billing-finance',
            resourceId: 'plan-cost',
            resourceType: 'siampark.billing-finance.financial-plan-entry',
            tenantId,
          },
          state: 'CONFIRMED',
        },
      ],
      invoices: [outgoingPaid, invoice, incomingPark, incomingRiver],
    };
    const result = projectFinanceRecords(baseline, 0, {});
    expect(result.indicators).toMatchObject({
      costMinor: 680_000,
      costVarianceMinor: -320_000,
      grossOutstandingMinor: 2_480_000,
      openInvoices: 3,
      overdueInvoices: 1,
      payablesOutstandingMinor: 680_000,
      receivablesOutstandingMinor: 1_800_000,
      revenueMinor: 3_400_000,
      revenueVarianceMinor: -6_600_000,
    });
    expect(Schema.is(RecordsResponseSchema)({ ...result, canWrite: false })).toBe(true);
    const golden = projectFinanceRecords(
      {
        ...baseline,
        invoices: [
          ...baseline.invoices,
          {
            ...invoice,
            accountingSyncState: 'SYNCED',
            dueDate: '2026-10-15',
            ref: { ...ref, resourceId: 'a101' },
            totalMinor: 1_500_000,
          },
        ],
      },
      4,
      {},
    );
    expect(golden.indicators).toMatchObject({
      costMinor: 680_000,
      grossOutstandingMinor: 3_980_000,
      openInvoices: 4,
      overdueInvoices: 1,
      revenueMinor: 4_900_000,
    });
    expect(
      projectFinanceRecords(baseline, 0, { propertyId: 'a0000000-0000-4000-8000-000000000011' }).indicators.costMinor,
    ).toBe(420_000);
    expect(projectFinanceRecords(baseline, 0, { resourceId: 'invoice-b201' }).state.invoices).toHaveLength(1);
    expect(
      projectFinanceRecords(
        { ...state, invoices: [{ ...invoice, dueDate: '2027-01-02', issueDate: '2027-01-01' }] },
        0,
        {},
      ).indicators.revenueMinor,
    ).toBe(0);
  });
});

const paymentTestDependencies = Layer.mergeAll(
  Layer.succeed(ActiveApplicationCompositionService, {
    load: Effect.die('A payment observation must not load foreign composition'),
  }),
  Layer.succeed(GatewayPrincipalVerifierConfiguration, {
    configuration: Effect.die('A payment observation must not request a foreign assertion'),
  }),
  Layer.succeed(
    HttpServerRequest.HttpServerRequest,
    HttpServerRequest.fromWeb(new Request('http://localhost:4115/finance-action-test')),
  ),
);

it.layer(paymentTestDependencies)('Finance Action lifecycle', (suite) => {
  suite.effect(
    'payment Action commits through the real Core collector and response codec, then rejects stale revision',
    () =>
      Effect.gen(function* paymentActionCollectorRegression() {
        let storedState = state;
        let revision = 0;
        const harness = yield* makeActionTestHarness({
          actionPermission: 'allowed',
          services: [
            bindActionTestServices(applyCommandAction, {
              load: () => Effect.succeed({ revision, state: storedState }),
              save: (nextState, expectedRevision) =>
                requireFinanceRevision(revision, expectedRevision).pipe(
                  Effect.flatMap(() => Schema.encodeEffect(FinanceStateSchema)(nextState)),
                  Effect.flatMap(Schema.decodeEffect(FinanceStateSchema)),
                  Effect.mapError(
                    () =>
                      new FinancePersistenceUnavailable({
                        code: 'finance_persistence_unavailable',
                        reason: 'Test persistence codec failed',
                      }),
                  ),
                  Effect.map((decoded) => {
                    storedState = decoded;
                    revision += 1;
                    return revision;
                  }),
                ),
              validators,
            }),
          ],
        });
        const principal = {
          authBindingId: 'a0000000-0000-4000-8000-000000000003',
          authContextRef: 'better-auth-session:finance-collector-test',
          authMethod: 'session' as const,
          legalEntityId,
          principalId: 'a0000000-0000-4000-8000-000000000004',
          tenantId,
        };
        const payload = {
          command: {
            _tag: 'ApplyPaymentObservation' as const,
            confirmedPaidMinor: invoice.totalMinor,
            correlation: 'payment-b201',
            currency: 'CZK' as const,
            invoiceRef: ref,
            resultId: 'payment-action-full',
          },
          expectedRevision: 0,
        };
        const result = yield* harness.runtime.runAction({
          payload,
          principal,
          registration: applyCommandAction,
          transport: { correlationId: 'finance-payment-action', idempotencyKey: 'finance-payment-action-1' },
        });
        expect(result.invoice.paymentState).toBe('PAID');
        expect(result.invoice.accountingSyncState).toBe('FAILED');
        expect(storedState.paymentObservations).toHaveLength(1);
        expect(harness.snapshot().committed).toHaveLength(1);
        expect(harness.snapshot().committed[0]?.evidence.dataAccessEvents).toHaveLength(1);
        expect(revision).toBe(1);
        const stale = yield* harness.runtime
          .runAction({
            payload: { ...payload, command: { ...payload.command, resultId: 'another-payment' } },
            principal,
            registration: applyCommandAction,
            transport: { correlationId: 'finance-stale-action', idempotencyKey: 'finance-payment-action-2' },
          })
          .pipe(Effect.flip);
        expect(Schema.is(FinanceConflict)(stale)).toBe(true);
        expect(storedState.paymentObservations).toHaveLength(1);
        expect(revision).toBe(1);
      }),
  );
});

it.layer(
  Layer.succeed(ActionPermission, {
    checkActionPermission: (request) => {
      expect(request).toEqual({
        actionKey: 'siampark.billing-finance.apply-command',
        ...capabilityScope,
      });
      return Effect.succeed('allowed');
    },
  }),
)('Finance authorized capabilities', (suite) => {
  suite.effect('exposes writes only after the exact existing Action permission is allowed', () =>
    Effect.gen(function* allowedCapability() {
      expect(yield* financeWriteCapability(capabilityScope)).toBe(true);
    }),
  );
});

it.layer(
  Layer.succeed(ActionPermission, {
    checkActionPermission: () => Effect.succeed('denied'),
  }),
)('Finance readonly capabilities', (suite) => {
  suite.effect('keeps a legitimate readonly reader without mutation capability', () =>
    Effect.gen(function* readonlyCapability() {
      expect(yield* financeWriteCapability(capabilityScope)).toBe(false);
    }),
  );
});

it.layer(
  Layer.succeed(ActionPermission, {
    checkActionPermission: () =>
      Effect.fail(
        new ActionPermissionCheckError({
          code: 'action_permission_check_failed',
          reason: 'The native permission service is unavailable',
        }),
      ),
  }),
)('Finance unavailable capabilities', (suite) => {
  suite.effect('fails closed with a typed unavailable error instead of exposing editable records', () =>
    Effect.gen(function* unavailableCapability() {
      const failure = yield* Effect.flip(financeWriteCapability(capabilityScope));
      expect(Schema.is(OperationContextUnavailable)(failure)).toBe(true);
    }),
  );
});
