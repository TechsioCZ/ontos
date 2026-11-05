import { Effect } from 'effect';
import { expect, it } from 'effect-rstest';

import {
  assertDelegatedAssignmentStaysBounded,
  assertDelegationEnvelope,
  assertDelegationLive,
  cellWithinDelegationEnvelope,
  delegationCellIssue,
  planDelegatedAssignment,
} from '../../src/access/lifecycle/delegation.ts';
import {
  capabilityKey,
  clockDates,
  dateAt,
  currency,
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
} from './access-lifecycle-support.ts';

const envelopeKey = capabilityKey('finance.invoice.void');
const siblingKey = capabilityKey('finance.invoice.add-note');
const foreignKey = capabilityKey('party.registry.party.merge');

const tenantScope = { _tag: 'TenantContext' as const, tenantId: ids.tenant(1) };
const legalEntityScope = {
  _tag: 'LegalEntity' as const,
  legalEntityId: legalEntityId(5),
  tenantId: ids.tenant(1),
};

it.effect('refuses a self-granted, re-delegated or invented envelope', () =>
  Effect.gen(function* envelopeIsBoundedAndExact() {
    const envelope = {
      catalog: [makeEntry(), makeEntry({ key: siblingKey })],
      delegation: makeDelegation(),
      grantorCapabilityKeys: [envelopeKey, siblingKey],
      managerAuthority: 'permanent' as const,
      roles: [makeRole()],
      scope: tenantScope,
    };
    yield* assertDelegationEnvelope(envelope);

    // The model already refuses to decode a self-granted delegation; this row reaches the writer from
    // storage, so the envelope check has to refuse it a second time.
    const selfGrant = yield* Effect.flip(
      assertDelegationEnvelope({ ...envelope, delegation: { ...makeDelegation(), managerId: ids.principal(10) } }),
    );
    expect(selfGrant.code).toBe('delegation_self_grant');
    const selfAssignable = yield* Effect.flip(
      assertDelegationEnvelope({ ...envelope, delegation: { ...makeDelegation(), people: [ids.principal(3)] } }),
    );
    expect(selfAssignable.code).toBe('delegation_self_grant');

    const redelegation = yield* Effect.flip(assertDelegationEnvelope({ ...envelope, managerAuthority: 'delegated' }));
    expect(redelegation.code).toBe('delegation_redelegation');

    const unknown = yield* Effect.flip(
      assertDelegationEnvelope({ ...envelope, catalog: [makeEntry({ key: siblingKey })] }),
    );
    expect(unknown.code).toBe('delegation_unknown_capability');

    // Nobody delegates authority they do not hold themselves.
    const beyondGrantor = yield* Effect.flip(
      assertDelegationEnvelope({ ...envelope, grantorCapabilityKeys: [siblingKey] }),
    );
    expect(beyondGrantor.code).toBe('delegation_outside_grantor_authority');

    // A delegation names only roles of its own scope.
    const unknownRole = yield* Effect.flip(
      assertDelegationEnvelope({ ...envelope, delegation: { ...makeDelegation(), roleIds: [ids.role(9)] } }),
    );
    expect(unknownRole.code).toBe('delegation_role_unknown');
    const foreignCompanyRole = yield* Effect.flip(
      assertDelegationEnvelope({
        ...envelope,
        roles: [makeRole({ legalEntityId: legalEntityId(5) })],
      }),
    );
    expect(foreignCompanyRole.code).toBe('delegation_role_scope_mismatch');
    const tenantWideRoleInCompany = yield* Effect.flip(
      assertDelegationEnvelope({
        ...envelope,
        delegation: makeDelegation({ scopeId: ids.scope(5) }),
        scope: legalEntityScope,
      }),
    );
    expect(tenantWideRoleInCompany.code).toBe('delegation_role_scope_mismatch');
    // The company-local variant of that company is inside its own delegation scope.
    yield* assertDelegationEnvelope({
      ...envelope,
      delegation: makeDelegation({ scopeId: ids.scope(5) }),
      roles: [makeRole({ legalEntityId: legalEntityId(5) })],
      scope: legalEntityScope,
    });
  }),
);

it.effect('admits an exact cell and refuses a capability that only shares the delegated module', () =>
  Effect.gen(function* envelopeNeverGrowsWithItsModule() {
    const delegation = makeDelegation();
    const entry = makeEntry();
    yield* cellWithinDelegationEnvelope({ cell: makeCell(), delegation, entry, roleId: ids.role(1) });

    const growth = yield* Effect.flip(
      cellWithinDelegationEnvelope({
        cell: makeCell({ capabilityKey: siblingKey }),
        delegation,
        entry: makeEntry({ key: siblingKey }),
        roleId: ids.role(1),
      }),
    );
    expect(growth.code).toBe('delegation_envelope_growth');

    const foreign = yield* Effect.flip(
      cellWithinDelegationEnvelope({
        cell: makeCell({ capabilityKey: capabilityKey('party.registry.party.merge') }),
        delegation,
        entry: makeEntry({ key: capabilityKey('party.registry.party.merge') }),
        roleId: ids.role(1),
      }),
    );
    expect(foreign.code).toBe('delegation_cell_outside_envelope');

    const roleOutside = yield* Effect.flip(
      cellWithinDelegationEnvelope({ cell: makeCell(), delegation, entry, roleId: ids.role(2) }),
    );
    expect(roleOutside.code).toBe('delegation_role_outside_envelope');

    // The catalog entry must be the cell's own capability, or the money rule would read the wrong one.
    const mismatched = yield* Effect.flip(
      cellWithinDelegationEnvelope({
        cell: makeCell(),
        delegation,
        entry: makeEntry({ key: siblingKey }),
        roleId: ids.role(1),
      }),
    );
    expect(mismatched.code).toBe('delegation_cell_outside_envelope');
  }),
);

it.effect('applies an amount ceiling only to a capability that moves money', () =>
  Effect.gen(function* moneyLimitsStayWithMoney() {
    const delegation = makeDelegation({ amountCeiling: { currency: currency('CZK'), limitMinor: 100_000 } });
    const entry = makeEntry({ amountInput: 'amount' });
    const within = makeCell({ amountCeiling: { currency: currency('CZK'), limitMinor: 90_000 } });
    yield* cellWithinDelegationEnvelope({ cell: within, delegation, entry, roleId: ids.role(1) });

    const over = yield* Effect.flip(
      cellWithinDelegationEnvelope({
        cell: makeCell({ amountCeiling: { currency: currency('CZK'), limitMinor: 100_001 } }),
        delegation,
        entry,
        roleId: ids.role(1),
      }),
    );
    expect(over.code).toBe('delegation_amount_outside_envelope');

    const otherCurrency = yield* Effect.flip(
      cellWithinDelegationEnvelope({
        cell: makeCell({ amountCeiling: { currency: currency('EUR'), limitMinor: 1 } }),
        delegation,
        entry,
        roleId: ids.role(1),
      }),
    );
    expect(otherCurrency.code).toBe('delegation_amount_outside_envelope');

    // An uncapped money cell is unlimited authority, so it never fits a capped envelope.
    const uncapped = yield* Effect.flip(
      cellWithinDelegationEnvelope({ cell: makeCell(), delegation, entry, roleId: ids.role(1) }),
    );
    expect(uncapped.code).toBe('delegation_amount_outside_envelope');

    // The same ceiling on a capability that moves no money neither restricts nor fails it.
    yield* cellWithinDelegationEnvelope({
      cell: makeCell({ amountCeiling: { currency: currency('CZK'), limitMinor: 1_000_000 } }),
      delegation,
      entry: makeEntry(),
      roleId: ids.role(1),
    });
    // And an uncapped money cell is inside an uncapped envelope.
    yield* cellWithinDelegationEnvelope({
      cell: makeCell(),
      delegation: makeDelegation(),
      entry,
      roleId: ids.role(1),
    });
  }),
);

it('reports the same refusal as a value for the planners that cannot run Effects', () => {
  const delegation = makeDelegation({ amountCeiling: { currency: currency('CZK'), limitMinor: 100_000 } });
  expect(
    delegationCellIssue({
      cell: makeCell(),
      delegation,
      entry: makeEntry({ amountInput: 'amount' }),
      roleId: ids.role(1),
    })?.code,
  ).toBe('delegation_amount_outside_envelope');
  expect(
    delegationCellIssue({ cell: makeCell(), delegation: makeDelegation(), entry: makeEntry(), roleId: ids.role(1) }),
  ).toBeUndefined();
});

it.effect('plans a bounded delegated assignment and refuses self-assignment, strangers and other scopes', () =>
  Effect.gen(function* delegatedAssignmentIsBounded() {
    const { future, past } = yield* clockDates;
    const delegation = makeDelegation({ validFrom: past, validUntil: future });
    const request = {
      assignedBy: ids.principal(3),
      catalog: [makeEntry()],
      delegation,
      holder: person(4),
      incarnationId: ids.incarnation(7),
      managerIsMember: true,
      roleId: ids.role(1),
      roleRevision: makeRoleRevision(),
      scopeId: ids.scope(1),
    };
    const assignment = yield* planDelegatedAssignment(request);
    expect(assignment.delegated?.delegationId).toBe(ids.delegationId(1));
    expect(assignment.validUntil).toBe(future);

    const selfAssignment = yield* Effect.flip(planDelegatedAssignment({ ...request, holder: person(3) }));
    expect(selfAssignment.code).toBe('delegation_self_assignment');

    const stranger = yield* Effect.flip(planDelegatedAssignment({ ...request, holder: person(9) }));
    expect(stranger.code).toBe('delegation_holder_outside_envelope');

    const otherScope = yield* Effect.flip(planDelegatedAssignment({ ...request, scopeId: ids.scope(2) }));
    expect(otherScope.code).toBe('delegation_scope_mismatch');

    const tooLong = yield* Effect.flip(
      planDelegatedAssignment({ ...request, validUntil: dateAt(Date.UTC(2200, 0, 1)) }),
    );
    expect(tooLong.code).toBe('delegation_end_outside_envelope');
  }),
);

it.effect('bounds a delegated assignment by every cell of the role revision it assigns', () =>
  Effect.gen(function* everyCellIsBounded() {
    const { future, past } = yield* clockDates;
    const delegation = makeDelegation({
      capabilityKeys: [envelopeKey, siblingKey],
      validFrom: past,
      validUntil: future,
    });
    const request = {
      assignedBy: ids.principal(3),
      catalog: [makeEntry(), makeEntry({ key: siblingKey }), makeEntry({ key: foreignKey })],
      delegation,
      holder: person(4),
      incarnationId: ids.incarnation(7),
      managerIsMember: true,
      roleId: ids.role(1),
      roleRevision: makeRoleRevision({ cells: [makeCell(), makeCell({ capabilityKey: siblingKey })] }),
      scopeId: ids.scope(1),
    };
    const assignment = yield* planDelegatedAssignment(request);
    // Every key of the revision is frozen, so the bound covers exactly the authority it grants.
    expect(assignment.delegated?.capabilityKeys).toEqual([envelopeKey, siblingKey]);

    // A cell the caller never looked at fails the whole assignment, not just that one cell.
    const outside = yield* Effect.flip(
      planDelegatedAssignment({
        ...request,
        roleRevision: makeRoleRevision({ cells: [makeCell(), makeCell({ capabilityKey: foreignKey })] }),
      }),
    );
    expect(outside.code).toBe('delegation_cell_outside_envelope');

    // An uncapped money cell under a capped envelope is unlimited authority (D10b).
    const uncapped = yield* Effect.flip(
      planDelegatedAssignment({
        ...request,
        catalog: [makeEntry({ amountInput: 'amount' })],
        delegation: makeDelegation({
          amountCeiling: { currency: currency('CZK'), limitMinor: 100_000 },
          validFrom: past,
          validUntil: future,
        }),
        roleRevision: makeRoleRevision({ cells: [makeCell()] }),
      }),
    );
    expect(uncapped.code).toBe('delegation_amount_outside_envelope');

    // The manager's membership is a real input, not an assumption baked into the planner.
    const notAMember = yield* Effect.flip(planDelegatedAssignment({ ...request, managerIsMember: false }));
    expect(notAMember.code).toBe('delegation_not_live');

    // The revision must be a revision of the role the assignment names.
    const foreignRevision = yield* Effect.flip(
      planDelegatedAssignment({ ...request, roleRevision: makeRoleRevision({ roleId: ids.role(2) }) }),
    );
    expect(foreignRevision.code).toBe('delegation_role_outside_envelope');

    // An empty revision grants nothing, so there is no bound to freeze and no assignment to make.
    const emptyRevision = yield* Effect.flip(
      planDelegatedAssignment({ ...request, roleRevision: makeRoleRevision({ cells: [] }) }),
    );
    expect(emptyRevision.code).toBe('delegation_role_empty');
  }),
);

it.effect('requires the exact delegation to be live, unexpired and its manager still a member', () =>
  Effect.gen(function* delegationMustBeLive() {
    const { future, past } = yield* clockDates;
    yield* assertDelegationLive({
      delegation: makeDelegation({ validFrom: past, validUntil: future }),
      managerIsMember: true,
    });

    const revoked = yield* Effect.flip(
      assertDelegationLive({ delegation: makeDelegation({ status: 'revoked' }), managerIsMember: true }),
    );
    expect(revoked.code).toBe('delegation_not_live');

    const notAMember = yield* Effect.flip(
      assertDelegationLive({
        delegation: makeDelegation({ validFrom: past, validUntil: future }),
        managerIsMember: false,
      }),
    );
    expect(notAMember.code).toBe('delegation_not_live');
  }),
);

it.effect('keeps frozen delegated limits after the delegation ends and refuses limits that were dropped', () =>
  Effect.gen(function* delegatedAssignmentsStayBounded() {
    const delegation = makeDelegation({ status: 'revoked', validFrom: ELAPSED, validUntil: FUTURE });
    const bounded = makeAssignment({
      delegated: {
        capabilityKeys: [envelopeKey],
        delegationId: ids.delegationId(1),
        until: FUTURE,
      },
      validUntil: FUTURE,
    });
    yield* assertDelegatedAssignmentStaysBounded({ assignment: bounded, delegation });

    const dropped = yield* Effect.flip(
      assertDelegatedAssignmentStaysBounded({ assignment: makeAssignment({ validUntil: FUTURE }), delegation }),
    );
    expect(dropped.code).toBe('delegation_limits_lost');

    // A frozen envelope that names a key the delegation never had was widened in place.
    const widened = yield* Effect.flip(
      assertDelegatedAssignmentStaysBounded({
        assignment: makeAssignment({
          delegated: {
            capabilityKeys: [envelopeKey, siblingKey],
            delegationId: ids.delegationId(1),
            until: FUTURE,
          },
          validUntil: FUTURE,
        }),
        delegation,
      }),
    );
    expect(widened.code).toBe('delegation_limits_lost');
  }),
);
