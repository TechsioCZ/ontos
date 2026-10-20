import { readFileSync } from 'node:fs';
import { describe, expect, it } from '@rstest/core';
import { Effect, Exit } from 'effect';
import { dispatchCrmCommand } from '../../shared/commands/index.ts';
import type { CrmCommand } from '../../shared/commands/index.ts';
import type { CrmViewer } from '../../shared/domain/access.ts';
import { needsReview, openReviewEvents } from '../../shared/domain/imports.ts';
import type { CrmState } from '../../shared/domain/state.ts';
import { initialCrmState, projectCrmState } from '../../shared/domain/state.ts';
import { parseOrdersCsv } from '../../shared/imports/csv.ts';
import { seedImports } from '../../shared/imports/demo-seed.ts';
import { ordersCsvSamples } from '../../shared/imports/samples.ts';

const at = '2026-10-20T08:00:00.000Z';
const client = (id: string, owner?: string, extra: Record<string, string> = {}) => ({
  createdAt: at,
  createdBy: 'p-admin',
  id,
  kind: 'organization' as const,
  name: id,
  status: 'active' as const,
  updatedAt: at,
  ...(owner === undefined ? {} : { ownerSalespersonId: owner }),
  ...extra,
});
const keysA = ['pekarna-mala', 'zlata-husa', 'potraviny-cerna', 'hotel-podhradi', 'zs-blansko', 'kavarna-na-rohu'];
const keysB = ['bistro-kral', 'zamecka-restaurace', 'minimarket-hodonin', 'lazensky-hotel', 'catering-vsetin'];
const base: CrmState = {
  ...initialCrmState,
  clients: {
    assignmentHistory: [],
    contacts: [],
    items: [
      ...keysA.map((key) =>
        client(
          key,
          'a',
          key === 'zlata-husa'
            ? { email: 'objednavky@restaurace-u-zlate-husy.demo', regNo: '90000102' }
            : key === 'pekarna-mala'
              ? { regNo: '90000101' }
              : {},
        ),
      ),
      ...keysB.map((key) => client(key, 'b')),
      client('sladka-tecka', undefined, { email: 'cukrarna@sladka-tecka.demo', regNo: '90000112' }),
    ],
  },
  salespeople: [
    { active: true, id: 'a', name: 'A', principalId: 'p-a' },
    { active: true, id: 'b', name: 'B', principalId: 'p-b' },
  ],
};
const lead: CrmViewer = {
  assign: true,
  principalId: 'p-lead',
  readAll: true,
  readAssigned: false,
  writeAll: true,
  writeAssigned: false,
};
const repA: CrmViewer = {
  assign: false,
  principalId: 'p-a',
  readAll: false,
  readAssigned: true,
  salespersonId: 'a',
  writeAll: false,
  writeAssigned: true,
};

const seeded = Effect.runSync(
  seedImports(base, {
    by: 'p-admin',
    clientIdOf: (key) => key,
    importedAt: '2026-10-18T07:00:00.000Z',
    invocationId: 'seed',
    linkedAt: '2026-05-01T07:00:00.000Z',
  }),
);
let invocation = 0;
const run = (state: CrmState, command: CrmCommand, viewer: CrmViewer = lead) =>
  Effect.runSyncExit(dispatchCrmCommand(state, command, { invocationId: `i${(invocation += 1)}`, now: at, viewer }));
const runOk = (state: CrmState, command: CrmCommand, viewer: CrmViewer = lead) => {
  const exit = run(state, command, viewer);
  if (Exit.isFailure(exit)) {
    throw new Error(`command failed: ${String(exit.cause)}`);
  }
  return exit.value.state;
};
const sample = (key: string) => {
  const found = ordersCsvSamples.find((entry) => entry.key === key);
  if (found === undefined) {
    throw new Error(key);
  }
  return { _tag: 'ImportOrdersCsv' as const, csv: found.csv, fileName: found.fileName };
};
const order = (state: CrmState, externalId: string, source = 'E-shop') => {
  const found = state.imports.orders.find((entry) => entry.externalId === externalId && entry.source === source);
  if (found === undefined) {
    throw new Error(`order ${externalId}`);
  }
  return found;
};

describe('CRM order CSV parser', () => {
  it('samples in TS are identical to demo-data files', () => {
    for (const entry of ordersCsvSamples) {
      const file = readFileSync(new URL(`../../demo-data/${entry.fileName}`, import.meta.url), 'utf8');
      expect(entry.csv).toBe(file);
    }
  });
  it('normalizes decimals, dates and lines; reports readable row errors', () => {
    const parsed = parseOrdersCsv(sample('errors').csv);
    const errors = parsed.rows.filter((row) => row.kind === 'error');
    expect(errors.map((row) => row.row)).toEqual([2, 3, 4, 5, 6]);
    const first = parseOrdersCsv(sample('initial').csv).rows[0];
    expect(first?.kind === 'ok' ? first.value : undefined).toMatchObject({
      amount: '11850.00',
      eventAt: '2026-05-09T08:20:00.000Z',
      orderedAt: '2026-05-06',
    });
    expect(first?.kind === 'ok' ? first.value.lines?.length : 0).toBe(3);
  });
  it('rejects a file without required columns', () => {
    expect(parseOrdersCsv('a;b\n1;2').fileError).toContain('zdroj');
  });
});

describe('CRM order import (C03)', () => {
  it('C03-01 seeded import keeps source, number and raw state; pairs only approved links (C04-01)', () => {
    expect(seeded.imports.orders).toHaveLength(28);
    expect(seeded.imports.batches[0]).toMatchObject({ created: 28, rejected: 0, rowCount: 29, status: 'completed', updated: 1 });
    expect(order(seeded, '100201')).toMatchObject({
      clientId: 'pekarna-mala',
      number: 'OBJ-2026-0201',
      pairing: 'paired',
      rawStatus: 'dorucena',
      source: 'E-shop',
    });
    expect(order(seeded, '100281').statusHistory).toHaveLength(2);
  });
  it('C03-04 unknown customer stays unpaired; IČO/e-mail match is only a candidate', () => {
    expect(order(seeded, '100274')).toMatchObject({ pairing: 'unpaired' });
    expect(order(seeded, '100274').clientId).toBeUndefined();
    const sweet = order(seeded, '100277');
    expect(sweet.pairing).toBe('review');
    expect(sweet.clientId).toBeUndefined();
    expect(sweet.candidates?.[0]?.clientId).toBe('sladka-tecka');
  });
  it('C03-05 the same order from a second source is flagged, not counted twice', () => {
    const twin = order(seeded, 'UO-26-0129', 'Účetní systém');
    expect(twin.duplicateOf).toBe(order(seeded, '100266').id);
    expect(needsReview(twin)).toBe(true);
  });
  it('C03-02 status update adds history to the same order; older event is flagged, not applied', () => {
    const next = runOk(seeded, sample('statusUpdates'));
    expect(next.imports.orders).toHaveLength(29);
    const first = order(next, '100266');
    expect(first.rawStatus).toBe('dorucena');
    expect(first.statusHistory.map((event) => event.rawStatus)).toEqual(['odeslana', 'dorucena']);
    const late = order(next, '100285');
    expect(late.rawStatus).toBe('zaplacena');
    expect(openReviewEvents(late)).toHaveLength(1);
    expect(next.imports.batches[0]).toMatchObject({ created: 1, duplicates: 1, review: 1, updated: 6 });
  });
  it('C03-03 importing the same file again changes no counts and no history', () => {
    const once = runOk(seeded, sample('statusUpdates'));
    const twice = runOk(once, sample('statusUpdates'));
    expect(twice.imports.orders).toHaveLength(once.imports.orders.length);
    expect(twice.imports.orders.map((entry) => entry.statusHistory.length)).toEqual(
      once.imports.orders.map((entry) => entry.statusHistory.length),
    );
    expect(twice.imports.batches[0]).toMatchObject({ accepted: 0, duplicates: 9, rejected: 0 });
    const again = runOk(seeded, sample('initial'));
    expect(again.imports.orders).toHaveLength(28);
  });
  it('bad rows produce readable errors and do not block good rows', () => {
    const next = runOk(seeded, sample('errors'));
    const batch = next.imports.batches[0];
    expect(batch).toMatchObject({ rejected: 5, status: 'completed_with_errors' });
    expect(batch?.errors.map((error) => error.row)).toEqual([2, 3, 4, 5, 6]);
    expect(order(next, '100301').pairing).toBe('paired');
    const emailOnly = order(next, '100295');
    expect(emailOnly.clientId).toBeUndefined();
    expect(emailOnly.candidates?.[0]?.reason).toContain('e-mail');
    expect(order(next, 'UO-26-0140', 'Účetní systém').duplicateOf).toBe(order(next, '100285').id);
    expect(openReviewEvents(order(next, '100257'))).toHaveLength(1);
  });
  it('a salesperson cannot import and sees only own paired orders without candidates', () => {
    expect(Exit.isFailure(run(seeded, sample('statusUpdates'), repA))).toBe(true);
    const view = projectCrmState(seeded, repA).imports;
    expect(view.batches).toHaveLength(0);
    expect(view.orders.every((entry) => entry.clientId !== undefined && keysA.includes(entry.clientId))).toBe(true);
    expect(view.orders.some((entry) => entry.externalId === '100274')).toBe(false);
  });
});

describe('CRM order pairing (C04)', () => {
  it('C04-03 manual pairing stores reason, author and can approve the customer link', () => {
    const target = order(seeded, '100277');
    const next = runOk(seeded, {
      _tag: 'PairOrder',
      approveCustomerLink: true,
      clientId: 'sladka-tecka',
      orderId: target.id,
      reason: 'Ověřeno telefonicky s majitelkou',
    });
    expect(order(next, '100277')).toMatchObject({ clientId: 'sladka-tecka', pairing: 'paired' });
    expect(next.imports.pairingHistory.at(-1)).toMatchObject({
      by: 'p-lead',
      orderId: target.id,
      reason: 'Ověřeno telefonicky s majitelkou',
      toClientId: 'sladka-tecka',
      via: 'manual',
    });
    expect(next.imports.customerLinks.some((link) => link.externalCustomerId === 'ESH-1100')).toBe(true);
  });
  it('correction keeps the old and new binding; reps cannot pair', () => {
    const target = order(seeded, '100201');
    const moved = runOk(seeded, {
      _tag: 'PairOrder',
      clientId: 'zlata-husa',
      orderId: target.id,
      reason: 'Oprava chybného přiřazení',
    });
    expect(moved.imports.pairingHistory.at(-1)).toMatchObject({ fromClientId: 'pekarna-mala', toClientId: 'zlata-husa' });
    const unpaired = runOk(moved, { _tag: 'UnpairOrder', orderId: target.id, reason: 'Nejasný odběratel' });
    expect(order(unpaired, '100201').pairing).toBe('unpaired');
    expect(
      Exit.isFailure(run(seeded, { _tag: 'PairOrder', clientId: 'pekarna-mala', orderId: target.id, reason: 'xxx' }, repA)),
    ).toBe(true);
  });
  it('review decisions resolve the flag with author and reason', () => {
    const next = runOk(seeded, sample('statusUpdates'));
    const late = order(next, '100285');
    const index = openReviewEvents(late)[0]?.index ?? -1;
    const resolved = runOk(next, {
      _tag: 'ResolveOrderStatusEvent',
      decision: 'dismiss',
      eventIndex: index,
      orderId: late.id,
      reason: 'Opožděná zpráva, platí zaplaceno',
    });
    expect(needsReview(order(resolved, '100285'))).toBe(false);
    const twin = order(seeded, 'UO-26-0129', 'Účetní systém');
    const confirmed = runOk(seeded, {
      _tag: 'ResolveOrderDuplicate',
      decision: 'confirmed_duplicate',
      orderId: twin.id,
      reason: 'Účetní systém převzal objednávku z e-shopu',
    });
    expect(order(confirmed, 'UO-26-0129', 'Účetní systém').duplicateOf).toBe(twin.duplicateOf);
    expect(needsReview(order(confirmed, 'UO-26-0129', 'Účetní systém'))).toBe(false);
  });
});
