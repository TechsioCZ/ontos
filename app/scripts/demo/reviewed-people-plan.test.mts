import { fileURLToPath } from 'node:url';

import { NodeServices } from '@effect/platform-node';
import { DateTime, Effect, Match, Option, Predicate, Result } from 'effect';
import { expect, it } from 'effect-rstest';

import { stableUuid } from '@app/core-runtime/access/catalog';

import { readAccessCatalogArtifact } from '../authorization-catalog-artifact.mts';
import { policyReleaseEntries } from './access-policy.mts';
import { demoHumanAccounts, demoModuleIds } from './permissions.mts';
import {
  AccessAssignmentIdSchema,
  AccessCapabilityKeySchema,
  AccessCatalogSnapshotIdSchema,
  AccessCompanyIdSchema,
  AccessHumanIdSchema,
  AccessPeopleRevisionSchema,
  AccessRoleIdSchema,
  AccessRoleRevisionIdSchema,
} from '../../apps/shell-super-app/shared/access-admin-api.ts';
import {
  AssignStep,
  AdmitMemberStep,
  IdempotencyKeySchema,
  admittedMembershipIdOf,
  assignmentIdOf,
  COMPANY_ID,
  COMPANY_SCOPE,
  desiredState,
  MANAGED_ROLE_IDS,
  membershipIdOf,
  observedCellOf,
  planReviewedPeople,
  PRINCIPAL_IDS,
  NEW_IN_THIS_REVIEW,
  previewIssue,
  reviewedAdditions,
  slotOf,
  reviewedExclusions,
  stepWithinAllowList,
  TENANT_ID,
  TENANT_SCOPE,
} from './reviewed-people-plan.mts';
import type {
  DesiredState,
  HumanId,
  ObservedMembership,
  ObservedPerson,
  ObservedState,
  PlannedStep,
  PlanOptions,
  SaveRole,
  ScopeTarget,
} from './reviewed-people-plan.mts';

const OWNER = AccessHumanIdSchema.make('493dafec-c9b1-5a84-89cb-bee630de3c34');
const NAJEMPARK = AccessCompanyIdSchema.make('71000000-0000-4000-8000-000000000021');
const FULL_ACCESS_ROLE = AccessRoleIdSchema.make('a2542ee7-34b0-8eff-89d5-0b2e4b0dc4ae');
const ROUTING = 'demo-shell-routing';
const NEXT_GENERATION = '--generation 2';
const OUTSIDE = 'outside the three people';
const AT = DateTime.makeUnsafe('2026-11-10T13:00:00.000Z');
const apply1: PlanOptions = { generation: 1, mode: 'apply' };
const apply2: PlanOptions = { generation: 2, mode: 'apply' };
const rollback1: PlanOptions = { generation: 1, mode: 'rollback' };
const company = (legalEntityId: string): ScopeTarget => ({
  kind: 'company',
  legalEntityId: AccessCompanyIdSchema.make(legalEntityId),
});
const incarnation = (seed: string) => AccessAssignmentIdSchema.make(stableUuid(seed));
const human = (principalId: string) => AccessHumanIdSchema.make(principalId);
const revision = (seed: string) => AccessRoleRevisionIdSchema.make(stableUuid(seed));
const times = <A,>(count: number, value: A): readonly A[] => Array.from({ length: count }, () => value);

const desired = Effect.gen(function* reviewedDesiredState() {
  const modules = yield* readAccessCatalogArtifact(fileURLToPath(new URL('../..', import.meta.url)));
  const entries = yield* Effect.fromResult(policyReleaseEntries(modules, demoModuleIds));
  return yield* Effect.fromResult(desiredState(entries));
}).pipe(Effect.provide(NodeServices.layer));

/** A membership row somebody else recorded before the script ran; its id is no admission key's. */
const member = (
  scope: ScopeTarget,
  kind: ObservedMembership['kind'] = 'member',
  membershipId: string = stableUuid(`recorded-before:${kind}:${JSON.stringify(scope)}`),
): ObservedMembership => ({
  kind,
  membershipId,
  scope,
  status: 'active',
  validUntil: Option.none(),
});

const companyAdmin = (principalId: string, legalEntityId: string): ObservedPerson => ({
  assignments: [
    { incarnationId: incarnation(`a:${principalId}`), roleId: FULL_ACCESS_ROLE, scope: TENANT_SCOPE, status: 'active' },
  ],
  delegations: [],
  memberships: [member(TENANT_SCOPE), member(company(legalEntityId)), member(company(legalEntityId), 'access_admin')],
  principalId: human(principalId),
  teams: [],
});

/** Stage as read at 13:00Z: six people, "Plný přístup" with 11 holders, and none of the three admitted. */
const stageBefore = (state: DesiredState): ObservedState => ({
  actingPrincipalId: OWNER,
  at: AT,
  directory: [...PRINCIPAL_IDS, OWNER].map((principalId) => ({ activeHumanMember: true, principalId })),
  people: [
    companyAdmin('849fdb3c-fab6-5c14-b20a-d885dc27313d', '71000000-0000-4000-8000-000000000022'),
    companyAdmin('1aaf0c53-beaf-50b6-819e-fa0c055f5b26', '71000000-0000-4000-8000-000000000024'),
    companyAdmin('52f863a1-c09c-5758-af37-74db4ee9c69f', '71000000-0000-4000-8000-000000000024'),
    companyAdmin('cdfa4353-77ab-5b46-9dc9-b1119ae0d5a9', '71000000-0000-4000-8000-000000000023'),
    companyAdmin('72000000-0000-4000-8000-000000000021', String(NAJEMPARK)),
    {
      assignments: [
        { incarnationId: incarnation('a:owner'), roleId: FULL_ACCESS_ROLE, scope: TENANT_SCOPE, status: 'active' },
      ],
      delegations: [],
      memberships: [member(TENANT_SCOPE, 'owner'), member(TENANT_SCOPE), member(COMPANY_SCOPE)],
      principalId: OWNER,
      teams: [],
    },
  ],
  peopleRevision: AccessPeopleRevisionSchema.make('r0'),
  release: {
    catalogSnapshotId: AccessCatalogSnapshotIdSchema.make('729c9c2d-4059-8473-a4dc-4158ea4d7b32'),
    createAvailable: true,
    entries: [...state.entries.values()].map(({ key, kind, modes, risk, selectors }) => ({
      capabilityKey: AccessCapabilityKeySchema.make(key),
      kind,
      modes,
      risk,
      selectors,
    })),
    saveAvailable: true,
  },
  roles: [
    {
      cells: [{ plain: true, slot: 'core.shell.composition.read run all' }],
      holderCount: 11,
      id: FULL_ACCESS_ROLE,
      legalEntityId: Option.none(),
      name: 'Plný přístup',
      revisionId: revision('full-access-revision'),
    },
  ],
  tenantId: TENANT_ID,
  writeAvailability: { canAdmitMember: true, canAssign: true, canEndMembership: true, canUnassign: true },
});

const withPerson = (state: ObservedState, principalId: HumanId, update: (person: ObservedPerson) => ObservedPerson) => {
  const current = state.people.find((person) => person.principalId === principalId) ?? {
    assignments: [],
    delegations: [],
    memberships: [],
    principalId,
    teams: [],
  };
  return [...state.people.filter((person) => person.principalId !== principalId), update(current)];
};

const holderDelta = (state: ObservedState, roleId: string, delta: number) =>
  state.roles.map((role) => (role.id === roleId ? { ...role, holderCount: role.holderCount + delta } : role));

/** What the Shell would answer to each write, applied to the observed state. */
const simulate = (state: ObservedState, step: PlannedStep): ObservedState => {
  const next = { ...state, peopleRevision: AccessPeopleRevisionSchema.make(`${state.peopleRevision}+`) };
  return Match.valueTags(step, {
    // The Shell names both rows by the admission key; a live tenant row is reused, never doubled.
    AdmitMember: ({ idempotencyKey, principalId }) => ({
      ...next,
      people: withPerson(state, principalId, (person) => ({
        ...person,
        memberships: [
          ...person.memberships,
          ...(person.memberships.some(
            (row) => row.kind === 'member' && row.scope.kind === 'tenant' && row.status === 'active',
          )
            ? []
            : [member(TENANT_SCOPE, 'member', membershipIdOf(idempotencyKey, TENANT_SCOPE))]),
          member(COMPANY_SCOPE, 'member', membershipIdOf(idempotencyKey, COMPANY_SCOPE)),
        ],
      })),
    }),
    Assign: ({ idempotencyKey, principalId, roleId, scope }) => ({
      ...next,
      people: withPerson(state, principalId, (person) => ({
        ...person,
        assignments: [
          ...person.assignments,
          { incarnationId: assignmentIdOf(idempotencyKey), roleId, scope, status: 'active' as const },
        ],
      })),
      roles: holderDelta(state, roleId, 1),
    }),
    CreateRole: ({ name, roleId, scope }) => ({
      ...next,
      roles: [
        ...state.roles,
        {
          cells: [],
          holderCount: 0,
          id: roleId,
          legalEntityId: scope.kind === 'company' ? Option.some(scope.legalEntityId) : Option.none(),
          name,
          revisionId: revision(`${roleId}:1`),
        },
      ],
    }),
    EndMembership: ({ principalId, scope }) => ({
      ...next,
      people: withPerson(state, principalId, (person) => ({
        ...person,
        memberships: person.memberships.map((row) =>
          row.kind === 'member' && row.scope.kind === scope.kind ? { ...row, status: 'revoked' as const } : row,
        ),
      })),
    }),
    RevokeAssignment: ({ incarnationId, principalId, roleId }) => ({
      ...next,
      people: withPerson(state, principalId, (person) => ({
        ...person,
        assignments: person.assignments.map((held) =>
          held.incarnationId === incarnationId ? { ...held, status: 'revoked' as const } : held,
        ),
      })),
      roles: holderDelta(state, roleId, -1),
    }),
    SaveRole: ({ cells, roleId }) => ({
      ...next,
      roles: state.roles.map((role) =>
        role.id === roleId ? { ...role, cells: cells.map(observedCellOf), revisionId: revision(`${roleId}:2`) } : role,
      ),
    }),
  });
};

const simulateAll = (state: ObservedState, steps: readonly PlannedStep[]): ObservedState => {
  let current = state;
  for (const step of steps) {
    current = simulate(current, step);
  }
  return current;
};

const plan = (state: DesiredState, observed: ObservedState, options: PlanOptions) =>
  planReviewedPeople(state, observed, options);
const signature = (steps: readonly PlannedStep[]) => steps.map((step) => `${step._tag} ${step.idempotencyKey}`);
const tagsOf = (steps: readonly PlannedStep[]) => steps.map(({ _tag }) => _tag);
const stepsOf = (result: ReturnType<typeof plan>): readonly PlannedStep[] => {
  if (Result.isFailure(result)) {
    throw new Error(`planner halted: ${result.failure.reason}`);
  }
  return result.success;
};
const haltOf = (result: ReturnType<typeof plan>) => (Result.isFailure(result) ? result.failure : undefined);
const applied = (state: DesiredState) =>
  simulateAll(stageBefore(state), stepsOf(plan(state, stageBefore(state), apply1)));
const firstSave = (steps: readonly PlannedStep[]): SaveRole => {
  const [save] = steps.flatMap((step) => (Predicate.isTagged(step, 'SaveRole') ? [step] : []));
  if (save === undefined) {
    throw new Error('no save step');
  }
  return save;
};
const roleId = (key: string) =>
  stableUuid(['ontos.shell.access-roles.role', TENANT_ID, `ontos-demo-reviewed-role:v1:${key}`].join(':'));
const PEOPLE_STEPS = [...times(3, 'AdmitMember'), ...times(6, 'Assign')];

it.effect('pins the reviewed roles, their dangerous cells and the six assignments of the three people', () =>
  Effect.gen(function* exactDesiredState() {
    const state = yield* desired;
    expect(PRINCIPAL_IDS).toEqual([
      '2bdc200d-ad86-5101-b48f-a52339718354',
      '4f94471b-1d15-5aa9-a836-c87e0f8a449d',
      '3952547a-564f-5468-9038-8dce11185c44',
    ]);
    expect(demoHumanAccounts.slice(1).map(({ principalId }) => principalId)).toEqual(PRINCIPAL_IDS);
    expect(
      state.roles.map(({ cells, confirmations, key, roleId: id, scope }) => [
        key,
        cells.length,
        confirmations.length,
        id,
        scope,
      ]),
    ).toEqual([
      ['sales', 441, 397, roleId('sales'), COMPANY_SCOPE],
      ['accounting', 161, 129, roleId('accounting'), COMPANY_SCOPE],
      ['warehouse', 33, 23, roleId('warehouse'), COMPANY_SCOPE],
      [ROUTING, 1, 0, roleId(ROUTING), TENANT_SCOPE],
    ]);
    // Capabilities the release declared after the review stay with full access: no reviewed role holds one.
    const excluded = new Set<string>(Object.values(reviewedExclusions).flat());
    expect([reviewedExclusions.sales.length, reviewedExclusions.accounting.length, excluded.size]).toEqual([
      16, 10, 16,
    ]);
    expect([...excluded].filter((key) => !state.entries.has(key))).toEqual([]);
    expect(
      state.roles.flatMap(({ cells, key }) =>
        cells
          .filter(({ capabilityKey }) => excluded.has(capabilityKey))
          .map(({ capabilityKey }) => [key, capabilityKey]),
      ),
    ).toEqual([]);
    const [obchodnik, ucetni, sklad] = PRINCIPAL_IDS;
    expect(state.assignments.map(({ principalId, roleKey, scope }) => [principalId, roleKey, scope])).toEqual([
      [obchodnik, 'sales', COMPANY_SCOPE],
      [obchodnik, ROUTING, TENANT_SCOPE],
      [ucetni, 'accounting', COMPANY_SCOPE],
      [ucetni, ROUTING, TENANT_SCOPE],
      [sklad, 'warehouse', COMPANY_SCOPE],
      [sklad, ROUTING, TENANT_SCOPE],
    ]);
  }),
);

it.effect('writes only the three people, the four roles and tenant or company 0020 on a stage-shaped state', () =>
  Effect.gen(function* limitedToNamedPeople() {
    const state = yield* desired;
    const before = stageBefore(state);
    const steps = stepsOf(plan(state, before, apply1));
    expect(tagsOf(steps)).toEqual([...times(4, ['CreateRole', 'SaveRole']).flat(), ...PEOPLE_STEPS]);
    const named = JSON.stringify(steps).match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gu) ?? [];
    const allowed = new Set<string>([
      ...PRINCIPAL_IDS,
      ...MANAGED_ROLE_IDS,
      COMPANY_ID,
      before.release.catalogSnapshotId,
    ]);
    expect(named.filter((id) => !allowed.has(id))).toEqual([]);
    // A forged write naming the owner, Nájempark or "Plný přístup" never passes the last guard.
    const [principal] = PRINCIPAL_IDS;
    const assign = {
      expectedRevision: AccessPeopleRevisionSchema.make('r0'),
      expectedRoleRevisionId: Option.none(),
      idempotencyKey: IdempotencyKeySchema.make('forged'),
      principalId: principal ?? OWNER,
      roleId: MANAGED_ROLE_IDS[0] ?? FULL_ACCESS_ROLE,
      roleKey: 'sales',
      scope: COMPANY_SCOPE,
    } as const;
    expect(stepWithinAllowList(AssignStep.make(assign), before)).toBe(true);
    for (const forged of [
      AdmitMemberStep.make({
        expectedRevision: assign.expectedRevision,
        idempotencyKey: assign.idempotencyKey,
        principalId: OWNER,
      }),
      AssignStep.make({ ...assign, principalId: OWNER }),
      AssignStep.make({ ...assign, roleId: FULL_ACCESS_ROLE }),
      AssignStep.make({ ...assign, scope: company(NAJEMPARK) }),
    ]) {
      expect(stepWithinAllowList(forged, before)).toBe(false);
    }
    // Somebody outside the three holding a managed role stops the plan.
    const done = applied(state);
    const outsider = {
      ...done,
      people: withPerson(done, OWNER, (person) => ({
        ...person,
        assignments: [
          ...person.assignments,
          { incarnationId: incarnation('x'), roleId: assign.roleId, scope: COMPANY_SCOPE, status: 'active' as const },
        ],
      })),
    };
    expect(haltOf(plan(state, outsider, apply1))?.reason).toContain(OUTSIDE);
  }),
);

it.effect('plans exactly the remaining steps from every halfway state and nothing once applied', () =>
  Effect.gen(function* halfwayStates() {
    const state = yield* desired;
    const before = stageBefore(state);
    const steps = stepsOf(plan(state, before, apply1));
    let observed = before;
    for (const [index, step] of steps.entries()) {
      expect(signature(stepsOf(plan(state, observed, apply1)))).toEqual(signature(steps.slice(index)));
      observed = simulate(observed, step);
    }
    expect(stepsOf(plan(state, observed, apply1))).toEqual([]);
    const holders = observed.roles
      .filter(({ id }) => MANAGED_ROLE_IDS.includes(id))
      .map(({ holderCount }) => holderCount);
    expect(holders).toEqual([1, 1, 1, 3]);
    // All four roles created but still empty: four saves, then the people.
    const created = simulateAll(
      before,
      steps.filter((step) => Predicate.isTagged(step, 'CreateRole')),
    );
    expect(tagsOf(stepsOf(plan(state, created, apply1)))).toEqual([...times(4, 'SaveRole'), ...PEOPLE_STEPS]);
  }),
);

it.effect('halts instead of saving over a managed role with other cells or an unexpected preview', () =>
  Effect.gen(function* haltsOnForeignRoleState() {
    const state = yield* desired;
    const before = stageBefore(state);
    const steps = stepsOf(plan(state, before, apply1));
    const save = firstSave(steps);
    const created = simulateAll(before, steps.slice(0, 1));
    const changed = {
      ...created,
      roles: created.roles.map((role) =>
        role.id === save.roleId
          ? { ...role, cells: [{ plain: true, slot: 'core.identity.unreviewed.read run all' }] }
          : role,
      ),
    };
    expect(haltOf(plan(state, changed, apply1))?.reason).toContain('holds other cells');

    const cells = save.cells.map(observedCellOf);
    const exact = { added: cells, affectedHolders: [], cells, dangerous: save.confirmations, removed: [] };
    expect(previewIssue(save, exact)).toBeUndefined();
    expect(previewIssue(save, { ...exact, dangerous: save.confirmations.slice(1) })).toContain('dangerous');
    expect(previewIssue(save, { ...exact, affectedHolders: [Option.some(OWNER)] })).toContain(OUTSIDE);
  }),
);

const TAX_PREFIX = 'commerce.tax.';
const TAX_RULE_SET_READ_SLOT = 'commerce.tax.tax-rule-set.read run all';
/** A capability new in this review: the VAT reads of Phase 1. */
const isNew = (capabilityKey: string) => NEW_IN_THIS_REVIEW.has(capabilityKey);
const slotKey = (slot: string) => slot.split(' ')[0] ?? slot;
/** The role as saved before this review: without any of the capabilities new in it. */
const withoutNew = (observed: ObservedState, id: string): ObservedState => ({
  ...observed,
  roles: observed.roles.map((role) =>
    role.id === id ? { ...role, cells: role.cells.filter(({ slot }) => !isNew(slotKey(slot))) } : role,
  ),
});

it.effect('adds only the newly reviewed VAT reads to a role saved before them, and names each one', () =>
  Effect.gen(function* extendsSavedRole() {
    const state = yield* desired;
    const accounting = state.roles.find(({ key }) => key === 'accounting');
    if (accounting === undefined) {
      throw new Error('no accounting role');
    }
    // No preset role holds a Tax write: the accountant only reads Tax.
    expect(accounting.cells.filter(({ capabilityKey }) => capabilityKey.startsWith(TAX_PREFIX)).map(slotOf)).toEqual([
      'commerce.tax.seller-vat-regime-declaration.read-history run all',
      'commerce.tax.seller-vat-regime.read-at-instant run all',
      TAX_RULE_SET_READ_SLOT,
      'commerce.tax.tax-rule.read-history run all',
    ]);
    const newCells = accounting.cells.filter(({ capabilityKey }) => isNew(capabilityKey));
    expect(newCells.map(slotOf)).toEqual([
      'commerce.tax.seller-vat-regime-declaration.read-history run all',
      'commerce.tax.seller-vat-regime.read-at-instant run all',
      TAX_RULE_SET_READ_SLOT,
      'commerce.tax.tax-rule.read-history run all',
      'finance.billing.navigation-vat.read run all',
      'finance.billing.page-vat.read run all',
      'finance.billing.vat-choices.read run all',
    ]);
    // Stage holds the three reviewed roles as saved before Phase 1: everything except their new VAT reads.
    let before = applied(state);
    for (const id of MANAGED_ROLE_IDS) {
      before = withoutNew(before, id);
    }
    const steps = stepsOf(plan(state, before, apply1));
    // The warehouse role gains nothing: it needs no VAT read of its own.
    expect(tagsOf(steps)).toEqual(['SaveRole', 'SaveRole']);
    const saves = steps.flatMap((step) => (Predicate.isTagged(step, 'SaveRole') ? [step] : []));
    expect(saves.map(({ addedCells, roleKey }) => [roleKey, addedCells.length])).toEqual([
      ['sales', 1],
      ['accounting', 7],
    ]);
    const [, save] = saves;
    if (save === undefined) {
      throw new Error('no accounting save');
    }
    expect(save.addedCells.map(slotOf)).toEqual(newCells.map(slotOf));
    expect(save.cells).toEqual(accounting.cells);
    expect(save.confirmations.length).toBeGreaterThan(0);
    expect(save.confirmations.every(({ slot }) => isNew(slotKey(slot)))).toBe(true);
    // The Shell must preview exactly the additions on top of the saved cells.
    const exact = {
      added: save.addedCells.map(observedCellOf),
      affectedHolders: [],
      cells: save.cells.map(observedCellOf),
      dangerous: save.confirmations,
      removed: [],
    };
    expect(previewIssue(save, exact)).toBeUndefined();
    expect(previewIssue(save, { ...exact, added: exact.cells })).toContain('does not add exactly');
    // Once saved, nothing is left to do.
    expect(stepsOf(plan(state, simulateAll(before, steps), apply1))).toEqual([]);
  }),
);

it.effect('never gives back a reviewed cell a person removed from a saved role; only the new cells are added', () =>
  Effect.gen(function* keepsRemovals() {
    const state = yield* desired;
    const accounting = state.roles.find(({ key }) => key === 'accounting');
    if (accounting === undefined) {
      throw new Error('no accounting role');
    }
    const removed = accounting.cells.find(({ capabilityKey }) => !isNew(capabilityKey));
    if (removed === undefined) {
      throw new Error('the accounting role holds no other cell');
    }
    // Saved before Phase 1, and since then a person removed one of its reviewed cells in the role editor.
    let before = withoutNew(applied(state), accounting.roleId);
    before = {
      ...before,
      roles: before.roles.map((role) =>
        role.id === accounting.roleId
          ? { ...role, cells: role.cells.filter(({ slot }) => slot !== slotOf(removed)) }
          : role,
      ),
    };
    const steps = stepsOf(plan(state, before, apply1));
    const saves = steps.flatMap((step) => (Predicate.isTagged(step, 'SaveRole') ? [step] : []));
    expect(saves.map(({ roleKey }) => roleKey)).toEqual(['accounting']);
    const [save] = saves;
    expect(save?.addedCells.every(({ capabilityKey }) => isNew(capabilityKey))).toBe(true);
    expect(save?.cells.map(slotOf)).not.toContain(slotOf(removed));
    expect(save?.cells).toHaveLength(accounting.cells.length - 1);
    // Once the new cells are saved there is nothing left to do: the removal stays.
    expect(stepsOf(plan(state, simulateAll(before, steps), apply1))).toEqual([]);
  }),
);

it('extends a saved role only when it holds nothing but plain reviewed cells', () => {
  const reviewed = [
    { capabilityKey: AccessCapabilityKeySchema.make('commerce.tax.tax-rule-set.read'), mode: 'run', selector: 'all' },
    { capabilityKey: AccessCapabilityKeySchema.make('work.tasks.api-records.read'), mode: 'run', selector: 'all' },
  ] as const;
  const tasksCell = { plain: true, slot: 'work.tasks.api-records.read run all' };
  expect(reviewedAdditions([tasksCell], reviewed)?.map(slotOf)).toEqual([TAX_RULE_SET_READ_SLOT]);
  // Only what is new in this review is ever added: the Tasks read a role lacks was removed by a person.
  expect(reviewedAdditions([], reviewed)?.map(slotOf)).toEqual([TAX_RULE_SET_READ_SLOT]);
  expect(reviewedAdditions([tasksCell], reviewed, new Set())).toEqual([]);
  expect(reviewedAdditions([{ ...tasksCell, plain: false }], reviewed)).toBeUndefined();
  expect(reviewedAdditions([{ plain: true, slot: 'core.identity.unreviewed.read run all' }], reviewed)).toBeUndefined();
  expect(reviewedAdditions([tasksCell, tasksCell], reviewed)).toBeUndefined();
});

it.effect('after a rollback asks for a new generation, and generation 2 admits and assigns under fresh ids', () =>
  Effect.gen(function* reapplyAfterRollback() {
    const state = yield* desired;
    const done = applied(state);
    const firstIds = new Set(
      done.people.flatMap(({ assignments }) => assignments.map(({ incarnationId }) => incarnationId)),
    );

    // One assignment ended by hand: the same generation would replay its revoked id forever.
    const rollback = stepsOf(plan(state, done, rollback1));
    const oneEnded = simulateAll(done, rollback.slice(0, 1));
    expect(haltOf(plan(state, oneEnded, apply1))?.reason).toContain(NEXT_GENERATION);
    expect(tagsOf(stepsOf(plan(state, oneEnded, apply2)))).toEqual(['Assign']);

    expect(tagsOf(rollback)).toEqual([...times(6, 'RevokeAssignment'), ...times(6, 'EndMembership')]);
    const rolledBack = simulateAll(done, rollback);
    expect(stepsOf(plan(state, rolledBack, rollback1))).toEqual([]);
    expect(haltOf(plan(state, rolledBack, apply1))?.reason).toContain(NEXT_GENERATION);

    const again = stepsOf(plan(state, rolledBack, apply2));
    expect(tagsOf(again)).toEqual(PEOPLE_STEPS);
    expect(again.every(({ idempotencyKey }) => idempotencyKey.includes(':g2:'))).toBe(true);
    const freshIds = again.flatMap((step) =>
      Predicate.isTagged(step, 'Assign') ? [assignmentIdOf(step.idempotencyKey)] : [],
    );
    expect(freshIds.filter((id) => firstIds.has(id))).toEqual([]);
    expect(stepsOf(plan(state, simulateAll(rolledBack, again), apply2))).toEqual([]);

    // An apply that stopped after the admissions, rolled back: no assignment id tells, the ended rows do.
    const steps = stepsOf(plan(state, stageBefore(state), apply1));
    const admitted = simulateAll(
      stageBefore(state),
      steps.filter((step) => !Predicate.isTagged(step, 'Assign')),
    );
    const endedEarly = simulateAll(admitted, stepsOf(plan(state, admitted, rollback1)));
    expect(haltOf(plan(state, endedEarly, apply1))?.reason).toContain(NEXT_GENERATION);
  }),
);

it.effect('rolls back only the memberships its own admissions wrote, and stops before closing anything else', () =>
  Effect.gen(function* rollbackStaysInsideTheApply() {
    const state = yield* desired;
    const [obchodnik = OWNER, ucetni = OWNER] = PRINCIPAL_IDS;
    // Účetní was a member of the tenant and of company 0020 before the apply, so the apply admits nobody
    // for her; the other two are admitted under generation 1.
    const before = stageBefore(state);
    const memberBefore = {
      ...before,
      people: withPerson(before, ucetni, (person) => ({
        ...person,
        memberships: [member(TENANT_SCOPE), member(COMPANY_SCOPE)],
      })),
    };
    const applySteps = stepsOf(plan(state, memberBefore, apply1));
    expect(applySteps.filter((step) => Predicate.isTagged(step, 'AdmitMember'))).toHaveLength(2);
    const done = simulateAll(memberBefore, applySteps);
    expect(
      done.people
        .find(({ principalId }) => principalId === obchodnik)
        ?.memberships.map(({ membershipId }) => membershipId)
        .toSorted(),
    ).toEqual(
      [
        admittedMembershipIdOf(1, obchodnik, TENANT_SCOPE),
        admittedMembershipIdOf(1, obchodnik, COMPANY_SCOPE),
      ].toSorted(),
    );

    // Her managed roles are revoked, but her own memberships are not the script's to end.
    const rollback = stepsOf(plan(state, done, rollback1));
    expect(tagsOf(rollback)).toEqual([...times(6, 'RevokeAssignment'), ...times(4, 'EndMembership')]);
    const ended = rollback.flatMap((step) => (Predicate.isTagged(step, 'EndMembership') ? [step.principalId] : []));
    expect(ended).not.toContain(ucetni);
    // A rollback named with a later generation still recognizes the rows generation 1 admitted.
    const later = stepsOf(plan(state, done, { generation: 2, mode: 'rollback' }));
    expect(later.filter((step) => Predicate.isTagged(step, 'EndMembership'))).toHaveLength(4);

    // Anything ending an admitted membership would close beyond the two plain member rows stops the plan.
    const withExtra = (extra: (person: ObservedPerson) => ObservedPerson) => ({
      ...done,
      people: withPerson(done, obchodnik, extra),
    });
    const najempark = company(NAJEMPARK);
    const tooMuch: readonly (readonly [string, ObservedState])[] = [
      ['team place', withExtra((person) => ({ ...person, teams: [COMPANY_SCOPE] }))],
      [
        'live delegation',
        withExtra((person) => ({ ...person, delegations: [{ managerId: obchodnik, status: 'active' }] })),
      ],
      [
        'access_admin membership',
        withExtra((person) => ({
          ...person,
          memberships: [...person.memberships, member(COMPANY_SCOPE, 'access_admin')],
        })),
      ],
      [
        `member membership in company ${NAJEMPARK}`,
        withExtra((person) => ({ ...person, memberships: [...person.memberships, member(najempark)] })),
      ],
    ];
    for (const [what, observed] of tooMuch) {
      expect(haltOf(plan(state, observed, rollback1))?.reason).toContain(what);
    }
    // A delegation that only names them, or one already revoked, closes nothing and does not stop it.
    const harmless = withExtra((person) => ({
      ...person,
      delegations: [
        { managerId: OWNER, status: 'active' },
        { managerId: obchodnik, status: 'revoked' },
      ],
    }));
    expect(signature(stepsOf(plan(state, harmless, rollback1)))).toEqual(signature(rollback));
  }),
);

it.effect('halts instead of ending its tenant row when company 0020 was admitted again through Lidé', () =>
  Effect.gen(function* foreignCompanyRowStopsTheTenantEnd() {
    const state = yield* desired;
    const [obchodnik = OWNER] = PRINCIPAL_IDS;
    const done = applied(state);
    // The script's company row was ended in Lidé and the person admitted to company 0020 again under
    // another id; the tenant row is still the one the script wrote.
    const readmitted = member(COMPANY_SCOPE, 'member', stableUuid('readmitted-through-lide'));
    const observed = {
      ...done,
      people: withPerson(done, obchodnik, (person) => ({
        ...person,
        memberships: [
          ...person.memberships.map((row) =>
            row.membershipId === admittedMembershipIdOf(1, obchodnik, COMPANY_SCOPE)
              ? { ...row, status: 'revoked' as const }
              : row,
          ),
          readmitted,
        ],
      })),
    };
    const planned = plan(state, observed, rollback1);
    expect(haltOf(planned)?.reason).toContain(obchodnik);
    expect(haltOf(planned)?.reason).toContain(readmitted.membershipId);
    expect(Result.isFailure(planned)).toBe(true);
  }),
);

it.effect('refuses to plan for anyone but the tenant owner of the reviewed tenant', () =>
  Effect.gen(function* ownerOnly() {
    const state = yield* desired;
    const before = stageBefore(state);
    for (const observed of [
      { ...before, actingPrincipalId: '849fdb3c-fab6-5c14-b20a-d885dc27313d' },
      { ...before, tenantId: '70000000-0000-4000-8000-000000000010' },
    ]) {
      expect(haltOf(plan(state, observed, apply1))?.kind).toBe('identity');
    }
  }),
);
