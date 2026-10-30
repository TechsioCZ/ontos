import { DateTime, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';
import type { ClientSchema } from '../../shared/domain/clients.ts';
import { CrmViewerSchema } from '../../shared/domain/access.ts';
import { ImportedOrderSchema, orderDateText } from '../../shared/domain/imports.ts';
import type { ImportedOrder, OrderDecision } from '../../shared/domain/imports.ts';
import {
  buildCrmHomeSummary,
  buildSalesReport,
  clientSalesFacts,
  decimalToUnits,
  groupsCsv,
  ordersCsv,
  reportStatusMeaning,
  ReportPeriodSchema,
  unitsToDecimal,
} from '../../shared/domain/reports.ts';
import type { CrmState } from '../../shared/domain/state.ts';
import { CrmStateSchema, initialCrmState, projectCrmState } from '../../shared/domain/state.ts';

const at = '2026-10-01T08:00:00.000Z';
const client = (id: string, owner?: string): typeof ClientSchema.Encoded => {
  const value = {
    createdAt: at,
    createdBy: 'p-admin',
    id,
    kind: 'organization' as const,
    name: `Klient ${id.toUpperCase()}`,
    status: 'active' as const,
    updatedAt: at,
  };
  if (owner === undefined) {
    return value;
  }
  return { ...value, ownerSalespersonId: owner };
};

let sequence = 0;
type ImportedOrderInput = typeof ImportedOrderSchema.Encoded;
const order = (patch: Partial<ImportedOrderInput> & Pick<ImportedOrderInput, 'pairing'>): ImportedOrder => {
  sequence += 1;
  return Schema.decodeUnknownSync(ImportedOrderSchema)({
    externalId: `EXT-${sequence}`,
    id: `o-${sequence}`,
    number: `O-${sequence}`,
    rawStatus: 'nova',
    receivedAt: '2026-10-02T10:00:00.000Z',
    source: 'E-shop',
    statusHistory: [],
    ...patch,
  });
};

const base = (orders: readonly ImportedOrder[]): CrmState =>
  Schema.decodeUnknownSync(CrmStateSchema)({
    ...Schema.encodeSync(CrmStateSchema)(initialCrmState),
    clients: { assignmentHistory: [], contacts: [], items: [client('x', 'a'), client('y', 'b'), client('z')] },
    imports: {
      ...Schema.encodeSync(CrmStateSchema)(initialCrmState).imports,
      orders: orders.map((entry) => Schema.encodeSync(ImportedOrderSchema)(entry)),
    },
    salespeople: [
      { active: true, id: 'a', name: 'Jan Novák', principalId: 'p-a' },
      { active: true, id: 'b', name: 'Petra Svobodová', principalId: 'p-b' },
    ],
    visits: {
      items: [
        {
          authorPrincipalId: 'p-a',
          clientId: 'x',
          corrections: [],
          createdAt: at,
          id: 'v1',
          kind: 'visit',
          occurredAt: '2026-09-15T09:00:00.000Z',
          result: 'Domluvena objednávka',
          salespersonId: 'a',
          updatedAt: at,
        },
      ],
      plan: [],
    },
  });

const repA = Schema.decodeUnknownSync(CrmViewerSchema)({
  assign: false,
  principalId: 'p-a',
  readAll: false,
  readAssigned: true,
  salespersonId: 'a',
  writeAll: false,
  writeAssigned: true,
});

describe('CRM sales report (C05)', () => {
  it('C05-01: three paired orders of X count, the unpaired one is reported aside', () => {
    const state = base([
      order({ amount: '1000.00', clientId: 'x', currency: 'CZK', orderedAt: '2026-08-03', pairing: 'paired' }),
      order({ amount: '250.50', clientId: 'x', currency: 'CZK', orderedAt: '2026-09-10', pairing: 'paired' }),
      order({ amount: '99.99', clientId: 'x', currency: 'CZK', orderedAt: '2026-10-01', pairing: 'paired' }),
      order({ amount: '500.00', currency: 'CZK', customerName: 'Neznámá s.r.o.', pairing: 'unpaired' }),
    ]);
    const report = buildSalesReport(state, { clientId: 'x' });
    expect(report.count).toBe(3);
    expect(report.totals).toEqual([{ amount: '1350.49', count: 3, currency: 'CZK' }]);
    expect(report.excluded).toEqual([{ count: 1, reason: 'unpaired' }]);
    expect(report.byMonth.map((group) => [group.key, group.count])).toEqual([
      ['2026-08', 1],
      ['2026-09', 1],
      ['2026-10', 1],
    ]);
  });

  it('C05-02: CZK and EUR are never added together', () => {
    const state = base([
      order({ amount: '1000.00', clientId: 'x', currency: 'CZK', pairing: 'paired' }),
      order({ amount: '40.00', clientId: 'x', currency: 'eur', pairing: 'paired' }),
      order({ amount: '10.25', clientId: 'y', currency: 'EUR', pairing: 'paired' }),
    ]);
    const report = buildSalesReport(state);
    expect(report.totals).toEqual([
      { amount: '1000.00', count: 1, currency: 'CZK' },
      { amount: '50.25', count: 2, currency: 'EUR' },
    ]);
    expect(report.currencies).toEqual(['CZK', 'EUR']);
    const x = report.byClient.find((group) => group.key === 'x');
    expect(x?.totals.map((total) => total.currency)).toEqual(['CZK', 'EUR']);
  });

  it('C05-03: missing lines say "no data", never zero items', () => {
    const state = base([order({ amount: '1.00', clientId: 'x', currency: 'CZK', pairing: 'paired' })]);
    expect(buildSalesReport(state).items).toEqual({ ordersWithLines: 0, rows: [] });
    const withLines = base([
      order({
        amount: '1.00',
        clientId: 'x',
        currency: 'CZK',
        lines: [
          { name: 'Mouka hladká 25 kg', quantity: '2', sku: 'MOU-25' },
          { name: 'Mouka hladká 25 kg', quantity: '1.5', sku: 'MOU-25' },
        ],
        pairing: 'paired',
      }),
    ]);
    expect(buildSalesReport(withLines).items.rows).toEqual([
      { key: 'MOU-25', name: 'Mouka hladká 25 kg', orders: 1, quantity: '3.50', sku: 'MOU-25' },
    ]);
  });

  it('C05-04: a salesperson report (and CSV) never contains the other salesperson clients', () => {
    const state = base([
      order({ amount: '100.00', clientId: 'x', currency: 'CZK', pairing: 'paired' }),
      order({ amount: '200.00', clientId: 'y', currency: 'CZK', pairing: 'paired' }),
      order({ amount: '300.00', currency: 'CZK', pairing: 'unpaired' }),
    ]);
    const report = buildSalesReport(projectCrmState(state, repA));
    expect(report.rows.map((row) => row.clientId)).toEqual(['x']);
    const csv = ordersCsv(report);
    expect(csv).toContain('Klient X');
    expect(csv).not.toContain('Klient Y');
    expect(report.excluded).toEqual([]);
  });

  it('C03-05: cross-source duplicates and review pairings stay out of confirmed totals', () => {
    const state = base([
      order({ amount: '100.00', clientId: 'x', currency: 'CZK', pairing: 'paired' }),
      order({ amount: '100.00', clientId: 'x', currency: 'CZK', duplicateOf: 'o-x', pairing: 'paired' }),
      order({ amount: '70.00', currency: 'CZK', pairing: 'review' }),
    ]);
    const report = buildSalesReport(state);
    expect(report.count).toBe(1);
    expect(report.totals).toEqual([{ amount: '100.00', count: 1, currency: 'CZK' }]);
    expect(report.excluded).toEqual([
      { count: 1, reason: 'review' },
      { count: 1, reason: 'duplicate' },
    ]);
    expect(report.excludedTotal).toBe(2);
  });

  it('filters by period, salesperson (current owner), client and raw or mapped status', () => {
    const state = base([
      order({ amount: '1.00', clientId: 'x', currency: 'CZK', orderedAt: '2026-09-30', pairing: 'paired' }),
      order({
        amount: '2.00',
        clientId: 'y',
        currency: 'CZK',
        orderedAt: '2026-10-05',
        pairing: 'paired',
        rawStatus: 'Stornována',
      }),
      order({ amount: '4.00', clientId: 'z', currency: 'CZK', orderedAt: '2026-10-06', pairing: 'paired' }),
    ]);
    expect(
      buildSalesReport(state, {
        period: Schema.decodeSync(ReportPeriodSchema)({ from: '2026-10-01', to: '2026-10-31' }),
      }).count,
    ).toBe(2);
    expect(buildSalesReport(state, { salespersonId: 'b' }).rows.map((row) => row.clientId)).toEqual(['y']);
    expect(buildSalesReport(state, { salespersonId: 'none' }).rows.map((row) => row.clientId)).toEqual(['z']);
    expect(buildSalesReport(state, { status: { kind: 'raw', raw: 'stornovana' } }).count).toBe(1);
    // R04 not approved: no business meanings in statistics, groups follow the raw source status.
    const unapproved = buildSalesReport(state);
    expect(unapproved.mappingApproved).toBe(false);
    expect(buildSalesReport(state, { status: { kind: 'meaning', meaning: 'cancelled' } }).count).toBe(3);
    expect(unapproved.byStatus.map((group) => group.label)).toEqual(['Ze zdroje: nova', 'Ze zdroje: Stornována']);
    expect(unapproved.rows.every((row) => row.meaning === 'unmapped')).toBe(true);
    // Approved for exactly this mapping version: meaning filters and groups apply.
    const approved = Schema.decodeUnknownSync(CrmStateSchema)({
      ...Schema.encodeSync(CrmStateSchema)(state),
      customerInputs: [
        {
          evidence: 'Zápis z jednání 3. 11. 2026',
          history: [],
          id: 'R04',
          requestedAt: '2026-10-19',
          requestedBy: 'Techsio',
          sampleApprovedAt: '2026-11-03',
          sampleVersion: 'stavy-v1',
          status: 'approved',
        },
      ],
    });
    expect(buildSalesReport(approved).mappingApproved).toBe(true);
    expect(buildSalesReport(approved, { status: { kind: 'meaning', meaning: 'cancelled' } }).count).toBe(1);
    expect(buildSalesReport(approved, { status: { kind: 'meaning', meaning: 'open' } }).count).toBe(2);
    const otherVersion = Schema.decodeUnknownSync(CrmStateSchema)({
      ...Schema.encodeSync(CrmStateSchema)(approved),
      customerInputs: Schema.encodeSync(CrmStateSchema)(approved).customerInputs?.map((entry) => ({
        ...entry,
        sampleVersion: 'stavy-v0',
      })),
    });
    expect(buildSalesReport(otherVersion).mappingApproved).toBe(false);
  });

  it('orders without amount are counted but not summed', () => {
    const state = base([
      order({ amount: '10.00', clientId: 'x', currency: 'CZK', pairing: 'paired' }),
      order({ clientId: 'x', pairing: 'paired' }),
    ]);
    const report = buildSalesReport(state);
    expect(report.count).toBe(2);
    expect(report.withoutAmount).toBe(1);
    expect(report.totals).toEqual([{ amount: '10.00', count: 1, currency: 'CZK' }]);
  });

  it('maps raw statuses through the versioned table only', () => {
    expect(reportStatusMeaning('Vyřízená')).toBe('fulfilled');
    expect(reportStatusMeaning('ZAPLACENA')).toBe('paid');
    expect(reportStatusMeaning('odeslana')).toBe('unmapped');
  });

  it('sums decimals exactly', () => {
    expect(unitsToDecimal((decimalToUnits('0.1') ?? 0n) + (decimalToUnits('0.2') ?? 0n))).toBe('0.30');
    expect(unitsToDecimal(decimalToUnits('12.3456') ?? 0n)).toBe('12.3456');
    expect(decimalToUnits('1e3')).toBeUndefined();
  });

  it('client facts: order count, last order, last visit, value per currency', () => {
    const state = base([
      order({ amount: '10.00', clientId: 'x', currency: 'CZK', orderedAt: '2026-09-01', pairing: 'paired' }),
      order({ amount: '5.00', clientId: 'x', currency: 'EUR', orderedAt: '2026-10-01', pairing: 'paired' }),
    ]);
    const facts = clientSalesFacts(state, 'x');
    expect({
      ...facts,
      lastContactAt: orderDateText(facts.lastContactAt),
      lastOrderAt: orderDateText(facts.lastOrderAt),
      lastVisitAt: orderDateText(facts.lastVisitAt),
    }).toEqual({
      lastContactAt: '2026-09-15T09:00:00.000Z',
      lastOrderAt: '2026-10-01',
      lastVisitAt: '2026-09-15T09:00:00.000Z',
      orderCount: 2,
      totals: [
        { amount: '10.00', count: 1, currency: 'CZK' },
        { amount: '5.00', count: 1, currency: 'EUR' },
      ],
      withoutAmount: 0,
    });
  });

  it('last visit counts personal visits only; calls and e-mails are only the last contact', () => {
    const state = base([]);
    const withCall = Schema.decodeUnknownSync(CrmStateSchema)({
      ...Schema.encodeSync(CrmStateSchema)(state),
      visits: {
        ...Schema.encodeSync(CrmStateSchema)(state).visits,
        items: [
          ...Schema.encodeSync(CrmStateSchema)(state).visits.items,
          {
            ...Schema.encodeSync(CrmStateSchema)(state).visits.items[0],
            id: 'v-call',
            kind: 'call',
            occurredAt: '2026-10-17T08:00:00.000Z',
          },
          {
            ...Schema.encodeSync(CrmStateSchema)(state).visits.items[0],
            clientId: 'y',
            id: 'v-mail',
            kind: 'email',
            occurredAt: '2026-10-18T08:00:00.000Z',
          },
        ],
      },
    });
    expect(orderDateText(clientSalesFacts(withCall, 'x').lastVisitAt)).toBe('2026-09-15T09:00:00.000Z');
    expect(orderDateText(clientSalesFacts(withCall, 'x').lastContactAt)).toBe('2026-10-17T08:00:00.000Z');
    expect(clientSalesFacts(withCall, 'y').lastVisitAt).toBeUndefined();
    expect(orderDateText(clientSalesFacts(withCall, 'y').lastContactAt)).toBe('2026-10-18T08:00:00.000Z');
  });

  it('CSV escapes separators and keeps currencies in separate columns', () => {
    const state = base([
      order({ amount: '10.50', clientId: 'x', currency: 'CZK', pairing: 'paired', source: 'E-shop; test' }),
      order({ amount: '3.00', clientId: 'x', currency: 'EUR', pairing: 'paired' }),
    ]);
    const report = buildSalesReport(state);
    expect(ordersCsv(report)).toContain('"E-shop; test"');
    expect(groupsCsv('Klient', report.byClient, report.currencies).split('\r\n')).toEqual([
      'Klient;Počet objednávek;Hodnota CZK;Hodnota EUR;Bez částky',
      'Klient X;2;10,50;3,00;0',
    ]);
  });
});

describe('CRM sales report — duplicate decisions', () => {
  it('a confirmed duplicate stays out, an order decided "distinct" counts', () => {
    const decided = (decision: OrderDecision['decision']): Partial<ImportedOrderInput> => ({
      decisions: [{ at, by: 'p-lead', decision, reason: 'ověřeno' }],
    });
    const state = base([
      order({ amount: '100.00', clientId: 'x', currency: 'CZK', pairing: 'paired' }),
      order({
        amount: '100.00',
        clientId: 'x',
        currency: 'CZK',
        duplicateOf: 'o-1',
        pairing: 'paired',
        ...decided('confirmed_duplicate'),
      }),
      order({
        amount: '40.00',
        clientId: 'x',
        currency: 'CZK',
        duplicateOf: 'o-1',
        pairing: 'paired',
        ...decided('distinct'),
      }),
    ]);
    const report = buildSalesReport(state);
    expect(report.count).toBe(2);
    expect(report.totals).toEqual([{ amount: '140.00', count: 2, currency: 'CZK' }]);
    expect(report.excluded).toEqual([{ count: 1, reason: 'confirmed_duplicate' }]);
  });
});

describe('CRM shell Home summary', () => {
  it('counts only open manual contacts, scoped clients and this-month currency totals', () => {
    const source = base([
      order({ amount: '12.30', clientId: 'x', currency: 'CZK', orderedAt: '2026-10-01', pairing: 'paired' }),
      order({ amount: '3.50', clientId: 'x', currency: 'EUR', orderedAt: '2026-10-02', pairing: 'paired' }),
      order({ amount: '800.00', clientId: 'x', currency: 'CZK', orderedAt: '2026-09-30', pairing: 'paired' }),
      order({ amount: '999.00', clientId: 'y', currency: 'CZK', orderedAt: '2026-10-01', pairing: 'paired' }),
      order({ pairing: 'unpaired' }),
    ]);
    const plan = (id: string, dueDate: string, status: 'open' | 'done' = 'open', salespersonId = 'a') => ({
      clientId: 'x',
      createdAt: at,
      createdBy: 'p-a',
      dueDate,
      id,
      salespersonId,
      status,
    });
    const state = Schema.decodeUnknownSync(CrmStateSchema)({
      ...Schema.encodeSync(CrmStateSchema)(source),
      visits: {
        ...Schema.encodeSync(CrmStateSchema)(source).visits,
        plan: [
          plan('today', '2026-10-20'),
          plan('late', '2026-10-19'),
          plan('future', '2026-10-21'),
          plan('done', '2026-10-20', 'done'),
          plan('other-rep', '2026-10-20', 'open', 'b'),
        ],
      },
    });
    const result = buildCrmHomeSummary({
      assignmentCandidates: [],
      departedPrincipalIds: [],
      now: DateTime.makeUnsafe('2026-10-20T09:00:00.000Z'),
      revision: 1,
      state: projectCrmState(state, repA),
      viewer: repA,
    });
    expect(result.clients).toBe(1);
    expect(result.dueToday).toBe(1);
    expect(result.overdue).toBe(1);
    expect(result.openContacts).toBe(3);
    expect(result.toResolve).toBeUndefined();
    expect(result.month.totals).toEqual([
      { amount: '12.30', count: 1, currency: 'CZK' },
      { amount: '3.50', count: 1, currency: 'EUR' },
    ]);
  });
});
