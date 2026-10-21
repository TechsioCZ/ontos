// CRM.md §3/§4 + C04: the server-side Party Registry intake targets and the external-id correlation.
import { describe, expect, it } from '@rstest/core';
import { Effect, Exit } from 'effect';
import {
  correlateCustomerLinks,
  identityTargets,
  linkVerifiedParty,
  linkedIdentityIds,
  uncorrelatedCustomerLinks,
} from '../../shared/commands/clients.ts';
import type { CrmCommand } from '../../shared/commands/index.ts';
import { dispatchCrmCommand } from '../../shared/commands/index.ts';
import type { CrmViewer } from '../../shared/domain/access.ts';
import type { CrmState } from '../../shared/domain/state.ts';
import { initialCrmState } from '../../shared/domain/state.ts';
import { matchingRegistryCustomer, validIco } from '../../src/services/party-intake.ts';

const at = '2026-10-21T08:00:00.000Z';
const client = (id: string, extra: Record<string, unknown> = {}) => ({
  createdAt: at,
  createdBy: 'p-admin',
  id,
  kind: 'organization' as const,
  name: `Firma ${id}`,
  status: 'active' as const,
  updatedAt: at,
  ...extra,
});
const linked = (id: string, counterpartyId: string, partyId: string) =>
  client(id, { partyRef: { counterpartyId, partyId } });
const base: CrmState = {
  ...initialCrmState,
  clients: {
    assignmentHistory: [],
    contacts: [],
    items: [linked('x', 'cp-x', 'party-x'), client('y', { ownerSalespersonId: 'a' }), client('z', { status: 'archived' })],
  },
  imports: {
    ...initialCrmState.imports,
    customerLinks: [
      { clientId: 'x', createdAt: at, createdBy: 'p-admin', externalCustomerId: 'ESH-1', source: 'E-shop' },
      { clientId: 'y', createdAt: at, createdBy: 'p-admin', externalCustomerId: 'ESH-2', source: 'E-shop' },
    ],
  },
  salespeople: [{ active: true, id: 'a', name: 'Jan Novák', principalId: 'p-a' }],
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
const context = (viewer: CrmViewer) => ({ invocationId: 'inv1', now: at, viewer });
const run = (state: CrmState, command: CrmCommand, viewer: CrmViewer) =>
  Effect.runSyncExit(dispatchCrmCommand(state, command, context(viewer)));

describe('Party Registry intake targets (CRM.md §3)', () => {
  it('a salesperson\'s new client without partyRef is an intake target', () => {
    const exit = run(base, { _tag: 'CreateClient', kind: 'organization', name: 'Bistro U Magnólie s.r.o.' }, repA);
    expect(Exit.isSuccess(exit)).toBe(true);
    if (Exit.isSuccess(exit)) {
      const targets = identityTargets(base, exit.value.state, { _tag: 'CreateClient' }, exit.value.entityIds);
      expect(targets.map((entry) => entry.name)).toEqual(['Bistro U Magnólie s.r.o.']);
    }
  });

  it('a restored unlinked client is a target, an edit of an active client is not', () => {
    const restored = run(base, { _tag: 'RestoreClient', id: 'z' }, lead);
    expect(Exit.isSuccess(restored) && identityTargets(base, restored.value.state, { _tag: 'RestoreClient' }, []).map((c) => c.id)).toEqual(['z']);
    const edited = run(base, { _tag: 'UpdateClient', id: 'y', patch: { phone: '+420 600 000 000' } }, repA);
    expect(Exit.isSuccess(edited) && identityTargets(base, edited.value.state, { _tag: 'UpdateClient' }, [])).toEqual([]);
  });

  it('SyncClientParties is for vedení only and targets every active unlinked client', () => {
    expect(Exit.isFailure(run(base, { _tag: 'SyncClientParties' }, repA))).toBe(true);
    const exit = run(base, { _tag: 'SyncClientParties' }, lead);
    expect(Exit.isSuccess(exit)).toBe(true);
    if (Exit.isSuccess(exit)) {
      expect(exit.value.entityIds).toEqual(['y']);
      expect(identityTargets(base, exit.value.state, { _tag: 'SyncClientParties' }, exit.value.entityIds).map((c) => c.id)).toEqual(['y']);
    }
  });

  it('links the verified identity, records it and correlates the external customer ids (C04)', () => {
    const next = linkVerifiedParty(base, 'y', { counterpartyId: 'cp-y', displayName: 'Firma y', partyId: 'party-y' }, context(repA), 'party-intake-0');
    const y = next.clients.items.find((entry) => entry.id === 'y');
    expect(y?.partyRef).toMatchObject({ counterpartyId: 'cp-y', linkedBy: 'p-a', partyId: 'party-y' });
    expect(next.clients.events?.at(-1)?.kind).toBe('party_linked');
    expect(next.imports.customerLinks.map((link) => link.counterpartyId)).toEqual(['cp-x', 'cp-y']);
    expect(uncorrelatedCustomerLinks(next)).toBe(0);
    // A Party another CRM client already holds is never linked twice.
    expect(linkVerifiedParty(base, 'y', { counterpartyId: 'cp-x', partyId: 'party-x' }, context(repA), 's')).toBe(base);
    expect(linkedIdentityIds(base).has('cp-x')).toBe(true);
  });

  it('migrates existing approved correlations of linked clients', () => {
    expect(uncorrelatedCustomerLinks(base)).toBe(1);
    const migrated = correlateCustomerLinks(base);
    expect(migrated.imports.customerLinks[0]).toMatchObject({ counterpartyId: 'cp-x', partyId: 'party-x' });
    expect(correlateCustomerLinks(migrated)).toBe(migrated);
  });

  it('reuses a registry customer by IČO, else by name, skipping taken ones', () => {
    const customers = [
      { companyId: '27082440', counterpartyId: 'c1', displayName: 'Alza', partyId: 'p1', status: 'ACTIVE' },
      { companyId: null, counterpartyId: 'c2', displayName: 'Bistro U Magnólie s.r.o.', partyId: 'p2', status: 'ACTIVE' },
    ];
    expect(matchingRegistryCustomer({ name: 'x', regNo: '27082440' }, customers, new Set())?.counterpartyId).toBe('c1');
    expect(matchingRegistryCustomer({ name: 'bistro u magnolie  s.r.o.', regNo: undefined }, customers, new Set())?.counterpartyId).toBe('c2');
    expect(matchingRegistryCustomer({ name: 'Bistro U Magnólie s.r.o.', regNo: undefined }, customers, new Set(['c2']))).toBeUndefined();
    expect(validIco('27082440')).toBe(true);
    expect(validIco('12345678')).toBe(false);
  });
});
