import { Effect, Match, Option, Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import { TestClock } from 'effect/testing';

import type { AccessScopeId, PrincipalId } from '../../src/access/ids.ts';
import { RecordKeySchema } from '../../src/access/ids.ts';
import {
  combinePeopleChangePlans,
  membershipIsLive,
  ownershipTransferCandidates,
  planDelegationGrant,
  planDelegationRevocation,
  planMembershipEnd,
  planMembershipGrant,
  planOwnershipTransfer,
  planRoleAssignment,
  planRoleUnassignment,
  planTeamMembership,
} from '../../src/access/lifecycle/people-commands.ts';
import type { ManagerAuthority } from '../../src/access/lifecycle/delegation.ts';
import type {
  GrantorAlternative,
  PeopleChangePlan,
  PeopleIntentWrite,
} from '../../src/access/lifecycle/people-commands.ts';
import { AccessMembershipIdSchema, AccessMembershipSchema } from '../../src/access/intent/memberships.ts';
import type { AccessMembership, MembershipKind, MembershipStatus } from '../../src/access/intent/memberships.ts';
import { AccessTeamMemberIdSchema, AccessTeamMemberSchema, AccessTeamSchema } from '../../src/access/intent/teams.ts';
import type { AccessTeam, AccessTeamMember } from '../../src/access/intent/teams.ts';
import type { AccessScope, Assignment, Cell, Delegation, RoleRevision } from '../../src/access/model.ts';
import {
  capabilityKey,
  clockDates,
  companyAdministrators,
  currency,
  dateAt,
  ELAPSED,
  FUTURE,
  ids,
  legalEntityId,
  makeAdministration,
  makeAssignment,
  makeCell,
  makeDelegation,
  makeEntry,
  makeRole,
  makeRoleRevision,
  ownerRecord,
  person,
  personId,
} from './access-lifecycle-support.ts';

/*
 * The atomic people commands. Each suite proves the rule a command exists for and its negative
 * control: an assignment outside the delegating envelope, a delegation that would manage itself, and
 * a departure that would leave a scope unadministered are all refused, not planned.
 */

const tenant = ids.tenant(1);
const tenantScope = ids.scope(1);
const companyScope = ids.scope(2);
/** Model time every planner is given; memberships and delegations are anchored around it. */
const AT = dateAt(Date.UTC(2026, 10, 3, 12));
const MEMBER = personId(2);
const OTHER = personId(3);
const MANAGER = personId(4);
/** The person granting a delegation: the acting person, never the manager receiving it. */
const GRANTOR = personId(5);
const ENVELOPE_KEY = capabilityKey('finance.invoice.void');
const CZK = currency('CZK');

const membershipId = (n: number) =>
  Schema.decodeUnknownSync(AccessMembershipIdSchema)(`10000000-0000-4000-8000-${n.toString().padStart(12, '0')}`);

const teamMemberId = (n: number) =>
  Schema.decodeUnknownSync(AccessTeamMemberIdSchema)(`30000000-0000-4000-8000-${n.toString().padStart(12, '0')}`);

const holderOf = (principalId: PrincipalId) => person(Number(principalId.slice(-12)));

interface MembershipFixture {
  readonly holder?: PrincipalId;
  readonly id?: number;
  readonly kind?: MembershipKind;
  readonly scopeId?: AccessScopeId;
  readonly status?: MembershipStatus;
  readonly validFrom?: Date;
  readonly validUntil?: Date;
}

const membership = (fixture: MembershipFixture): AccessMembership => {
  const base = {
    createdAt: ELAPSED,
    holder: holderOf(fixture.holder ?? MEMBER),
    id: membershipId(fixture.id ?? 1),
    kind: fixture.kind ?? 'member',
    recordedBy: personId(900),
    scopeId: fixture.scopeId ?? tenantScope,
    status: fixture.status ?? 'active',
    tenantId: tenant,
    validFrom: fixture.validFrom ?? ELAPSED,
  };
  return Schema.decodeUnknownSync(AccessMembershipSchema)(
    fixture.validUntil === undefined ? base : { ...base, validUntil: fixture.validUntil },
  );
};

const memberOf = (holder: PrincipalId, scopeId: AccessScopeId = tenantScope) => membership({ holder, scopeId });

interface TeamFixture {
  readonly id?: number;
  readonly scopeId?: AccessScopeId;
}

const team = (fixture: TeamFixture = {}): AccessTeam =>
  Schema.decodeUnknownSync(AccessTeamSchema)({
    createdAt: ELAPSED,
    createdBy: personId(900),
    id: ids.teamId(fixture.id ?? 1),
    name: 'Finance team',
    scopeId: fixture.scopeId ?? tenantScope,
    tenantId: tenant,
  });

const teamMember = (fixture: { readonly holder: PrincipalId; readonly teamId: number }): AccessTeamMember =>
  Schema.decodeUnknownSync(AccessTeamMemberSchema)({
    addedAt: ELAPSED,
    addedBy: personId(900),
    holder: holderOf(fixture.holder),
    id: teamMemberId(fixture.teamId),
    teamId: ids.teamId(fixture.teamId),
    tenantId: tenant,
  });

const facts = { actor: personId(1), at: AT, scopeId: tenantScope, tenantId: tenant };
const companyFacts = { ...facts, scopeId: companyScope };

const scopeTarget = (scopeId: AccessScopeId): AccessScope =>
  scopeId === tenantScope
    ? { _tag: 'TenantContext', tenantId: tenant }
    : { _tag: 'LegalEntity', legalEntityId: legalEntityId(5), tenantId: tenant };

/** One write's tag, read through the tagged union instead of comparing `_tag` by hand. */
const tagOf = (write: PeopleIntentWrite): PeopleIntentWrite['_tag'] =>
  Match.value(write).pipe(
    Match.tag('EndAssignment', () => 'EndAssignment' as const),
    Match.tag('EndDelegation', () => 'EndDelegation' as const),
    Match.tag('EndMembership', () => 'EndMembership' as const),
    Match.tag('RecordAssignment', () => 'RecordAssignment' as const),
    Match.tag('RecordDelegation', () => 'RecordDelegation' as const),
    Match.tag('RecordMembership', () => 'RecordMembership' as const),
    Match.tag('RecordTeamMember', () => 'RecordTeamMember' as const),
    Match.tag('RemoveTeamMember', () => 'RemoveTeamMember' as const),
    Match.exhaustive,
  );

const writeTags = (plan: PeopleChangePlan) => plan.writes.map(tagOf);

const membershipIn = (write: PeopleIntentWrite | undefined): Option.Option<AccessMembership> =>
  Match.value(write).pipe(
    Match.tag('RecordMembership', ({ membership: recorded }) => Option.some(recorded)),
    Match.orElse(() => Option.none<AccessMembership>()),
  );

const assignmentIn = (write: PeopleIntentWrite | undefined): Option.Option<Assignment> =>
  Match.value(write).pipe(
    Match.tag('RecordAssignment', ({ assignment }) => Option.some(assignment)),
    Match.orElse(() => Option.none<Assignment>()),
  );

const endedMembershipIn = (write: PeopleIntentWrite | undefined): Option.Option<string> =>
  Match.value(write).pipe(
    Match.tag('EndMembership', ({ membershipId: ended }) => Option.some(ended)),
    Match.orElse(() => Option.none<string>()),
  );

/* ------------------------------------------------------------------------------------------------
 * Membership
 * ---------------------------------------------------------------------------------------------- */

it.effect('admits one live membership and refuses a duplicate, an agent and a mis-scoped management kind', () =>
  Effect.gen(function* membershipIsAdmittedOnce() {
    yield* TestClock.setTime(AT.getTime());
    const administration = makeAdministration({ tenantOwners: [ownerRecord({ principalId: MANAGER })] });
    const admitted = yield* planMembershipGrant({
      ...facts,
      administration,
      holder: holderOf(MEMBER),
      kind: 'member',
      membershipId: membershipId(11),
      memberships: [],
    });
    expect(writeTags(admitted)).toEqual(['RecordMembership']);
    const [recorded] = admitted.writes;
    expect(Option.getOrThrow(membershipIn(recorded)).status).toBe('active');

    const duplicate = yield* Effect.flip(
      planMembershipGrant({
        ...facts,
        administration,
        holder: holderOf(MEMBER),
        kind: 'member',
        membershipId: membershipId(12),
        memberships: [memberOf(MEMBER)],
      }),
    );
    expect(duplicate.code).toBe('people_membership_already_active');

    // An agent holds no membership in this wave (O67-Q5), management kinds included.
    const agent = yield* Effect.flip(
      planMembershipGrant({
        ...facts,
        administration,
        holder: { _tag: 'Agent', agentId: ids.agent(1) },
        kind: 'member',
        membershipId: membershipId(13),
        memberships: [],
      }),
    );
    expect(agent.code).toBe('people_agent_holder_forbidden');

    // Tenant ownership lives in the tenant scope, company administration in one company (O28).
    const ownerInCompany = yield* Effect.flip(
      planMembershipGrant({
        ...companyFacts,
        administration,
        holder: holderOf(MEMBER),
        kind: 'owner',
        membershipId: membershipId(14),
        memberships: [],
      }),
    );
    expect(ownerInCompany.code).toBe('people_membership_scope_mismatch');
    const adminInTenant = yield* Effect.flip(
      planMembershipGrant({
        ...facts,
        administration,
        holder: holderOf(MEMBER),
        kind: 'access_admin',
        membershipId: membershipId(15),
        memberships: [],
      }),
    );
    expect(adminInTenant.code).toBe('people_membership_scope_mismatch');

    const expired = yield* Effect.flip(
      planMembershipGrant({
        ...facts,
        administration,
        holder: holderOf(MEMBER),
        kind: 'member',
        membershipId: membershipId(16),
        memberships: [],
        validUntil: ELAPSED,
      }),
    );
    expect(expired.code).toBe('people_membership_period_invalid');

    // A revoked membership is final; the rejoin is the fresh row this command plans (D27).
    const rejoin = yield* planMembershipGrant({
      ...facts,
      administration,
      holder: holderOf(MEMBER),
      kind: 'member',
      membershipId: membershipId(17),
      memberships: [membership({ holder: MEMBER, id: 16, status: 'revoked' })],
    });
    expect(writeTags(rejoin)).toEqual(['RecordMembership']);
  }),
);

/* ------------------------------------------------------------------------------------------------
 * Role assignment
 * ---------------------------------------------------------------------------------------------- */

interface AssignmentOverrides {
  /** Model time; the delegated cases pass the test clock, because a delegation is checked for liveness. */
  readonly at?: Date;
  readonly catalog?: readonly ReturnType<typeof makeEntry>[];
  readonly delegation?: {
    readonly delegation: Delegation;
    readonly managerIsMember: boolean;
  };
  readonly holder?: PrincipalId;
  readonly memberships?: readonly AccessMembership[];
  readonly revision?: RoleRevision;
  readonly validUntil?: Date;
}

const role = makeRole();

/** The member and the delegating manager are both live members unless a suite says otherwise. */
const assignmentRequest = (overrides: AssignmentOverrides = {}) => {
  const base = {
    ...facts,
    actor: facts.actor,
    catalog: overrides.catalog ?? [makeEntry()],
    holder: holderOf(overrides.holder ?? MEMBER),
    incarnationId: ids.incarnation(21),
    memberships: overrides.memberships ?? [memberOf(MEMBER), membership({ holder: MANAGER, id: 2 })],
    role,
    roleRevision: overrides.revision ?? makeRoleRevision(),
    scope: scopeTarget(tenantScope),
  };
  const timed = overrides.at === undefined ? base : { ...base, at: overrides.at };
  const deadline = overrides.validUntil === undefined ? timed : { ...timed, validUntil: overrides.validUntil };
  return overrides.delegation === undefined ? deadline : { ...deadline, delegation: overrides.delegation };
};

it.effect('assigns a role to a live member and refuses a suspended member, a foreign role and a long deadline', () =>
  Effect.gen(function* assignmentNeedsLiveMembership() {
    yield* TestClock.setTime(AT.getTime());
    const assigned = yield* planRoleAssignment(assignmentRequest());
    expect(writeTags(assigned)).toEqual(['RecordAssignment']);
    const [recorded] = assigned.writes;
    expect(Option.getOrThrow(assignmentIn(recorded)).status).toBe('active');

    // Suspension subtracts the graph, so a suspended member is not a live member.
    const suspended = yield* Effect.flip(
      planRoleAssignment(
        assignmentRequest({
          memberships: [membership({ holder: MEMBER, status: 'suspended' }), membership({ holder: MANAGER, id: 2 })],
        }),
      ),
    );
    expect(suspended.code).toBe('people_holder_not_a_member');

    const stranger = yield* Effect.flip(
      planRoleAssignment(assignmentRequest({ memberships: [membership({ holder: MANAGER, id: 2 })] })),
    );
    expect(stranger.code).toBe('people_holder_not_a_member');

    // A tenant-wide role does not live in a company, and a company role not in the tenant (O7).
    const foreignRole = yield* Effect.flip(
      planRoleAssignment({
        ...assignmentRequest(),
        role: makeRole({ legalEntityId: legalEntityId(5) }),
        scope: scopeTarget(tenantScope),
      }),
    );
    expect(foreignRole.code).toBe('people_role_outside_scope');

    const revisionMismatch = yield* Effect.flip(
      planRoleAssignment(assignmentRequest({ revision: makeRoleRevision({ roleId: ids.role(9) }) })),
    );
    expect(revisionMismatch.code).toBe('people_role_revision_mismatch');

    const unpublished = yield* Effect.flip(
      planRoleAssignment(assignmentRequest({ catalog: [makeEntry({ key: capabilityKey('party.parties.read') })] })),
    );
    expect(unpublished.code).toBe('people_capability_unknown');

    // A deadline past the membership would leave an assignment the person cannot hold.
    const boundedMembership = membership({ holder: MEMBER, validUntil: dateAt(Date.UTC(2030, 0, 1)) });
    const tooLate = yield* Effect.flip(
      planRoleAssignment(
        assignmentRequest({
          memberships: [boundedMembership, membership({ holder: MANAGER, id: 2 })],
          validUntil: FUTURE,
        }),
      ),
    );
    expect(tooLate.code).toBe('people_deadline_outside_membership');

    // Without an explicit deadline the assignment ends with the membership that carries it.
    const inherited = yield* planRoleAssignment(
      assignmentRequest({ memberships: [boundedMembership, membership({ holder: MANAGER, id: 2 })] }),
    );
    const [inheritedWrite] = inherited.writes;
    expect(Option.getOrThrow(assignmentIn(inheritedWrite)).validUntil?.toISOString()).toBe(
      dateAt(Date.UTC(2030, 0, 1)).toISOString(),
    );
  }),
);

it.effect('keeps a delegated assignment inside the frozen envelope, including the D10b amount ceiling', () =>
  Effect.gen(function* delegatedAssignmentStaysBounded() {
    yield* TestClock.setTime(AT.getTime());
    // A delegation is checked for liveness, so its period brackets the test clock.
    const dates = yield* clockDates;
    const delegation = makeDelegation({
      amountCeiling: { currency: CZK, limitMinor: 5000 },
      capabilityKeys: [ENVELOPE_KEY],
      managerId: MANAGER,
      people: [MEMBER],
      roleIds: [ids.role(1)],
      validFrom: dates.past,
      validUntil: dates.future,
    });
    const leased = { delegation, managerIsMember: true };
    // D10b: only a capability that moves money is limited by an amount ceiling, so the snapshot has
    // to declare the money input for that rule to apply at all.
    const money = [makeEntry({ amountInput: 'amount.minorUnits' })];
    const finance = makeRoleRevision({ cells: [makeCell({ amountCeiling: { currency: CZK, limitMinor: 1000 } })] });
    const inside = yield* planRoleAssignment(
      assignmentRequest({ at: dates.now, catalog: money, delegation: leased, revision: finance }),
    );
    const [write] = inside.writes;
    const frozen = Option.getOrThrow(assignmentIn(write)).delegated;
    expect(frozen?.delegationId).toBe(delegation.id);
    expect(frozen?.amountCeiling?.limitMinor).toBe(5000);
    expect(frozen?.capabilityKeys).toEqual([ENVELOPE_KEY]);

    // Above the ceiling is outside the envelope.
    const above = makeRoleRevision({ cells: [makeCell({ amountCeiling: { currency: CZK, limitMinor: 9000 } })] });
    const tooMuch = yield* Effect.flip(
      planRoleAssignment(assignmentRequest({ at: dates.now, catalog: money, delegation: leased, revision: above })),
    );
    expect(tooMuch.code).toBe('delegation_amount_outside_envelope');

    // A money cell with no limit is unlimited authority, so it never fits a capped envelope (D10b).
    const unlimited = makeRoleRevision({ cells: [makeCell()] });
    const unbounded = yield* Effect.flip(
      planRoleAssignment(assignmentRequest({ at: dates.now, catalog: money, delegation: leased, revision: unlimited })),
    );
    expect(unbounded.code).toBe('delegation_amount_outside_envelope');

    // A new capability of the same module never joins the envelope: a delegation never grows (P8).
    const siblingKey = capabilityKey('finance.invoice.add-note');
    const sibling = makeRoleRevision({
      cells: [makeCell({ amountCeiling: { currency: CZK, limitMinor: 1000 }, capabilityKey: siblingKey })],
    });
    const outsideEnvelope = yield* Effect.flip(
      planRoleAssignment(
        assignmentRequest({
          at: dates.now,
          catalog: [...money, makeEntry({ amountInput: 'amount.minorUnits', key: siblingKey })],
          delegation: leased,
          revision: sibling,
        }),
      ),
    );
    expect(outsideEnvelope.code).toBe('delegation_envelope_growth');

    // A delegate never assigns themselves.
    const selfAssignment = yield* Effect.flip(
      planRoleAssignment(
        assignmentRequest({
          at: dates.now,
          catalog: money,
          delegation: leased,
          holder: MANAGER,
          memberships: [membership({ holder: MANAGER, id: 2 }), memberOf(MEMBER)],
          revision: finance,
        }),
      ),
    );
    expect(selfAssignment.code).toBe('delegation_self_assignment');
  }),
);

it.effect('ends an assignment once, keeps its frozen limits, and never touches the membership', () =>
  Effect.gen(function* unassignmentEndsOnly() {
    yield* TestClock.setTime(AT.getTime());
    const assignment = makeAssignment({ holder: holderOf(MEMBER) });
    const ended = yield* planRoleUnassignment({ ...facts, assignment });
    expect(writeTags(ended)).toEqual(['EndAssignment']);

    const again = yield* Effect.flip(
      planRoleUnassignment({ ...facts, assignment: { ...assignment, status: 'revoked' } }),
    );
    expect(again.code).toBe('people_assignment_already_ended');

    const foreignScope = yield* Effect.flip(planRoleUnassignment({ ...companyFacts, assignment }));
    expect(foreignScope.code).toBe('people_assignment_scope_mismatch');

    // A delegated assignment keeps the envelope it was written with forever (D10b).
    const delegation = makeDelegation({ people: [MEMBER] });
    const delegatedAssignment: Assignment = {
      ...assignment,
      delegated: {
        capabilityKeys: [ENVELOPE_KEY],
        delegationId: delegation.id,
        until: delegation.validUntil,
      },
      validUntil: delegation.validUntil,
    };
    const frozen = yield* planRoleUnassignment({ ...facts, assignment: delegatedAssignment, delegation });
    expect(writeTags(frozen)).toEqual(['EndAssignment']);

    const widened = yield* Effect.flip(
      planRoleUnassignment({
        ...facts,
        assignment: { ...delegatedAssignment, validUntil: dateAt(Date.UTC(2101, 0, 1)) },
        delegation,
      }),
    );
    expect(widened.code).toBe('delegation_limits_lost');
  }),
);

it.effect('lets a delegated manager end only what their live envelope could have assigned', () =>
  Effect.gen(function* delegatedUnassignmentStaysInEnvelope() {
    yield* TestClock.setTime(AT.getTime());
    const manager = { delegation: makeDelegation({ managerId: MANAGER, people: [MEMBER] }), managerIsMember: true };
    const assignment = makeAssignment({ holder: holderOf(MEMBER) });
    const ended = yield* planRoleUnassignment({ ...facts, assignment, manager });
    expect(writeTags(ended)).toEqual(['EndAssignment']);

    const foreignRole = yield* Effect.flip(
      planRoleUnassignment({
        ...facts,
        assignment: makeAssignment({ holder: holderOf(MEMBER), roleId: ids.role(9) }),
        manager,
      }),
    );
    expect(foreignRole.code).toBe('delegation_role_outside_envelope');

    const outsider = yield* Effect.flip(
      planRoleUnassignment({ ...facts, assignment: makeAssignment({ holder: holderOf(OTHER) }), manager }),
    );
    expect(outsider.code).toBe('delegation_holder_outside_envelope');

    const own = yield* Effect.flip(
      planRoleUnassignment({ ...facts, assignment: makeAssignment({ holder: holderOf(MANAGER) }), manager }),
    );
    expect(own.code).toBe('delegation_self_assignment');

    const lapsed = yield* Effect.flip(
      planRoleUnassignment({
        ...facts,
        assignment,
        manager: { ...manager, delegation: { ...manager.delegation, status: 'revoked' } },
      }),
    );
    expect(lapsed.code).toBe('delegation_not_live');
  }),
);

/* ------------------------------------------------------------------------------------------------
 * Delegation
 * ---------------------------------------------------------------------------------------------- */

interface DelegationRequestFixture {
  readonly at?: Date;
  readonly delegation?: Delegation;
  readonly memberships?: readonly AccessMembership[];
}

const czkCeiling = (limitMinor: number) => ({ currency: CZK, limitMinor });
/** One grantor grant over every record, capped in CZK when a limit is given. */
const grantOf = (mode: GrantorAlternative['mode'], limitMinor?: number): GrantorAlternative =>
  limitMinor === undefined
    ? { mode, selector: { _tag: 'all' } }
    : { amountCeiling: czkCeiling(limitMinor), mode, selector: { _tag: 'all' } };

const delegationRequest = (fixture: DelegationRequestFixture = {}) => {
  const base = {
    ...facts,
    actor: GRANTOR,
    catalog: [makeEntry()],
    delegation: fixture.delegation ?? makeDelegation({ grantedBy: GRANTOR, managerId: MANAGER, people: [MEMBER] }),
    grantorCapabilityKeys: [ENVELOPE_KEY],
    managerAuthority: 'permanent' as const,
    memberships: fixture.memberships ?? [membership({ holder: MANAGER, id: 2 }), memberOf(MEMBER)],
    roles: [role],
    scope: scopeTarget(tenantScope),
  };
  return fixture.at === undefined ? base : { ...base, at: fixture.at };
};

it.effect('grants one bounded delegation and refuses a misattributed, self-managing or unbounded one', () =>
  Effect.gen(function* delegationIsExact() {
    yield* TestClock.setTime(AT.getTime());
    const dates = yield* clockDates;
    const live = (overrides: Parameters<typeof makeDelegation>[0] = {}) =>
      makeDelegation({
        grantedBy: GRANTOR,
        managerId: MANAGER,
        people: [MEMBER],
        validFrom: dates.past,
        validUntil: dates.future,
        ...overrides,
      });
    // The acting person grants the envelope; the manager it names is somebody else who receives it.
    const granted = yield* planDelegationGrant(delegationRequest({ at: dates.now, delegation: live() }));
    expect(writeTags(granted)).toEqual(['RecordDelegation']);

    // A delegation is attributed to the person granting it, never to somebody else.
    const misattributed = yield* Effect.flip(
      planDelegationGrant(delegationRequest({ at: dates.now, delegation: live({ grantedBy: OTHER }) })),
    );
    expect(misattributed.code).toBe('delegation_outside_grantor_authority');
    // Nobody delegates to themselves, and a manager never manages themselves.
    const selfDelegated = yield* Effect.flip(
      planDelegationGrant(delegationRequest({ at: dates.now, delegation: { ...live(), managerId: GRANTOR } })),
    );
    expect(selfDelegated.code).toBe('delegation_self_grant');
    const selfManaging = yield* Effect.flip(
      planDelegationGrant(delegationRequest({ at: dates.now, delegation: { ...live(), people: [MANAGER] } })),
    );
    expect(selfManaging.code).toBe('delegation_self_grant');

    // A delegate manages inside its envelope; it never hands out a new one (P8).
    const redelegation = yield* Effect.flip(
      planDelegationGrant({
        ...delegationRequest({ at: dates.now, delegation: live() }),
        managerAuthority: 'delegated' as const,
      }),
    );
    expect(redelegation.code).toBe('delegation_redelegation');

    const unknownCapability = yield* Effect.flip(
      planDelegationGrant(
        delegationRequest({
          at: dates.now,
          delegation: live({ capabilityKeys: [capabilityKey('party.parties.merge')] }),
        }),
      ),
    );
    expect(unknownCapability.code).toBe('delegation_unknown_capability');

    const beyondGrantor = yield* Effect.flip(
      planDelegationGrant({
        ...delegationRequest({ at: dates.now, delegation: live() }),
        grantorCapabilityKeys: [capabilityKey('finance.invoice.add-note')],
      }),
    );
    expect(beyondGrantor.code).toBe('delegation_outside_grantor_authority');

    const unknownRole = yield* Effect.flip(
      planDelegationGrant(delegationRequest({ at: dates.now, delegation: live({ roleIds: [ids.role(9)] }) })),
    );
    expect(unknownRole.code).toBe('delegation_role_unknown');

    // The grantor's grants are checked against every cell the delegated roles carry, mode by mode.
    const money = [makeEntry({ amountInput: 'amountMinor' })];
    const runCell = makeCell({ mode: 'run' });
    const bounded = (
      delegation: Delegation,
      grants: readonly GrantorAlternative[],
      delegatedCells: readonly Cell[] = [runCell],
    ) =>
      planDelegationGrant({
        ...delegationRequest({ at: dates.now, delegation }),
        catalog: money,
        delegatedCells,
        grantorAuthority: new Map([[ENVELOPE_KEY, grants]]),
      });

    // A delegation beyond its grantor's own amount ceiling is widening authority nobody holds ...
    const overCeiling = yield* Effect.flip(bounded(live({ amountCeiling: czkCeiling(9000) }), [grantOf('run', 5000)]));
    expect(overCeiling.code).toBe('delegation_amount_outside_envelope');
    // ... and a capped grantor cannot hand out an envelope that names no ceiling: that one is unlimited.
    const uncapped = yield* Effect.flip(bounded(live(), [grantOf('run', 5000)]));
    expect(uncapped.code).toBe('delegation_amount_outside_envelope');

    // Each grant is an alternative: the wider one covers what the narrower does not ...
    const covered = yield* bounded(live({ amountCeiling: czkCeiling(500) }), [
      grantOf('run', 100),
      grantOf('run', 1000),
    ]);
    expect(writeTags(covered)).toEqual(['RecordDelegation']);
    // ... and an uncapped grant covers even an envelope with no ceiling.
    const unlimited = yield* bounded(live(), [grantOf('run')]);
    expect(writeTags(unlimited)).toEqual(['RecordDelegation']);

    // A grant to propose never lifts the ceiling on running, nor stands in for running at all ...
    const proposeLiftsRun = yield* Effect.flip(bounded(live(), [grantOf('run', 5000), grantOf('propose')]));
    expect(proposeLiftsRun.code).toBe('delegation_amount_outside_envelope');
    const proposeOnly = yield* Effect.flip(bounded(live({ amountCeiling: czkCeiling(100) }), [grantOf('propose')]));
    expect(proposeOnly.code).toBe('delegation_outside_grantor_authority');
    // ... while a role that only proposes is covered by the grant to propose.
    const proposing = yield* bounded(
      live(),
      [grantOf('run', 5000), grantOf('propose')],
      [makeCell({ mode: 'propose' })],
    );
    expect(writeTags(proposing)).toEqual(['RecordDelegation']);

    // A grant for some records never stands in for all of them.
    const someRecords = yield* Effect.flip(
      bounded(live({ amountCeiling: czkCeiling(100) }), [
        {
          amountCeiling: czkCeiling(5000),
          mode: 'run',
          selector: { _tag: 'targets', recordKeys: [RecordKeySchema.make('invoice-a')] },
        },
      ]),
    );
    expect(someRecords.code).toBe('delegation_outside_grantor_authority');

    // The envelope never reaches a person who is not a live member of its scope.
    const nonMember = yield* Effect.flip(
      planDelegationGrant(
        delegationRequest({
          at: dates.now,
          delegation: live({ people: [OTHER] }),
          memberships: [membership({ holder: MANAGER, id: 2 }), memberOf(MEMBER)],
        }),
      ),
    );
    expect(nonMember.code).toBe('people_holder_not_a_member');

    const lapsed = yield* Effect.flip(
      planDelegationGrant(delegationRequest({ at: dates.now, delegation: { ...live(), validUntil: ELAPSED } })),
    );
    expect(lapsed.code).toBe('people_delegation_end_missing');
  }),
);

it.effect('revokes a delegation without touching the frozen limits of what it created', () =>
  Effect.gen(function* revocationKeepsLimits() {
    yield* TestClock.setTime(AT.getTime());
    const dates = yield* clockDates;
    const delegation = makeDelegation({ people: [MEMBER], validFrom: dates.past, validUntil: dates.future });
    const assignment = makeAssignment({
      delegated: { capabilityKeys: [ENVELOPE_KEY], delegationId: delegation.id, until: delegation.validUntil },
      holder: holderOf(MEMBER),
      validUntil: delegation.validUntil,
    });
    const revocation = {
      actor: facts.actor,
      assignments: [assignment],
      at: dates.now,
      delegation,
      managerAuthority: 'permanent' as const,
      scopeId: facts.scopeId,
      tenantId: facts.tenantId,
    };
    const revoked = yield* planDelegationRevocation(revocation);
    expect(writeTags(revoked)).toEqual(['EndDelegation']);

    // Only permanent authority manages delegations; a delegate never revokes one (P8).
    const byDelegate = yield* Effect.flip(planDelegationRevocation({ ...revocation, managerAuthority: 'delegated' }));
    expect(byDelegate.code).toBe('delegation_redelegation');

    // A stored row decodes its frozen deadline apart from the delegation's own: the same instant, another object.
    const decodedApart = yield* planDelegationRevocation({
      ...revocation,
      assignments: [
        {
          ...assignment,
          delegated: {
            capabilityKeys: [ENVELOPE_KEY],
            delegationId: delegation.id,
            until: dateAt(delegation.validUntil.getTime()),
          },
        },
      ],
    });
    expect(writeTags(decodedApart)).toEqual(['EndDelegation']);

    const already = yield* Effect.flip(
      planDelegationRevocation({ ...revocation, delegation: { ...delegation, status: 'revoked' } }),
    );
    expect(already.code).toBe('delegation_not_live');

    // An assignment widened in place is refused, never "repaired" by this command.
    const widened = yield* Effect.flip(
      planDelegationRevocation({
        ...revocation,
        assignments: [{ ...assignment, validUntil: dateAt(Date.UTC(2101, 0, 1)) }],
      }),
    );
    expect(widened.code).toBe('delegation_limits_lost');

    // The frozen envelope outlives the delegation: a revoked delegation still bounds what it created,
    // so the assignment stays readable with its own capabilities, ceiling and end date (D10b).
    const revokedDelegation = { ...delegation, status: 'revoked' as const };
    const stillBounded = yield* planRoleUnassignment({
      ...facts,
      assignment,
      at: dates.now,
      delegation: revokedDelegation,
    });
    expect(writeTags(stillBounded)).toEqual(['EndAssignment']);
    expect(assignment.delegated?.capabilityKeys).toEqual([ENVELOPE_KEY]);
    expect(assignment.delegated?.until).toEqual(delegation.validUntil);
  }),
);

/* ------------------------------------------------------------------------------------------------
 * Team membership
 * ---------------------------------------------------------------------------------------------- */

interface TeamRequestFixture {
  readonly action: 'join' | 'leave';
  readonly holder?: PrincipalId;
  readonly managerAuthority?: ManagerAuthority;
  readonly memberId?: number;
  readonly memberships?: readonly AccessMembership[];
  readonly team?: AccessTeam;
  readonly teamMembers?: readonly AccessTeamMember[];
}

const teamRequest = (fixture: TeamRequestFixture) => ({
  ...facts,
  action: fixture.action,
  holder: holderOf(fixture.holder ?? MEMBER),
  managerAuthority: fixture.managerAuthority ?? 'permanent',
  memberId: teamMemberId(fixture.memberId ?? 1),
  memberships: fixture.memberships ?? [memberOf(MEMBER)],
  team: fixture.team ?? team(),
  teamMembers: fixture.teamMembers ?? [],
});

it.effect('places a live member in a team of the same scope and removes the place again', () =>
  Effect.gen(function* teamPlaceIsScoped() {
    yield* TestClock.setTime(AT.getTime());
    const joined = yield* planTeamMembership(teamRequest({ action: 'join' }));
    expect(writeTags(joined)).toEqual(['RecordTeamMember']);

    const place = teamMember({ holder: MEMBER, teamId: 1 });
    const left = yield* planTeamMembership(teamRequest({ action: 'leave', teamMembers: [place] }));
    expect(writeTags(left)).toEqual(['RemoveTeamMember']);

    const twice = yield* Effect.flip(
      planTeamMembership(teamRequest({ action: 'join', memberId: 2, teamMembers: [place] })),
    );
    expect(twice.code).toBe('people_team_membership_exists');

    const absent = yield* Effect.flip(planTeamMembership(teamRequest({ action: 'leave', memberId: 3 })));
    expect(absent.code).toBe('people_team_membership_unknown');

    // A team reaches only its own scope's records, so a foreign team is refused (O24).
    const foreign = yield* Effect.flip(
      planTeamMembership(teamRequest({ action: 'join', memberId: 4, team: team({ id: 2, scopeId: companyScope }) })),
    );
    expect(foreign.code).toBe('people_team_scope_mismatch');

    const stranger = yield* Effect.flip(
      planTeamMembership(teamRequest({ action: 'join', holder: OTHER, memberId: 5 })),
    );
    expect(stranger.code).toBe('people_holder_not_a_member');

    // A team place widens every role its holder has, which no delegation envelope bounds.
    const delegated = yield* Effect.flip(
      planTeamMembership(teamRequest({ action: 'join', managerAuthority: 'delegated', memberId: 6 })),
    );
    expect(delegated.code).toBe('people_authority_missing');
  }),
);

/* ------------------------------------------------------------------------------------------------
 * Last owner: O53 and O65
 * ---------------------------------------------------------------------------------------------- */

interface MembershipEndFixture {
  readonly actor?: PrincipalId;
  readonly administration: ReturnType<typeof makeAdministration>;
  readonly assignments?: readonly Assignment[];
  readonly membershipId: ReturnType<typeof membershipId>;
  readonly memberships: readonly AccessMembership[];
  readonly nextStatus: 'revoked' | 'suspended';
  readonly successor?: { readonly membershipId: ReturnType<typeof membershipId>; readonly principalId: PrincipalId };
  readonly teamMembers?: readonly AccessTeamMember[];
  readonly teams?: readonly AccessTeam[];
}

const membershipEndRequest = (fixture: MembershipEndFixture, scopeId: AccessScopeId = tenantScope) => {
  const base = {
    ...facts,
    actor: fixture.actor ?? MANAGER,
    administration: fixture.administration,
    assignments: fixture.assignments ?? [],
    membershipId: fixture.membershipId,
    memberships: fixture.memberships,
    nextStatus: fixture.nextStatus,
    scopeId,
    teamMembers: fixture.teamMembers ?? [],
    teams: fixture.teams ?? [],
  };
  return fixture.successor === undefined ? base : { ...base, successor: fixture.successor };
};

it.effect('the last tenant owner leaves only by naming a successor in the same plan (O53)', () =>
  Effect.gen(function* lastOwnerNeedsATransfer() {
    yield* TestClock.setTime(AT.getTime());
    const administration = makeAdministration({ tenantOwners: [ownerRecord({ principalId: MANAGER })] });
    const owner = membership({ holder: MANAGER, id: 31, kind: 'owner' });
    const request = membershipEndRequest({
      administration,
      membershipId: owner.id,
      memberships: [owner, memberOf(MEMBER), membership({ holder: MANAGER, id: 2 })],
      nextStatus: 'revoked',
    });
    const blocked = yield* Effect.flip(planMembershipEnd(request));
    expect(blocked.code).toBe('ownership_transfer_required');
    expect(blocked.scopeIds).toEqual([tenantScope]);

    const selfTransfer = yield* Effect.flip(
      planMembershipEnd({
        ...request,
        successor: { membershipId: membershipId(41), principalId: MANAGER },
      }),
    );
    expect(selfTransfer.code).toBe('ownership_transfer_self');

    const stranger = yield* Effect.flip(
      planMembershipEnd({
        ...request,
        successor: { membershipId: membershipId(42), principalId: OTHER },
      }),
    );
    expect(stranger.code).toBe('people_successor_not_a_member');

    // The successor is minted in the SAME plan, so one commit never leaves the scope unadministered.
    const transferred = yield* planMembershipEnd({
      ...request,
      successor: { membershipId: membershipId(43), principalId: MEMBER },
    });
    expect(writeTags(transferred)).toEqual(['RecordMembership', 'EndMembership']);
    const [grant, end] = transferred.writes;
    const granted = Option.getOrThrow(membershipIn(grant));
    expect(granted.kind).toBe('owner');
    expect(granted.holder).toEqual(holderOf(MEMBER));
    expect(Option.getOrThrow(endedMembershipIn(end))).toBe(owner.id);
    expect(transferred.ownershipTransferScopeIds).toEqual([tenantScope]);

    // A second live owner means nobody has to be transferred, and a named successor is then stale.
    const shared = makeAdministration({
      tenantOwners: [ownerRecord({ principalId: MANAGER }), ownerRecord({ principalId: OTHER })],
    });
    const withoutTransfer = yield* planMembershipEnd({ ...request, administration: shared });
    expect(writeTags(withoutTransfer)).toEqual(['EndMembership']);
    const stale = yield* Effect.flip(
      planMembershipEnd({
        ...request,
        administration: shared,
        successor: { membershipId: membershipId(44), principalId: MEMBER },
      }),
    );
    expect(stale.code).toBe('ownership_transfer_not_required');
  }),
);

it.effect('a company administrator who alone administers the company transfers it too (O65)', () =>
  Effect.gen(function* companyAdministrationTransfers() {
    yield* TestClock.setTime(AT.getTime());
    const administration = makeAdministration({
      companyAdministrators: companyAdministrators(companyScope, [ownerRecord({ principalId: MANAGER })]),
      tenantOwners: [],
    });
    const companyAdmin = membership({ holder: MANAGER, id: 31, kind: 'access_admin', scopeId: companyScope });
    const request = membershipEndRequest(
      {
        administration,
        membershipId: companyAdmin.id,
        memberships: [
          companyAdmin,
          membership({ holder: MANAGER, id: 2, scopeId: companyScope }),
          memberOf(MEMBER, companyScope),
        ],
        nextStatus: 'revoked',
      },
      companyScope,
    );
    const blocked = yield* Effect.flip(planMembershipEnd(request));
    expect(blocked.code).toBe('ownership_transfer_required');
    expect(blocked.scopeIds).toEqual([companyScope]);

    const transferred = yield* planMembershipEnd({
      ...request,
      successor: { membershipId: membershipId(45), principalId: MEMBER },
    });
    expect(writeTags(transferred)).toEqual(['RecordMembership', 'EndMembership']);
    const [grant] = transferred.writes;
    expect(Option.getOrThrow(membershipIn(grant)).kind).toBe('access_admin');
  }),
);

it.effect('ending a membership ends its assignments and team places in the same plan', () =>
  Effect.gen(function* endingClosesEverything() {
    yield* TestClock.setTime(AT.getTime());
    const administration = makeAdministration({ tenantOwners: [ownerRecord({ principalId: MANAGER })] });
    const member = memberOf(MEMBER);
    const ended = yield* planMembershipEnd(
      membershipEndRequest({
        administration,
        assignments: [
          makeAssignment({ holder: holderOf(MEMBER) }),
          makeAssignment({ holder: holderOf(OTHER), incarnationId: ids.incarnation(2) }),
        ],
        membershipId: member.id,
        memberships: [member, membership({ holder: MANAGER, id: 2 })],
        nextStatus: 'suspended',
        teamMembers: [teamMember({ holder: MEMBER, teamId: 1 })],
        teams: [team()],
      }),
    );
    expect(writeTags(ended)).toEqual(['EndMembership', 'EndAssignment', 'RemoveTeamMember']);
    const [first] = ended.writes;
    expect(Option.getOrThrow(endedMembershipIn(first))).toBe(member.id);

    const alreadyEnded = yield* Effect.flip(
      planMembershipEnd(
        membershipEndRequest({
          administration,
          membershipId: member.id,
          memberships: [{ ...member, status: 'revoked' }, membership({ holder: MANAGER, id: 2 })],
          nextStatus: 'revoked',
        }),
      ),
    );
    expect(alreadyEnded.code).toBe('people_membership_ended');
    expect(alreadyEnded.reason).toContain('never reopens');
    expect(membershipIsLive({ ...member, status: 'revoked' }, AT)).toBe(false);
  }),
);

it.effect('a tenant departure transfers every sole administration it ends, all of them or none (O65)', () =>
  Effect.gen(function* departureTransfersEverything() {
    yield* TestClock.setTime(AT.getTime());
    const administration = makeAdministration({
      companyAdministrators: companyAdministrators(companyScope, [ownerRecord({ principalId: MANAGER })]),
      tenantOwners: [ownerRecord({ principalId: MANAGER })],
    });
    const memberships = [
      membership({ holder: MANAGER, id: 51, kind: 'owner' }),
      membership({ holder: MANAGER, id: 52, kind: 'access_admin', scopeId: companyScope }),
      membership({ holder: MANAGER, id: 53 }),
      memberOf(MEMBER),
      memberOf(MEMBER, companyScope),
    ];
    const transfer = yield* planOwnershipTransfer({
      actor: facts.actor,
      administration,
      assignments: [makeAssignment({ holder: holderOf(MANAGER) })],
      at: facts.at,
      from: MANAGER,
      membershipIds: [membershipId(61), membershipId(62)],
      memberships,
      scopeId: facts.scopeId,
      scopeIds: [tenantScope, companyScope],
      successor: MEMBER,
      tenantId: facts.tenantId,
    });
    expect(writeTags(transfer)).toEqual([
      'RecordMembership',
      'RecordMembership',
      'EndMembership',
      'EndMembership',
      'EndAssignment',
    ]);
    const granted = transfer.writes.flatMap((write) => Option.toArray(membershipIn(write)));
    expect(granted.map((recorded) => recorded.kind)).toEqual(['owner', 'access_admin']);

    const named = {
      actor: facts.actor,
      administration,
      assignments: [],
      at: facts.at,
      from: MANAGER,
      membershipIds: [membershipId(63), membershipId(64)],
      memberships,
      scopeId: facts.scopeId,
      successor: MEMBER,
      tenantId: facts.tenantId,
    };
    // Naming only the tenant leaves a company nobody administers, so the plan refuses it (O65).
    const incomplete = yield* Effect.flip(planOwnershipTransfer({ ...named, scopeIds: [tenantScope] }));
    expect(incomplete.code).toBe('ownership_transfer_required');
    expect(incomplete.scopeIds).toEqual([companyScope]);

    const overreach = yield* Effect.flip(
      planOwnershipTransfer({ ...named, scopeIds: [tenantScope, companyScope, ids.scope(9)] }),
    );
    expect(overreach.code).toBe('ownership_transfer_not_required');
    expect(overreach.scopeIds).toEqual([ids.scope(9)]);

    const self = yield* Effect.flip(
      planOwnershipTransfer({ ...named, scopeIds: [tenantScope, companyScope], successor: MANAGER }),
    );
    expect(self.code).toBe('ownership_transfer_self');

    const stranger = yield* Effect.flip(
      planOwnershipTransfer({
        ...named,
        memberships: memberships.filter((row) => row.scopeId !== companyScope),
        scopeIds: [tenantScope, companyScope],
      }),
    );
    expect(stranger.code).toBe('people_successor_not_a_member');

    const none = yield* Effect.flip(planOwnershipTransfer({ ...named, scopeIds: [] }));
    expect(none.code).toBe('people_transfer_scope_missing');

    // The candidates a surface may offer are exactly the live members of every transferred scope.
    expect(
      ownershipTransferCandidates({ at: AT, leaver: MANAGER, memberships, scopeIds: [tenantScope, companyScope] }),
    ).toEqual([MEMBER]);
  }),
);

it.effect('combines plans of one scope and refuses a plan that mixes scopes', () =>
  Effect.gen(function* plansCombineInOneScope() {
    yield* TestClock.setTime(AT.getTime());
    const administration = makeAdministration({ tenantOwners: [ownerRecord({ principalId: MANAGER })] });
    const grant = yield* planMembershipGrant({
      ...facts,
      administration,
      holder: holderOf(MEMBER),
      kind: 'member',
      membershipId: membershipId(71),
      memberships: [],
    });
    const combined = yield* combinePeopleChangePlans([grant, grant]);
    expect(combined.writes).toHaveLength(2);
    expect(combined.checks).toEqual(['people_membership_admitted']);

    const otherScope = yield* planMembershipGrant({
      ...companyFacts,
      administration,
      holder: holderOf(MEMBER),
      kind: 'member',
      membershipId: membershipId(72),
      memberships: [],
    });
    const mixed = yield* Effect.flip(combinePeopleChangePlans([grant, otherScope]));
    expect(mixed.code).toBe('people_membership_scope_mismatch');
    const empty = yield* Effect.flip(combinePeopleChangePlans([]));
    expect(empty.code).toBe('people_transfer_scope_missing');
  }),
);
