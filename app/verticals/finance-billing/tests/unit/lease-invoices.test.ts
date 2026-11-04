import { ReadHandlerNotFound, ReadHandlerUnavailable, ReadInputValidationError } from '@app/core-runtime';
import { Effect, Option, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';
import { InvoiceSchema } from '../../shared/apis/records.ts';
import type { FinanceState, Invoice } from '../../shared/apis/records.ts';
import type { LeaseInvoicesRequest } from '../../shared/apis/lease-invoices.ts';
import {
  decodeLeaseInvoiceCursor,
  encodeLeaseInvoiceCursor,
  selectLeaseInvoicesPage,
} from '../../src/api/lease-invoices.read.ts';
import type { LeaseInvoiceCursor } from '../../src/api/lease-invoices.read.ts';

const tenantId = 'a0000000-0000-4000-8000-000000000001';
const otherTenant = 'a0000000-0000-4000-8000-000000000099';
const legalEntityId = 'a0000000-0000-4000-8000-000000000002';
const scope = { legalEntityId, tenantId } as const;
const uuid = (suffix: string) => `a0000000-0000-4000-8000-${suffix.padStart(12, '0')}`;
const ref = (resourceId: string) => ({
  moduleId: 'finance.billing' as const,
  resourceId,
  resourceType: 'finance.billing.invoice' as const,
  tenantId,
});
const unitRef = (suffix: string, tenant = tenantId) => ({
  moduleId: 'property.portfolio' as const,
  resourceId: uuid(suffix),
  resourceType: 'property.portfolio.unit' as const,
  tenantId: tenant,
});
const occupancyRef = (suffix: string, tenant = tenantId) => ({
  moduleId: 'property.leasing' as const,
  resourceId: uuid(suffix),
  resourceType: 'property.leasing.occupancy' as const,
  tenantId: tenant,
});
const counterpartyRef = (suffix: string, tenant = tenantId) => ({
  moduleId: 'party.registry' as const,
  resourceId: uuid(suffix),
  resourceType: 'party.registry.counterparty' as const,
  tenantId: tenant,
});

const invoice = (resourceId: string, fields: Partial<typeof InvoiceSchema.Encoded> = {}) =>
  Schema.decodeSync(InvoiceSchema)({
    accountingCorrelation: `correlation-${resourceId}`,
    accountingSyncState: 'NOT_SYNCED',
    businessState: 'CONFIRMED',
    counterpartyRef: counterpartyRef('1'),
    createdAt: '2026-10-01T09:00:00.000Z',
    currency: 'CZK',
    direction: 'OUTGOING',
    documentNumber: `Invoice ${resourceId}`,
    dueDate: '2026-10-31',
    issueDate: '2026-10-01',
    paidMinor: 0,
    paymentState: 'UNPAID',
    ref: ref(resourceId),
    totalMinor: 10_000,
    updatedAt: '2026-10-01T09:00:00.000Z',
    ...fields,
  });

const stateOf = (...invoices: readonly Invoice[]): FinanceState => ({
  financialPlanEntries: [],
  invoices: [...invoices],
});
const request = (overrides: Partial<LeaseInvoicesRequest> = {}): LeaseInvoicesRequest => ({
  counterpartyRef: counterpartyRef('1'),
  limit: 200,
  occupancyRef: occupancyRef('1'),
  unitRef: unitRef('1'),
  ...overrides,
});
const cursorFor = (overrides: Partial<LeaseInvoiceCursor> = {}) =>
  encodeLeaseInvoiceCursor({
    afterId: 'invoice-1',
    counterpartyRef: counterpartyRef('1'),
    legalEntityId,
    occupancyRef: occupancyRef('1'),
    revision: 7,
    tenantId,
    unitRef: unitRef('1'),
    version: 1,
    ...overrides,
  });

describe('governed lease-invoices owner read', () => {
  it.effect('keeps only a full Occupancy match or, without one, a full Unit and Counterparty match', () =>
    Effect.gen(function* sourcePredicate() {
      const occupancyLinked = invoice('invoice-1', {
        counterpartyRef: counterpartyRef('3'),
        occupancyRef: occupancyRef('1'),
        unitRef: unitRef('9'),
      });
      const fallback = invoice('invoice-2', {
        counterpartyRef: counterpartyRef('1'),
        unitRef: unitRef('1'),
      });
      const wrongUnit = invoice('invoice-3', {
        counterpartyRef: counterpartyRef('1'),
        unitRef: unitRef('2'),
      });
      const wrongCounterparty = invoice('invoice-4', {
        counterpartyRef: counterpartyRef('2'),
        unitRef: unitRef('1'),
      });
      const foreignOccupancy = invoice('invoice-5', { occupancyRef: occupancyRef('1', otherTenant) });
      const state = stateOf(occupancyLinked, fallback, wrongUnit, wrongCounterparty, foreignOccupancy);
      const page = yield* selectLeaseInvoicesPage(state, 7, scope, request());
      expect(page.invoices).toEqual([occupancyLinked, fallback]);
      expect(page.revision).toBe(7);
      expect(page.nextCursor).toBeUndefined();

      const withoutCounterparty = yield* selectLeaseInvoicesPage(state, 7, scope, {
        limit: 200,
        occupancyRef: occupancyRef('1'),
        unitRef: unitRef('1'),
      });
      expect(withoutCounterparty.invoices).toEqual([occupancyLinked]);
    }),
  );

  it.effect('denies foreign-tenant references and requires a selected Legal Entity', () =>
    Effect.gen(function* tenantScopeDenial() {
      const foreign = yield* Effect.flip(
        selectLeaseInvoicesPage(stateOf(), 7, scope, request({ occupancyRef: occupancyRef('1', otherTenant) })),
      );
      expect(Schema.is(ReadHandlerNotFound)(foreign)).toBe(true);
      const foreignCounterparty = yield* Effect.flip(
        selectLeaseInvoicesPage(stateOf(), 7, scope, request({ counterpartyRef: counterpartyRef('1', otherTenant) })),
      );
      expect(Schema.is(ReadHandlerNotFound)(foreignCounterparty)).toBe(true);
      const missingCompany = yield* Effect.flip(selectLeaseInvoicesPage(stateOf(), 7, { tenantId }, request()));
      expect(Schema.is(ReadHandlerUnavailable)(missingCompany)).toBe(true);
    }),
  );

  it.effect('collects every match exactly once across pages ordered by invoice id', () =>
    Effect.gen(function* completeCollection() {
      const invoices = Array.from({ length: 5 }, (_, index) =>
        invoice(`invoice-${index + 1}`, { occupancyRef: occupancyRef('1') }),
      );
      const state = stateOf(...invoices);
      const first = yield* selectLeaseInvoicesPage(state, 7, scope, request({ limit: 2 }));
      expect(first.invoices.map((entry) => entry.ref.resourceId)).toEqual(['invoice-1', 'invoice-2']);
      const firstCursor = first.nextCursor ?? (yield* Effect.die('the first page must continue'));
      const second = yield* selectLeaseInvoicesPage(state, 7, scope, request({ cursor: firstCursor, limit: 2 }));
      expect(second.invoices.map((entry) => entry.ref.resourceId)).toEqual(['invoice-3', 'invoice-4']);
      const secondCursor = second.nextCursor ?? (yield* Effect.die('the second page must continue'));
      const third = yield* selectLeaseInvoicesPage(state, 7, scope, request({ cursor: secondCursor, limit: 2 }));
      expect(third.invoices.map((entry) => entry.ref.resourceId)).toEqual(['invoice-5']);
      expect(third.nextCursor).toBeUndefined();
      const collected = [...first.invoices, ...second.invoices, ...third.invoices];
      expect(collected).toHaveLength(5);
      expect(new Set(collected.map((entry) => entry.ref.resourceId)).size).toBe(5);
    }),
  );

  it.effect('rejects a cursor from another revision, scope, filter or position instead of mixing results', () =>
    Effect.gen(function* cursorTampering() {
      const state = stateOf(
        invoice('invoice-1', { occupancyRef: occupancyRef('1') }),
        invoice('invoice-2', { occupancyRef: occupancyRef('1') }),
      );
      const revisionDrift = yield* Effect.flip(
        selectLeaseInvoicesPage(state, 7, scope, request({ cursor: cursorFor({ revision: 8 }) })),
      );
      expect(Schema.is(ReadHandlerUnavailable)(revisionDrift)).toBe(true);
      const scopeDrift = yield* Effect.flip(
        selectLeaseInvoicesPage(state, 7, scope, request({ cursor: cursorFor({ legalEntityId: otherTenant }) })),
      );
      expect(Schema.is(ReadInputValidationError)(scopeDrift)).toBe(true);
      const filterDrift = yield* Effect.flip(
        selectLeaseInvoicesPage(state, 7, scope, request({ cursor: cursorFor({ occupancyRef: occupancyRef('2') }) })),
      );
      expect(Schema.is(ReadInputValidationError)(filterDrift)).toBe(true);
      const noCounterpartyCursor = encodeLeaseInvoiceCursor({
        afterId: 'invoice-1',
        legalEntityId,
        occupancyRef: occupancyRef('1'),
        revision: 7,
        tenantId,
        unitRef: unitRef('1'),
        version: 1,
      });
      const counterpartyDrift = yield* Effect.flip(
        selectLeaseInvoicesPage(state, 7, scope, request({ cursor: noCounterpartyCursor })),
      );
      expect(Schema.is(ReadInputValidationError)(counterpartyDrift)).toBe(true);
      const malformed = yield* Effect.flip(
        selectLeaseInvoicesPage(state, 7, scope, request({ cursor: 'not-a-cursor' })),
      );
      expect(Schema.is(ReadInputValidationError)(malformed)).toBe(true);
      const missingAnchor = yield* Effect.flip(
        selectLeaseInvoicesPage(state, 7, scope, request({ cursor: cursorFor({ afterId: 'invoice-9' }) })),
      );
      expect(Schema.is(ReadInputValidationError)(missingAnchor)).toBe(true);
    }),
  );

  it.effect('round-trips the exact request and scope binding through the cursor encoding', () =>
    Effect.sync(() => {
      const cursor = cursorFor();
      const decoded = Option.getOrThrow(decodeLeaseInvoiceCursor(cursor));
      expect(decoded.afterId).toBe('invoice-1');
      expect(decoded.revision).toBe(7);
      expect(decoded.tenantId).toBe(tenantId);
      expect(decoded.legalEntityId).toBe(legalEntityId);
      expect(decoded.occupancyRef.resourceId).toBe(uuid('1'));
      expect(decoded.unitRef.resourceId).toBe(uuid('1'));
      expect(decoded.counterpartyRef?.resourceId).toBe(uuid('1'));
      expect(Option.isNone(decodeLeaseInvoiceCursor('not-a-cursor'))).toBe(true);
    }),
  );
});
