// reqfix-crm: salespeople registration (CRM.md §8) and verified Party Registry links (CRM.md §3, C04).
import { describe, expect, it } from '@rstest/core';
import { Effect, Exit } from 'effect';
import type { VerifiedParty } from '../../shared/commands/context.ts';
import type { CrmCommand } from '../../shared/commands/index.ts';
import { dispatchCrmCommand } from '../../shared/commands/index.ts';
import type { CrmViewer } from '../../shared/domain/access.ts';
import type { CrmState } from '../../shared/domain/state.ts';
import { initialCrmState, projectCrmState } from '../../shared/domain/state.ts';
import { linkTargetClientId } from '../../shared/domain/imports.ts';
import { salespersonOfPrincipal } from '../../shared/domain/team.ts';
import { contactsCsv } from '../../src/routes/[lang]/crm/klienti/clients-model.ts';
import { partyLinksOf, verifiedPartyOf, viewerFor } from '../../src/services/persistence.service.ts';

const at = '2026-10-21T08:00:00.000Z';
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
  clients: { assignmentHistory: [], contacts: [], items: [client('x', 'a'), client('z')] },
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

let counter = 0;
const run = (
  state: CrmState,
  command: CrmCommand,
  viewer: CrmViewer,
  verifiedParties?: ReadonlyMap<string, VerifiedParty>,
) => {
  counter += 1;
  return Effect.runSyncExit(
    dispatchCrmCommand(state, command, {
      invocationId: `inv${counter}`,
      now: at,
      viewer,
      ...(verifiedParties === undefined ? {} : { verifiedParties }),
    }),
  );
};
const ok = (...args: Parameters<typeof run>) => {
  const exit = run(...args);
  if (Exit.isFailure(exit)) {
    throw new Error(`command ${args[1]._tag} failed: ${String(exit.cause)}`);
  }
  return exit.value;
};
const failTag = (...args: Parameters<typeof run>) => {
  const exit = run(...args);
  return Exit.isSuccess(exit)
    ? 'success'
    : (JSON.stringify(exit.cause).match(/"_tag":"(Crm[A-Za-z]+)"/u)?.[1] ?? String(exit.cause));
};

describe('salespeople (CRM.md §8)', () => {
  it('a správce registers a new Obchodník account; it can then own clients and see only them', () => {
    const registered = ok(
      base,
      { _tag: 'RegisterSalesperson', email: 'tomas.benes@hanak.demo', name: 'Tomáš Beneš', principalId: 'p-c' },
      lead,
    );
    const id = registered.entityIds[0] ?? '';
    expect(registered.state.salespeople.find((person) => person.id === id)).toMatchObject({
      active: true,
      name: 'Tomáš Beneš',
      principalId: 'p-c',
      registeredBy: 'p-lead',
    });
    const assigned = ok(registered.state, { _tag: 'AssignClient', clientId: 'z', toSalespersonId: id }, lead);
    const viewer = viewerFor(assigned.state, 'p-c', (permission) => permission.endsWith('_assigned'));
    expect(viewer.salespersonId).toBe(id);
    expect(projectCrmState(assigned.state, viewer).clients.items.map((entry) => entry.id)).toEqual(['z']);
  });

  it('refuses duplicates and registration by a salesperson', () => {
    expect(failTag(base, { _tag: 'RegisterSalesperson', name: 'Znovu', principalId: 'p-a' }, lead)).toBe(
      'CrmLifecycleConflict',
    );
    expect(failTag(base, { _tag: 'RegisterSalesperson', name: 'Nový', principalId: 'p-new' }, repA)).toBe(
      'CrmPermissionDenied',
    );
  });

  it('deactivation needs the clients handed over first and then hides the clients from that account', () => {
    expect(failTag(base, { _tag: 'SetSalespersonActive', active: false, salespersonId: 'a' }, lead)).toBe(
      'CrmLifecycleConflict',
    );
    const handedOver = ok(base, { _tag: 'AssignClient', clientId: 'x', reason: 'Odchod z firmy' }, lead);
    const deactivated = ok(handedOver.state, { _tag: 'SetSalespersonActive', active: false, salespersonId: 'a' }, lead);
    expect(salespersonOfPrincipal(deactivated.state.salespeople, 'p-a')).toBeUndefined();
    expect(failTag(deactivated.state, { _tag: 'AssignClient', clientId: 'z', toSalespersonId: 'a' }, lead)).toBe(
      'CrmReferenceIneligible',
    );
  });
});

describe('Party Registry links (CRM.md §3)', () => {
  const link = { counterpartyId: 'cp-1', partyId: 'party-1' };
  const verified = new Map([['cp-1', { counterpartyId: 'cp-1', displayName: 'Firma Z s.r.o.', partyId: 'party-1' }]]);

  it('stores only a server-verified link, with who/when and the registry name', () => {
    expect(failTag(base, { _tag: 'LinkClientParty', clientId: 'z', partyRef: link }, lead)).toBe(
      'CrmReferenceIneligible',
    );
    const linked = ok(base, { _tag: 'LinkClientParty', clientId: 'z', partyRef: link }, lead, verified);
    expect(linked.state.clients.items.find((entry) => entry.id === 'z')?.partyRef).toEqual({
      counterpartyId: 'cp-1',
      linkedAt: at,
      linkedBy: 'p-lead',
      partyId: 'party-1',
      registryName: 'Firma Z s.r.o.',
    });
    expect(linked.state.clients.events?.at(-1)?.kind).toBe('party_linked');
  });

  it('one Party is one CRM client: a second client for the same Party is refused', () => {
    const linked = ok(base, { _tag: 'LinkClientParty', clientId: 'z', partyRef: link }, lead, verified);
    expect(
      failTag(
        linked.state,
        { _tag: 'CreateClient', kind: 'organization', name: 'Duplicita', partyRef: link },
        lead,
        verified,
      ),
    ).toBe('CrmLifecycleConflict');
  });

  it('CreateClient with a verified Party stores the PartyRef', () => {
    const created = ok(
      base,
      { _tag: 'CreateClient', kind: 'organization', name: 'Nová', partyRef: link },
      lead,
      verified,
    );
    const id = created.entityIds[0] ?? '';
    expect(created.state.clients.items.find((entry) => entry.id === id)?.partyRef?.counterpartyId).toBe('cp-1');
  });

  it('lists the links a command carries and checks the registry answer', () => {
    expect(partyLinksOf({ _tag: 'CreateClient', kind: 'organization', name: 'Bez vazby' })).toEqual([]);
    expect(partyLinksOf({ _tag: 'LinkClientParty', clientId: 'z', partyRef: link })).toEqual([link]);
    const answer = {
      currentRoles: [{ roleType: 'CUSTOMER', state: 'ACTIVE', validFrom: '2026-05-01T00:00:00.000Z', validTo: null }],
      legalEntityRef: { resourceId: 'le-1' },
      party: {
        archived: false,
        canonicalPartyRef: { resourceId: 'party-1' },
        displayName: 'Firma Z s.r.o.',
        storedPartyRef: { resourceId: 'party-1' },
      },
    };
    expect(verifiedPartyOf(link, answer, 'le-1', '2026-10-21')).toEqual({
      counterpartyId: 'cp-1',
      displayName: 'Firma Z s.r.o.',
      partyId: 'party-1',
    });
    expect(verifiedPartyOf(link, answer, 'le-other', '2026-10-21')).toBe(
      'Zákazník v evidenci zákazníků patří jiné firmě',
    );
    expect(verifiedPartyOf(link, { ...answer, currentRoles: [] }, 'le-1', '2026-10-21')).toBe(
      'Firma nemá v evidenci zákazníků platnou roli zákazníka',
    );
    expect(verifiedPartyOf({ ...link, partyId: 'party-2' }, answer, 'le-1', '2026-10-21')).toBe(
      'Party a Counterparty v Party Registry k sobě nepatří',
    );
  });
});

describe('contacts export and Party-based customer links', () => {
  const withContacts: CrmState = {
    ...base,
    clients: {
      ...base.clients,
      contacts: [
        {
          clientId: 'x',
          createdAt: at,
          createdBy: 'p',
          id: 'cx',
          name: 'Eva Mlynářová',
          status: 'active',
          updatedAt: at,
        },
        {
          clientId: 'z',
          createdAt: at,
          createdBy: 'p',
          id: 'cz',
          name: 'Skrytý Kontakt',
          status: 'active',
          updatedAt: at,
        },
      ],
    },
  };

  it('S15-02: the CSV of a salesperson contains only entrusted clients and their contacts', () => {
    const projected = projectCrmState(withContacts, repA);
    const records = { now: at, revision: 1, state: projected, viewer: repA };
    const csv = contactsCsv(records, projected.clients.items);
    expect(csv).toContain('Eva Mlynářová');
    expect(csv).not.toContain('Skrytý Kontakt');
    expect(csv).not.toContain('Firma z');
    expect(csv.split('\r\n')).toHaveLength(2);
  });

  it('an approved external id follows the Counterparty, not a stale client id', () => {
    const clients = [
      { id: 'old', partyRef: { counterpartyId: 'cp-9' } },
      { id: 'new', partyRef: { counterpartyId: 'cp-7' } },
    ];
    const link = {
      clientId: 'old',
      counterpartyId: 'cp-7',
      createdAt: at,
      createdBy: 'p',
      externalCustomerId: 'E1',
      source: 'E-shop',
    };
    expect(linkTargetClientId(clients, link)).toBe('new');
    expect(linkTargetClientId(clients, { ...link, counterpartyId: undefined } as never)).toBe('old');
    expect(linkTargetClientId([{ id: 'plain' }], { ...link, clientId: 'plain', counterpartyId: 'cp-x' })).toBe('plain');
  });
});

describe('customer inputs register (CRM.md §6)', () => {
  it('starts with R01–R08 requested; approval needs a sample version and keeps history', () => {
    const viewer = lead;
    const approved = run(
      base,
      {
        _tag: 'UpdateCustomerInput',
        evidence: 'E-mail jednatele 2. 11. 2026',
        id: 'R04',
        status: 'approved',
        note: 'Schváleno na schůzce',
      },
      viewer,
    );
    expect(Exit.isSuccess(approved)).toBe(true);
    if (Exit.isSuccess(approved)) {
      const entry = approved.value.state.customerInputs?.find((input) => input.id === 'R04');
      expect(entry).toMatchObject({ sampleApprovedAt: '2026-10-21', sampleVersion: 'stavy-v1', status: 'approved' });
      expect(entry?.history).toHaveLength(1);
      const withdrawn = ok(
        approved.value.state,
        { _tag: 'UpdateCustomerInput', id: 'R04', status: 'received' },
        viewer,
      );
      const after = withdrawn.state.customerInputs?.find((input) => input.id === 'R04');
      expect(after?.sampleApprovedAt).toBeUndefined();
      expect(after?.history.map((change) => change.status)).toEqual(['approved', 'received']);
    }
    expect(failTag(base, { _tag: 'UpdateCustomerInput', id: 'R05', status: 'approved' }, viewer)).toBe(
      'CrmReferenceIneligible',
    );
    expect(failTag(base, { _tag: 'UpdateCustomerInput', id: 'R01', status: 'received' }, repA)).toBe(
      'CrmPermissionDenied',
    );
  });
});
