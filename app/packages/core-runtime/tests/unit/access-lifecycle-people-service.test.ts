import { Effect, Option, Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import { TestClock } from 'effect/testing';

import { TrustedPrincipalContextSchema } from '../../src/actions/principal-context.ts';
import { CatalogDigestSchema, CatalogSnapshotIdSchema } from '../../src/access/ids.ts';
import type { AccessConfigureBasis } from '../../src/access/changes/authority.ts';
import type { AccessScopeId, PrincipalId } from '../../src/access/ids.ts';
import { AccessMembershipIdSchema, AccessMembershipSchema } from '../../src/access/intent/memberships.ts';
import type { AccessMembership } from '../../src/access/intent/memberships.ts';
import type { AccessPeopleIntent } from '../../src/access/intent/people-store.ts';
import { administrationOf, makeAccessPeopleCommands } from '../../src/access/lifecycle/people-service.ts';
import { isSoleAdministrator } from '../../src/access/lifecycle/owners.ts';
import type { AssignRoleCommand, GrantDelegationCommand } from '../../src/access/lifecycle/people-service.ts';
import type { PeopleIntentWrite } from '../../src/access/lifecycle/people-commands.ts';
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
  /** The acting person's configure bases, as the tenant intent loader answers them. */
  readonly bases?: readonly AccessConfigureBasis[];
  readonly delegations?: readonly Delegation[];
  /** Roles of the tenant nobody in the fixture holds. */
  readonly roles?: AccessPeopleIntent['roles'];
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
        Effect.succeed([
          membership(MANAGER, scopeB, 1),
          membership(MEMBER, scopeB, 2),
          membership(GRANTOR, scopeB, 3),
          // A company grantor's grants count only on a live path: the tenant's membership and the company's.
          membership(GRANTOR, tenantScope, 4),
        ]),
      recordMembership: () => unused,
      recordMemberships: () => unused,
      setMembershipStatus: () => unused,
    },
    people: {
      applyPeopleChange: (_scope, change) =>
        Effect.sync(() => {
          fixture.written?.push(...change.writes);
        }),
      loadCatalogSnapshot: () => Effect.succeed(Option.some(catalog)),
      loadTenantPeople: () => Effect.succeed(intent),
    },
    projection: {
      reconcileTenant: () =>
        Effect.succeed({
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
    },
    teams: {
      loadTenantTeams: () => Effect.succeed([]),
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
    expect(written).toEqual([{ _tag: 'RecordAssignment', assignment: assigned.assignment }]);

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
