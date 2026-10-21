// CRM.md §3/§4 + C04: the server-side Party Registry intake targets and the external-id correlation.
import { describe, expect, it } from '@rstest/core';
import { Effect, Exit, Option } from 'effect';
import { correlateCustomerLinks, uncorrelatedCustomerLinks } from '../../shared/commands/clients.ts';
import type { VerifiedParty } from '../../shared/commands/context.ts';
import type { CrmCommand } from '../../shared/commands/index.ts';
import { dispatchCrmCommand } from '../../shared/commands/index.ts';
import type { CrmViewer } from '../../shared/domain/access.ts';
import type { CrmState } from '../../shared/domain/state.ts';
import { initialCrmState } from '../../shared/domain/state.ts';
import type { IntakeCrmClient } from '../../src/services/party-intake.ts';
import {
  ambiguousCaseDecision,
  linkClientsInBatch,
  matchingRegistryCustomer,
  sameIcoClientCustomer,
  validIco,
} from '../../src/services/party-intake.ts';

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
const run = (
  state: CrmState,
  command: CrmCommand,
  viewer: CrmViewer,
  verifiedParties?: ReadonlyMap<string, VerifiedParty>,
) =>
  Effect.runSyncExit(
    dispatchCrmCommand(state, command, {
      invocationId: 'inv1',
      now: at,
      viewer,
      ...(verifiedParties === undefined ? {} : { verifiedParties }),
    }),
  );
const intake: CrmViewer = { ...lead, assign: false, principalId: 'p-intake' };

describe('Party Registry intake (CRM.md §3, C04)', () => {
  it('SyncClientParties is for vedení only and names every active client without identity', () => {
    expect(Exit.isFailure(run(base, { _tag: 'SyncClientParties' }, repA))).toBe(true);
    const exit = run(base, { _tag: 'SyncClientParties' }, lead);
    expect(Exit.isSuccess(exit) && exit.value.entityIds).toEqual(['y']);
    // Explicit ids include archived clients (e.g. a client created before the intake existed).
    const listed = run(base, { _tag: 'SyncClientParties', clientIds: ['z'] }, lead);
    expect(Exit.isSuccess(listed) && listed.value.entityIds).toEqual(['z']);
  });

  it('the intake link stores the verified identity, records it and correlates external customer ids', () => {
    const verified = new Map([['cp-y', { counterpartyId: 'cp-y', displayName: 'Firma y', partyId: 'party-y' }]]);
    const exit = run(
      base,
      { _tag: 'LinkClientParty', clientId: 'y', partyRef: { counterpartyId: 'cp-y', partyId: 'party-y' } },
      intake,
      verified,
    );
    expect(Exit.isSuccess(exit)).toBe(true);
    if (Exit.isSuccess(exit)) {
      const next = exit.value.state;
      expect(next.clients.items.find((entry) => entry.id === 'y')?.partyRef).toMatchObject({
        counterpartyId: 'cp-y',
        linkedBy: 'p-intake',
        partyId: 'party-y',
      });
      expect(next.clients.events?.at(-1)?.kind).toBe('party_linked');
      // Every linked client's approved external ids now carry its Counterparty (also x's older one).
      expect(next.imports.customerLinks.map((link) => link.counterpartyId)).toEqual(['cp-x', 'cp-y']);
      expect(uncorrelatedCustomerLinks(next)).toBe(0);
    }
    // A Party another CRM client already holds is refused.
    const taken = new Map([['cp-x', { counterpartyId: 'cp-x', partyId: 'party-x' }]]);
    expect(
      Exit.isFailure(
        run(base, { _tag: 'LinkClientParty', clientId: 'y', partyRef: { counterpartyId: 'cp-x', partyId: 'party-x' } }, intake, taken),
      ),
    ).toBe(true);
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
    // The same IČO is the same organization even when another CRM client holds that customer.
    expect(matchingRegistryCustomer({ name: 'Alza 2', regNo: '270 82 440' }, customers, new Set(['c1', 'p1']))?.counterpartyId).toBe('c1');
    // An IČO never falls back to a name match.
    expect(matchingRegistryCustomer({ name: 'Bistro U Magnólie s.r.o.', regNo: '25596641' }, customers, new Set())).toBeUndefined();
    expect(validIco('27082440')).toBe(true);
    expect(validIco('12345678')).toBe(false);
  });

  describe('duplicate client (same name as an existing client) still ends with a registry identity', () => {
    const existing = linked('x', 'cp-x', 'party-x');
    const dupState = (regNoExisting: string | undefined, regNoDuplicate: string | undefined): CrmState => ({
      ...base,
      clients: {
        ...base.clients,
        items: [
          { ...existing, name: 'Pekárna Novák s.r.o.', ...(regNoExisting === undefined ? {} : { regNo: regNoExisting }) },
          client('dup', { name: 'Pekárna Novák s.r.o.', ownerSalespersonId: 'a', ...(regNoDuplicate === undefined ? {} : { regNo: regNoDuplicate }) }),
        ],
      },
    });
    const customers = [
      { companyId: '27082440', counterpartyId: 'cp-x', displayName: 'Pekárna Novák s.r.o.', partyId: 'party-x', status: 'ACTIVE' },
    ];
    const taken = new Set(['cp-x', 'party-x']);

    it('same IČO: the intake reuses the existing Party and the CRM stores the shared link', () => {
      const state = dupState('27082440', '27082440');
      const match = matchingRegistryCustomer({ name: 'Pekárna Novák s.r.o.', regNo: '27082440' }, customers, taken);
      expect(match?.partyId).toBe('party-x');
      // A CRM IČO the registry does not hold as identifier (no checksum): the same-IČO client's customer is reused.
      const legacy = [{ ...customers[0], companyId: null }];
      const items = dupState('90000101', '90000101').clients.items;
      expect(sameIcoClientCustomer({ id: 'dup', regNo: '9000 0101' }, items, legacy)?.partyId).toBe('party-x');
      expect(sameIcoClientCustomer({ id: 'dup', regNo: undefined }, items, legacy)).toBeUndefined();
      expect(sameIcoClientCustomer({ id: 'dup', regNo: '25596641' }, items, legacy)).toBeUndefined();
      expect(sameIcoClientCustomer({ id: 'dup', regNo: '90000101' }, items, [{ ...legacy[0], status: 'ARCHIVED' }])).toBeUndefined();
      const exit = run(
        state,
        { _tag: 'LinkClientParty', clientId: 'dup', partyRef: { counterpartyId: 'cp-x', partyId: 'party-x' } },
        intake,
        new Map([['cp-x', { counterpartyId: 'cp-x', displayName: 'Pekárna Novák s.r.o.', partyId: 'party-x' }]]),
      );
      expect(Exit.isSuccess(exit)).toBe(true);
      if (Exit.isSuccess(exit)) {
        const items = exit.value.state.clients.items;
        expect(items.filter((entry) => entry.status === 'active').every((entry) => entry.partyRef !== undefined)).toBe(true);
        expect(items.find((entry) => entry.id === 'dup')?.partyRef?.partyId).toBe('party-x');
      }
    });

    it('same name without IČO (or another IČO): no reuse, the lookalike case becomes a new Party that links', () => {
      expect(matchingRegistryCustomer({ name: 'Pekárna Novák s.r.o.', regNo: undefined }, customers, taken)).toBeUndefined();
      expect(matchingRegistryCustomer({ name: 'Pekárna Novák s.r.o.', regNo: '25596641' }, customers, taken)).toBeUndefined();
      // The registry raises a duplicate case on the lookalike name only -> resolved as CREATE_NEW, not a review.
      expect(ambiguousCaseDecision({ evaluatedEvidence: [{}], lifecycleState: 'OPEN' })).toBe('create');
      expect(ambiguousCaseDecision({ evaluatedEvidence: [{ identifierType: 'ICO' }], lifecycleState: 'OPEN' })).toBe('review');
      expect(ambiguousCaseDecision({ evaluatedEvidence: [], lifecycleState: 'RESOLVED' })).toBe('review');
      const verified = new Map([['cp-new', { counterpartyId: 'cp-new', displayName: 'Pekárna Novák s.r.o.', partyId: 'party-new' }]]);
      for (const regNo of [undefined, '25596641']) {
        const exit = run(
          dupState('27082440', regNo),
          { _tag: 'LinkClientParty', clientId: 'dup', partyRef: { counterpartyId: 'cp-new', partyId: 'party-new' } },
          intake,
          verified,
        );
        expect(Exit.isSuccess(exit) && exit.value.state.clients.items.every((entry) => entry.partyRef !== undefined)).toBe(true);
        // Sharing the existing client's Party is still refused without the same IČO.
        expect(
          Exit.isFailure(
            run(
              dupState('27082440', regNo),
              { _tag: 'LinkClientParty', clientId: 'dup', partyRef: { counterpartyId: 'cp-x', partyId: 'party-x' } },
              intake,
              new Map([['cp-x', { counterpartyId: 'cp-x', partyId: 'party-x' }]]),
            ),
          ),
        ).toBe(true);
      }
    });
  });
  describe('one approval batch with the same organization twice (CRM-A-02)', () => {
    const fresh = (id: string, regNo: string | undefined): IntakeCrmClient => ({
      id,
      kind: 'organization',
      name: 'Pekárna Novák s.r.o.',
      status: 'active',
      ...(regNo === undefined ? {} : { regNo }),
    });
    /** A registry that creates a new Party per identify call and never lists it yet (projection lag). */
    const fakeSteps = () => {
      const created: string[] = [];
      const links: { clientId: string; partyId: string; revision: number }[] = [];
      const seen: { taken: string[]; crmClients: readonly IntakeCrmClient[] }[] = [];
      return {
        created,
        links,
        seen,
        steps: {
          identify: (client: IntakeCrmClient, taken: ReadonlySet<string>, crmClients: readonly IntakeCrmClient[]) =>
            Effect.sync(() => {
              seen.push({ crmClients, taken: [...taken] });
              const sameIco = sameIcoClientCustomer(
                client,
                crmClients,
                created.map((partyId) => ({ companyId: null, counterpartyId: `cp-${partyId}`, displayName: client.name, partyId, status: 'ACTIVE' })),
              );
              if (sameIco !== undefined) {
                return Option.some({ counterpartyId: sameIco.counterpartyId, partyId: sameIco.partyId });
              }
              const partyId = `party-${created.length + 1}`;
              created.push(partyId);
              return Option.some({ counterpartyId: `cp-${partyId}`, partyId });
            }),
          link: (clientId: string, party: VerifiedParty, expectedRevision: number) =>
            Effect.sync(() => {
              links.push({ clientId, partyId: party.partyId, revision: expectedRevision });
              return expectedRevision + 1;
            }),
        },
      };
    };

    it('the second client with the same IČO reuses the Party linked earlier in the batch', () => {
      const a = fresh('a1', '9000 0101');
      const b = fresh('b1', '90000101');
      const fake = fakeSteps();
      const outcome = Effect.runSync(linkClientsInBatch([a, b], [a, b], 7, fake.steps));
      expect(outcome).toEqual({ linked: 2, review: 0 });
      expect(fake.created).toEqual(['party-1']);
      expect(fake.links).toEqual([
        { clientId: 'a1', partyId: 'party-1', revision: 7 },
        { clientId: 'b1', partyId: 'party-1', revision: 8 },
      ]);
    });

    it('later identify calls see earlier links as linked clients and taken Parties', () => {
      const a = fresh('a2', undefined);
      const b = fresh('b2', undefined);
      const fake = fakeSteps();
      const outcome = Effect.runSync(linkClientsInBatch([a, b], [a, b], 1, fake.steps));
      // Without IČO the same name is no evidence: two Parties (CRM.md l.210).
      expect(outcome).toEqual({ linked: 2, review: 0 });
      expect(fake.created).toEqual(['party-1', 'party-2']);
      expect(fake.seen[1]?.taken).toEqual(['cp-party-1', 'party-1']);
      expect(fake.seen[1]?.crmClients.find((entry) => entry.id === 'a2')?.partyRef).toEqual({
        counterpartyId: 'cp-party-1',
        partyId: 'party-1',
      });
    });

    it('a failed link is not carried forward and does not stop the batch', () => {
      const a = fresh('a3', '90000101');
      const b = fresh('b3', '90000101');
      const fake = fakeSteps();
      const steps = {
        ...fake.steps,
        link: (clientId: string, party: VerifiedParty, expectedRevision: number) =>
          clientId === 'a3' ? Effect.fail('refused' as const) : fake.steps.link(clientId, party, expectedRevision),
      };
      const outcome = Effect.runSync(linkClientsInBatch([a, b], [a, b], 1, steps));
      expect(outcome).toEqual({ linked: 1, review: 1 });
      expect(fake.links).toEqual([{ clientId: 'b3', partyId: 'party-2', revision: 1 }]);
    });
  });
});
