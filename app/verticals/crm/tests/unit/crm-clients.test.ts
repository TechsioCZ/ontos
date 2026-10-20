// crm-clients lane: reducer + projection tests for clients, contact persons, assignment and archive (C00/C01).
import { describe, expect, it } from '@rstest/core';
import { Effect, Exit } from 'effect';
import type { CrmCommand } from '../../shared/commands/index.ts';
import { dispatchCrmCommand } from '../../shared/commands/index.ts';
import type { CrmViewer } from '../../shared/domain/access.ts';
import type { CrmState } from '../../shared/domain/state.ts';
import { initialCrmState, projectCrmState } from '../../shared/domain/state.ts';

const at = '2026-10-20T08:00:00.000Z';
const client = (id: string, owner?: string) => ({
  createdAt: at,
  createdBy: 'p-admin',
  id,
  kind: 'organization' as const,
  name: `Firma ${id}`,
  status: 'active' as const,
  updatedAt: at,
  ...(owner === undefined ? {} : { ownerSalespersonId: owner }),
});
const base: CrmState = {
  ...initialCrmState,
  clients: {
    assignmentHistory: [],
    contacts: [
      {
        clientId: 'y',
        createdAt: at,
        createdBy: 'p-admin',
        email: 'nakup@y.demo',
        id: 'cy',
        name: 'Kontakt Y',
        status: 'active',
        updatedAt: at,
      },
    ],
    items: [client('x', 'a'), client('y', 'b'), client('z')],
  },
  salespeople: [
    { active: true, id: 'a', name: 'Jan Novák', principalId: 'p-a' },
    { active: true, id: 'b', name: 'Petra Svobodová', principalId: 'p-b' },
  ],
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
const lead: CrmViewer = {
  assign: true,
  principalId: 'p-lead',
  readAll: true,
  readAssigned: false,
  writeAll: true,
  writeAssigned: false,
};

let counter = 0;
const run = (state: CrmState, command: CrmCommand, viewer: CrmViewer) => {
  counter += 1;
  return Effect.runSyncExit(dispatchCrmCommand(state, command, { invocationId: `inv${counter}`, now: at, viewer }));
};
const ok = (state: CrmState, command: CrmCommand, viewer: CrmViewer) => {
  const exit = run(state, command, viewer);
  if (Exit.isFailure(exit)) {
    throw new Error(`command ${command._tag} failed: ${String(exit.cause)}`);
  }
  return exit.value;
};
const failTag = (state: CrmState, command: CrmCommand, viewer: CrmViewer) => {
  const exit = run(state, command, viewer);
  if (Exit.isSuccess(exit)) {
    return 'success';
  }
  return JSON.stringify(exit.cause).match(/"_tag":"(Crm[A-Za-z]+)"/u)?.[1] ?? String(exit.cause);
};

describe('CRM clients', () => {
  it('C01-01: a company with two contact persons is created in one command and the first is the main contact', () => {
    const { entityIds, state } = ok(
      base,
      {
        _tag: 'CreateClient',
        contacts: [
          { name: 'Jana Nová', primary: true, role: 'Nákupčí' },
          { email: 'petr@firma.demo', name: 'Petr Starý' },
        ],
        kind: 'organization',
        name: 'Nová firma s.r.o.',
        regNo: '12345678',
        segment: 'hotel',
      },
      lead,
    );
    const id = entityIds[0] ?? '';
    const created = state.clients.items.find((entry) => entry.id === id);
    expect(created?.segment).toBe('hotel');
    expect(created?.ownerSalespersonId).toBeUndefined();
    const contacts = state.clients.contacts.filter((entry) => entry.clientId === id);
    expect(contacts.map((entry) => entry.name)).toEqual(['Jana Nová', 'Petr Starý']);
    expect(contacts.map((entry) => entry.primary === true)).toEqual([true, false]);
    expect(state.clients.events?.filter((event) => event.clientId === id).map((event) => event.kind)).toEqual([
      'client_created',
      'contact_added',
      'contact_added',
    ]);
  });

  it('a salesperson creates a client for themself and cannot hand it to a colleague', () => {
    const { entityIds, state } = ok(
      base,
      { _tag: 'CreateClient', kind: 'person', name: 'Radek Malina', regNo: '1' },
      repA,
    );
    const created = state.clients.items.find((entry) => entry.id === entityIds[0]);
    expect(created?.ownerSalespersonId).toBe('a');
    expect(created?.regNo).toBeUndefined(); // a person carries no IČO
    expect(
      failTag(base, { _tag: 'CreateClient', kind: 'organization', name: 'X', ownerSalespersonId: 'b' }, repA),
    ).toBe('CrmPermissionDenied');
  });

  it('C00: a salesperson cannot read or write a foreign client or its contact persons', () => {
    const projected = projectCrmState(base, repA);
    expect(projected.clients.items.map((entry) => entry.id)).toEqual(['x']);
    expect(projected.clients.contacts).toEqual([]);
    expect(failTag(base, { _tag: 'UpdateClient', id: 'y', patch: { phone: '1' } }, repA)).toBe('CrmNotFound');
    expect(failTag(base, { _tag: 'AddContactPerson', clientId: 'y', name: 'Vetřelec' }, repA)).toBe('CrmNotFound');
    expect(failTag(base, { _tag: 'UpdateContactPerson', contactId: 'cy', patch: { phone: '1' } }, repA)).toBe(
      'CrmNotFound',
    );
    expect(failTag(base, { _tag: 'RemoveContactPerson', contactId: 'cy' }, repA)).toBe('CrmNotFound');
    expect(failTag(base, { _tag: 'ArchiveClient', id: 'y' }, repA)).toBe('CrmNotFound');
    expect(failTag(base, { _tag: 'AssignClient', clientId: 'x', toSalespersonId: 'b' }, repA)).toBe(
      'CrmPermissionDenied',
    );
  });

  it('UpdateClient changes only the sent fields, clears with an empty string and logs the changed fields', () => {
    const withData = ok(
      base,
      { _tag: 'UpdateClient', id: 'x', patch: { email: 'a@x.demo', phone: '+420 1' } },
      repA,
    ).state;
    const { state } = ok(withData, { _tag: 'UpdateClient', id: 'x', patch: { email: '', phone: '+420 1' } }, repA);
    const updated = state.clients.items.find((entry) => entry.id === 'x');
    expect(updated?.email).toBeUndefined();
    expect(updated?.phone).toBe('+420 1');
    expect(state.clients.events?.at(-1)?.fields).toEqual(['email']);
  });

  it('contacts: edit, single main contact, remove archives and keeps the record', () => {
    const added = ok(
      base,
      { _tag: 'AddContactPerson', clientId: 'x', name: 'Eva', primary: true, role: 'Majitelka' },
      repA,
    );
    const second = ok(added.state, { _tag: 'AddContactPerson', clientId: 'x', name: 'Ivo' }, repA);
    const ivo = second.entityIds[0] ?? '';
    const promoted = ok(
      second.state,
      { _tag: 'UpdateContactPerson', contactId: ivo, patch: { phone: '777', primary: true } },
      repA,
    );
    const ofX = promoted.state.clients.contacts.filter((entry) => entry.clientId === 'x');
    expect(ofX.filter((entry) => entry.primary === true).map((entry) => entry.name)).toEqual(['Ivo']);
    const removed = ok(promoted.state, { _tag: 'RemoveContactPerson', contactId: ivo }, repA).state;
    const ivoAfter = removed.clients.contacts.find((entry) => entry.id === ivo);
    expect(ivoAfter?.status).toBe('archived');
    expect(ivoAfter?.primary).toBeUndefined();
    expect(failTag(removed, { _tag: 'UpdateContactPerson', contactId: ivo, patch: { name: 'X' } }, repA)).toBe(
      'CrmLifecycleConflict',
    );
  });

  it('C00-03: reassignment by the lead keeps the reason and history; the old owner loses access, the new one gains it', () => {
    const visit = ok(
      base,
      { _tag: 'RecordVisit', clientId: 'x', kind: 'visit', occurredAt: at, result: 'Schůzka' },
      repA,
    );
    const moved = ok(
      visit.state,
      { _tag: 'AssignClient', clientId: 'x', reason: 'Změna regionu', toSalespersonId: 'b' },
      lead,
    ).state;
    const change = moved.clients.assignmentHistory.at(-1);
    expect(change).toMatchObject({
      by: 'p-lead',
      fromSalespersonId: 'a',
      reason: 'Změna regionu',
      toSalespersonId: 'b',
    });
    expect(projectCrmState(moved, repA).clients.items).toEqual([]);
    const repB: CrmViewer = { ...repA, principalId: 'p-b', salespersonId: 'b' };
    const seenByB = projectCrmState(moved, repB);
    expect(seenByB.clients.items.map((entry) => entry.id)).toEqual(['x', 'y']);
    expect(seenByB.visits.items.map((entry) => entry.authorPrincipalId)).toEqual(['p-a']);
  });

  it('C00-03: a direct API reassignment or unassignment requires a nonempty reason', () => {
    expect(failTag(base, { _tag: 'AssignClient', clientId: 'x', toSalespersonId: 'b' }, lead)).toBe(
      'CrmReferenceIneligible',
    );
    expect(failTag(base, { _tag: 'AssignClient', clientId: 'x' }, lead)).toBe('CrmReferenceIneligible');
    // Initial assignment of an unowned client does not need a handover reason.
    expect(
      ok(base, { _tag: 'AssignClient', clientId: 'z', toSalespersonId: 'a' }, lead).state.clients.items.find(
        (entry) => entry.id === 'z',
      )?.ownerSalespersonId,
    ).toBe('a');
  });

  it('C01-02: companies sharing a contact email remain distinct', () => {
    const email = 'nakup@spolecny-kontakt.demo';
    const first = ok(
      base,
      {
        _tag: 'CreateClient',
        kind: 'organization',
        name: 'Kavárna Lipová',
        contacts: [{ name: 'Jana Lipová', email }],
      },
      lead,
    );
    const second = ok(
      first.state,
      { _tag: 'CreateClient', kind: 'organization', name: 'Bistro Lipové', contacts: [{ name: 'Jana Lipová', email }] },
      lead,
    );
    expect(first.entityIds[0]).not.toBe(second.entityIds[0]);
    expect(second.state.clients.contacts.filter((contact) => contact.email === email)).toHaveLength(2);
  });

  it('C01-03: archive hides nothing from history and can be undone', () => {
    const archived = ok(base, { _tag: 'ArchiveClient', id: 'x' }, repA).state;
    expect(archived.clients.items.find((entry) => entry.id === 'x')?.status).toBe('archived');
    expect(projectCrmState(archived, repA).clients.items.map((entry) => entry.id)).toEqual(['x']);
    expect(failTag(archived, { _tag: 'UpdateClient', id: 'x', patch: { phone: '1' } }, repA)).toBe(
      'CrmLifecycleConflict',
    );
    const restored = ok(archived, { _tag: 'RestoreClient', id: 'x' }, repA).state;
    const back = restored.clients.items.find((entry) => entry.id === 'x');
    expect(back?.status).toBe('active');
    expect(back?.archivedAt).toBeUndefined();
    expect(restored.clients.events?.map((event) => event.kind)).toEqual(['client_archived', 'client_restored']);
  });
});
