import type { OperationalScope } from '@app/core-runtime';
import {
  AssignmentSchema,
  CatalogSnapshotEntrySchema,
  RoleRevisionSchema,
  RoleSchema,
} from '@app/core-runtime/access/changes/role-revision';
import type { AccessDecision } from '@app/core-runtime/access/decision/contract';
import { AccessDecisionGate, makeTestAccessDecision } from '@app/core-runtime/access/enforcement';
import type { AccessDecisionService, GateInput } from '@app/core-runtime/access/enforcement';
import {
  AccessScopeIdSchema,
  DelegationIdSchema,
  LegalEntityIdSchema,
  PrincipalIdSchema,
  TenantIdSchema,
} from '@app/core-runtime/access/ids';
import { AccessMembershipSchema } from '@app/core-runtime/access/intent/memberships';
import type { AccessMembership } from '@app/core-runtime/access/intent/memberships';
import { AccessPeopleDirectory } from '@app/core-runtime/access/intent/people-directory';
import type {
  AccessDirectoryCompanyMember,
  AccessPeopleDirectoryService,
} from '@app/core-runtime/access/intent/people-directory';
import { AccessTeamMemberSchema, AccessTeamSchema } from '@app/core-runtime/access/intent/teams';
import {
  AccessPeopleCommands,
  administrationOf,
  peopleFailure,
} from '@app/core-runtime/access/lifecycle/people-service';
import type {
  AccessPeopleCommandsService,
  AccessPeopleView,
  PeopleCommandFailure,
} from '@app/core-runtime/access/lifecycle/people-service';
import { DateTime, Effect, Layer, Option, Result, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import type { AccessAdminProblem } from '../../shared/access-admin-api.ts';
import {
  AdmitAccessMemberPayloadSchema,
  AssignAccessRolePayloadSchema,
  CreateAccessDelegationPayloadSchema,
  EndAccessMembershipPayloadSchema,
  ListAccessAssignmentsPayloadSchema,
  RevokeAccessAssignmentPayloadSchema,
  RevokeAccessDelegationPayloadSchema,
  SetAccessTeamMembershipPayloadSchema,
  TransferAccessOwnershipPayloadSchema,
} from '../../shared/access-admin-api.ts';
import { AccessAdminClock } from '../../api/access-admin/clock.ts';
import type { AccessPeopleBffService } from '../../api/access-admin/people.ts';
import { AccessPeopleBff, AccessPeopleBffLive, accessPeopleDeclarations } from '../../api/access-admin/people.ts';
import { AccessAdminSession, accessAdminUnavailableProblem } from '../../api/access-admin/session.ts';
import { AccessPeopleWriteAvailability } from '../../api/access-admin/people-write-gate.ts';

/*
 * "Lidé", unit level: the BFF's own rules. Which capability each operation asks, what one person may
 * see of the tenant's people (O88), which identities a write mints from its idempotency key, when the
 * write gate and a stale revision refuse a write, and which status each Core refusal becomes. Core's
 * people commands are a scripted port here, so a failure of this module's wiring cannot hide behind
 * Core's rules; the rules themselves are proved by the Core people suites.
 */

const uuid = (index: number): string => `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
const TENANT = uuid(1);
const TENANT_SCOPE = uuid(2);
const COMPANY_A = uuid(3);
const COMPANY_B = uuid(4);
const A_SCOPE = uuid(5);
const B_SCOPE = uuid(6);
const OWNER = uuid(10);
const ALICE = uuid(11);
const BOB = uuid(12);
const COMPANY_ADMIN = uuid(13);
/** Listed by both companies' directories, admitted to neither yet. */
const DANA = uuid(14);
/** Listed by company A's directory as departed. */
const EVA = uuid(15);
/** An agent principal company A's directory lists. */
const AGENT = uuid(16);
const ROLE_A = uuid(20);
const ROLE_B = uuid(21);
const ROLE_A_REVISION = uuid(22);
const ROLE_B_REVISION = uuid(23);
const ALICE_ASSIGNMENT = uuid(30);
const BOB_ASSIGNMENT = uuid(31);
const BOB_DELEGATION = uuid(32);
const TEAM_A = uuid(33);
const CATALOG = uuid(34);
const CAPABILITY = 'test.party.read';

class FixtureInvalid extends Schema.TaggedError<FixtureInvalid>()('FixtureInvalid', { reason: Schema.String }) {}

const decode = <Value, Input>(schema: Schema.Decoder<Value>, input: Input): Value => {
  const decoded = Schema.decodeUnknownResult(schema)(input);
  if (Result.isFailure(decoded)) {
    throw new FixtureInvalid({ reason: `fixture is invalid: ${decoded.failure.message}` });
  }
  return decoded.success;
};

const instant = (hour: number): Date => DateTime.toDateUtc(DateTime.makeUnsafe(Date.UTC(2026, 10, 3, hour)));
const NOW = instant(9);

const scopeFor = (principalId: string): OperationalScope =>
  Object.freeze({
    authBindingId: 'binding-1',
    authContextRef: 'session-1',
    authMethod: 'session' as const,
    correlationId: 'people-unit',
    principalId: PrincipalIdSchema.make(principalId),
    tenantId: TenantIdSchema.make(TENANT),
  });

const membership = (index: number, principalId: string, scopeId: string, kind = 'member'): AccessMembership =>
  decode(AccessMembershipSchema, {
    createdAt: instant(1),
    holder: { _tag: 'Principal', principalId },
    id: uuid(100 + index),
    kind,
    recordedBy: OWNER,
    scopeId,
    status: 'active',
    tenantId: TENANT,
    validFrom: instant(1),
  });

const role = (id: string, revision: string, legalEntityId: string, name: string) => ({
  revision: decode(RoleRevisionSchema, {
    catalogSnapshotId: CATALOG,
    cells: [{ capabilityKey: CAPABILITY, mode: 'run', selector: { _tag: 'all' } }],
    createdAt: instant(1),
    createdBy: OWNER,
    id: revision,
    provenance: 'manual',
    revision: 1,
    roleId: id,
    tenantId: TENANT,
  }),
  role: decode(RoleSchema, { createdAt: instant(1), createdBy: OWNER, id, legalEntityId, name, tenantId: TENANT }),
});

const assignment = (incarnationId: string, principalId: string, roleId: string, revision: string, scopeId: string) =>
  decode(AssignmentSchema, {
    assignedAt: instant(2),
    assignedBy: OWNER,
    holder: { _tag: 'Principal', principalId },
    incarnationId,
    roleId,
    roleRevisionId: revision,
    scopeId,
    status: 'active',
    tenantId: TENANT,
    validFrom: instant(2),
  });

const memberships: readonly AccessMembership[] = [
  membership(1, OWNER, TENANT_SCOPE, 'owner'),
  membership(2, OWNER, TENANT_SCOPE),
  membership(3, ALICE, TENANT_SCOPE),
  membership(4, ALICE, A_SCOPE),
  membership(5, BOB, TENANT_SCOPE),
  membership(6, BOB, B_SCOPE),
  membership(7, COMPANY_ADMIN, TENANT_SCOPE),
  membership(8, COMPANY_ADMIN, A_SCOPE),
  membership(9, COMPANY_ADMIN, A_SCOPE, 'access_admin'),
];

const view: AccessPeopleView = {
  administration: administrationOf(memberships, AccessScopeIdSchema.make(TENANT_SCOPE), NOW),
  assignments: [
    assignment(ALICE_ASSIGNMENT, ALICE, ROLE_A, ROLE_A_REVISION, A_SCOPE),
    assignment(BOB_ASSIGNMENT, BOB, ROLE_B, ROLE_B_REVISION, B_SCOPE),
  ],
  at: NOW,
  delegations: [
    {
      capabilityKeys: [decode(CatalogSnapshotEntrySchema.fields.key, CAPABILITY)],
      grantedBy: PrincipalIdSchema.make(OWNER),
      id: DelegationIdSchema.make(BOB_DELEGATION),
      managerId: PrincipalIdSchema.make(BOB),
      people: [PrincipalIdSchema.make(ALICE)],
      roleIds: [role(ROLE_B, ROLE_B_REVISION, COMPANY_B, 'B').role.id],
      scopeId: AccessScopeIdSchema.make(B_SCOPE),
      status: 'active',
      tenantId: TenantIdSchema.make(TENANT),
      validFrom: instant(2),
      validUntil: instant(20),
    },
  ],
  memberships,
  revision: 'core-tenant-wide-revision',
  roles: [role(ROLE_A, ROLE_A_REVISION, COMPANY_A, 'Účetní A'), role(ROLE_B, ROLE_B_REVISION, COMPANY_B, 'Účetní B')],
  scopes: [
    { scopeId: AccessScopeIdSchema.make(TENANT_SCOPE), tenantContextId: TenantIdSchema.make(TENANT) },
    { legalEntityId: LegalEntityIdSchema.make(COMPANY_A), scopeId: AccessScopeIdSchema.make(A_SCOPE) },
    { legalEntityId: LegalEntityIdSchema.make(COMPANY_B), scopeId: AccessScopeIdSchema.make(B_SCOPE) },
  ],
  teams: [
    {
      members: [
        decode(AccessTeamMemberSchema, {
          addedAt: instant(2),
          addedBy: OWNER,
          holder: { _tag: 'Principal', principalId: ALICE },
          id: uuid(40),
          teamId: TEAM_A,
          tenantId: TENANT,
        }),
      ],
      team: decode(AccessTeamSchema, {
        createdAt: instant(1),
        createdBy: OWNER,
        id: TEAM_A,
        name: 'Fakturace',
        scopeId: A_SCOPE,
        tenantId: TENANT,
      }),
    },
  ],
  tenantScopeId: AccessScopeIdSchema.make(TENANT_SCOPE),
};

const NAMES = new Map<string, string>([
  [AGENT, 'Asistent'],
  [ALICE, 'Alice Nováková'],
  [BOB, 'Bob Dvořák'],
  [COMPANY_ADMIN, 'Cyril Správce'],
  [DANA, 'Dana Malá'],
  [EVA, 'Eva Odešlá'],
  [OWNER, 'Olga Majitelová'],
]);

const listed = (principalId: string, status = 'active'): AccessDirectoryCompanyMember => ({
  affiliation: 'employee',
  displayName: NAMES.get(principalId) ?? principalId,
  principalId: PrincipalIdSchema.make(principalId),
  principalKind: principalId === AGENT ? 'agent' : 'human',
  principalStatus: 'active',
  status,
});

/**
 * Each company's own directory. Alice is already a live member of A; Bob is a live member of B but not
 * of A; Eva left A; the agent is no person; Dana is listed by both and admitted to neither.
 */
const COMPANY_DIRECTORY = new Map<string, readonly AccessDirectoryCompanyMember[]>([
  [COMPANY_A, [listed(AGENT), listed(ALICE), listed(BOB), listed(DANA), listed(EVA, 'departed')]],
  [COMPANY_B, [listed(BOB), listed(DANA)]],
]);

/** The people directory, counting every company directory read into `reads`. */
/** Reads the options run beside each other: how many are in flight now and at most. */
interface Flight {
  current: number;
  most: number;
}

/** One scripted read, counted while it is in flight; it yields once so concurrent reads can overlap. */
const inFlight = <Value, Failure>(flight: Flight, read: Effect.Effect<Value, Failure>) =>
  Effect.acquireUseRelease(
    Effect.sync(() => {
      flight.current += 1;
      flight.most = Math.max(flight.most, flight.current);
    }),
    () => Effect.yieldNow.pipe(Effect.andThen(read)),
    () =>
      Effect.sync(() => {
        flight.current -= 1;
      }),
  );

const directoryFor = (reads: { directoryReads: number; readonly flight: Flight }): AccessPeopleDirectoryService => {
  const companyMembers: AccessPeopleDirectoryService['companyMembers'] = (_scope, legalEntityId) =>
    inFlight(
      reads.flight,
      Effect.sync(() => {
        reads.directoryReads += 1;
        return COMPANY_DIRECTORY.get(legalEntityId) ?? [];
      }),
    );
  return {
    companyMember: (scope, legalEntityId, principalId) =>
      companyMembers(scope, legalEntityId).pipe(
        Effect.map((rows) => Option.fromUndefinedOr(rows.find((row) => row.principalId === principalId))),
      ),
    companyMembers,
    people: (_scope, ids) =>
      inFlight(
        reads.flight,
        Effect.succeed(
          ids.flatMap((principalId) => {
            const displayName = NAMES.get(principalId);
            const kind = principalId === AGENT ? 'agent' : 'human';
            return displayName === undefined ? [] : [{ displayName, kind, principalId, status: 'active' }];
          }),
        ),
      ),
    scopeLabels: () =>
      inFlight(
        reads.flight,
        Effect.succeed({
          companies: [
            { legalEntityId: LegalEntityIdSchema.make(COMPANY_A), legalName: 'Firma A s.r.o.' },
            { legalEntityId: LegalEntityIdSchema.make(COMPANY_B), legalName: 'Firma B s.r.o.' },
          ],
          tenantName: 'Skupina',
        }),
      ),
  };
};

/**
 * Who may do what: a tenant owner everywhere, a company administrator in company A only, and Bob as a
 * delegate whose envelope the gate admits in company B although he administers nothing permanently.
 */
const PersonaSchema = Schema.Literals(['companyAdmin', 'delegate', 'nobody', 'owner']);
type Persona = typeof PersonaSchema.Type;

/** How the BFF asked the gate: each single decision, and each batch with its questions. */
interface GateAsks {
  readonly batches: (readonly GateInput[])[];
  readonly singles: GateInput[];
}

const gateFor = (persona: Persona, asks: GateAsks): AccessDecisionService => {
  const base = makeTestAccessDecision();
  const allowed = (input: GateInput): boolean =>
    persona === 'owner' ||
    (persona === 'companyAdmin' && input.legalEntityScope === 'required' && input.scope.legalEntityId === COMPANY_A) ||
    (persona === 'delegate' && input.legalEntityScope === 'required' && input.scope.legalEntityId === COMPANY_B);
  const answer = (input: GateInput): AccessDecision => ({
    evidence: [],
    outcome: allowed(input) ? 'ALLOWED' : 'DENIED',
    reasons: [{ code: allowed(input) ? 'structural.owner' : 'deny.insufficient_grant' }],
    selectors: [],
  });
  return {
    ...base,
    decide: (input) =>
      Effect.sync(() => {
        asks.singles.push(input);
        return answer(input);
      }),
    // A batch answers each question exactly as a single decision would, as the live gate does.
    decideMany: (inputs) =>
      Effect.sync(() => {
        asks.batches.push(inputs);
        return inputs.map(answer);
      }),
  };
};

/** Every command this suite's scripted Core receives, as the service names them. */
type PeopleCommand = Parameters<
  AccessPeopleCommandsService[Exclude<keyof AccessPeopleCommandsService, 'read' | 'readCatalog' | 'reconcile'>]
>[1];

interface Recorded {
  readonly calls: { readonly command: PeopleCommand; readonly operation: string }[];
  /** How many times a company directory was read. */
  directoryReads: number;
  /** The directory and catalogue reads in flight together. */
  readonly flight: Flight;
  /** How many times the projection was reconciled outside a write. */
  reconciles: number;
}

const commandsFor = (
  recorded: Recorded,
  failure?: PeopleCommandFailure,
  reconcileFailure?: PeopleCommandFailure,
): AccessPeopleCommandsService => {
  const answer = (operation: string, command: PeopleCommand) =>
    Effect.suspend(() => {
      recorded.calls.push({ command, operation });
      return failure === undefined ? Effect.succeed({ revision: 'after' }) : Effect.fail(failure);
    });
  return {
    admitMember: (_scope, command) => answer('admitMember', command),
    assignRole: (_scope, command) => answer('assignRole', command),
    endMembership: (_scope, command) => answer('endMembership', command),
    grantDelegation: (_scope, command) => answer('grantDelegation', command),
    read: () => Effect.succeed(view),
    readCatalog: () =>
      inFlight(
        recorded.flight,
        Effect.succeed([
          decode(CatalogSnapshotEntrySchema, {
            key: CAPABILITY,
            kind: 'action',
            modes: ['run'],
            moduleKey: 'test',
            placement: { group: 'parties', level: 'basic' },
            risk: 'sensitive',
            selectors: ['all'],
          }),
        ]),
      ),
    reconcile: () =>
      Effect.suspend(() => {
        recorded.reconciles += 1;
        return reconcileFailure === undefined ? Effect.void : Effect.fail(reconcileFailure);
      }),
    revokeDelegation: (_scope, command) => answer('revokeDelegation', command),
    setTeamMembership: (_scope, command) => answer('setTeamMembership', command),
    transferOwnership: (_scope, command) => answer('transferOwnership', command),
    unassignRole: (_scope, command) => answer('unassignRole', command),
  };
};

const harness = (input: {
  readonly failure?: PeopleCommandFailure;
  readonly persona: Persona;
  readonly reconcileFailure?: PeopleCommandFailure;
  readonly writes?: boolean;
}) => {
  const recorded: Recorded = { calls: [], directoryReads: 0, flight: { current: 0, most: 0 }, reconciles: 0 };
  const asks: GateAsks = { batches: [], singles: [] };
  const actor = { companyAdmin: COMPANY_ADMIN, delegate: BOB, nobody: OWNER, owner: OWNER }[input.persona];
  const gate = gateFor(input.persona, asks);
  const layer = AccessPeopleBffLive.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(AccessAdminSession, { requireTenantContext: () => Effect.succeed(scopeFor(actor)) }),
        Layer.succeed(AccessAdminClock, { now: Effect.succeed(NOW) }),
        Layer.succeed(AccessPeopleWriteAvailability, {
          available: input.writes ?? true,
          reason: 'pending real-gate verification',
        }),
        Layer.succeed(AccessDecisionGate, gate),
        Layer.succeed(AccessPeopleCommands, commandsFor(recorded, input.failure, input.reconcileFailure)),
        Layer.succeed(AccessPeopleDirectory, directoryFor(recorded)),
      ),
    ),
  );
  const run = <Value>(body: (bff: AccessPeopleBffService) => Effect.Effect<Value, AccessAdminProblem>) =>
    AccessPeopleBff.pipe(Effect.flatMap(body), Effect.provide(layer));
  return { asks, recorded, run };
};

const headers = new Headers();
const failureOf = <Value>(effect: Effect.Effect<Value, AccessAdminProblem>) => Effect.flip(effect);

/** The revision this persona's screen shows, read through the list exactly as the browser reads it. */
const revisionFor = (persona: Persona) =>
  harness({ persona })
    .run((bff) => bff.list(headers, { limit: 50 }))
    .pipe(Effect.map(({ revision }) => revision));

it.effect('decides every people operation by its own declared admin capability', () =>
  Effect.sync(() => {
    const keys = Object.values(accessPeopleDeclarations).map(({ key, kind }) => `${kind} ${key}`);
    expect(keys.toSorted()).toEqual([
      'admin shell-super-app.access-people.admit-member',
      'admin shell-super-app.access-people.assign',
      'admin shell-super-app.access-people.assignments',
      'admin shell-super-app.access-people.delegate',
      'admin shell-super-app.access-people.end-membership',
      'admin shell-super-app.access-people.list',
      'admin shell-super-app.access-people.options',
      'admin shell-super-app.access-people.revoke-assignment',
      'admin shell-super-app.access-people.revoke-delegation',
      'admin shell-super-app.access-people.team-membership',
      'admin shell-super-app.access-people.transfer-ownership',
    ]);
  }),
);

it.effect('lists every person, assignment, delegation and team of the tenant to its owner', () =>
  Effect.gen(function* ownerList() {
    const { run } = harness({ persona: 'owner' });
    const page = yield* run((bff) => bff.list(headers, { limit: 50 }));
    expect(page.items.map(({ displayName }) => displayName)).toEqual([
      'Alice Nováková',
      'Bob Dvořák',
      'Cyril Správce',
      'Olga Majitelová',
    ]);
    const alice = page.items.find(({ principalId }) => principalId === ALICE);
    expect(alice?.assignments.map(({ incarnationId, roleName }) => [incarnationId, roleName])).toEqual([
      [ALICE_ASSIGNMENT, 'Účetní A'],
    ]);
    expect(alice?.teams.map(({ name }) => name)).toEqual(['Fakturace']);
    const bob = page.items.find(({ principalId }) => principalId === BOB);
    expect(bob?.delegations.map(({ delegationId }) => delegationId)).toEqual([BOB_DELEGATION]);
    const owner = page.items.find(({ principalId }) => principalId === OWNER);
    expect(owner?.ownership.soleAdministratorScopes).toEqual([{ kind: 'tenant' }]);
    expect(page.revision).not.toBe(view.revision);
  }),
);

it.effect('pages the list after the narrowing and filters it by name', () =>
  Effect.gen(function* pagedList() {
    const { run } = harness({ persona: 'owner' });
    const first = yield* run((bff) => bff.list(headers, { limit: 2 }));
    expect(first.items).toHaveLength(2);
    expect(first.nextCursor).toBe('2');
    const second = yield* run((bff) => bff.list(headers, { cursor: '2', limit: 2 }));
    expect(second.items.map(({ principalId }) => principalId)).toEqual([COMPANY_ADMIN, OWNER]);
    expect(second.nextCursor).toBeNull();
    const named = yield* run((bff) => bff.list(headers, { limit: 50, query: 'bob' }));
    expect(named.items.map(({ principalId }) => principalId)).toEqual([BOB]);
  }),
);

it.effect('shows a company administrator only the people, rows and teams of their own company', () =>
  Effect.gen(function* companyNarrowing() {
    const { run } = harness({ persona: 'companyAdmin' });
    const page = yield* run((bff) => bff.list(headers, { limit: 50 }));
    // Bob holds nothing in company A: he is withheld exactly like a person who does not exist.
    expect(page.items.map(({ principalId }) => principalId)).toEqual([ALICE, COMPANY_ADMIN]);
    const alice = page.items.find(({ principalId }) => principalId === ALICE);
    expect(alice?.memberships.map(({ scope }) => scope)).toEqual([{ kind: 'company', legalEntityId: COMPANY_A }]);
    const refused = yield* failureOf(
      harness({ persona: 'companyAdmin' }).run((bff) =>
        bff.assignments(headers, decode(ListAccessAssignmentsPayloadSchema, { limit: 50, principalId: BOB })),
      ),
    );
    expect(refused.status).toBe(403);
    const options = yield* run((bff) => bff.options(headers, { limit: 100 }));
    expect(options.scopes).toEqual([{ label: 'Firma A s.r.o.', scope: { kind: 'company', legalEntityId: COMPANY_A } }]);
    expect(options.roles.map(({ roleId }) => roleId)).toEqual([ROLE_A]);
    expect(options.teams.map(({ teamId }) => teamId)).toEqual([TEAM_A]);
    expect(options.revision).toBe(page.revision);
    // The tenant-wide revision of the owner's screen is not this person's: a change in company B never
    // makes their form stale and never leaks through the token.
    expect(page.revision).not.toBe(yield* revisionFor('owner'));
  }),
);

it.effect('refuses a person whose authority covers no scope at all, never answering an empty page', () =>
  Effect.gen(function* nothingCovered() {
    const problem = yield* failureOf(harness({ persona: 'nobody' }).run((bff) => bff.list(headers, { limit: 50 })));
    expect(problem.status).toBe(403);
  }),
);

it.effect('assigns a role with an incarnation named by the idempotency key, in the scope the screen named', () =>
  Effect.gen(function* assignByKey() {
    const revision = yield* revisionFor('owner');
    const { recorded, run } = harness({ persona: 'owner' });
    const write = {
      headers,
      idempotencyKey: 'assign-1',
      payload: decode(AssignAccessRolePayloadSchema, {
        expectedRevision: revision,
        expectedRoleRevisionId: ROLE_A_REVISION,
        principalId: ALICE,
        roleId: ROLE_A,
        scope: { kind: 'company', legalEntityId: COMPANY_A },
      }),
    };
    const answer = yield* run((bff) => bff.assign(write));
    yield* run((bff) => bff.assign(write));
    expect(answer.revision).toBe(revision);
    expect(recorded.calls.map(({ operation }) => operation)).toEqual(['assignRole', 'assignRole']);
    const [first, retry] = recorded.calls.map(({ command }) => command);
    expect(first).toMatchObject({
      holder: { _tag: 'Principal', principalId: ALICE },
      roleId: ROLE_A,
      scopeId: A_SCOPE,
    });
    // A retry names the very same incarnation, so it can never fork a second assignment.
    expect(retry).toEqual(first);
  }),
);

it.effect('refuses a stale screen with 409 before Core writes, converging the projection first', () =>
  Effect.gen(function* staleRevision() {
    const { recorded, run } = harness({ persona: 'owner' });
    const problem = yield* failureOf(
      run((bff) =>
        bff.assign({
          headers,
          idempotencyKey: 'assign-2',
          payload: decode(AssignAccessRolePayloadSchema, {
            expectedRevision: 'an-old-revision',
            expectedRoleRevisionId: ROLE_A_REVISION,
            principalId: ALICE,
            roleId: ROLE_A,
            scope: { kind: 'company', legalEntityId: COMPANY_A },
          }),
        }),
      ),
    );
    expect(problem.status).toBe(409);
    expect(recorded.calls).toEqual([]);
    // A retry of a write that committed before its reconcile failed lands here; it reconciles once.
    expect(recorded.reconciles).toBe(1);
  }),
);

it.effect('answers a stale screen whose repair fails as unavailable, never as a change this request saved', () =>
  Effect.gen(function* staleRepairFails() {
    const { recorded, run } = harness({
      persona: 'owner',
      reconcileFailure: { code: 'access_projection_write_unavailable', reason: 'engine down' },
    });
    const problem = yield* failureOf(
      run((bff) =>
        bff.assign({
          headers,
          idempotencyKey: 'assign-3',
          payload: decode(AssignAccessRolePayloadSchema, {
            expectedRevision: 'an-old-revision',
            expectedRoleRevisionId: ROLE_A_REVISION,
            principalId: ALICE,
            roleId: ROLE_A,
            scope: { kind: 'company', legalEntityId: COMPANY_A },
          }),
        }),
      ),
    );
    expect(recorded.calls).toEqual([]);
    expect(problem).toEqual(accessAdminUnavailableProblem());
  }),
);

it.effect('refuses a company administrator a write into another company exactly like a missing scope', () =>
  Effect.gen(function* foreignCompanyWrite() {
    const revision = yield* revisionFor('companyAdmin');
    const { recorded, run } = harness({ persona: 'companyAdmin' });
    const intoB = yield* failureOf(
      run((bff) =>
        bff.assign({
          headers,
          idempotencyKey: 'assign-3',
          payload: decode(AssignAccessRolePayloadSchema, {
            expectedRevision: revision,
            expectedRoleRevisionId: ROLE_B_REVISION,
            principalId: ALICE,
            roleId: ROLE_B,
            scope: { kind: 'company', legalEntityId: COMPANY_B },
          }),
        }),
      ),
    );
    expect(intoB.status).toBe(403);
    const roleOfB = yield* failureOf(
      run((bff) =>
        bff.assign({
          headers,
          idempotencyKey: 'assign-4',
          payload: decode(AssignAccessRolePayloadSchema, {
            expectedRevision: revision,
            expectedRoleRevisionId: ROLE_B_REVISION,
            principalId: ALICE,
            roleId: ROLE_B,
            scope: { kind: 'company', legalEntityId: COMPANY_A },
          }),
        }),
      ),
    );
    expect(roleOfB.status).toBe(403);
    const bobsAssignment = yield* failureOf(
      run((bff) =>
        bff.revokeAssignment({
          headers,
          idempotencyKey: 'revoke-1',
          payload: decode(RevokeAccessAssignmentPayloadSchema, {
            expectedRevision: revision,
            incarnationId: BOB_ASSIGNMENT,
            reason: 'odchod',
          }),
        }),
      ),
    );
    expect(bobsAssignment.status).toBe(403);
    const bobsDelegation = yield* failureOf(
      run((bff) =>
        bff.revokeDelegation({
          headers,
          idempotencyKey: 'revoke-2',
          payload: decode(RevokeAccessDelegationPayloadSchema, {
            delegationId: BOB_DELEGATION,
            expectedRevision: revision,
            reason: 'konec',
          }),
        }),
      ),
    );
    expect(bobsDelegation.status).toBe(403);
    expect(recorded.calls).toEqual([]);
  }),
);

it.effect('unassigns, delegates and revokes a delegation through the Core people commands', () =>
  Effect.gen(function* peopleWrites() {
    const revision = yield* revisionFor('owner');
    const { recorded, run } = harness({ persona: 'owner' });
    yield* run((bff) =>
      bff.revokeAssignment({
        headers,
        idempotencyKey: 'revoke-3',
        payload: decode(RevokeAccessAssignmentPayloadSchema, {
          expectedRevision: revision,
          incarnationId: ALICE_ASSIGNMENT,
          reason: 'odchod',
        }),
      }),
    );
    const delegated = yield* run((bff) =>
      bff.createDelegation({
        headers,
        idempotencyKey: 'delegate-1',
        payload: decode(CreateAccessDelegationPayloadSchema, {
          capabilityKeys: [CAPABILITY],
          expectedRevision: revision,
          managerId: ALICE,
          people: [COMPANY_ADMIN],
          roleIds: [ROLE_A],
          scope: { kind: 'company', legalEntityId: COMPANY_A },
          validUntil: instant(20).toISOString(),
        }),
      }),
    );
    yield* run((bff) =>
      bff.revokeDelegation({
        headers,
        idempotencyKey: 'revoke-4',
        payload: decode(RevokeAccessDelegationPayloadSchema, {
          delegationId: BOB_DELEGATION,
          expectedRevision: revision,
          reason: 'konec',
        }),
      }),
    );
    yield* run((bff) =>
      bff.setTeamMembership({
        headers,
        idempotencyKey: 'team-1',
        payload: decode(SetAccessTeamMembershipPayloadSchema, {
          action: 'join',
          expectedRevision: revision,
          principalId: COMPANY_ADMIN,
          teamId: TEAM_A,
        }),
      }),
    );
    expect(recorded.calls.map(({ operation }) => operation)).toEqual([
      'unassignRole',
      'grantDelegation',
      'revokeDelegation',
      'setTeamMembership',
    ]);
    expect(recorded.calls[0]?.command).toEqual({ incarnationId: ALICE_ASSIGNMENT });
    expect(recorded.calls[1]?.command).toMatchObject({ managerId: ALICE, people: [COMPANY_ADMIN], scopeId: A_SCOPE });
    expect(recorded.calls[2]?.command).toEqual({ delegationId: BOB_DELEGATION });
    expect(recorded.calls[3]?.command).toMatchObject({ action: 'join', principalId: COMPANY_ADMIN, teamId: TEAM_A });
    expect(delegated.revision).toBe(revision);
  }),
);

/** One call of each of the eight people writes, as the screen showing `revision` sends it. */
const eightWrites = (revision: string) => ({
  admitMember: (bff: AccessPeopleBffService) =>
    bff.admitMember({
      headers,
      idempotencyKey: 'write-admit',
      payload: decode(AdmitAccessMemberPayloadSchema, {
        expectedRevision: revision,
        principalId: DANA,
        scope: { kind: 'company', legalEntityId: COMPANY_A },
      }),
    }),
  assign: (bff: AccessPeopleBffService) =>
    bff.assign({
      headers,
      idempotencyKey: 'write-assign',
      payload: decode(AssignAccessRolePayloadSchema, {
        expectedRevision: revision,
        expectedRoleRevisionId: ROLE_A_REVISION,
        principalId: ALICE,
        roleId: ROLE_A,
        scope: { kind: 'company', legalEntityId: COMPANY_A },
      }),
    }),
  createDelegation: (bff: AccessPeopleBffService) =>
    bff.createDelegation({
      headers,
      idempotencyKey: 'write-delegate',
      payload: decode(CreateAccessDelegationPayloadSchema, {
        capabilityKeys: [CAPABILITY],
        expectedRevision: revision,
        managerId: ALICE,
        people: [COMPANY_ADMIN],
        roleIds: [ROLE_A],
        scope: { kind: 'company', legalEntityId: COMPANY_A },
        validUntil: instant(20).toISOString(),
      }),
    }),
  endMembership: (bff: AccessPeopleBffService) =>
    bff.endMembership({
      headers,
      idempotencyKey: 'write-end',
      payload: decode(EndAccessMembershipPayloadSchema, {
        expectedRevision: revision,
        principalId: ALICE,
        reason: 'odchod z firmy',
        scope: { kind: 'company', legalEntityId: COMPANY_A },
      }),
    }),
  revokeAssignment: (bff: AccessPeopleBffService) =>
    bff.revokeAssignment({
      headers,
      idempotencyKey: 'write-unassign',
      payload: decode(RevokeAccessAssignmentPayloadSchema, {
        expectedRevision: revision,
        incarnationId: ALICE_ASSIGNMENT,
        reason: 'odchod',
      }),
    }),
  revokeDelegation: (bff: AccessPeopleBffService) =>
    bff.revokeDelegation({
      headers,
      idempotencyKey: 'write-revoke-delegation',
      payload: decode(RevokeAccessDelegationPayloadSchema, {
        delegationId: BOB_DELEGATION,
        expectedRevision: revision,
        reason: 'konec',
      }),
    }),
  setTeamMembership: (bff: AccessPeopleBffService) =>
    bff.setTeamMembership({
      headers,
      idempotencyKey: 'write-team',
      payload: decode(SetAccessTeamMembershipPayloadSchema, {
        action: 'join',
        expectedRevision: revision,
        principalId: COMPANY_ADMIN,
        teamId: TEAM_A,
      }),
    }),
  transferOwnership: (bff: AccessPeopleBffService) =>
    bff.transferOwnership({
      headers,
      idempotencyKey: 'write-transfer',
      payload: decode(TransferAccessOwnershipPayloadSchema, {
        expectedRevision: revision,
        fromPrincipalId: OWNER,
        scopes: [{ kind: 'tenant' }],
        toPrincipalId: ALICE,
      }),
    }),
});

it.effect('refuses all eight writes with a retryable 503 while the write gate is closed, and says so', () =>
  Effect.gen(function* closedGate() {
    const revision = yield* revisionFor('owner');
    const writes = Object.entries(eightWrites(revision));
    expect(writes).toHaveLength(8);
    const closed = harness({ persona: 'owner', writes: false });
    for (const [name, write] of writes) {
      const problem = yield* failureOf(closed.run(write));
      // The unavailable problem is the retryable one: a closed gate is never a denial.
      expect([name, problem.status, problem._tag]).toEqual([name, 503, 'AccessAdminUnavailable']);
    }
    const options = yield* closed.run((bff) => bff.options(headers, { limit: 100 }));
    expect(Object.values(options.writeAvailability)).toEqual(Array.from({ length: 8 }, () => false));
    expect(options.admissionCandidates).toEqual([]);
    // Nothing reached Core and no company directory was read while closed.
    expect(closed.recorded.calls).toEqual([]);
    expect(closed.recorded.directoryReads).toBe(0);
    // The same eight requests are real writes: with the gate open each reaches its Core command.
    const open = harness({ persona: 'owner' });
    for (const [, write] of writes) {
      yield* open.run(write);
    }
    expect(open.recorded.calls.map(({ operation }) => operation)).toEqual([
      'admitMember',
      'assignRole',
      'grantDelegation',
      'endMembership',
      'unassignRole',
      'revokeDelegation',
      'setTeamMembership',
      'transferOwnership',
    ]);
    const openOptions = yield* open.run((bff) => bff.options(headers, { limit: 100 }));
    expect(Object.values(openOptions.writeAvailability)).toEqual(Array.from({ length: 8 }, () => true));
  }),
);

it.effect('offers as admission candidates only active directory humans not yet live members of that company', () =>
  Effect.gen(function* candidates() {
    const owner = yield* harness({ persona: 'owner' }).run((bff) => bff.options(headers, { limit: 100 }));
    // Bob is a live member of B only, so A still offers him; Alice is live in A, Eva left, the agent is no person.
    expect(owner.admissionCandidates).toEqual([
      { displayName: 'Bob Dvořák', principalId: BOB, scope: { kind: 'company', legalEntityId: COMPANY_A } },
      { displayName: 'Dana Malá', principalId: DANA, scope: { kind: 'company', legalEntityId: COMPANY_A } },
      { displayName: 'Dana Malá', principalId: DANA, scope: { kind: 'company', legalEntityId: COMPANY_B } },
    ]);
    // A company administrator is offered their own company only, and B's directory is never read.
    const admin = harness({ persona: 'companyAdmin' });
    const own = yield* admin.run((bff) => bff.options(headers, { limit: 100 }));
    expect(own.admissionCandidates.map(({ principalId, scope }) => [principalId, scope])).toEqual([
      [BOB, { kind: 'company', legalEntityId: COMPANY_A }],
      [DANA, { kind: 'company', legalEntityId: COMPANY_A }],
    ]);
    expect(admin.recorded.directoryReads).toBe(1);
    expect([own.writeAvailability.canAdmitMember, own.writeAvailability.canEndMembership]).toEqual([true, true]);
  }),
);

it.effect('answers an owner options with one gate batch for every write and one directory read per company', () =>
  Effect.gen(function* boundedOptions() {
    const owner = harness({ persona: 'owner' });
    const offered = yield* owner.run((bff) => bff.options(headers, { limit: 100 }));
    const scopes = view.scopes.length;
    const companies = scopes - 1;
    const writes = Object.values(offered.writeAvailability).length;
    expect([scopes, companies, writes, offered.admissionCandidates.length]).toEqual([3, 2, 8, 3]);
    expect(Object.values(offered.writeAvailability)).toEqual(Array.from({ length: writes }, () => true));
    // The read's own admission is one batch of one question per scope, asked first so a refused reader is
    // asked nothing else; every write control is then one batch of one question per write and scope, never a
    // single decision per write and scope, which held an owner's options for tens of seconds.
    expect(owner.asks.singles).toHaveLength(0);
    expect(owner.asks.batches.map((batch) => batch.length)).toEqual([scopes, writes * scopes]);
    // Candidates come from one directory read per administered company, never one per candidate.
    expect(owner.recorded.directoryReads).toBe(companies);
  }),
);

it.effect('asks the options read before its writes, so a refused or a closed reader is asked the read only', () =>
  Effect.gen(function* optionsAdmission() {
    const nobody = harness({ persona: 'nobody' });
    const refused = yield* failureOf(nobody.run((bff) => bff.options(headers, { limit: 100 })));
    // Refused like every Lidé read that covers no scope, before any directory or catalogue read.
    expect(refused.status).toBe(403);
    expect(nobody.recorded.directoryReads).toBe(0);
    // Only the read's own question was asked, once per scope: no write question, so no write refusal is recorded.
    expect(nobody.asks.batches.map((batch) => batch.length)).toEqual([view.scopes.length]);
    expect(
      nobody.asks.batches
        .flat()
        .every((question) => question.carrier.accessDeclaration === accessPeopleDeclarations.options),
    ).toBe(true);
    const closed = harness({ persona: 'owner', writes: false });
    yield* closed.run((bff) => bff.options(headers, { limit: 100 }));
    // A closed Lidé gate asks the read's own declaration only: no write is asked or offered.
    expect(closed.asks.singles).toHaveLength(0);
    expect(closed.asks.batches.map((batch) => batch.length)).toEqual([view.scopes.length]);
    expect(
      closed.asks.batches
        .flat()
        .every((question) => question.carrier.accessDeclaration === accessPeopleDeclarations.options),
    ).toBe(true);
  }),
);

it.effect('runs the independent options reads two at a time, never more of the shared pool', () =>
  Effect.gen(function* boundedReads() {
    const owner = harness({ persona: 'owner' });
    yield* owner.run((bff) => bff.options(headers, { limit: 100 }));
    // The people, labels and catalogue reads, then one directory read per administered company.
    expect(owner.recorded.directoryReads).toBe(2);
    expect(owner.recorded.flight.most).toBe(2);
    expect(owner.recorded.flight.current).toBe(0);
  }),
);

it.effect('offers a delegate neither admission nor ending, which only permanent administration may run', () =>
  Effect.gen(function* delegateOptions() {
    const delegate = harness({ persona: 'delegate' });
    const offered = yield* delegate.run((bff) => bff.options(headers, { limit: 100 }));
    // The gate reaches company B through the envelope, so the other writes stay offered there.
    expect(offered.writeAvailability.canAssign).toBe(true);
    expect([offered.writeAvailability.canAdmitMember, offered.writeAvailability.canEndMembership]).toEqual([
      false,
      false,
    ]);
    expect(offered.admissionCandidates).toEqual([]);
    expect(delegate.recorded.directoryReads).toBe(0);
  }),
);

it.effect('admits a candidate with tenant and company rows named by the idempotency key', () =>
  Effect.gen(function* admitByKey() {
    const revision = yield* revisionFor('owner');
    const { recorded, run } = harness({ persona: 'owner' });
    const admit = eightWrites(revision).admitMember;
    yield* run(admit);
    yield* run(admit);
    const [first, retry] = recorded.calls.map(({ command }) => command);
    expect(first).toMatchObject({ holder: { _tag: 'Principal', principalId: DANA }, legalEntityId: COMPANY_A });
    // A retry names the very same two rows, and the tenant row is never the company row.
    expect(retry).toEqual(first);
    const rows = recorded.calls.flatMap(({ command }) =>
      'tenantMembershipId' in command ? [command.tenantMembershipId, command.companyMembershipId] : [],
    );
    expect(new Set(rows).size).toBe(2);
  }),
);

/** One admission by a persona, answering its status and how many Core commands ran. */
const admitInto = (persona: Persona, principalId: string, legalEntityId: string, expectedRevision?: string) =>
  Effect.gen(function* admitOne() {
    const revision = expectedRevision ?? (yield* revisionFor(persona));
    const { recorded, run } = harness({ persona });
    const problem = yield* failureOf(
      run((bff) =>
        bff.admitMember({
          headers,
          idempotencyKey: `admit-${principalId}`,
          payload: decode(AdmitAccessMemberPayloadSchema, {
            expectedRevision: revision,
            principalId,
            scope: { kind: 'company', legalEntityId },
          }),
        }),
      ),
    );
    return [problem.status, recorded.calls.length];
  });

it.effect('refuses a non-candidate before Core runs: 403 off the directory, 409 when already a member', () =>
  Effect.gen(function* nonCandidate() {
    expect(yield* admitInto('owner', EVA, COMPANY_A)).toEqual([403, 0]);
    expect(yield* admitInto('owner', AGENT, COMPANY_A)).toEqual([403, 0]);
    expect(yield* admitInto('owner', OWNER, COMPANY_A)).toEqual([403, 0]);
    expect(yield* admitInto('companyAdmin', DANA, COMPANY_B)).toEqual([403, 0]);
    expect(yield* admitInto('owner', ALICE, COMPANY_A)).toEqual([409, 0]);
    expect(yield* admitInto('owner', DANA, COMPANY_A, 'an-old-revision')).toEqual([409, 0]);
  }),
);

it.effect('ends a membership in the named scope and passes the reason on to Core', () =>
  Effect.gen(function* endMembership() {
    const revision = yield* revisionFor('owner');
    const { recorded, run } = harness({ persona: 'owner' });
    const end = eightWrites(revision).endMembership;
    yield* run(end);
    expect(recorded.calls[0]?.command).toEqual({
      holder: { _tag: 'Principal', principalId: ALICE },
      reason: 'odchod z firmy',
      scopeId: A_SCOPE,
    });
    const adminRevision = yield* revisionFor('companyAdmin');
    const admin = harness({ persona: 'companyAdmin' });
    const bobInB = yield* failureOf(
      admin.run((bff) =>
        bff.endMembership({
          headers,
          idempotencyKey: 'end-bob',
          payload: decode(EndAccessMembershipPayloadSchema, {
            expectedRevision: adminRevision,
            principalId: BOB,
            reason: 'odchod',
            scope: { kind: 'company', legalEntityId: COMPANY_B },
          }),
        }),
      ),
    );
    expect(bobInB.status).toBe(403);
    expect(admin.recorded.calls).toEqual([]);
  }),
);

it.effect('transfers ownership with membership rows named by the key, and refuses a scope outside reach', () =>
  Effect.gen(function* transfer() {
    const revision = yield* revisionFor('owner');
    const { recorded, run } = harness({ persona: 'owner' });
    const write = eightWrites(revision).transferOwnership;
    const answer = yield* run(write);
    yield* run(write);
    expect(answer).toMatchObject({ transferredScopes: [{ kind: 'tenant' }] });
    const [first, retry] = recorded.calls.map(({ command }) => command);
    expect(first).toMatchObject({ fromPrincipalId: OWNER, scopeIds: [TENANT_SCOPE], toPrincipalId: ALICE });
    expect(retry).toEqual(first);
    const adminRevision = yield* revisionFor('companyAdmin');
    const admin = harness({ persona: 'companyAdmin' });
    const tenantTakeover = yield* failureOf(
      admin.run((bff) =>
        bff.transferOwnership({
          headers,
          idempotencyKey: 'transfer-tenant',
          payload: decode(TransferAccessOwnershipPayloadSchema, {
            expectedRevision: adminRevision,
            fromPrincipalId: COMPANY_ADMIN,
            scopes: [{ kind: 'tenant' }],
            toPrincipalId: ALICE,
          }),
        }),
      ),
    );
    expect(tenantTakeover.status).toBe(403);
    expect(admin.recorded.calls).toEqual([]);
  }),
);

it.effect('maps Core refusals onto one status each: 409 for a moved row, 422 for a rule, 503 for a retry', () =>
  Effect.gen(function* refusalMapping() {
    const revision = yield* revisionFor('owner');
    const unassign = (failure: PeopleCommandFailure) =>
      failureOf(
        harness({ failure, persona: 'owner' }).run((bff) =>
          bff.revokeAssignment({
            headers,
            idempotencyKey: 'revoke-6',
            payload: decode(RevokeAccessAssignmentPayloadSchema, {
              expectedRevision: revision,
              incarnationId: ALICE_ASSIGNMENT,
              reason: 'x',
            }),
          }),
        ),
      ).pipe(Effect.map(({ status }) => status));
    expect(yield* unassign(peopleFailure('people_assignment_already_ended', 'ended'))).toBe(409);
    expect(yield* unassign(peopleFailure('delegation_limits_lost', 'lost'))).toBe(422);
    expect(yield* unassign(peopleFailure('access_intent_unavailable', 'down'))).toBe(503);
    expect(yield* unassign(peopleFailure('delegation_outside_grantor_authority', 'no'))).toBe(403);
    const membershipWrite = (name: 'admitMember' | 'endMembership', failure: PeopleCommandFailure) =>
      failureOf(harness({ failure, persona: 'owner' }).run(eightWrites(revision)[name])).pipe(
        Effect.map(({ status }) => status),
      );
    expect(yield* membershipWrite('endMembership', peopleFailure('people_membership_unknown', 'gone'))).toBe(409);
    expect(yield* membershipWrite('endMembership', peopleFailure('people_granted_delegations_live', 'live'))).toBe(409);
    expect(
      yield* membershipWrite('admitMember', peopleFailure('people_directory_membership_missing', 'departed')),
    ).toBe(422);
  }),
);
