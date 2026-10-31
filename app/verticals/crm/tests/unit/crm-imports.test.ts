import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'effect-rstest';
import { DateTime, Effect, Exit, Schema } from 'effect';
import { CrmCommandSchema, dispatchCrmCommand } from '../../shared/commands/index.ts';
import type { CrmCommandInput } from '../../shared/commands/index.ts';
import { EntityIdSchema, PrincipalIdSchema } from '../../shared/domain/common.ts';
import type { ClientSchema } from '../../shared/domain/clients.ts';
import { CrmViewerSchema } from '../../shared/domain/access.ts';
import type { CrmViewer } from '../../shared/domain/access.ts';
import { needsReview, openReviewEvents, orderDateText } from '../../shared/domain/imports.ts';
import type { CrmState } from '../../shared/domain/state.ts';
import { CrmStateSchema, initialCrmState, projectCrmState } from '../../shared/domain/state.ts';
import { parseOrdersCsv } from '../../shared/imports/csv.ts';
import { seedImports } from '../../shared/imports/demo-seed.ts';
import { ordersCsvSamples } from '../../shared/imports/samples.ts';

const at = '2026-10-20T08:00:00.000Z';
const client = (
  id: string,
  owner?: string,
  extra: Partial<typeof ClientSchema.Encoded> = {},
): typeof ClientSchema.Encoded => {
  const value = {
    createdAt: at,
    createdBy: 'p-admin',
    id,
    kind: 'organization' as const,
    name: id,
    status: 'active' as const,
    updatedAt: at,
  };
  if (owner === undefined) {
    return { ...value, ...extra };
  }
  return { ...value, ownerSalespersonId: owner, ...extra };
};
const keysA = ['pekarna-mala', 'zlata-husa', 'potraviny-cerna', 'hotel-podhradi', 'zs-blansko', 'kavarna-na-rohu'];
const keysB = ['bistro-kral', 'zamecka-restaurace', 'minimarket-hodonin', 'lazensky-hotel', 'catering-vsetin'];
const base = Schema.decodeUnknownSync(CrmStateSchema)({
  ...Schema.encodeSync(CrmStateSchema)(initialCrmState),
  clients: {
    assignmentHistory: [],
    contacts: [],
    items: [
      ...keysA.map((key) => {
        if (key === 'zlata-husa') {
          return client(key, 'a', { email: 'objednavky@restaurace-u-zlate-husy.demo', regNo: '90000102' });
        }
        if (key === 'pekarna-mala') {
          return client(key, 'a', { regNo: '90000101' });
        }
        return client(key, 'a');
      }),
      ...keysB.map((key) => client(key, 'b')),
      client('sladka-tecka', undefined, { email: 'cukrarna@sladka-tecka.demo', regNo: '90000112' }),
    ],
  },
  salespeople: [
    { active: true, id: 'a', name: 'A', principalId: 'p-a' },
    { active: true, id: 'b', name: 'B', principalId: 'p-b' },
  ],
});
const lead = Schema.decodeUnknownSync(CrmViewerSchema)({
  assign: true,
  principalId: 'p-lead',
  readAll: true,
  readAssigned: false,
  writeAll: true,
  writeAssigned: false,
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

const seededEffect = seedImports(base, {
  by: Schema.decodeUnknownSync(PrincipalIdSchema)('p-admin'),
  clientIdOf: Schema.decodeUnknownSync(EntityIdSchema),
  importedAt: DateTime.makeUnsafe('2026-10-18T07:00:00.000Z'),
  invocationId: 'seed',
  linkedAt: DateTime.makeUnsafe('2026-05-01T07:00:00.000Z'),
});
let invocation = 0;
const run = (state: CrmState, command: CrmCommandInput, viewer: CrmViewer = lead) => {
  invocation += 1;
  const invocationId = `i${invocation}`;
  return Schema.decodeUnknownEffect(CrmCommandSchema)(command).pipe(
    Effect.flatMap((decoded) =>
      dispatchCrmCommand(state, decoded, { invocationId, now: DateTime.makeUnsafe(at), viewer }),
    ),
    Effect.exit,
  );
};
const runOk = (state: CrmState, command: CrmCommandInput, viewer: CrmViewer = lead) =>
  Effect.gen(function* effectGenerator1() {
    const exit = yield* run(state, command, viewer);
    if (Exit.isFailure(exit)) {
      throw new Error(`command failed: ${String(exit.cause)}`);
    }
    return exit.value.state;
  });
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
      const file = readFileSync(new URL(`../../demo-data/${entry.fileName}`, import.meta.url), 'utf-8');
      expect(entry.csv).toBe(file);
    }
  });
  it('normalizes decimals, dates and lines; reports readable row errors', () => {
    const parsed = parseOrdersCsv(sample('errors').csv);
    const errors = parsed.rows.filter((row) => row.kind === 'error');
    expect(errors.map((row) => row.row)).toEqual([2, 3, 4, 5, 6]);
    const [first] = parseOrdersCsv(sample('initial').csv).rows;
    expect(
      first?.kind === 'ok'
        ? {
            ...first.value,
            eventAt: orderDateText(first.value.eventAt),
            orderedAt: orderDateText(first.value.orderedAt),
          }
        : undefined,
    ).toMatchObject({
      amount: '11850.00',
      eventAt: '2026-05-09T08:20:00.000Z',
      orderedAt: '2026-05-06',
    });
    expect(first?.kind === 'ok' ? first.value.lines?.length : 0).toBe(3);
  });
  it('requires currency for supplied line amounts even when the order total is absent', () => {
    const parsed = parseOrdersCsv('zdroj;id_objednavky;stav;polozky\nE-shop;1;nova;SKU:Mouka:2:450.00\n');
    expect(parsed.rows[0]).toMatchObject({ kind: 'error', message: 'Částka položky bez měny: doplňte sloupec mena' });
  });
  it('rejects a file without required columns', () => {
    expect(parseOrdersCsv('a;b\n1;2').fileError).toContain('zdroj');
  });
});

describe('CRM order import (C03)', () => {
  it.effect('C03-01 seeded import keeps source, number and raw state; pairs only approved links (C04-01)', () =>
    Effect.gen(function* effectGenerator2() {
      const seeded = yield* seededEffect;
      expect(seeded.imports.orders).toHaveLength(28);
      expect(seeded.imports.batches[0]).toMatchObject({
        created: 28,
        rejected: 0,
        rowCount: 29,
        status: 'completed',
        updated: 1,
      });
      expect(order(seeded, '100201')).toMatchObject({
        clientId: 'pekarna-mala',
        number: 'OBJ-2026-0201',
        pairing: 'paired',
        rawStatus: 'dorucena',
        source: 'E-shop',
      });
      expect(order(seeded, '100281').statusHistory).toHaveLength(2);
    }),
  );
  it.effect('C03-04 unknown customer stays unpaired; IČO/e-mail match is only a candidate', () =>
    Effect.gen(function* effectGenerator3() {
      const seeded = yield* seededEffect;
      expect(order(seeded, '100274')).toMatchObject({ pairing: 'unpaired' });
      expect(order(seeded, '100274').clientId).toBeUndefined();
      const sweet = order(seeded, '100277');
      expect(sweet.pairing).toBe('review');
      expect(sweet.clientId).toBeUndefined();
      expect(sweet.candidates?.[0]?.clientId).toBe('sladka-tecka');
    }),
  );
  it.effect('C03-05 the same order from a second source is flagged, not counted twice', () =>
    Effect.gen(function* effectGenerator4() {
      const seeded = yield* seededEffect;
      const twin = order(seeded, 'UO-26-0129', 'Účetní systém');
      expect(twin.duplicateOf).toBe(order(seeded, '100266').id);
      expect(needsReview(twin)).toBe(true);
    }),
  );
  it.effect('C03-02 status update adds history to the same order; older event is flagged, not applied', () =>
    Effect.gen(function* effectGenerator5() {
      const seeded = yield* seededEffect;
      const next = yield* runOk(seeded, sample('statusUpdates'));
      expect(next.imports.orders).toHaveLength(29);
      const first = order(next, '100266');
      expect(first.rawStatus).toBe('dorucena');
      expect(first.statusHistory.map((event) => event.rawStatus)).toEqual(['odeslana', 'dorucena']);
      const late = order(next, '100285');
      expect(late.rawStatus).toBe('zaplacena');
      expect(openReviewEvents(late)).toHaveLength(1);
      expect(next.imports.batches[0]).toMatchObject({ created: 1, duplicates: 1, review: 1, updated: 6 });
    }),
  );
  it.effect('C03-03 importing the same file again changes no counts and no history', () =>
    Effect.gen(function* effectGenerator6() {
      const seeded = yield* seededEffect;
      const once = yield* runOk(seeded, sample('statusUpdates'));
      const twice = yield* runOk(once, sample('statusUpdates'));
      expect(twice.imports.orders).toHaveLength(once.imports.orders.length);
      expect(twice.imports.orders.map((entry) => entry.statusHistory.length)).toEqual(
        once.imports.orders.map((entry) => entry.statusHistory.length),
      );
      expect(twice.imports.batches[0]).toMatchObject({ accepted: 0, duplicates: 9, rejected: 0 });
      const again = yield* runOk(seeded, sample('initial'));
      expect(again.imports.orders).toHaveLength(28);
    }),
  );
  it.effect('preserves the current state when the previous event has no timestamp', () =>
    Effect.gen(function* effectGenerator7() {
      const first = yield* runOk(base, {
        _tag: 'ImportOrdersCsv',
        csv: 'zdroj;id_objednavky;stav\nE-shop;1;dorucena\n',
        fileName: 'bez-casu.csv',
      });
      const next = yield* runOk(first, {
        _tag: 'ImportOrdersCsv',
        csv: 'zdroj;id_objednavky;stav;cas_udalosti\nE-shop;1;nova;2026-10-19T10:00:00+02:00\n',
        fileName: 'stav.csv',
      });
      expect(order(next, '1').rawStatus).toBe('dorucena');
      expect(openReviewEvents(order(next, '1'))).toHaveLength(1);
      expect(next.imports.batches[0]?.results?.[0]?.message).toContain('Předchozí stav nemá čas');
    }),
  );
  it.effect('keeps conflicting payloads of the same event ID for review and deduplicates their replay', () =>
    Effect.gen(function* effectGenerator8() {
      const header = 'zdroj;id_objednavky;stav;cas_udalosti;id_udalosti\n';
      const first = yield* runOk(base, {
        _tag: 'ImportOrdersCsv',
        csv: `${header}E-shop;1;dorucena;2026-10-19T10:00:00+02:00;event-1\n`,
        fileName: 'prvni.csv',
      });
      const command = {
        _tag: 'ImportOrdersCsv' as const,
        csv: `${header}E-shop;1;stornovana;2026-10-20T10:00:00+02:00;event-1\n`,
        fileName: 'konflikt.csv',
      };
      const next = yield* runOk(first, command);
      expect(order(next, '1').rawStatus).toBe('dorucena');
      expect(openReviewEvents(order(next, '1'))).toHaveLength(1);
      expect(next.imports.batches[0]?.results?.[0]?.message).toContain('Stejné ID události');
      const replay = yield* runOk(next, command);
      expect(order(replay, '1').statusHistory).toHaveLength(2);
      expect(replay.imports.batches[0]?.duplicates).toBe(1);
    }),
  );
  it.effect('bad rows produce readable errors and do not block good rows', () =>
    Effect.gen(function* effectGenerator9() {
      const seeded = yield* seededEffect;
      const next = yield* runOk(seeded, sample('errors'));
      const [batch] = next.imports.batches;
      expect(batch).toMatchObject({ rejected: 5, status: 'completed_with_errors' });
      expect(batch?.errors.map((error) => error.row)).toEqual([2, 3, 4, 5, 6]);
      expect(order(next, '100301').pairing).toBe('paired');
      const emailOnly = order(next, '100295');
      expect(emailOnly.clientId).toBeUndefined();
      expect(emailOnly.candidates?.[0]?.reason).toContain('e-mail');
      expect(order(next, 'UO-26-0140', 'Účetní systém').duplicateOf).toBe(order(next, '100285').id);
      expect(openReviewEvents(order(next, '100257'))).toHaveLength(1);
    }),
  );
  it.effect('a salesperson cannot import and sees only own paired orders without candidates', () =>
    Effect.gen(function* effectGenerator10() {
      const seeded = yield* seededEffect;
      expect(Exit.isFailure(yield* run(seeded, sample('statusUpdates'), repA))).toBe(true);
      const view = projectCrmState(seeded, repA).imports;
      expect(view.batches).toHaveLength(0);
      expect(view.orders.every((entry) => entry.clientId !== undefined && keysA.includes(entry.clientId))).toBe(true);
      expect(view.orders.some((entry) => entry.externalId === '100274')).toBe(false);
    }),
  );
});

describe('CRM order pairing (C04)', () => {
  it.effect('C04-03 manual pairing stores reason, author and can approve the customer link', () =>
    Effect.gen(function* effectGenerator11() {
      const seeded = yield* seededEffect;
      const target = order(seeded, '100277');
      const next = yield* runOk(seeded, {
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
    }),
  );
  it.effect('correction keeps the old and new binding; reps cannot pair', () =>
    Effect.gen(function* effectGenerator12() {
      const seeded = yield* seededEffect;
      const target = order(seeded, '100201');
      const moved = yield* runOk(seeded, {
        _tag: 'PairOrder',
        clientId: 'zlata-husa',
        orderId: target.id,
        reason: 'Oprava chybného přiřazení',
      });
      expect(moved.imports.pairingHistory.at(-1)).toMatchObject({
        fromClientId: 'pekarna-mala',
        toClientId: 'zlata-husa',
      });
      const unpaired = yield* runOk(moved, { _tag: 'UnpairOrder', orderId: target.id, reason: 'Nejasný odběratel' });
      expect(order(unpaired, '100201').pairing).toBe('unpaired');
      expect(
        Exit.isFailure(
          yield* run(seeded, { _tag: 'PairOrder', clientId: 'pekarna-mala', orderId: target.id, reason: 'xxx' }, repA),
        ),
      ).toBe(true);
    }),
  );
  it.effect('review decisions resolve the flag with author and reason', () =>
    Effect.gen(function* effectGenerator13() {
      const seeded = yield* seededEffect;
      const next = yield* runOk(seeded, sample('statusUpdates'));
      const late = order(next, '100285');
      const index = openReviewEvents(late)[0]?.index ?? -1;
      const resolved = yield* runOk(next, {
        _tag: 'ResolveOrderStatusEvent',
        decision: 'dismiss',
        eventIndex: index,
        orderId: late.id,
        reason: 'Opožděná zpráva, platí zaplaceno',
      });
      expect(needsReview(order(resolved, '100285'))).toBe(false);
      const twin = order(seeded, 'UO-26-0129', 'Účetní systém');
      const confirmed = yield* runOk(seeded, {
        _tag: 'ResolveOrderDuplicate',
        decision: 'confirmed_duplicate',
        orderId: twin.id,
        reason: 'Účetní systém převzal objednávku z e-shopu',
      });
      expect(order(confirmed, 'UO-26-0129', 'Účetní systém').duplicateOf).toBe(twin.duplicateOf);
      expect(needsReview(order(confirmed, 'UO-26-0129', 'Účetní systém'))).toBe(false);
    }),
  );
});
