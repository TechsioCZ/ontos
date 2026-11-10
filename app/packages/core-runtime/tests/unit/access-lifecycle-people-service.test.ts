import { Effect, Option, Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import { TestClock } from 'effect/testing';

import { TrustedPrincipalContextSchema } from '../../src/actions/principal-context.ts';
import { CatalogDigestSchema, CatalogSnapshotIdSchema } from '../../src/access/ids.ts';
import type { AccessConfigureBasis } from '../../src/access/changes/authority.ts';
import type { AccessScopeId, PrincipalId } from '../../src/access/ids.ts';
import { AccessMembershipIdSchema, AccessMembershipSchema } from '../../src/access/intent/memberships.ts';
import { AccessTeamMemberIdSchema, AccessTeamMemberSchema, AccessTeamSchema } from '../../src/access/intent/teams.ts';
import type { AccessMembership } from '../../src/access/intent/memberships.ts';
import type { AccessPeopleIntent } from '../../src/access/intent/people-store.ts';
import type { AccessTeamWithMembers } from '../../src/access/intent/teams.ts';
import { administrationOf, makeAccessPeopleCommands } from '../../src/access/lifecycle/people-service.ts';
import { isSoleAdministrator } from '../../src/access/lifecycle/owners.ts';
import type { AssignRoleCommand, GrantDelegationCommand } from '../../src/access/lifecycle/people-service.ts';
import { peopleRefusal } from '../../src/access/lifecycle/people-commands.ts';
import type { PeopleCommandError, PeopleIntentWrite } from '../../src/access/lifecycle/people-commands.ts';
import { CatalogSnapshotSchema } from '../../src/access/model.ts';
import type { Assignment, Cell, Delegation } from '../../src/access/model.ts';
import type { OperationalScope } from '../../src/operations/context.ts';
import {
  capabilityKey,
  currency,
  dateAt,
  digestOf,
  ELAPSED,
  FUTURE,
  ids,
  legalEntityId,
  makeAssignment,
  makeCell,
  makeDelegation,
  makeEntry,
  makeRole,
  makeRoleRevision,
  person,
  personId,
} from './access-lifecycle-support.ts';

/*
 * The people command service over in-memory stores. A delegation is bounded by what its grantor holds
 * in the delegation's own scope, exactly as the gate reads authority: a capability, or a money ceiling,
 * held in another company or in the tenant context never stands in for authority in this one. Every
 * write is planned under the acting person's own configure basis, so a delegated manager writes only
 * through their envelope.
 */

const tenant = ids.tenant(1);
const tenantScope = ids.scope(1);
const scopeA = ids.scope(2);
const scopeB = ids.scope(3);
const companyA = legalEntityId(20);
const companyB = legalEntityId(30);
const AT = dateAt(Date.UTC(2026, 10, 3, 12));
const GRANTOR = personId(5);
const MANAGER = personId(4);
const MEMBER = personId(2);
const PAY = capabilityKey('finance.invoice.pay');
const REFUND = capabilityKey('finance.invoice.refund');
const CZK = currency('CZK');

const roleA = makeRole({ id: ids.role(1), legalEntityId: companyA });
const roleB = makeRole({ id: ids.role(2), legalEntityId: companyB });
const tenantRole = makeRole({ id: ids.role(3) });
const rolesByScope = new Map([
  [scopeA, roleA],
  [scopeB, roleB],
]);

const membership = (holder: PrincipalId, scopeId: AccessScopeId, n: number): AccessMembership =>
  Schema.decodeUnknownSync(AccessMembershipSchema)({
    createdAt: ELAPSED,
    holder: person(Number(holder.slice(-12))),
    id: Schema.decodeUnknownSync(AccessMembershipIdSchema)(`10000000-0000-4000-8000-${n.toString().padStart(12, '0')}`),
    kind: 'member',
    recordedBy: personId(900),
    scopeId,
    status: 'active',
    tenantId: tenant,
    validFrom: ELAPSED,
  });

const catalog = Schema.decodeUnknownSync(CatalogSnapshotSchema)({
  digest: Schema.decodeUnknownSync(CatalogDigestSchema)('a'.repeat(64)),
  entries: [
    makeEntry({ amountInput: 'amountMinor', key: PAY }),
    makeEntry({ amountInput: 'amountMinor', key: REFUND }),
  ],
  id: Schema.decodeUnknownSync(CatalogSnapshotIdSchema)('00000000-0000-4000-8000-000000000090'),
  publishedAt: ELAPSED,
});

const ceilingOf = (limitMinor: number) => ({ currency: CZK, limitMinor });
const payCell = (limitMinor: number): Cell => makeCell({ amountCeiling: ceilingOf(limitMinor), capabilityKey: PAY });

/** One grantor assignment of the pay capability in a scope, through a role revision of its own. */
const holding = (n: number, scopeId: AccessScopeId, limitMinor: number) => {
  const role = rolesByScope.get(scopeId) ?? tenantRole;
  const revision = makeRoleRevision({ cells: [payCell(limitMinor)], id: ids.roleRevision(n), roleId: role.id });
  const assignment: Assignment = makeAssignment({
    holder: person(5),
    incarnationId: ids.incarnation(n),
    roleId: role.id,
    roleRevisionId: revision.id,
    scopeId,
  });
  return { assignment, revision, role };
};

const scopeOf = (principalId: PrincipalId): OperationalScope => ({
  ...Schema.decodeSync(TrustedPrincipalContextSchema)({
    authBindingId: '53000000-0000-4000-8000-000000000001',
    authContextRef: 'better-auth-session:people-service',
    authMethod: 'session',
    principalId,
    tenantId: tenant,
  }),
  correlationId: 'people-service',
});
const grantorScope = scopeOf(GRANTOR);
const managerScope = scopeOf(MANAGER);

/** A second company-B role the delegation below does not name. */
const otherRoleB = makeRole({ id: ids.role(4), legalEntityId: companyB });
const roleBRevision = makeRoleRevision({ cells: [payCell(1)], id: ids.roleRevision(99), roleId: roleB.id });
const otherRoleBRevision = makeRoleRevision({ cells: [payCell(1)], id: ids.roleRevision(98), roleId: otherRoleB.id });

interface ServiceFixture {
  /** The store's write, when a case needs it to refuse inside its own transaction. */
  readonly apply?: (writes: readonly PeopleIntentWrite[]) => Effect.Effect<void, PeopleCommandError>;
  /** The acting person's configure bases, as the tenant intent loader answers them. */
  readonly bases?: readonly AccessConfigureBasis[];
  readonly delegations?: readonly Delegation[];
  /** The tenant's membership rows; the default makes the manager, member and grantor company-B members. */
  readonly memberships?: readonly AccessMembership[];
  /** Counts the reconciles, so a refused write is seen to project nothing. */
  readonly reconciled?: { count: number };
  /** Roles of the tenant nobody in the fixture holds. */
  readonly roles?: AccessPeopleIntent['roles'];
  readonly teams?: readonly AccessTeamWithMembers[];
  /** Every write the service persists, in order. */
  readonly written?: PeopleIntentWrite[];
}

/** The service over one tenant's intent: every command is decided against these rows alone. */
const serviceOver = (holdings: readonly ReturnType<typeof holding>[], fixture: ServiceFixture = {}) => {
  const intent: AccessPeopleIntent = {
    assignments: holdings.map(({ assignment }) => assignment),
    delegations: fixture.delegations ?? [],
    roles: [
      ...holdings.map(({ revision, role }) => ({ revision, role })),
      { revision: roleBRevision, role: roleB },
      { revision: otherRoleBRevision, role: otherRoleB },
      ...(fixture.roles ?? []),
    ],
    scopes: [
      { scopeId: tenantScope, tenantContextId: tenant },
      { legalEntityId: companyA, scopeId: scopeA },
      { legalEntityId: companyB, scopeId: scopeB },
    ],
  };
  const unused = Effect.die(new Error('not used by the people service'));
  return makeAccessPeopleCommands({
    loader: { loadConfigureBases: () => Effect.succeed(fixture.bases ?? [{ _tag: 'Owner' }]) },
    memberships: {
      loadTenantMemberships: () =>
        Effect.succeed(
          fixture.memberships ?? [
            membership(MANAGER, scopeB, 1),
            membership(MEMBER, scopeB, 2),
            membership(GRANTOR, scopeB, 3),
            // A company grantor's grants count only on a live path: the tenant's membership and the company's.
            membership(GRANTOR, tenantScope, 4),
          ],
        ),
      recordMembership: () => unused,
      recordMemberships: () => unused,
      setMembershipStatus: () => unused,
    },
    people: {
      applyPeopleChange: (_scope, change) =>
        (fixture.apply?.(change.writes) ?? Effect.void).pipe(
          Effect.andThen(
            Effect.sync(() => {
              fixture.written?.push(...change.writes);
            }),
          ),
        ),
      loadCatalogSnapshot: () => Effect.succeed(Option.some(catalog)),
      loadTenantPeople: () => Effect.succeed(intent),
    },
    projection: {
      reconcileTenant: () =>
        Effect.sync(() => {
          if (fixture.reconciled !== undefined) {
            fixture.reconciled.count += 1;
          }
        }).pipe(
          Effect.as({
            deletions: 0,
            digest: digestOf('b'),
            operationId: ids.operation(1),
            projectionToken: 'token',
            resumed: false,
            scopeId: tenantScope,
            touches: 0,
            units: [],
            verified: true,
          }),
        ),
    },
    teams: {
      loadTenantTeams: () => Effect.succeed(fixture.teams ?? []),
      recordTeam: () => unused,
      recordTeamMember: () => unused,
      removeTeamMember: () => unused,
    },
  });
};

const delegationInB = (limitMinor: number): GrantDelegationCommand => ({
  amountCeiling: { currency: 'CZK', limitMinor },
  capabilityKeys: [PAY],
  delegationId: ids.delegationId(1),
  managerId: MANAGER,
  people: [MEMBER],
  roleIds: [roleB.id],
  scopeId: scopeB,
  validUntil: FUTURE,
});

it.effect('bounds a delegation by the authority its grantor holds in the delegation scope only', () =>
  Effect.gen(function* delegationIsBoundedInItsScope() {
    yield* TestClock.setTime(AT.getTime());

    // Holding the capability in company A, or in the tenant context, is no authority in company B.
    const elsewhere = yield* Effect.flip(
      serviceOver([holding(1, scopeA, 50_000), holding(2, tenantScope, 50_000)]).grantDelegation(
        grantorScope,
        delegationInB(1000),
      ),
    );
    expect(elsewhere.code).toBe('delegation_outside_grantor_authority');

    // Held in company B, the same delegation is granted there.
    const granted = yield* serviceOver([holding(3, scopeB, 50_000)]).grantDelegation(grantorScope, delegationInB(1000));
    expect(granted.delegation?.scopeId).toBe(scopeB);

    // The grantor's ceiling is B's: a narrower limit held in company A does not cap it ...
    const service = serviceOver([holding(4, scopeA, 1000), holding(5, scopeB, 50_000)]);
    const wide = yield* service.grantDelegation(grantorScope, delegationInB(20_000));
    expect(wide.delegation?.amountCeiling).toEqual(ceilingOf(20_000));
    // ... and B's own limit still does.
    const beyond = yield* Effect.flip(service.grantDelegation(grantorScope, delegationInB(60_000)));
    expect(beyond.code).toBe('delegation_amount_outside_envelope');
  }),
);

it.effect('checks a delegation against the ceiling its grantor holds for each capability it covers', () =>
  Effect.gen(function* ceilingsStayWithTheirCapability() {
    yield* TestClock.setTime(AT.getTime());
    // The grantor pays up to 50 000 CZK and refunds up to 100 USD, both in company B.
    const { assignment, role } = holding(8, scopeB, 50_000);
    const revision = makeRoleRevision({
      cells: [
        payCell(50_000),
        makeCell({ amountCeiling: { currency: currency('USD'), limitMinor: 100 }, capabilityKey: REFUND }),
      ],
      id: assignment.roleRevisionId,
      roleId: role.id,
    });
    // The delegation hands out a company-B role that pays without a ceiling of its own.
    const payer = makeRole({ id: ids.role(5), legalEntityId: companyB });
    const payerRevision = makeRoleRevision({
      cells: [makeCell({ capabilityKey: PAY })],
      id: ids.roleRevision(97),
      roleId: payer.id,
    });
    const service = serviceOver([{ assignment, revision, role }], {
      roles: [{ revision: payerRevision, role: payer }],
    });
    const payThrough = (currencyCode: string, limitMinor: number): GrantDelegationCommand => ({
      ...delegationInB(1),
      amountCeiling: { currency: currencyCode, limitMinor },
      roleIds: [payer.id],
    });

    // The refund limit is not a pay limit: pay is delegated up to its own 50 000 CZK ...
    const pay = yield* service.grantDelegation(grantorScope, payThrough('CZK', 20_000));
    expect(pay.delegation?.amountCeiling).toEqual(ceilingOf(20_000));
    // ... and pay authority in USD is never borrowed from the refund limit.
    const borrowed = yield* Effect.flip(service.grantDelegation(grantorScope, payThrough('USD', 100)));
    expect(borrowed.code).toBe('delegation_amount_outside_envelope');
  }),
);

/** The grantor's own pay authority in company B, received through delegation 7 of up to 5 000 CZK. */
const receivedThrough = (status: Delegation['status']) => {
  const source = makeDelegation({
    amountCeiling: ceilingOf(5000),
    capabilityKeys: [PAY],
    id: ids.delegationId(7),
    managerId: personId(3),
    people: [GRANTOR],
    roleIds: [roleB.id],
    scopeId: scopeB,
    status,
  });
  const { revision, role } = holding(6, scopeB, 50_000);
  const assignment = makeAssignment({
    delegated: { amountCeiling: ceilingOf(5000), capabilityKeys: [PAY], delegationId: source.id, until: FUTURE },
    holder: person(5),
    incarnationId: ids.incarnation(6),
    roleId: role.id,
    roleRevisionId: revision.id,
    scopeId: scopeB,
    validUntil: FUTURE,
  });
  return serviceOver([{ assignment, revision, role }], { delegations: [source] });
};

it.effect('counts delegated authority only while its delegation lives, and only inside its envelope', () =>
  Effect.gen(function* delegatedAuthorityFollowsItsDelegation() {
    yield* TestClock.setTime(AT.getTime());

    // While delegation 7 lives, the grantor may hand on pay authority, but only up to its 5 000 CZK.
    const live = receivedThrough('active');
    const granted = yield* live.grantDelegation(grantorScope, delegationInB(1000));
    expect(granted.delegation?.amountCeiling).toEqual(ceilingOf(1000));
    const beyond = yield* Effect.flip(live.grantDelegation(grantorScope, delegationInB(20_000)));
    expect(beyond.code).toBe('delegation_amount_outside_envelope');

    // Once delegation 7 is revoked, its assignment grants the grantor nothing to delegate.
    const revoked = yield* Effect.flip(receivedThrough('revoked').grantDelegation(grantorScope, delegationInB(1000)));
    expect(revoked.code).toBe('delegation_outside_grantor_authority');
  }),
);

/** A live delegation of company B: MANAGER assigns role B, and only to MEMBER, up to 5 000 CZK. */
const managed = (status: Delegation['status'] = 'active'): Delegation =>
  makeDelegation({
    amountCeiling: ceilingOf(5000),
    capabilityKeys: [PAY],
    grantedBy: GRANTOR,
    managerId: MANAGER,
    people: [MEMBER],
    roleIds: [roleB.id],
    scopeId: scopeB,
    status,
  });

const delegatedBasis = (delegation: Delegation): AccessConfigureBasis => ({
  _tag: 'DelegatedManager',
  delegation,
  scope: { id: scopeB, scope: { _tag: 'LegalEntity', legalEntityId: companyB, tenantId: tenant } },
});

const assignInB = (principalId: PrincipalId, n: number, role = roleB, revision = roleBRevision): AssignRoleCommand => ({
  incarnationId: ids.incarnation(100 + n),
  principalId,
  roleId: role.id,
  roleRevisionId: revision.id,
  scopeId: scopeB,
});

it.effect('assigns through a delegated manager envelope only, and freezes its limits on the assignment', () =>
  Effect.gen(function* delegatedManagerAssignsInsideEnvelope() {
    yield* TestClock.setTime(AT.getTime());
    const delegation = managed();
    const written: PeopleIntentWrite[] = [];
    // The grantor pays in company B, which is what the delegate hands on.
    const service = serviceOver([holding(10, scopeB, 50_000)], {
      bases: [delegatedBasis(delegation)],
      delegations: [delegation],
      written,
    });

    // A role the envelope names, for a person it names: written with the delegation's frozen limits.
    const assigned = yield* service.assignRole(managerScope, assignInB(MEMBER, 1));
    expect(assigned.assignment?.delegated).toEqual({
      amountCeiling: ceilingOf(5000),
      capabilityKeys: [PAY],
      delegationId: delegation.id,
      until: delegation.validUntil,
    });
    expect(assigned.assignment?.validUntil).toEqual(delegation.validUntil);
    // The write names the grantor assignment that covers it, which the store locks as it commits.
    expect(written).toEqual([
      {
        _tag: 'RecordAssignment',
        assignment: assigned.assignment,
        grantorCover: [{ incarnationId: ids.incarnation(10), roleRevisionId: ids.roleRevision(10) }],
      },
    ]);

    // A role outside `roleIds`, the manager themselves and a person outside the envelope are refused.
    const foreignRole = yield* Effect.flip(
      service.assignRole(managerScope, assignInB(MEMBER, 2, otherRoleB, otherRoleBRevision)),
    );
    expect(foreignRole.code).toBe('delegation_role_outside_envelope');
    const self = yield* Effect.flip(service.assignRole(managerScope, assignInB(MANAGER, 3)));
    expect(self.code).toBe('delegation_self_assignment');
    const outsider = yield* Effect.flip(service.assignRole(managerScope, assignInB(GRANTOR, 4)));
    expect(outsider.code).toBe('delegation_holder_outside_envelope');
    expect(written).toHaveLength(1);

    // A grantor who no longer pays leaves the delegate nothing to assign, though the delegation lives.
    const lapsed = yield* Effect.flip(
      serviceOver([], { bases: [delegatedBasis(delegation)], delegations: [delegation] }).assignRole(
        managerScope,
        assignInB(MEMBER, 5),
      ),
    );
    expect(lapsed.code).toBe('delegation_outside_grantor_authority');
  }),
);

it.effect('refuses a person without a live basis in the scope, and keeps the direct path for an owner', () =>
  Effect.gen(function* basisDecidesThePath() {
    yield* TestClock.setTime(AT.getTime());
    const revoked = managed('revoked');
    // A revoked delegation is no basis at all, and neither is nothing.
    const lapsed = yield* Effect.flip(
      serviceOver([], { bases: [delegatedBasis(revoked)], delegations: [revoked] }).assignRole(
        managerScope,
        assignInB(MEMBER, 5),
      ),
    );
    expect(lapsed.code).toBe('people_authority_missing');
    const none = yield* Effect.flip(serviceOver([], { bases: [] }).assignRole(managerScope, assignInB(MEMBER, 6)));
    expect(none.code).toBe('people_authority_missing');

    // A company administrator of another company does not reach company B.
    const elsewhere = yield* Effect.flip(
      serviceOver([], { bases: [{ _tag: 'ScopeAdmin', legalEntityIds: [companyA], tenantContext: false }] }).assignRole(
        grantorScope,
        assignInB(MEMBER, 7),
      ),
    );
    expect(elsewhere.code).toBe('people_authority_missing');

    // An owner assigns directly, with no envelope; so does one who also manages a delegation there.
    const delegation = managed();
    const owned = yield* serviceOver([], {
      bases: [delegatedBasis(delegation), { _tag: 'Owner' }],
      delegations: [delegation],
    }).assignRole(grantorScope, assignInB(MANAGER, 8));
    expect(owned.assignment?.delegated).toBeUndefined();
    expect(owned.assignment?.assignedBy).toBe(GRANTOR);
  }),
);

it.effect('never lets a delegated manager grant or revoke a delegation', () =>
  Effect.gen(function* delegateManagesAssignmentsOnly() {
    yield* TestClock.setTime(AT.getTime());
    const delegation = managed();
    const service = serviceOver([holding(10, scopeB, 50_000)], {
      bases: [delegatedBasis(delegation)],
      delegations: [delegation],
    });
    const redelegated = yield* Effect.flip(
      service.grantDelegation(managerScope, { ...delegationInB(1000), managerId: GRANTOR }),
    );
    expect(redelegated.code).toBe('delegation_redelegation');
    const revoked = yield* Effect.flip(service.revokeDelegation(managerScope, { delegationId: delegation.id }));
    expect(revoked.code).toBe('delegation_redelegation');
    // Nor take ownership: ownership is permanent, and a delegation ends.
    const written: PeopleIntentWrite[] = [];
    const transferred = yield* Effect.flip(
      serviceOver([holding(11, scopeB, 50_000)], {
        bases: [delegatedBasis(delegation)],
        delegations: [delegation],
        written,
      }).transferOwnership(managerScope, {
        fromPrincipalId: GRANTOR,
        membershipIds: [],
        scopeIds: [scopeB],
        toPrincipalId: MANAGER,
      }),
    );
    expect(transferred.code).toBe('people_authority_missing');
    expect(written).toEqual([]);
  }),
);

it.effect('counts an owner as an administrator only over a live, unsuspended membership path', () =>
  Effect.gen(function* administrationNeedsThePath() {
    yield* TestClock.setTime(AT.getTime());
    const ownerRow = (holder: PrincipalId, n: number): AccessMembership => ({
      ...membership(holder, tenantScope, n),
      kind: 'owner',
    });
    // Two owners, but the manager's own tenant membership has ended: only the grantor administers.
    const administration = administrationOf(
      [ownerRow(GRANTOR, 21), membership(GRANTOR, tenantScope, 22), ownerRow(MANAGER, 23)],
      tenantScope,
      AT,
    );
    expect(isSoleAdministrator({ administration, at: AT, principalId: GRANTOR, scopeId: tenantScope })).toBe(true);
    // With the manager back as a member, the grantor no longer administers alone.
    const restored = administrationOf(
      [
        ownerRow(GRANTOR, 21),
        membership(GRANTOR, tenantScope, 22),
        ownerRow(MANAGER, 23),
        membership(MANAGER, tenantScope, 24),
      ],
      tenantScope,
      AT,
    );
    expect(isSoleAdministrator({ administration: restored, at: AT, principalId: GRANTOR, scopeId: tenantScope })).toBe(
      false,
    );
  }),
);

/* ------------------------------------------------------------------------------------------------
 * Admission and ending: permanent authority only, the directory checked in the write, nothing revived
 * ---------------------------------------------------------------------------------------------- */

const OWNER = personId(1);
const LEAVER = MEMBER;
const ADMIN_A = personId(6);
const NEWCOMER = personId(7);
const ownerScope = scopeOf(OWNER);
const adminAScope = scopeOf(ADMIN_A);
const adminOf = (legalEntity: typeof companyA): AccessConfigureBasis => ({
  _tag: 'ScopeAdmin',
  legalEntityIds: [legalEntity],
  tenantContext: false,
});

const row = (
  holder: PrincipalId,
  scopeId: AccessScopeId,
  n: number,
  kind: AccessMembership['kind'] = 'member',
): AccessMembership => ({ ...membership(holder, scopeId, n), kind });

/** The owner, a company-A administrator and a person who is a member of the tenant and both companies. */
const peopleRows: readonly AccessMembership[] = [
  row(OWNER, tenantScope, 60),
  row(OWNER, tenantScope, 61, 'owner'),
  row(ADMIN_A, tenantScope, 62),
  row(ADMIN_A, scopeA, 63),
  row(ADMIN_A, scopeA, 64, 'access_admin'),
  row(LEAVER, tenantScope, 65),
  row(LEAVER, scopeA, 66),
  row(LEAVER, scopeB, 67),
];
const leaverRow = (scopeId: AccessScopeId) =>
  peopleRows.find(
    (candidate) =>
      candidate.scopeId === scopeId &&
      candidate.kind === 'member' &&
      candidate.holder._tag === 'Principal' &&
      candidate.holder.principalId === LEAVER,
  );

const teamIn = (scopeId: AccessScopeId, n: number): AccessTeamWithMembers => {
  const team = Schema.decodeUnknownSync(AccessTeamSchema)({
    createdAt: ELAPSED,
    createdBy: OWNER,
    id: ids.teamId(n),
    name: `Team ${n}`,
    scopeId,
    tenantId: tenant,
  });
  const member = Schema.decodeUnknownSync(AccessTeamMemberSchema)({
    addedAt: ELAPSED,
    addedBy: OWNER,
    holder: person(2),
    id: Schema.decodeUnknownSync(AccessTeamMemberIdSchema)(`30000000-0000-4000-8000-${n.toString().padStart(12, '0')}`),
    teamId: team.id,
    tenantId: tenant,
  });
  return { members: [member], team };
};

const leaverHolding = (n: number, scopeId: AccessScopeId) => ({
  ...holding(n, scopeId, 1000),
  assignment: makeAssignment({
    holder: person(2),
    incarnationId: ids.incarnation(n),
    roleId: (rolesByScope.get(scopeId) ?? tenantRole).id,
    roleRevisionId: ids.roleRevision(n),
    scopeId,
  }),
});

const admitInto = (legalEntity: typeof companyA, principalId: PrincipalId = NEWCOMER) => ({
  companyMembershipId: Schema.decodeUnknownSync(AccessMembershipIdSchema)('40000000-0000-4000-8000-000000000002'),
  legalEntityId: legalEntity,
  principalId,
  tenantMembershipId: Schema.decodeUnknownSync(AccessMembershipIdSchema)('40000000-0000-4000-8000-000000000001'),
});

it.effect('admits through permanent authority over the company only, with the directory checked in the write', () =>
  Effect.gen(function* admissionNeedsPermanentAuthority() {
    yield* TestClock.setTime(AT.getTime());
    const written: PeopleIntentWrite[] = [];
    const admitted = yield* serviceOver([], {
      bases: [adminOf(companyA)],
      memberships: peopleRows,
      written,
    }).admitMember(adminAScope, admitInto(companyA));
    expect(admitted.membership).toEqual({ principalId: NEWCOMER, scopeId: scopeA, status: 'active' });
    // A company administrator's admission writes the person's tenant row too, after the precondition.
    expect(written.map((write) => write._tag)).toEqual([
      'RequireDirectoryMember',
      'RecordMembership',
      'RecordMembership',
    ]);
    expect(written[0]).toEqual({ _tag: 'RequireDirectoryMember', legalEntityId: companyA, principalId: NEWCOMER });

    // The administrator of company B does not reach A; a delegated manager never admits anybody.
    const elsewhere = yield* Effect.flip(
      serviceOver([], { bases: [adminOf(companyB)], memberships: peopleRows }).admitMember(
        adminAScope,
        admitInto(companyA),
      ),
    );
    expect(elsewhere.code).toBe('people_authority_missing');
    const delegation = managed();
    const delegated = yield* Effect.flip(
      serviceOver([], {
        bases: [delegatedBasis(delegation)],
        delegations: [delegation],
        memberships: peopleRows,
      }).admitMember(managerScope, admitInto(companyB)),
    );
    expect(delegated.code).toBe('people_authority_missing');
    const unknown = yield* Effect.flip(
      serviceOver([], { memberships: peopleRows }).admitMember(ownerScope, admitInto(legalEntityId(99))),
    );
    expect(unknown.code).toBe('people_membership_scope_mismatch');
  }),
);

it.effect('refuses an admission the directory refutes inside the write transaction, and projects nothing', () =>
  Effect.gen(function* directoryCheckedInTheWrite() {
    yield* TestClock.setTime(AT.getTime());
    // The person was 'active' when the screen offered them and departs before the write: only the
    // store's own transaction sees that, so the service must hand it the precondition and report it.
    const departed = new Set<PrincipalId>([NEWCOMER]);
    const reconciled = { count: 0 };
    const refused = yield* Effect.flip(
      serviceOver([], {
        apply: (writes) =>
          writes.some((write) => write._tag === 'RequireDirectoryMember' && departed.has(write.principalId))
            ? Effect.fail(peopleRefusal('people_directory_membership_missing', 'departed'))
            : Effect.void,
        memberships: peopleRows,
        reconciled,
      }).admitMember(ownerScope, admitInto(companyA)),
    );
    expect(refused.code).toBe('people_directory_membership_missing');
    expect(reconciled.count).toBe(0);
  }),
);

it.effect('ends exactly the closed scopes: one company, or the tenant and every company with it', () =>
  Effect.gen(function* endingClosesItsScopes() {
    yield* TestClock.setTime(AT.getTime());
    const holdings = [leaverHolding(31, scopeA), leaverHolding(32, scopeB), leaverHolding(33, tenantScope)];
    const managesA = makeDelegation({
      grantedBy: OWNER,
      id: ids.delegationId(51),
      managerId: LEAVER,
      people: [MANAGER],
      roleIds: [roleA.id],
      scopeId: scopeA,
    });
    const managesB = makeDelegation({
      grantedBy: OWNER,
      id: ids.delegationId(52),
      managerId: LEAVER,
      people: [MANAGER],
      roleIds: [roleB.id],
      scopeId: scopeB,
    });
    const teams = [teamIn(scopeA, 1), teamIn(scopeB, 2)];
    const fixture = { delegations: [managesA, managesB], memberships: peopleRows, teams };
    const reason = 'Moved to another employer';

    const companyWrites: PeopleIntentWrite[] = [];
    const company = yield* serviceOver(holdings, { ...fixture, written: companyWrites }).endMembership(ownerScope, {
      principalId: LEAVER,
      reason,
      scopeId: scopeA,
    });
    expect(company.membership).toEqual({ principalId: LEAVER, scopeId: scopeA, status: 'revoked' });
    // Company A only: its row with the reason, its managed delegation, assignment and team place; the
    // tenant row, company B and everything in them stay.
    expect(companyWrites).toEqual([
      { _tag: 'EndMembership', membershipId: leaverRow(scopeA)?.id, reason, status: 'revoked' },
      { _tag: 'EndDelegation', delegationId: managesA.id },
      { _tag: 'EndAssignment', incarnationId: ids.incarnation(31) },
      { _tag: 'RemoveTeamMember', teamMemberId: teams[0]?.members[0]?.id },
    ]);

    const tenantWrites: PeopleIntentWrite[] = [];
    yield* serviceOver(holdings, { ...fixture, written: tenantWrites }).endMembership(ownerScope, {
      principalId: LEAVER,
      reason,
      scopeId: tenantScope,
    });
    // Leaving the tenant closes every company: all three member rows (each with the reason), both
    // delegations, all three assignments and both team places.
    expect(tenantWrites).toHaveLength(10);
    expect(tenantWrites).toEqual(
      expect.arrayContaining([
        { _tag: 'EndMembership', membershipId: leaverRow(tenantScope)?.id, reason, status: 'revoked' },
        { _tag: 'EndMembership', membershipId: leaverRow(scopeA)?.id, reason, status: 'revoked' },
        { _tag: 'EndMembership', membershipId: leaverRow(scopeB)?.id, reason, status: 'revoked' },
        { _tag: 'EndDelegation', delegationId: managesA.id },
        { _tag: 'EndDelegation', delegationId: managesB.id },
        { _tag: 'EndAssignment', incarnationId: ids.incarnation(31) },
        { _tag: 'EndAssignment', incarnationId: ids.incarnation(32) },
        { _tag: 'EndAssignment', incarnationId: ids.incarnation(33) },
      ]),
    );
  }),
);

/** The tenant owner joined company A, and the manager co-administers it. */
const coAdminRows: readonly AccessMembership[] = [
  ...peopleRows,
  row(OWNER, scopeA, 68),
  row(MANAGER, tenantScope, 69),
  row(MANAGER, scopeA, 70),
  row(MANAGER, scopeA, 71, 'access_admin'),
];

it.effect(
  'refuses an ending outside the actor authority, over an administrator, or with live granted delegations',
  () =>
    Effect.gen(function* endingRefusals() {
      yield* TestClock.setTime(AT.getTime());
      const asAdminA = serviceOver([], { bases: [adminOf(companyA)], memberships: peopleRows });
      const end = (
        service: ReturnType<typeof serviceOver>,
        scope: OperationalScope,
        principalId: PrincipalId,
        scopeId: AccessScopeId,
      ) => Effect.flip(service.endMembership(scope, { principalId, reason: 'test', scopeId }));

      expect((yield* end(asAdminA, adminAScope, NEWCOMER, scopeA)).code).toBe('people_membership_unknown');
      // A company administrator never reaches the tenant row (it closes every company) ...
      expect((yield* end(asAdminA, adminAScope, LEAVER, tenantScope)).code).toBe('people_authority_missing');
      // ... nor ends a co-administrator or the tenant owner in their company (S4).
      const coAdmin = serviceOver([], { bases: [adminOf(companyA)], memberships: coAdminRows });
      expect((yield* end(coAdmin, adminAScope, MANAGER, scopeA)).code).toBe('people_authority_missing');
      expect((yield* end(coAdmin, adminAScope, OWNER, scopeA)).code).toBe('people_authority_missing');
      // The owner ends the co-administrator; the company administrator ends a plain member.
      yield* serviceOver([], { memberships: coAdminRows }).endMembership(ownerScope, {
        principalId: MANAGER,
        reason: 'test',
        scopeId: scopeA,
      });
      yield* asAdminA.endMembership(adminAScope, { principalId: LEAVER, reason: 'test', scopeId: scopeA });

      // While the leaver's own grants stand in a closed scope, the owner revokes them first (S3) ...
      const grantedA = makeDelegation({
        grantedBy: LEAVER,
        id: ids.delegationId(54),
        managerId: MANAGER,
        people: [OWNER],
        roleIds: [roleA.id],
        scopeId: scopeA,
      });
      const granting = serviceOver([], { delegations: [grantedA], memberships: peopleRows });
      const live = yield* end(granting, ownerScope, LEAVER, scopeA);
      expect(live.code).toBe('people_granted_delegations_live');
      expect(live.scopeIds).toEqual([scopeA]);
      // ... while a grant in a company the ending leaves open does not block it.
      yield* granting.endMembership(ownerScope, { principalId: LEAVER, reason: 'test', scopeId: scopeB });

      // The sole owner leaving the tenant must transfer it first.
      const sole = yield* end(serviceOver([], { memberships: peopleRows }), ownerScope, OWNER, tenantScope);
      expect(sole.code).toBe('ownership_transfer_required');
      expect(sole.scopeIds).toEqual([tenantScope]);
    }),
);
