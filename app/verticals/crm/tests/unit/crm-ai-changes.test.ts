import { describe, expect, it } from 'effect-rstest';
import { DateTime, Effect, Exit, Predicate, Schema } from 'effect';
import { reverse as reverseArray, sort as sortArray } from 'effect/Array';
import { sign as orderingSign } from 'effect/Number';
import { CrmCommandSchema, dispatchCrmCommand } from '../../shared/commands/index.ts';
import type { CrmCommandInput } from '../../shared/commands/index.ts';
import { CrmViewerSchema } from '../../shared/domain/access.ts';
import { AiChangesSliceSchema, AiSnapshotSchema, newClientContactsDiff } from '../../shared/domain/ai-changes.ts';
import { CrmStateSchema, initialCrmState, projectCrmState } from '../../shared/domain/state.ts';
import type { CrmState } from '../../shared/domain/state.ts';

// JSONB changes key order without changing JSON values or the order of array entries.
const isJsonArray = Schema.is(Schema.Array(Schema.Json));
const isJsonObject = Schema.is(Schema.Record(Schema.String, Schema.Json));
const jsonb = (value: Schema.Json): Schema.Json => {
  if (isJsonArray(value)) {
    return value.map(jsonb);
  }
  if (isJsonObject(value)) {
    return Object.fromEntries(
      sortArray(Object.entries(value), ([left]: [string, Schema.Json], [right]: [string, Schema.Json]) =>
        orderingSign(left.localeCompare(right)),
      ).map(([key, entry]) => [key, jsonb(entry)]),
    );
  }
  return value;
};
const aiChangesJson = Schema.fromJsonString(AiChangesSliceSchema);
const jsonValue = Schema.fromJsonString(Schema.Json);
const jsonbAiChanges = (value: CrmState['aiChanges']) =>
  value === undefined ? value : jsonb(Schema.decodeSync(jsonValue)(Schema.encodeSync(aiChangesJson)(value)));

describe('CRM snapshot wire contract', () => {
  it('round-trips JSON values, including nested entity snapshots', () => {
    for (const value of [null, 42, true, 'value', [1, null], { nested: { values: [1, 'value', false] } }]) {
      const snapshot = { after: value, before: value, id: 'snapshot-1', kind: 'client' };
      const decoded = Schema.decodeUnknownSync(AiSnapshotSchema)(snapshot);
      expect(Schema.encodeSync(AiSnapshotSchema)(decoded)).toEqual(snapshot);
    }
  });

  it('rejects non-JSON values in either side of a snapshot', () => {
    for (const value of [Number.NaN, Number.POSITIVE_INFINITY, 1n, { nested: Symbol('not-json') }]) {
      expect(Schema.is(AiSnapshotSchema)({ after: value, id: 'snapshot-1', kind: 'client' })).toBe(false);
      expect(Schema.is(AiSnapshotSchema)({ before: value, id: 'snapshot-1', kind: 'client' })).toBe(false);
    }
  });
});

const now = '2026-10-20T08:00:00.000Z';
const human = Schema.decodeUnknownSync(CrmViewerSchema)({
  assign: true,
  principalId: 'human',
  readAll: true,
  readAssigned: false,
  writeAll: true,
  writeAssigned: false,
});
const agent = Schema.decodeUnknownSync(CrmViewerSchema)({ ...human, principalId: 'agent-c' });
const rep = Schema.decodeUnknownSync(CrmViewerSchema)({
  ...human,
  assign: false,
  principalId: 'rep',
  readAll: false,
  readAssigned: true,
  salespersonId: 's1',
  writeAll: false,
  writeAssigned: true,
});
const base = Schema.decodeUnknownSync(CrmStateSchema)({
  ...Schema.encodeSync(CrmStateSchema)(initialCrmState),
  clients: {
    ...Schema.encodeSync(CrmStateSchema)(initialCrmState).clients,
    items: [
      {
        createdAt: now,
        createdBy: 'human',
        id: 'c1',
        kind: 'organization',
        name: 'Bistro Král',
        ownerSalespersonId: 's1',
        phone: '+420 111 222 333',
        status: 'active',
        updatedAt: now,
      },
    ],
  },
  salespeople: [
    { active: true, id: 's1', name: 'Jan Novák', principalId: 'rep' },
    { active: true, id: 's2', name: 'Jana Nová', principalId: 'rep2' },
  ],
});
let sequence = 0;
const run = (state: CrmState, command: CrmCommandInput, viewer = human) => {
  sequence += 1;
  const invocationId = `ai-inv-${sequence}`;
  return Schema.decodeUnknownEffect(CrmCommandSchema)(command).pipe(
    Effect.flatMap((decoded) =>
      dispatchCrmCommand(state, decoded, { invocationId, now: DateTime.makeUnsafe(now), viewer }),
    ),
    Effect.exit,
  );
};
const ok = (state: CrmState, command: CrmCommandInput, viewer = human) =>
  Effect.gen(function* effectGenerator1() {
    const result = yield* run(state, command, viewer);
    if (Exit.isFailure(result)) {
      throw new Error(String(result.cause));
    }
    return result.value;
  });
const proposal = (
  state: CrmState,
  operation: Extract<CrmCommandInput, { _tag: 'AiProposeChanges' }>['changes'][number]['operation'],
  runId?: string,
) => {
  const command = {
    _tag: 'AiProposeChanges',
    changes: [{ operation, reason: 'Ověřeno s klientem při návštěvě' }],
    instruction: 'Uprav údaje podle ověřeného kontaktu',
  } satisfies Extract<CrmCommandInput, { readonly _tag: 'AiProposeChanges' }>;
  if (runId === undefined) {
    return ok(state, command, agent);
  }
  return ok(state, { ...command, runId }, agent);
};

const approve = (state: CrmState) =>
  ok(state, {
    _tag: 'AiDecideChanges',
    changeIds: state.aiChanges?.changes.filter((entry) => entry.status === 'pending').map((entry) => entry.id) ?? [],
    decision: 'approve',
  });
const revert = (state: CrmState) =>
  ok(state, { _tag: 'AiRevertBatch', batchId: state.aiChanges?.batches[0]?.id ?? '' });

describe('AI level C governed pending batches', () => {
  it.effect('never auto-applies even low-risk contact additions; human applies and whole batch reverts', () =>
    Effect.gen(function* effectGenerator2() {
      const pending = (yield* proposal(base, {
        _tag: 'AddContactPerson',
        clientId: 'c1',
        email: 'jana@bistro.demo',
        name: 'Jana Králová',
      })).state;
      expect(pending.clients).toEqual(base.clients);
      expect(pending.aiChanges?.changes[0]?.status).toBe('pending');
      const applied = (yield* approve(pending)).state;
      expect(applied.clients.contacts).toHaveLength(1);
      expect(applied.aiChanges?.changes[0]?.decidedBy).toBe('human');
      const restored = (yield* revert(applied)).state;
      expect(restored.clients.contacts.filter((entry) => entry.status === 'active')).toHaveLength(0);
      expect(restored.aiChanges?.changes[0]?.status).toBe('reverted');
      expect(restored.aiChanges?.log.map((entry) => entry.action)).toEqual([
        'proposed',
        'approved',
        'reverted',
        'batch_reverted',
      ]);
    }),
  );
  it.effect('exposes every nested contact value, including the actual primary designation', () =>
    Effect.gen(function* effectGenerator3() {
      const pending = (yield* proposal(base, {
        _tag: 'CreateClient',
        contacts: [
          {
            email: 'eva@lipa.demo',
            name: 'Eva Lipová',
            note: 'Volat ráno',
            phone: '+420 777 123 456',
            primary: true,
            role: 'Provozní',
          },
          { email: 'pavel@lipa.demo', name: 'Pavel Lipový', primary: true },
        ],
        kind: 'organization',
        name: 'Kavárna U lípy s.r.o.',
      })).state;
      const diff = Object.fromEntries(
        pending.aiChanges?.changes[0]?.diff.map((entry) => [entry.field, entry.after]) ?? [],
      );
      expect(diff).toMatchObject({
        'contacts.0.email': 'eva@lipa.demo',
        'contacts.0.name': 'Eva Lipová',
        'contacts.0.note': 'Volat ráno',
        'contacts.0.phone': '+420 777 123 456',
        'contacts.0.primary': 'ano',
        'contacts.0.role': 'Provozní',
        'contacts.1.email': 'pavel@lipa.demo',
        'contacts.1.name': 'Pavel Lipový',
        'contacts.1.primary': 'ne',
      });
      const applied = (yield* approve(pending)).state;
      expect(applied.clients.contacts.map((entry) => entry.primary === true)).toEqual([true, false]);
      expect((yield* revert(applied)).state.clients.contacts.every((entry) => entry.status === 'archived')).toBe(true);
    }),
  );
  const twoEdits = () =>
    ok(
      base,
      {
        _tag: 'AiProposeChanges',
        changes: [
          {
            operation: { _tag: 'UpdateClient', id: 'c1', patch: { phone: '+420 777 888 999' } },
            reason: 'Ověřeno telefonicky',
          },
          {
            operation: { _tag: 'UpdateClient', id: 'c1', patch: { website: 'https://bistro-kral.demo' } },
            reason: 'Nový web klienta',
          },
        ],
        instruction: 'Aktualizuj telefon a web Bistra Král',
      },
      agent,
    ).pipe(Effect.map((change) => change.state));
  it.effect('approves two edits to one client atomically and reverts the whole chain', () =>
    Effect.gen(function* effectGenerator4() {
      const pending = yield* twoEdits();
      expect(pending.clients).toEqual(base.clients);
      const applied = (yield* approve(pending)).state;
      expect(applied.clients.items[0]).toMatchObject({
        phone: '+420 777 888 999',
        website: 'https://bistro-kral.demo',
      });
      expect(applied.aiChanges?.changes.every((entry) => entry.status === 'applied')).toBe(true);
      expect((yield* revert(applied)).state.clients.items).toEqual(base.clients.items);
    }),
  );
  it.effect('supports separate item approval in reverse order, while retaining safe whole-batch undo', () =>
    Effect.gen(function* effectGenerator5() {
      const pending = yield* twoEdits();
      const working = yield* Effect.reduce(
        reverseArray(pending.aiChanges?.changes ?? []),
        () => pending,
        (state, change) =>
          ok(state, { _tag: 'AiDecideChanges', changeIds: [change.id], decision: 'approve' }).pipe(
            Effect.map((result) => result.state),
          ),
      );
      expect(working.clients.items[0]).toMatchObject({
        phone: '+420 777 888 999',
        website: 'https://bistro-kral.demo',
      });
      expect((yield* revert(working)).state.clients.items).toEqual(base.clients.items);
    }),
  );
  it.effect('does not rebase over an intervening human or foreign-batch edit', () =>
    Effect.gen(function* effectGenerator6() {
      const pending = yield* twoEdits();
      const [first, second] = pending.aiChanges?.changes ?? [];
      const firstApplied = (yield* ok(pending, {
        _tag: 'AiDecideChanges',
        changeIds: [first?.id ?? ''],
        decision: 'approve',
      })).state;
      const humanEdited = (yield* ok(firstApplied, {
        _tag: 'UpdateClient',
        id: 'c1',
        patch: { email: 'clovek@bistro.demo' },
      })).state;
      const otherPending = (yield* proposal(firstApplied, {
        _tag: 'UpdateClient',
        id: 'c1',
        patch: { email: 'jiny@bistro.demo' },
      })).state;
      const other = otherPending.aiChanges?.changes.at(-1);
      const otherApplied = (yield* ok(otherPending, {
        _tag: 'AiDecideChanges',
        changeIds: [other?.id ?? ''],
        decision: 'approve',
      })).state;
      yield* Effect.forEach([humanEdited, otherApplied], (edited) =>
        Effect.gen(function* effectGenerator7() {
          expect(
            Exit.isFailure(
              yield* run(edited, { _tag: 'AiDecideChanges', changeIds: [second?.id ?? ''], decision: 'approve' }),
            ),
          ).toBe(true);
          expect(
            Exit.isFailure(
              yield* run(edited, { _tag: 'AiRevertBatch', batchId: pending.aiChanges?.batches[0]?.id ?? '' }),
            ),
          ).toBe(true);
        }),
      );
    }),
  );
  it.effect('reconstructs a complete contact review for batches saved with a legacy name-only diff', () =>
    Effect.gen(function* effectGenerator8() {
      const pending = (yield* proposal(base, {
        _tag: 'CreateClient',
        contacts: [
          { email: 'eva@lipa.demo', name: 'Eva Lipová', phone: '+420 777 123 456', primary: true, role: 'Provozní' },
        ],
        kind: 'organization',
        name: 'Kavárna U lípy s.r.o.',
      })).state.aiChanges?.changes[0];
      const operation = pending?.operation;
      if (pending === undefined || !Predicate.isTagged(operation, 'CreateClient')) {
        throw new Error('Missing creation proposal');
      }
      const legacy = {
        ...pending,
        diff: [{ after: 'Eva Lipová', field: 'contacts', label: 'Kontaktní osoby' }],
        operation,
      };
      expect(newClientContactsDiff(legacy.operation.contacts).map((entry) => entry.after)).toEqual([
        'Eva Lipová',
        'eva@lipa.demo',
        '+420 777 123 456',
        'Provozní',
        'ano',
      ]);
    }),
  );
  it.effect('round-trips client data exactly and records actor/time/result', () =>
    Effect.gen(function* effectGenerator9() {
      const pending = (yield* proposal(base, { _tag: 'UpdateClient', id: 'c1', patch: { phone: '+420 777 888 999' } }))
        .state;
      expect(pending.clients.items).toEqual(base.clients.items);
      const applied = (yield* approve(pending)).state;
      expect(applied.clients.items[0]?.phone).toBe('+420 777 888 999');
      expect((yield* revert(applied)).state.clients.items).toEqual(base.clients.items);
      expect(
        applied.aiChanges?.log.every(
          (entry) =>
            entry.at.pipe(DateTime.formatIso) === now &&
            entry.actorPrincipalId !== '' &&
            entry.invocationId !== undefined,
        ),
      ).toBe(true);
    }),
  );
  it.effect('approves and reverts snapshots after a JSONB-style key reordering', () =>
    Effect.gen(function* effectGenerator10() {
      const pending = (yield* proposal(base, { _tag: 'UpdateClient', id: 'c1', patch: { phone: '+420 777 888 999' } }))
        .state;
      const persisted = Schema.decodeUnknownSync(CrmStateSchema)({
        ...Schema.encodeSync(CrmStateSchema)(pending),
        aiChanges: jsonbAiChanges(pending.aiChanges),
      });
      const applied = (yield* approve(persisted)).state;
      const loaded = Schema.decodeUnknownSync(CrmStateSchema)({
        ...Schema.encodeSync(CrmStateSchema)(applied),
        aiChanges: jsonbAiChanges(applied.aiChanges),
      });
      expect((yield* revert(loaded)).state.clients.items).toEqual(base.clients.items);
    }),
  );
  it.effect('supports guarded assignment proposals and undo', () =>
    Effect.gen(function* effectGenerator11() {
      const pending = (yield* proposal(base, {
        _tag: 'AssignClient',
        clientId: 'c1',
        reason: 'Změna regionu',
        toSalespersonId: 's2',
      })).state;
      expect(pending.clients.items[0]?.ownerSalespersonId).toBe('s1');
      const applied = (yield* approve(pending)).state;
      expect(applied.clients.items[0]?.ownerSalespersonId).toBe('s2');
      expect((yield* revert(applied)).state.clients.items[0]?.ownerSalespersonId).toBe('s1');
    }),
  );
  it.effect('rejects a batch without changing business data', () =>
    Effect.gen(function* effectGenerator12() {
      const pending = (yield* proposal(base, { _tag: 'UpdateClient', id: 'c1', patch: { phone: '+420 777 888 999' } }))
        .state;
      const rejected = (yield* ok(pending, {
        _tag: 'AiDecideChanges',
        changeIds: [pending.aiChanges?.changes[0]?.id ?? ''],
        decision: 'reject',
        note: 'Údaj není ověřen',
      })).state;
      expect(rejected.clients).toEqual(base.clients);
      expect(rejected.aiChanges?.changes[0]?.status).toBe('rejected');
    }),
  );
  it.effect('refuses stale approval and refuses undo over a later human edit', () =>
    Effect.gen(function* effectGenerator13() {
      const pending = (yield* proposal(base, { _tag: 'UpdateClient', id: 'c1', patch: { phone: '+420 777 888 999' } }))
        .state;
      const edited = (yield* ok(pending, { _tag: 'UpdateClient', id: 'c1', patch: { phone: '+420 666 555 444' } }))
        .state;
      expect(
        Exit.isFailure(
          yield* run(edited, {
            _tag: 'AiDecideChanges',
            changeIds: [pending.aiChanges?.changes[0]?.id ?? ''],
            decision: 'approve',
          }),
        ),
      ).toBe(true);
      const applied = (yield* approve(pending)).state;
      const later = (yield* ok(applied, { _tag: 'UpdateClient', id: 'c1', patch: { phone: '+420 666 555 444' } }))
        .state;
      expect(
        Exit.isFailure(yield* run(later, { _tag: 'AiRevertBatch', batchId: later.aiChanges?.batches[0]?.id ?? '' })),
      ).toBe(true);
      expect(later.clients.items[0]?.phone).toBe('+420 666 555 444');
    }),
  );
  it.effect('deduplicates an agent run and hides proposal snapshots from salespeople', () =>
    Effect.gen(function* effectGenerator14() {
      const first = (yield* proposal(
        base,
        { _tag: 'UpdateClient', id: 'c1', patch: { phone: '+420 777 888 999' } },
        'run-1',
      )).state;
      const second = (yield* proposal(
        first,
        { _tag: 'UpdateClient', id: 'c1', patch: { phone: '+420 777 888 999' } },
        'run-1',
      )).state;
      expect(second.aiChanges?.batches).toHaveLength(1);
      expect(
        Exit.isFailure(
          yield* run(
            second,
            {
              _tag: 'AiProposeChanges',
              changes: [
                {
                  operation: { _tag: 'UpdateClient', id: 'c1', patch: { phone: '+420 000 111 222' } },
                  reason: 'Nový odlišný požadavek',
                },
              ],
              instruction: 'Jiný návrh se stejným během',
              runId: 'run-1',
            },
            agent,
          ),
        ),
      ).toBe(true);
      expect(projectCrmState(second, rep).aiChanges?.changes).toHaveLength(0);
      expect(
        Exit.isFailure(
          yield* run(
            second,
            { _tag: 'AiDecideChanges', changeIds: [second.aiChanges?.changes[0]?.id ?? ''], decision: 'approve' },
            rep,
          ),
        ),
      ).toBe(true);
    }),
  );
});
