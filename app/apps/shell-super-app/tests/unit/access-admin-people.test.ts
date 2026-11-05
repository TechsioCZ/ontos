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
import type { AccessPeopleDirectoryService } from '@app/core-runtime/access/intent/people-directory';
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
import { DateTime, Effect, Layer, Result, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import type { AccessAdminProblem } from '../../shared/access-admin-api.ts';
import {
  AssignAccessRolePayloadSchema,
  CreateAccessDelegationPayloadSchema,
  ListAccessAssignmentsPayloadSchema,
  RevokeAccessAssignmentPayloadSchema,
  RevokeAccessDelegationPayloadSchema,
  SetAccessTeamMembershipPayloadSchema,
} from '../../shared/access-admin-api.ts';
import { AccessAdminClock } from '../../api/access-admin/clock.ts';
import type { AccessPeopleBffService } from '../../api/access-admin/people.ts';
import { AccessPeopleBff, AccessPeopleBffLive, accessPeopleDeclarations } from '../../api/access-admin/people.ts';
import { AccessAdminSession } from '../../api/access-admin/session.ts';
import { AccessChangesWriteAvailability } from '../../api/access-admin/write-gate.ts';

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
  administration: administrationOf(memberships, AccessScopeIdSchema.make(TENANT_SCOPE)),
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
  [ALICE, 'Alice Nováková'],
  [BOB, 'Bob Dvořák'],
  [COMPANY_ADMIN, 'Cyril Správce'],
  [OWNER, 'Olga Majitelová'],
]);

const directory: AccessPeopleDirectoryService = {
  people: (_scope, ids) =>
    Effect.succeed(
      ids.flatMap((principalId) => {
        const displayName = NAMES.get(principalId);
        return displayName === undefined ? [] : [{ displayName, kind: 'human', principalId, status: 'active' }];
      }),
    ),
  scopeLabels: () =>
    Effect.succeed({
      companies: [
        { legalEntityId: LegalEntityIdSchema.make(COMPANY_A), legalName: 'Firma A s.r.o.' },
        { legalEntityId: LegalEntityIdSchema.make(COMPANY_B), legalName: 'Firma B s.r.o.' },
      ],
      tenantName: 'Skupina',
    }),
};

/** Who may do what: a tenant owner everywhere, a company administrator in company A only. */
const PersonaSchema = Schema.Literals(['companyAdmin', 'nobody', 'owner']);
type Persona = typeof PersonaSchema.Type;

const gateFor = (persona: Persona): AccessDecisionService => {
  const base = makeTestAccessDecision();
  const allowed = (input: GateInput): boolean =>
    persona === 'owner' ||
    (persona === 'companyAdmin' && input.legalEntityScope === 'required' && input.scope.legalEntityId === COMPANY_A);
  return {
    ...base,
    decide: (input) =>
      Effect.succeed<AccessDecision>({
        evidence: [],
        outcome: allowed(input) ? 'ALLOWED' : 'DENIED',
        reasons: [{ code: allowed(input) ? 'structural.owner' : 'deny.insufficient_grant' }],
        selectors: [],
      }),
  };
};

/** Every command this suite's scripted Core receives, as the service names them. */
type PeopleCommand = Parameters<
  AccessPeopleCommandsService[Exclude<keyof AccessPeopleCommandsService, 'read' | 'readCatalog' | 'reconcile'>]
>[1];

interface Recorded {
  readonly calls: { readonly command: PeopleCommand; readonly operation: string }[];
  /** How many times the projection was reconciled outside a write. */
  reconciles: number;
}

const commandsFor = (recorded: Recorded, failure?: PeopleCommandFailure): AccessPeopleCommandsService => {
  const answer = (operation: string, command: PeopleCommand) =>
    Effect.suspend(() => {
      recorded.calls.push({ command, operation });
      return failure === undefined ? Effect.succeed({ revision: 'after' }) : Effect.fail(failure);
    });
  return {
    assignRole: (_scope, command) => answer('assignRole', command),
    grantDelegation: (_scope, command) => answer('grantDelegation', command),
    read: () => Effect.succeed(view),
    readCatalog: () =>
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
    reconcile: () =>
      Effect.sync(() => {
        recorded.reconciles += 1;
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
  readonly writes?: boolean;
}) => {
  const recorded: Recorded = { calls: [], reconciles: 0 };
  const actor = input.persona === 'companyAdmin' ? COMPANY_ADMIN : OWNER;
  const gate = gateFor(input.persona);
  const layer = AccessPeopleBffLive.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(AccessAdminSession, { requireTenantContext: () => Effect.succeed(scopeFor(actor)) }),
        Layer.succeed(AccessAdminClock, { now: Effect.succeed(NOW) }),
        Layer.succeed(AccessChangesWriteAvailability, {
          available: input.writes ?? true,
          reason: 'pending real-gate verification',
        }),
        Layer.succeed(AccessDecisionGate, gate),
        Layer.succeed(AccessPeopleCommands, commandsFor(recorded, input.failure)),
        Layer.succeed(AccessPeopleDirectory, directory),
      ),
    ),
  );
  const run = <Value>(body: (bff: AccessPeopleBffService) => Effect.Effect<Value, AccessAdminProblem>) =>
    AccessPeopleBff.pipe(Effect.flatMap(body), Effect.provide(layer));
  return { recorded, run };
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
      'admin shell-super-app.access-people.assign',
      'admin shell-super-app.access-people.assignments',
      'admin shell-super-app.access-people.delegate',
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
    expect(first).toMatchObject({ principalId: ALICE, roleId: ROLE_A, scopeId: A_SCOPE });
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

it.effect('refuses every write with a retryable 503 while the write gate is closed, and says so', () =>
  Effect.gen(function* closedGate() {
    const revision = yield* revisionFor('owner');
    const { recorded, run } = harness({ persona: 'owner', writes: false });
    const problem = yield* failureOf(
      run((bff) =>
        bff.revokeAssignment({
          headers,
          idempotencyKey: 'revoke-5',
          payload: decode(RevokeAccessAssignmentPayloadSchema, {
            expectedRevision: revision,
            incarnationId: ALICE_ASSIGNMENT,
            reason: 'odchod',
          }),
        }),
      ),
    );
    expect(problem.status).toBe(503);
    expect(recorded.calls).toEqual([]);
    const options = yield* run((bff) => bff.options(headers, { limit: 100 }));
    expect(Object.values(options.writeAvailability)).toEqual([false, false, false, false, false, false]);
    const open = yield* harness({ persona: 'owner' }).run((bff) => bff.options(headers, { limit: 100 }));
    expect(Object.values(open.writeAvailability)).toEqual([true, true, true, true, true, true]);
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
  }),
);
