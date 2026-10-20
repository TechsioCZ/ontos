import { describe, expect, it } from '@rstest/core';
import { Effect, Exit } from 'effect';
import { dispatchCrmCommand } from '../../shared/commands/index.ts';
import type { CrmCommand } from '../../shared/commands/index.ts';
import type { CrmViewer } from '../../shared/domain/access.ts';
import { initialCrmState, projectCrmState } from '../../shared/domain/state.ts';
import type { CrmState } from '../../shared/domain/state.ts';

const now = '2026-10-20T08:00:00.000Z';
const human: CrmViewer = {
  principalId: 'human',
  readAll: true,
  writeAll: true,
  assign: true,
  readAssigned: false,
  writeAssigned: false,
};
const agent = { ...human, principalId: 'agent-c' };
const rep = {
  ...human,
  principalId: 'rep',
  readAll: false,
  writeAll: false,
  assign: false,
  readAssigned: true,
  writeAssigned: true,
  salespersonId: 's1',
};
const base: CrmState = {
  ...initialCrmState,
  salespeople: [
    { id: 's1', name: 'Jan Novák', active: true, principalId: 'rep' },
    { id: 's2', name: 'Jana Nová', active: true, principalId: 'rep2' },
  ],
  clients: {
    ...initialCrmState.clients,
    items: [
      {
        id: 'c1',
        name: 'Bistro Král',
        kind: 'organization',
        status: 'active',
        phone: '+420 111 222 333',
        ownerSalespersonId: 's1',
        createdAt: now,
        updatedAt: now,
        createdBy: 'human',
      },
    ],
  },
};
let sequence = 0;
const run = (state: CrmState, command: CrmCommand, viewer = human) =>
  Effect.runSyncExit(dispatchCrmCommand(state, command, { invocationId: `ai-inv-${++sequence}`, now, viewer }));
const ok = (state: CrmState, command: CrmCommand, viewer = human) => {
  const result = run(state, command, viewer);
  if (Exit.isFailure(result)) throw new Error(String(result.cause));
  return result.value;
};
const proposal = (
  state: CrmState,
  operation: Extract<CrmCommand, { _tag: 'AiProposeChanges' }>['changes'][number]['operation'],
  runId?: string,
) =>
  ok(
    state,
    {
      _tag: 'AiProposeChanges',
      instruction: 'Uprav údaje podle ověřeného kontaktu',
      changes: [{ operation, reason: 'Ověřeno s klientem při návštěvě' }],
      ...(runId === undefined ? {} : { runId }),
    },
    agent,
  );
const approve = (state: CrmState) =>
  ok(state, {
    _tag: 'AiDecideChanges',
    changeIds: state.aiChanges?.changes.filter((entry) => entry.status === 'pending').map((entry) => entry.id) ?? [],
    decision: 'approve',
  });
const revert = (state: CrmState) =>
  ok(state, { _tag: 'AiRevertBatch', batchId: state.aiChanges?.batches[0]?.id ?? '' });

describe('AI level C governed pending batches', () => {
  it('never auto-applies even low-risk contact additions; human applies and whole batch reverts', () => {
    const pending = proposal(base, {
      _tag: 'AddContactPerson',
      clientId: 'c1',
      name: 'Jana Králová',
      email: 'jana@bistro.demo',
    }).state;
    expect(pending.clients).toEqual(base.clients);
    expect(pending.aiChanges?.changes[0]?.status).toBe('pending');
    const applied = approve(pending).state;
    expect(applied.clients.contacts).toHaveLength(1);
    expect(applied.aiChanges?.changes[0]?.decidedBy).toBe('human');
    const restored = revert(applied).state;
    expect(restored.clients.contacts.filter((entry) => entry.status === 'active')).toHaveLength(0);
    expect(restored.aiChanges?.changes[0]?.status).toBe('reverted');
    expect(restored.aiChanges?.log.map((entry) => entry.action)).toEqual([
      'proposed',
      'approved',
      'reverted',
      'batch_reverted',
    ]);
  });
  it('exposes every nested contact value, including the actual primary designation', () => {
    const pending = proposal(base, {
      _tag: 'CreateClient',
      kind: 'organization',
      name: 'Kavárna U lípy s.r.o.',
      contacts: [
        {
          name: 'Eva Lipová',
          email: 'eva@lipa.demo',
          phone: '+420 777 123 456',
          role: 'Provozní',
          primary: true,
          note: 'Volat ráno',
        },
        { name: 'Pavel Lipový', email: 'pavel@lipa.demo', primary: true },
      ],
    }).state;
    const diff = Object.fromEntries(
      pending.aiChanges?.changes[0]?.diff.map((entry) => [entry.field, entry.after]) ?? [],
    );
    expect(diff).toMatchObject({
      'contacts.0.name': 'Eva Lipová',
      'contacts.0.email': 'eva@lipa.demo',
      'contacts.0.phone': '+420 777 123 456',
      'contacts.0.role': 'Provozní',
      'contacts.0.primary': 'ano',
      'contacts.0.note': 'Volat ráno',
      'contacts.1.name': 'Pavel Lipový',
      'contacts.1.email': 'pavel@lipa.demo',
      'contacts.1.primary': 'ne',
    });
    const applied = approve(pending).state;
    expect(applied.clients.contacts.map((entry) => entry.primary === true)).toEqual([true, false]);
    expect(revert(applied).state.clients.contacts.every((entry) => entry.status === 'archived')).toBe(true);
  });
  const twoEdits = () =>
    ok(
      base,
      {
        _tag: 'AiProposeChanges',
        instruction: 'Aktualizuj telefon a web Bistra Král',
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
      },
      agent,
    ).state;
  it('approves two edits to one client atomically and reverts the whole chain', () => {
    const pending = twoEdits();
    expect(pending.clients).toEqual(base.clients);
    const applied = approve(pending).state;
    expect(applied.clients.items[0]).toMatchObject({ phone: '+420 777 888 999', website: 'https://bistro-kral.demo' });
    expect(applied.aiChanges?.changes.every((entry) => entry.status === 'applied')).toBe(true);
    expect(revert(applied).state.clients.items).toEqual(base.clients.items);
  });
  it('supports separate item approval in reverse order, while retaining safe whole-batch undo', () => {
    const pending = twoEdits();
    let working = pending;
    for (const change of pending.aiChanges?.changes.toReversed() ?? []) {
      working = ok(working, { _tag: 'AiDecideChanges', changeIds: [change.id], decision: 'approve' }).state;
    }
    expect(working.clients.items[0]).toMatchObject({ phone: '+420 777 888 999', website: 'https://bistro-kral.demo' });
    expect(revert(working).state.clients.items).toEqual(base.clients.items);
  });
  it('does not rebase over an intervening human or foreign-batch edit', () => {
    const pending = twoEdits();
    const [first, second] = pending.aiChanges?.changes ?? [];
    const firstApplied = ok(pending, {
      _tag: 'AiDecideChanges',
      changeIds: [first?.id ?? ''],
      decision: 'approve',
    }).state;
    const humanEdited = ok(firstApplied, {
      _tag: 'UpdateClient',
      id: 'c1',
      patch: { email: 'clovek@bistro.demo' },
    }).state;
    const otherPending = proposal(firstApplied, {
      _tag: 'UpdateClient',
      id: 'c1',
      patch: { email: 'jiny@bistro.demo' },
    }).state;
    const other = otherPending.aiChanges?.changes.at(-1);
    const otherApplied = ok(otherPending, {
      _tag: 'AiDecideChanges',
      changeIds: [other?.id ?? ''],
      decision: 'approve',
    }).state;
    for (const edited of [humanEdited, otherApplied]) {
      expect(
        Exit.isFailure(run(edited, { _tag: 'AiDecideChanges', changeIds: [second?.id ?? ''], decision: 'approve' })),
      ).toBe(true);
      expect(
        Exit.isFailure(run(edited, { _tag: 'AiRevertBatch', batchId: pending.aiChanges?.batches[0]?.id ?? '' })),
      ).toBe(true);
    }
  });
  it('round-trips client data exactly and records actor/time/result', () => {
    const pending = proposal(base, { _tag: 'UpdateClient', id: 'c1', patch: { phone: '+420 777 888 999' } }).state;
    expect(pending.clients.items).toEqual(base.clients.items);
    const applied = approve(pending).state;
    expect(applied.clients.items[0]?.phone).toBe('+420 777 888 999');
    expect(revert(applied).state.clients.items).toEqual(base.clients.items);
    expect(
      applied.aiChanges?.log.every(
        (entry) => entry.at === now && entry.actorPrincipalId !== '' && entry.invocationId !== undefined,
      ),
    ).toBe(true);
  });
  it('approves and reverts snapshots after a JSONB-style key reordering', () => {
    const pending = proposal(base, { _tag: 'UpdateClient', id: 'c1', patch: { phone: '+420 777 888 999' } }).state;
    const jsonb = (value: unknown): unknown =>
      Array.isArray(value)
        ? value.map(jsonb)
        : value !== null && typeof value === 'object'
          ? Object.fromEntries(
              Object.entries(value)
                .sort(([a], [b]) => a.localeCompare(b))
                .map(([key, entry]) => [key, jsonb(entry)]),
            )
          : value;
    const persisted = { ...pending, aiChanges: jsonb(pending.aiChanges) } as CrmState;
    const applied = approve(persisted).state;
    const loaded = { ...applied, aiChanges: jsonb(applied.aiChanges) } as CrmState;
    expect(revert(loaded).state.clients.items).toEqual(base.clients.items);
  });
  it('supports guarded assignment proposals and undo', () => {
    const pending = proposal(base, {
      _tag: 'AssignClient',
      clientId: 'c1',
      toSalespersonId: 's2',
      reason: 'Změna regionu',
    }).state;
    expect(pending.clients.items[0]?.ownerSalespersonId).toBe('s1');
    const applied = approve(pending).state;
    expect(applied.clients.items[0]?.ownerSalespersonId).toBe('s2');
    expect(revert(applied).state.clients.items[0]?.ownerSalespersonId).toBe('s1');
  });
  it('rejects a batch without changing business data', () => {
    const pending = proposal(base, { _tag: 'UpdateClient', id: 'c1', patch: { phone: '+420 777 888 999' } }).state;
    const rejected = ok(pending, {
      _tag: 'AiDecideChanges',
      changeIds: [pending.aiChanges?.changes[0]?.id ?? ''],
      decision: 'reject',
      note: 'Údaj není ověřen',
    }).state;
    expect(rejected.clients).toEqual(base.clients);
    expect(rejected.aiChanges?.changes[0]?.status).toBe('rejected');
  });
  it('refuses stale approval and refuses undo over a later human edit', () => {
    const pending = proposal(base, { _tag: 'UpdateClient', id: 'c1', patch: { phone: '+420 777 888 999' } }).state;
    const edited = ok(pending, { _tag: 'UpdateClient', id: 'c1', patch: { phone: '+420 666 555 444' } }).state;
    expect(
      Exit.isFailure(
        run(edited, {
          _tag: 'AiDecideChanges',
          changeIds: [pending.aiChanges?.changes[0]?.id ?? ''],
          decision: 'approve',
        }),
      ),
    ).toBe(true);
    const applied = approve(pending).state;
    const later = ok(applied, { _tag: 'UpdateClient', id: 'c1', patch: { phone: '+420 666 555 444' } }).state;
    expect(Exit.isFailure(run(later, { _tag: 'AiRevertBatch', batchId: later.aiChanges?.batches[0]?.id ?? '' }))).toBe(
      true,
    );
    expect(later.clients.items[0]?.phone).toBe('+420 666 555 444');
  });
  it('deduplicates an agent run and hides proposal snapshots from salespeople', () => {
    const first = proposal(
      base,
      { _tag: 'UpdateClient', id: 'c1', patch: { phone: '+420 777 888 999' } },
      'run-1',
    ).state;
    const second = proposal(
      first,
      { _tag: 'UpdateClient', id: 'c1', patch: { phone: '+420 777 888 999' } },
      'run-1',
    ).state;
    expect(second.aiChanges?.batches).toHaveLength(1);
    expect(
      Exit.isFailure(
        run(
          second,
          {
            _tag: 'AiProposeChanges',
            runId: 'run-1',
            instruction: 'Jiný návrh se stejným během',
            changes: [
              {
                operation: { _tag: 'UpdateClient', id: 'c1', patch: { phone: '+420 000 111 222' } },
                reason: 'Nový odlišný požadavek',
              },
            ],
          },
          agent,
        ),
      ),
    ).toBe(true);
    expect(projectCrmState(second, rep).aiChanges?.changes).toHaveLength(0);
    expect(
      Exit.isFailure(
        run(
          second,
          { _tag: 'AiDecideChanges', changeIds: [second.aiChanges?.changes[0]?.id ?? ''], decision: 'approve' },
          rep,
        ),
      ),
    ).toBe(true);
  });
});
