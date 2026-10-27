// reqfix-crm: salespeople registration (CRM.md §8) and verified Party Registry links (CRM.md §3, C04).
import { describe, expect, it } from 'effect-rstest';
import { DateTime, Effect, Exit, Option, Schema, Struct } from 'effect';
import { RegistryCustomerSchema as BrowserRegistryCustomerSchema } from '../../src/crm/party-registry.ts';
import { VerifiedPartySchema } from '../../shared/commands/context.ts';
import type { VerifiedParty } from '../../shared/commands/context.ts';
import type { CrmCommandInput } from '../../shared/commands/index.ts';
import { CrmCommandSchema, dispatchCrmCommand } from '../../shared/commands/index.ts';
import { RecordsResponseSchema } from '../../shared/apis/records.ts';
import { PrincipalIdSchema } from '../../shared/domain/common.ts';
import { PartyLinkInputSchema, PartyRefSchema } from '../../shared/domain/clients.ts';
import type { ClientSchema } from '../../shared/domain/clients.ts';
import { CrmViewerSchema } from '../../shared/domain/access.ts';
import type { CrmViewer } from '../../shared/domain/access.ts';
import type { CrmState } from '../../shared/domain/state.ts';
import { CrmStateSchema, initialCrmState, projectCrmState } from '../../shared/domain/state.ts';
import { linkTargetClientId } from '../../shared/domain/imports.ts';
import { salespersonOfPrincipal } from '../../shared/domain/team.ts';
import { contactsCsv } from '../../src/routes/[lang]/crm/klienti/clients-model.ts';
import { partyLinksOf, verifiedPartyOf, viewerFor } from '../../src/services/persistence.service.ts';
import { assignableSalespeople, salespersonName } from '../../src/crm/records.ts';
import { assignmentPrincipalIds, crmAssignmentPermission } from '../../src/services/assignment-policy.ts';

const assignmentTargets = (command: CrmCommandInput, state: CrmState, principalId: string) =>
  assignmentPrincipalIds(
    Schema.decodeUnknownSync(CrmCommandSchema)(command),
    state,
    Schema.decodeUnknownSync(PrincipalIdSchema)(principalId),
  );
const commandPartyLinks = (command: CrmCommandInput) =>
  partyLinksOf(Schema.decodeUnknownSync(CrmCommandSchema)(command));

const verifiedParty = Schema.decodeUnknownSync(VerifiedPartySchema);

const at = '2026-10-21T08:00:00.000Z';
const client = (id: string, owner?: string): typeof ClientSchema.Encoded => {
  const value = {
    createdAt: at,
    createdBy: 'p-admin',
    id,
    kind: 'organization' as const,
    name: `Firma ${id}`,
    status: 'active' as const,
    updatedAt: at,
  };
  if (owner === undefined) {
    return value;
  }
  return { ...value, ownerSalespersonId: owner };
};
const base = Schema.decodeUnknownSync(CrmStateSchema)({
  ...Schema.encodeSync(CrmStateSchema)(initialCrmState),
  clients: { assignmentHistory: [], contacts: [], items: [client('x', 'a'), client('z')] },
  salespeople: [{ active: true, id: 'a', name: 'Jan Novák', principalId: 'p-a' }],
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

let counter = 0;
const run = (
  state: CrmState,
  command: CrmCommandInput,
  viewer: CrmViewer,
  verifiedParties?: ReadonlyMap<string, VerifiedParty>,
) => {
  counter += 1;
  const invocationId = `inv${counter}`;
  return Schema.decodeUnknownEffect(CrmCommandSchema)(command).pipe(
    Effect.flatMap((decoded) => {
      const context = { invocationId, now: DateTime.makeUnsafe(at), viewer };
      if (verifiedParties === undefined) {
        return dispatchCrmCommand(state, decoded, context);
      }
      return dispatchCrmCommand(state, decoded, { ...context, verifiedParties });
    }),
    Effect.exit,
  );
};
const ok = (...args: Parameters<typeof run>) =>
  Effect.gen(function* effectGenerator1() {
    const exit = yield* run(...args);
    if (Exit.isFailure(exit)) {
      throw new Error(`command ${args[1]._tag} failed: ${String(exit.cause)}`);
    }
    return exit.value;
  });
const failTag = (...args: Parameters<typeof run>) =>
  Effect.gen(function* effectGenerator2() {
    const exit = yield* run(...args);
    return Exit.isSuccess(exit)
      ? 'success'
      : (/"_tag":"(?<tag>Crm[A-Za-z]+)"/u.exec(JSON.stringify(exit.cause))?.groups?.tag ?? String(exit.cause));
  });

describe('salespeople (CRM.md §8)', () => {
  it.effect('a správce registers a new Obchodník account; it can then own clients and see only them', () =>
    Effect.gen(function* effectGenerator3() {
      const registered = yield* ok(
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
      const assigned = yield* ok(registered.state, { _tag: 'AssignClient', clientId: 'z', toSalespersonId: id }, lead);
      const viewer = viewerFor(assigned.state, Schema.decodeUnknownSync(PrincipalIdSchema)('p-c'), (permission) =>
        permission.endsWith('_assigned'),
      );
      expect(viewer.salespersonId).toBe(id);
      expect(projectCrmState(assigned.state, viewer).clients.items.map((entry) => entry.id)).toEqual(['z']);
    }),
  );

  it.effect('refuses duplicates and registration by a salesperson', () =>
    Effect.gen(function* effectGenerator4() {
      expect(yield* failTag(base, { _tag: 'RegisterSalesperson', name: 'Znovu', principalId: 'p-a' }, lead)).toBe(
        'CrmLifecycleConflict',
      );
      expect(yield* failTag(base, { _tag: 'RegisterSalesperson', name: 'Nový', principalId: 'p-new' }, repA)).toBe(
        'CrmPermissionDenied',
      );
    }),
  );

  it.effect('deactivation needs the clients handed over first and then hides the clients from that account', () =>
    Effect.gen(function* effectGenerator5() {
      expect(yield* failTag(base, { _tag: 'SetSalespersonActive', active: false, salespersonId: 'a' }, lead)).toBe(
        'CrmLifecycleConflict',
      );
      const handedOver = yield* ok(base, { _tag: 'AssignClient', clientId: 'x', reason: 'Odchod z firmy' }, lead);
      const deactivated = yield* ok(
        handedOver.state,
        { _tag: 'SetSalespersonActive', active: false, salespersonId: 'a' },
        lead,
      );
      expect(
        salespersonOfPrincipal(deactivated.state.salespeople, Schema.decodeUnknownSync(PrincipalIdSchema)('p-a')),
      ).toBeUndefined();
      expect(
        yield* failTag(deactivated.state, { _tag: 'AssignClient', clientId: 'z', toSalespersonId: 'a' }, lead),
      ).toBe('CrmReferenceIneligible');
    }),
  );
});

describe('Party Registry links (CRM.md §3)', () => {
  const link = Schema.decodeUnknownSync(PartyLinkInputSchema)({ counterpartyId: 'cp-1', partyId: 'party-1' });
  const verified = new Map([
    ['cp-1', verifiedParty({ counterpartyId: 'cp-1', displayName: 'Firma Z s.r.o.', partyId: 'party-1' })],
  ]);

  it.effect('stores only a server-verified link, with who/when and the registry name', () =>
    Effect.gen(function* effectGenerator6() {
      expect(yield* failTag(base, { _tag: 'LinkClientParty', clientId: 'z', partyRef: link }, lead)).toBe(
        'CrmReferenceIneligible',
      );
      const linked = yield* ok(base, { _tag: 'LinkClientParty', clientId: 'z', partyRef: link }, lead, verified);
      const partyRef = linked.state.clients.items.find((entry) => entry.id === 'z')?.partyRef;
      expect(partyRef === undefined ? undefined : Schema.encodeSync(PartyRefSchema)(partyRef)).toEqual({
        counterpartyId: 'cp-1',
        linkedAt: at,
        linkedBy: 'p-lead',
        partyId: 'party-1',
        registryName: 'Firma Z s.r.o.',
      });
      expect(linked.state.clients.events?.at(-1)?.kind).toBe('party_linked');
    }),
  );

  it.effect('one Party is one CRM client: a second client for the same Party is refused', () =>
    Effect.gen(function* effectGenerator7() {
      const linked = yield* ok(base, { _tag: 'LinkClientParty', clientId: 'z', partyRef: link }, lead, verified);
      expect(
        yield* failTag(
          linked.state,
          { _tag: 'CreateClient', kind: 'organization', name: 'Duplicita', partyRef: link },
          lead,
          verified,
        ),
      ).toBe('CrmLifecycleConflict');
    }),
  );

  it.effect('CreateClient with a verified Party stores the PartyRef', () =>
    Effect.gen(function* effectGenerator8() {
      const created = yield* ok(
        base,
        { _tag: 'CreateClient', kind: 'organization', name: 'Nová', partyRef: link },
        lead,
        verified,
      );
      const id = created.entityIds[0] ?? '';
      expect(created.state.clients.items.find((entry) => entry.id === id)?.partyRef?.counterpartyId).toBe('cp-1');
    }),
  );

  it('lists the links a command carries and checks the registry answer', () => {
    expect(commandPartyLinks({ _tag: 'CreateClient', kind: 'organization', name: 'Bez vazby' })).toEqual([]);
    expect(commandPartyLinks({ _tag: 'LinkClientParty', clientId: 'z', partyRef: link })).toEqual([link]);
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
    expect(
      verifiedPartyOf(
        Schema.decodeUnknownSync(PartyLinkInputSchema)({ ...link, partyId: 'party-2' }),
        answer,
        'le-1',
        '2026-10-21',
      ),
    ).toBe('Údaje o firmě a zákazníkovi k sobě nepatří');
  });
});

describe('contacts export and Party-based customer links', () => {
  const withContacts = Schema.decodeUnknownSync(CrmStateSchema)({
    ...Schema.encodeSync(CrmStateSchema)(base),
    clients: {
      ...Schema.encodeSync(CrmStateSchema)(base).clients,
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
  });

  it('S15-02: the CSV of a salesperson contains only entrusted clients and their contacts', () => {
    const projected = projectCrmState(withContacts, repA);
    const records = Schema.decodeUnknownSync(RecordsResponseSchema)({
      assignmentCandidates: [],
      departedPrincipalIds: [],
      now: at,
      revision: 1,
      state: Schema.encodeSync(CrmStateSchema)(projected),
      viewer: repA,
    });
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
    expect(linkTargetClientId(clients, Struct.omit(link, ['counterpartyId']))).toBe('old');
    expect(linkTargetClientId([{ id: 'plain' }], { ...link, clientId: 'plain', counterpartyId: 'cp-x' })).toBe('plain');
  });
});

describe('customer inputs register (CRM.md §6)', () => {
  it.effect('starts with R01–R08 requested; approval needs a sample version and keeps history', () =>
    Effect.gen(function* effectGenerator9() {
      const viewer = lead;
      const approved = yield* run(
        base,
        {
          _tag: 'UpdateCustomerInput',
          evidence: 'E-mail jednatele 2. 11. 2026',
          id: 'R04',
          note: 'Schváleno na schůzce',
          status: 'approved',
        },
        viewer,
      );
      expect(Exit.isSuccess(approved)).toBe(true);
      if (Exit.isSuccess(approved)) {
        const entry = approved.value.state.customerInputs?.find((input) => input.id === 'R04');
        expect(entry).toMatchObject({ sampleApprovedAt: '2026-10-21', sampleVersion: 'stavy-v1', status: 'approved' });
        expect(entry?.history).toHaveLength(1);
        const withdrawn = yield* ok(
          approved.value.state,
          { _tag: 'UpdateCustomerInput', id: 'R04', status: 'received' },
          viewer,
        );
        const after = withdrawn.state.customerInputs?.find((input) => input.id === 'R04');
        expect(after?.sampleApprovedAt).toBeUndefined();
        expect(after?.history.map((change) => change.status)).toEqual(['approved', 'received']);
      }
      expect(yield* failTag(base, { _tag: 'UpdateCustomerInput', id: 'R05', status: 'approved' }, viewer)).toBe(
        'CrmReferenceIneligible',
      );
      expect(yield* failTag(base, { _tag: 'UpdateCustomerInput', id: 'R01', status: 'received' }, repA)).toBe(
        'CrmPermissionDenied',
      );
    }),
  );
});

describe('Core-governed CRM assignment targets', () => {
  it('uses CRM native module permission, not a kind, affiliation or role name', () => {
    expect(crmAssignmentPermission).toEqual({ moduleId: 'demo.crm', permission: 'module.access' });
  });
  it('validates registration, reactivation and each deliberate new owner', () => {
    expect(
      assignmentTargets({ _tag: 'RegisterSalesperson', name: 'Eva', principalId: 'p-eva' }, base, 'actor'),
    ).toEqual(['p-eva']);
    expect(
      assignmentTargets({ _tag: 'SetSalespersonActive', active: true, salespersonId: 'a' }, base, 'actor'),
    ).toEqual(['p-a']);
    expect(
      assignmentTargets({ _tag: 'SetSalespersonActive', active: false, salespersonId: 'a' }, base, 'actor'),
    ).toEqual([]);
    expect(assignmentTargets({ _tag: 'AssignClient', clientId: 'z', toSalespersonId: 'a' }, base, 'actor')).toEqual([
      'p-a',
    ]);
  });
  it('preserves unchanged historical owners but fails closed for a new unbound target', () => {
    expect(assignmentTargets({ _tag: 'AssignClient', clientId: 'x', toSalespersonId: 'a' }, base, 'actor')).toEqual([]);
    const unbound = Schema.decodeUnknownSync(CrmStateSchema)({
      ...Schema.encodeSync(CrmStateSchema)(base),
      salespeople: [{ active: true, id: 'legacy', name: 'Historický obchodník' }],
    });
    expect(
      assignmentTargets({ _tag: 'AssignClient', clientId: 'z', toSalespersonId: 'legacy' }, unbound, 'actor'),
    ).toEqual(['']);
  });
  it('resolves explicit, actor-default and historical client owners for new work', () => {
    expect(assignmentTargets({ _tag: 'CreateClient', kind: 'organization', name: 'Firma' }, base, 'p-a')).toEqual([
      'p-a',
    ]);
    expect(assignmentTargets({ _tag: 'PlanContact', clientId: 'x', dueDate: '2026-11-01' }, base, 'manager')).toEqual([
      'p-a',
    ]);
    expect(assignmentTargets({ _tag: 'CreateClient', kind: 'organization', name: 'Firma' }, base, 'manager')).toEqual(
      [],
    );
  });
  it.effect('checks nested AI proposals and rechecks selected stored operations on approval', () =>
    Effect.gen(function* effectGenerator10() {
      const command = {
        _tag: 'AiProposeChanges',
        changes: [{ operation: { _tag: 'AssignClient', clientId: 'z', toSalespersonId: 'a' }, reason: 'Zastoupení' }],
        instruction: 'Převést klienta',
      } as const;
      expect(assignmentTargets(command, base, 'manager')).toEqual(['p-a']);
      const proposed = (yield* ok(base, command, lead)).state;
      const changeIds = proposed.aiChanges?.changes.map((change) => change.id) ?? [];
      expect(
        assignmentTargets({ _tag: 'AiDecideChanges', changeIds, decision: 'approve' }, proposed, 'manager'),
      ).toEqual(['p-a']);
      expect(
        assignmentTargets({ _tag: 'AiDecideChanges', changeIds, decision: 'reject' }, proposed, 'manager'),
      ).toEqual([]);
    }),
  );
});

it('excludes departed, unauthorized, unbound and locally inactive people from every CRM picker while retaining history', () => {
  const records = Schema.decodeUnknownSync(RecordsResponseSchema)({
    assignmentCandidates: [{ displayName: 'Jan', principalRef: { principalId: 'p-a', tenantId: 'tenant' } }],
    departedPrincipalIds: ['p-old'],
    now: at,
    revision: 1,
    state: {
      ...Schema.encodeSync(CrmStateSchema)(base),
      salespeople: [
        ...Schema.encodeSync(CrmStateSchema)(base).salespeople,
        { active: true, id: 'old', name: 'Bývalý kolega', principalId: 'p-old' },
        { active: true, id: 'denied', name: 'Bez přístupu', principalId: 'p-denied' },
        { active: true, id: 'unbound', name: 'Historický záznam' },
        { active: false, id: 'inactive', name: 'Vyřazený obchodník', principalId: 'p-a' },
      ],
    },
    viewer: lead,
  });
  expect(assignableSalespeople(records).map((person) => person.id)).toEqual(['a']);
  expect(salespersonName(records, 'old')).toBe('Bývalý kolega · Odešel – přeřadit');
  expect(salespersonName(records, 'a')).toBe('Jan Novák');
  expect(salespersonName(records, records.viewer.salespersonId)).toBeUndefined();
});

it.effect('browser registry company identifiers preserve undefined and foreign identifier wire values', () =>
  Effect.gen(function* registryIdentifierRoundTrip() {
    yield* Effect.forEach(
      [undefined, 'DE 123 / 45', '27082440'],
      Effect.fn('Crm.registryIdentifierRoundTrip')(function* identifierCase(companyId: string | undefined) {
        const input = {
          companyId,
          displayName: 'Registry customer',
          link: { counterpartyId: 'registry-customer', partyId: 'registry-party' },
        };
        const decoded = yield* Schema.decodeEffect(BrowserRegistryCustomerSchema)(input);
        expect(Option.getOrUndefined(decoded.companyId)).toBe(companyId);
        const encoded = yield* Schema.encodeEffect(BrowserRegistryCustomerSchema)(decoded);
        expect(encoded).toEqual(input);
        expect(Object.hasOwn(encoded, 'companyId')).toBe(true);
      }),
      { concurrency: 1, discard: true },
    );
  }),
);
