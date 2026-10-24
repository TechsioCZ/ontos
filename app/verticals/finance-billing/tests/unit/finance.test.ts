import { describe, expect, it } from 'effect-rstest';
import { ActionPermissionCheckError, OperationContextUnavailable } from '@app/core-runtime';
import { ActionPermission } from '@app/core-runtime/actions/runtime-wiring';
import { OAuthConnectionContextSchema } from '@app/core-runtime/actions/principal-context';
import { financeWriteCapability } from '../../src/api/records.read.ts';
import { DateTime, Effect, Exit, Layer, Schema } from 'effect';
import type { FinanceCommand } from '../../shared/actions/apply-command.ts';
import { FinanceRejected, FinanceCommandSchema } from '../../shared/actions/apply-command.ts';
import { CalendarDateSchema, InvoiceDraftFields, RecordsResponseSchema } from '../../shared/apis/records.ts';
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
const capabilityScope = {
  correlationId: 'finance-read-capability',
  legalEntityId,
  principalId: 'finance-actor',
  tenantId,
};
const input = { attemptId: 'attempt-retry', now, resourceId: 'invoice-new' };
const scope = { legalEntityId, tenantId };
const ref = {
  moduleId: 'finance.billing' as const,
  resourceId: 'invoice-b201',
  resourceType: 'finance.billing.invoice' as const,
  tenantId,
};
const propertyRef = {
  moduleId: 'property.portfolio' as const,
  resourceId: 'a0000000-0000-4000-8000-000000000010',
  resourceType: 'property.portfolio.property' as const,
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
  financialPlanEntries: [],
  invoices: [invoice],
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
  it.effect('creates and updates only drafts and rejects unavailable/foreign references', () =>
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
      expect(draft.invoice!.businessState).toBe('DRAFT');
      expect(draft.invoice!.accountingSyncState).toBe('NOT_SYNCED');
      const updated = yield* run(draft.state, {
        ...create,
        _tag: 'UpdateInvoiceDraft',
        invoiceRef: draft.invoice!.ref,
        propertyRef,
      });
      const editFields = yield* Schema.decodeEffect(Schema.Struct(InvoiceDraftFields))(updated.invoice!);
      const edited = yield* run(updated.state, {
        ...editFields,
        _tag: 'UpdateInvoiceDraft',
        documentNumber: 'SUP-EDITED',
        dueDate: '2026-10-20',
        invoiceRef: updated.invoice!.ref,
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
      const prepared = yield* run(edited.state, { _tag: 'MarkInvoicesPrepared', invoiceRefs: [draft.invoice!.ref] });
      const confirmed = yield* run(prepared.state, { _tag: 'ConfirmInvoice', invoiceRef: draft.invoice!.ref });
      expect(confirmed.invoice!.businessState).toBe('CONFIRMED');
      yield* fails(confirmed.state, {
        ...create,
        _tag: 'UpdateInvoiceDraft',
        invoiceRef: draft.invoice!.ref,
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
            moduleId: 'finance.billing',
            resourceId: 'plan-revenue',
            resourceType: 'finance.billing.financial-plan-entry',
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
            moduleId: 'finance.billing',
            resourceId: 'plan-cost',
            resourceType: 'finance.billing.financial-plan-entry',
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

it.layer(
  Layer.succeed(ActionPermission, {
    checkActionPermission: (request) => {
      expect(request).toEqual({
        actionKey: 'finance.billing.apply-command',
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

const connection = (input: unknown) => Schema.decodeUnknownSync(OAuthConnectionContextSchema)(input);

it.layer(
  Layer.succeed(ActionPermission, {
    checkActionPermission: () => Effect.succeed('allowed'),
  }),
)('Finance capabilities under an MCP connection', (suite) => {
  suite.effect('a read-only connection never reports write ability; a direct one with finance write does', () =>
    Effect.gen(function* connectionCapability() {
      const base = { clientId: 'client-1', clientName: 'Claude', grantId: '11111111-1111-4111-8111-111111111111' };
      expect(
        yield* financeWriteCapability({
          ...capabilityScope,
          authMethod: 'oauth_connection',
          connection: connection({ ...base, modules: 'all', writePolicy: 'read_only' }),
        }),
      ).toBe(false);
      expect(
        yield* financeWriteCapability({
          ...capabilityScope,
          authMethod: 'oauth_connection',
          connection: connection({
            ...base,
            modules: [{ access: 'write', moduleId: 'finance.billing' }],
            writePolicy: 'direct',
          }),
        }),
      ).toBe(true);
    }),
  );
});

it('filters related invoices by the exact Counterparty ref, including invoices without a Party snapshot', () => {
  const otherContext = { ...counterpartyRef, resourceId: 'other-counterparty' };
  const otherTenant = { ...counterpartyRef, tenantId: 'a0000000-0000-4000-8000-000000000099' };
  const fixture: FinanceState = {
    ...state,
    invoices: [
      invoice,
      { ...invoice, counterpartyRef: otherContext, ref: { ...ref, resourceId: 'unrelated-context' } },
      { ...invoice, counterpartyRef: otherTenant, ref: { ...ref, resourceId: 'unrelated-tenant' } },
    ],
  };
  expect(
    projectFinanceRecords(fixture, 0, { counterpartyRef }).state.invoices.map((item) => item.ref.resourceId),
  ).toEqual([ref.resourceId]);
  expect(
    projectFinanceRecords(fixture, 0, { counterpartyRef: otherContext }).state.invoices.map(
      (item) => item.ref.resourceId,
    ),
  ).toEqual(['unrelated-context']);
  expect(projectFinanceRecords(fixture, 0, {}).state.invoices).toHaveLength(3);
});

it('never substitutes a Counterparty ID for a missing Party ID in related invoice filters', () => {
  const partyId = 'party-different-from-counterparty';
  const fixture: FinanceState = {
    ...state,
    invoices: [invoice, { ...invoice, partyId, ref: { ...ref, resourceId: 'with-party' } }],
  };
  expect(projectFinanceRecords(fixture, 0, { partyId: counterpartyRef.resourceId }).state.invoices).toEqual([]);
  expect(projectFinanceRecords(fixture, 0, { partyId }).state.invoices.map((item) => item.ref.resourceId)).toEqual([
    ref.resourceId,
    'with-party',
  ]);
});

it('keeps legacy Party-filtered balances identical to Counterparty entry points without crossing identities', () => {
  const partyId = 'party-linked';
  const partial = { ...invoice, totalMinor: 100_000, paidMinor: 40_000, paymentState: 'PARTIALLY_PAID' as const };
  const fixture: FinanceState = {
    ...state,
    invoices: [
      partial,
      { ...invoice, partyId, businessState: 'DRAFT', ref: { ...ref, resourceId: 'linked-draft' } },
      { ...invoice, counterpartyRef: { ...counterpartyRef, tenantId: 'other-tenant' } },
      { ...invoice, counterpartyRef: { ...counterpartyRef, resourceId: 'other-counterparty' } },
      { ...invoice, partyId: 'explicitly-other-party', ref: { ...ref, resourceId: 'different-party' } },
    ],
  };
  const related = projectFinanceRecords(fixture, 1, { partyId }, '2026-10-20');
  expect(related.state.invoices.map((item) => item.ref.resourceId)).toEqual([ref.resourceId, 'linked-draft']);
  expect(related.indicators.receivablesOutstandingMinor).toBe(60_000);
  expect(related.indicators.overdueInvoices).toBe(1);
  expect(projectFinanceRecords(fixture, 1, { partyId: 'unknown-party' }).state.invoices).toEqual([]);
  // A resource/property filter must not erase the sibling invoice that establishes the Party relationship.
  expect(projectFinanceRecords(fixture, 1, { partyId, resourceId: ref.resourceId }).state.invoices).toEqual([partial]);
  expect(
    projectFinanceRecords(fixture, 1, {
      partyId,
      counterpartyRef: { ...counterpartyRef, resourceId: 'other-counterparty' },
    }).state.invoices,
  ).toEqual([]);
});
