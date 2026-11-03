import { DateTime, Effect, Result, Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import { FinanceCommandSchema, FinanceConflict } from '../../shared/actions/apply-command.ts';
import { FinanceStateSchema } from '../../shared/apis/records.ts';
import type { FinanceState, Invoice } from '../../shared/apis/records.ts';
import { derivePaymentState, transitionFinance } from '../../src/services/persistence.service.ts';
import type { FinanceValidators } from '../../src/services/persistence.service.ts';

const tenantId = 'a0000000-0000-4000-8000-000000000001';
const scope = { legalEntityId: 'a0000000-0000-4000-8000-000000000002', tenantId };
const now = DateTime.makeUnsafe('2026-10-21T08:00:00Z');
const invoice = (overrides: Partial<Invoice> = {}): Invoice => ({
  accountingCorrelation: 'reminder-invoice',
  accountingSyncState: 'NOT_SYNCED',
  businessState: 'CONFIRMED',
  counterpartyRef: {
    moduleId: 'party.registry',
    resourceId: 'a0000000-0000-4000-8000-000000000012',
    resourceType: 'party.registry.counterparty',
    tenantId,
  },
  createdAt: now,
  currency: 'CZK',
  direction: 'OUTGOING',
  documentNumber: 'FV-REMINDER',
  dueDate: '2026-10-20',
  issueDate: '2026-10-01',
  paidMinor: 0,
  paymentState: 'UNPAID',
  ref: {
    moduleId: 'finance.billing',
    resourceId: 'reminder-invoice',
    resourceType: 'finance.billing.invoice',
    tenantId,
  },
  totalMinor: 100_000,
  updatedAt: now,
  ...overrides,
});
const validators: FinanceValidators = { invoice: () => Effect.void };
const run = (state: FinanceState) =>
  Schema.decodeEffect(FinanceCommandSchema)({
    _tag: 'RecordReminder',
    actorLabel: 'Finance',
    invoiceRef: invoice().ref,
    recipient: 'recipient@company.example',
    text: 'Prosíme o úhradu faktury.',
  }).pipe(
    Effect.flatMap((command) =>
      transitionFinance(state, command, scope, validators, {
        attemptId: 'reminder-attempt',
        now,
        principalId: 'a0000000-0000-4000-8000-000000000003',
        resourceId: 'reminder-resource',
      }),
    ),
  );

it.effect('RecordReminder refuses incoming invoices, including partially paid supplier invoices', () =>
  Effect.gen(function* incomingReminders() {
    for (const paidMinor of [0, 50_000]) {
      const state: FinanceState = {
        financialPlanEntries: [],
        invoices: [
          invoice({
            direction: 'INCOMING',
            paidMinor,
            paymentState: derivePaymentState(paidMinor, 100_000),
          }),
        ],
        reminders: [],
      };
      const before = yield* Schema.encodeEffect(FinanceStateSchema)(state);
      const result = yield* run(state).pipe(Effect.result);
      expect(Result.isFailure(result)).toBe(true);
      if (Result.isFailure(result)) {
        expect(Schema.is(FinanceConflict)(result.failure)).toBe(true);
      }
      expect(yield* Schema.encodeEffect(FinanceStateSchema)(state)).toEqual(before);
      expect(state.reminders).toEqual([]);
    }
  }),
);

it.effect('RecordReminder still queues confirmed outgoing unpaid and partially paid invoices with the actor', () =>
  Effect.gen(function* outgoingReminders() {
    for (const paidMinor of [0, 50_000]) {
      const state: FinanceState = {
        financialPlanEntries: [],
        invoices: [invoice({ paidMinor, paymentState: derivePaymentState(paidMinor, 100_000) })],
      };
      const result = yield* run(state);
      expect(result.state.reminders).toEqual([
        {
          actorLabel: 'Finance',
          actorPrincipalId: 'a0000000-0000-4000-8000-000000000003',
          createdAt: now,
          deliveryMode: 'EMAIL',
          id: 'reminder-attempt',
          invoiceResourceId: 'reminder-invoice',
          recipient: 'recipient@company.example',
          status: 'QUEUED',
          text: 'Prosíme o úhradu faktury.',
        },
      ]);
      expect(result.state.invoices).toEqual(state.invoices);
    }
  }),
);

it.effect('RecordReminder keeps rejecting draft, voided and settled outgoing invoices', () =>
  Effect.gen(function* closedReminders() {
    const invoices = [
      invoice({ businessState: 'DRAFT' }),
      invoice({ businessState: 'VOIDED' }),
      invoice({ paidMinor: 100_000, paymentState: derivePaymentState(100_000, 100_000) }),
    ];
    for (const entry of invoices) {
      const result = yield* run({ financialPlanEntries: [], invoices: [entry] }).pipe(Effect.result);
      expect(Result.isFailure(result)).toBe(true);
      if (Result.isFailure(result)) {
        expect(Schema.is(FinanceConflict)(result.failure)).toBe(true);
      }
    }
  }),
);
