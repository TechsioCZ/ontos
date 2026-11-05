import type { Result } from 'effect';
import { Effect, Option } from 'effect';
import { expect, it } from 'effect-rstest';

import type {
  RoleCellConfirmation,
  RoleRevisionPlan,
  RoleRevisionPlanRequest,
} from '../../src/access/changes/role-revision.ts';
import {
  findEditableRole,
  planRoleRevision,
  planRoleRevisionPreview,
  previewRoleRevision,
  roleCellEffect,
  roleSummaryOf,
  templateKeyOf,
  writeRoleRevision,
} from '../../src/access/changes/role-revision.ts';
import { storeConflict } from '../../src/access/changes/persistence/errors/index.ts';
import type { AccessConfigureBasis } from '../../src/access/changes/authority.ts';
import type { AccessChangesState, AccessChangesStoreService } from '../../src/access/changes/persistence/store.ts';
import { AccessChangesStore } from '../../src/access/changes/persistence/store.ts';
import type { RoleCellEdit, RoleWithRevision } from '../../src/access/changes/role-edits.ts';
import {
  AccessOperationIdSchema,
  AccessScopeIdSchema,
  CommandDigestSchema,
  PrincipalIdSchema,
  RoleIdSchema,
  RoleRevisionIdSchema,
  TenantIdSchema,
} from '../../src/access/ids.ts';
import type { Assignment, Cell } from '../../src/access/model.ts';
import { CellSchema, HolderSchema } from '../../src/access/model.ts';
import { projectionWriteRefusal } from '../../src/access/intent/projection-write-error.ts';
import { planGrantIncarnationMove, grantIncarnationId } from '../../src/access/intent/grant-incarnations.ts';
import type { TenantProjectionWrite } from '../../src/access/intent/projection-writer.ts';
import { AccessProjectionWriter } from '../../src/access/intent/projection-writer.ts';
import type { TenantIntentLoaderService } from '../../src/access/intent/tenant-intent-loader.ts';
import { TenantIntentLoader } from '../../src/access/intent/tenant-intent-loader.ts';
import { capabilitySlot } from '../../src/access/compiler/object-id.ts';
import type { OperationalScope } from '../../src/operations/context.ts';
import {
  CATALOG,
  LEGAL_ENTITY,
  MANAGER,
  OTHER_PERSON,
  OTHER_ROLE,
  PERSON,
  ROLE,
  SCOPE,
  TENANT,
  assignment,
  cell,
  decodeWith,
  delegatedBasis,
  delegation,
  entry,
  failureOf,
  fixedId,
  instant,
  ownerBasis,
  principalHolder,
  roleState,
  snapshot,
  succeeded,
  tenantScopeRecord,
} from './access-changes-fixtures.ts';

/*
 * The role editor's write path (P2): the plan a save is built on, the token a stale preview is caught
 * by, and the one fenced operation that persists and reconciles it. Every refusal below is paired with
 * the case that must still succeed, so the planner cannot pass by refusing everything.
 */

const READ = 'test.party.read';
const NOTE = 'test.party.note';
const PAY = 'test.invoice.pay';
const ADMIN = 'test.tenant.configure';
const BUDGET = 'test.party.budget';

const readEntry = entry({ key: READ, kind: 'read', modes: ['run'], selectors: ['all', 'assigned'] });
const noteEntry = entry({ key: NOTE, modes: ['run', 'propose'], selectors: ['all'] });
const adminEntry = entry({ key: ADMIN, kind: 'admin', modes: ['run'], risk: 'sensitive' });
const payEntrySelectors = entry({
  amountInput: 'amount',
  key: PAY,
  modes: ['run', 'propose', 'approve'],
  risk: 'critical',
  selectors: ['all'],
});
const budgetEntrySelectors = entry({
  amountInput: 'amount',
  key: BUDGET,
  modes: ['run'],
  risk: 'routine',
  selectors: ['all'],
});

const catalog = snapshot([readEntry, noteEntry, adminEntry, payEntrySelectors, budgetEntrySelectors]);
const targetRevisionId = RoleRevisionIdSchema.make(fixedId(41));
const AT = instant(9);

const headRole = (cells: readonly Cell[], legalEntityId?: string): RoleWithRevision =>
  legalEntityId === undefined
    ? roleState({ cells, revisionId: fixedId(40) })
    : roleState({ cells, legalEntityId, revisionId: fixedId(40) });

const targetCell = (capabilityKey: string, recordKeys: readonly string[] = [fixedId(80)]): Cell =>
  decodeWith('targets cell', CellSchema, {
    capabilityKey,
    mode: 'run',
    selector: { _tag: 'targets', recordKeys },
  });

const budgetCell = (limitMinor: number): Cell =>
  decodeWith('budget cell', CellSchema, {
    amountCeiling: { currency: 'CZK', limitMinor },
    capabilityKey: BUDGET,
    mode: 'run',
    selector: { _tag: 'all' },
  });

const planOf = (
  role: RoleWithRevision,
  cells: readonly Cell[],
  overrides: Partial<RoleRevisionPlanRequest> = {},
): Effect.Effect<Result.Result<RoleRevisionPlan, { readonly code: string; readonly reason: string }>> =>
  Effect.result(
    planRoleRevision({
      catalog,
      cells,
      confirmedEffects: [],
      expectedRoleRevisionId: role.revision.id,
      role,
      targetRevisionId,
      ...overrides,
    }),
  );

const editablePlan = (
  role: RoleWithRevision,
  cells: readonly Cell[],
): Effect.Effect<RoleRevisionPlan, { readonly code: string; readonly reason: string }> =>
  Effect.map(planOf(role, cells), (result) => succeeded(result));

const editOf = (plan: RoleRevisionPlan): RoleCellEdit => Option.getOrThrow(plan.edit);

const payConfirmation = (): RoleCellConfirmation => ({
  effect: roleCellEffect(payEntrySelectors, cell(PAY, 'run')),
  slot: `${PAY} run all`,
});

it.effect('plans the successor revision of a role that adds and removes exact cells', () =>
  Effect.gen(function* planRevision() {
    const role = headRole([cell(READ), cell(NOTE)]);
    const plan = succeeded(yield* planOf(role, [cell(READ), cell(BUDGET)]));
    const edit = editOf(plan);
    expect(plan.unchanged).toBe(false);
    expect(plan.addedCells).toEqual([cell(BUDGET)]);
    expect(plan.removedCells).toEqual([cell(NOTE)]);
    expect(edit.cells).toEqual([cell(READ), cell(BUDGET)]);
    expect(edit.sourceRevisionId).toBe(role.revision.id);
    expect(edit.targetRevisionId).toBe(targetRevisionId);
    expect(edit.roleId).toBe(role.role.id);
  }),
);

it.effect('answers an unchanged cell set without writing a revision', () =>
  Effect.gen(function* planNoop() {
    const plan = succeeded(yield* planOf(headRole([cell(READ)]), [cell(READ)]));
    expect(plan.unchanged).toBe(true);
    expect(Option.isNone(plan.edit)).toBe(true);
    expect(plan.addedCells).toEqual([]);
    expect(plan.removedCells).toEqual([]);
  }),
);

it.effect('refuses a role that moved on instead of forking its history (R2-M5)', () =>
  Effect.gen(function* refuseStaleHead() {
    const role = headRole([cell(READ)]);
    const failure = failureOf(
      yield* planOf(role, [cell(READ), cell(NOTE)], { expectedRoleRevisionId: RoleRevisionIdSchema.make(fixedId(77)) }),
    );
    expect(failure.code).toBe('access_changes_preview_stale');
    expect(failure.reason).toContain(fixedId(77));
  }),
);

it.effect('refuses a capability the pinned release does not publish, so nothing follows a future flow (O1)', () =>
  Effect.gen(function* refuseFutureCapability() {
    const failure = failureOf(yield* planOf(headRole([]), [cell('test.party.unpublished')]));
    expect(failure.code).toBe('access_changes_capability_not_configurable');
    expect(failure.reason).toContain('test.party.unpublished');
  }),
);

it.effect('refuses a mode and a record selector the release does not declare for the cell', () =>
  Effect.gen(function* refuseUndeclaredMode() {
    const undeclaredMode = failureOf(yield* planOf(headRole([]), [cell(ADMIN, 'approve')]));
    expect(undeclaredMode.code).toBe('access_changes_capability_not_configurable');
    expect(undeclaredMode.reason).toContain('approve');

    const undeclaredSelector = failureOf(yield* planOf(headRole([]), [cell(ADMIN, 'run', 'assigned')]));
    expect(undeclaredSelector.reason).toContain('assigned');
  }),
);

it.effect('refuses explicit record targets on a tenant-context role and accepts them on a company role (O7)', () =>
  Effect.gen(function* scopeOfTargets() {
    const refused = failureOf(yield* planOf(headRole([]), [targetCell(READ)]));
    expect(refused.code).toBe('access_changes_capability_not_configurable');
    expect(refused.reason).toContain('tenant-context');

    const company = headRole([], LEGAL_ENTITY);
    const plan = succeeded(yield* planOf(company, [targetCell(READ)]));
    expect(plan.addedCells).toEqual([targetCell(READ)]);
  }),
);

it.effect('holds a capability declared with no selectors as its scope-wide cell', () =>
  Effect.gen(function* scopeWideWithoutSelectors() {
    const plan = succeeded(yield* planOf(headRole([cell(ADMIN)]), [cell(ADMIN), cell(READ)]));
    expect(plan.addedCells).toEqual([cell(READ)]);
    expect(plan.removedCells).toEqual([]);
  }),
);

it.effect('replaces the slot of a targets cell whose exact records changed', () =>
  Effect.gen(function* narrowTargets() {
    const both = targetCell(READ, [fixedId(80), fixedId(81)]);
    const narrowed = targetCell(READ, [fixedId(80)]);
    const plan = succeeded(yield* planOf(headRole([both], LEGAL_ENTITY), [narrowed]));
    expect(plan.unchanged).toBe(false);
    expect(plan.addedCells).toEqual([narrowed]);
    expect(plan.removedCells).toEqual([both]);
    const reordered = targetCell(READ, [fixedId(81), fixedId(80)]);
    expect(succeeded(yield* planOf(headRole([both], LEGAL_ENTITY), [reordered])).unchanged).toBe(true);
  }),
);

it.effect('refuses mixing a scope-wide and an explicit-target cell for one capability and mode (O51)', () =>
  Effect.gen(function* refuseMixedSlots() {
    const failure = failureOf(yield* planOf(headRole([], LEGAL_ENTITY), [cell(READ), targetCell(READ)]));
    expect(failure.code).toBe('access_changes_capability_not_configurable');
    expect(failure.reason).toContain('mixes');
  }),
);

it.effect('refuses a cell requested twice rather than picking one', () =>
  Effect.gen(function* refuseDuplicate() {
    const failure = failureOf(yield* planOf(headRole([]), [cell(READ), cell(READ)]));
    expect(failure.code).toBe('access_changes_capability_not_configurable');
    expect(failure.reason).toContain('requested twice');
  }),
);

it.effect('replaces the slot of a cell whose amount ceiling changed, and the slot gets a fresh incarnation', () =>
  Effect.gen(function* replaceCeiling() {
    const held = [budgetCell(1000), cell(READ)];
    const plan = succeeded(yield* planOf(headRole(held), [budgetCell(2000), cell(READ)]));
    // A ceiling is not part of the slot, so the change is the same slot with new content: naming only an
    // add would collide with the cell the role holds, and naming only a remove would end the cell.
    expect(plan.unchanged).toBe(false);
    expect(plan.addedCells).toEqual([budgetCell(2000)]);
    expect(plan.removedCells).toEqual([budgetCell(1000)]);
    const edit = Option.getOrThrow(plan.edit);
    expect(edit.cells.length).toBe(2);
    expect(
      edit.cells.some(
        (candidate) => candidate.capabilityKey === BUDGET && candidate.amountCeiling?.limitMinor === 2000,
      ),
    ).toBe(true);

    // The incarnations follow the plan: the replaced slot retires and comes back under a new id, while
    // the untouched cell keeps the incarnation its approvals witnessed (O51(2), O52).
    const ids = {
      roleId: RoleIdSchema.make(ROLE),
      scopeId: AccessScopeIdSchema.make(SCOPE),
      tenantId: TenantIdSchema.make(TENANT),
    };
    const oldBudget = budgetCell(1000);
    const kept = cell(READ);
    const oldBudgetId = grantIncarnationId({ cell: oldBudget, ...ids });
    const keptId = grantIncarnationId({ cell: kept, ...ids });
    const existing = [
      {
        capabilityKey: oldBudget.capabilityKey,
        grantIncarnationId: oldBudgetId,
        mode: oldBudget.mode,
        slot: capabilitySlot(oldBudget),
        status: 'active' as const,
      },
      {
        capabilityKey: kept.capabilityKey,
        grantIncarnationId: keptId,
        mode: kept.mode,
        slot: capabilitySlot(kept),
        status: 'active' as const,
      },
    ];
    const move = planGrantIncarnationMove({
      ...ids,
      addedCells: plan.addedCells,
      existing,
      removedCells: plan.removedCells,
      targetRevisionId,
    });
    expect(move.retire).toEqual([oldBudgetId]);
    expect(move.write.length).toBe(1);
    const written = move.write.find((row) => row.capabilityKey === BUDGET);
    expect(written?.cell).toEqual(budgetCell(2000));
    expect(written?.grantIncarnationId).not.toBe(oldBudgetId);

    // A cell the request leaves alone is neither retired nor written, so its witness survives.
    expect(move.retire).not.toContain(keptId);
    expect(move.write.map((row) => row.grantIncarnationId)).not.toContain(keptId);
  }),
);

it.effect('requires one named confirmation per dangerous cell and refuses a re-pointed or foreign one', () =>
  Effect.gen(function* confirmEachDanger() {
    const role = headRole([cell(READ)]);
    const cells = [cell(READ), cell(PAY, 'run')];
    const plan = succeeded(yield* planOf(role, cells, { confirmedEffects: [payConfirmation()] }));
    expect(plan.dangerous).toEqual([
      {
        capabilityKey: PAY,
        effect: roleCellEffect(payEntrySelectors, cell(PAY, 'run')),
        mode: 'run',
        risk: 'critical',
        slot: `${PAY} run all`,
      },
    ]);

    const missing = failureOf(yield* planOf(role, cells));
    expect(missing.code).toBe('access_changes_sensitive_requires_individual_decision');
    expect(missing.reason).toContain(`${PAY} run all`);

    const repointed = failureOf(
      yield* planOf(role, cells, {
        confirmedEffects: [{ effect: 'routine something else', slot: `${PAY} run all` }],
      }),
    );
    expect(repointed.code).toBe('access_changes_named_effect_mismatch');

    const foreign = failureOf(
      yield* planOf(role, cells, {
        confirmedEffects: [{ effect: 'anything', slot: `${READ} run all` }, payConfirmation()],
      }),
    );
    expect(foreign.code).toBe('access_changes_named_effect_mismatch');
    expect(foreign.reason).toContain(`${READ} run all`);

    const confirmed = succeeded(yield* planOf(role, cells, { confirmedEffects: [payConfirmation()] }));
    expect(confirmed.addedCells).toEqual([cell(PAY, 'run')]);
    expect(Option.isSome(confirmed.edit)).toBe(true);
  }),
);

it.effect('previews the dangerous cells a saved plan must carry a named confirmation for', () =>
  Effect.gen(function* previewThenSave() {
    const role = headRole([cell(READ)]);
    const cells = [cell(READ), cell(PAY, 'run')];
    const preview = succeeded(
      yield* Effect.result(
        planRoleRevisionPreview({
          catalog,
          cells,
          confirmedEffects: [],
          expectedRoleRevisionId: role.revision.id,
          role,
          targetRevisionId,
        }),
      ),
    );
    expect(preview.dangerous.map(({ slot }) => slot)).toEqual([`${PAY} run all`]);
    expect(Option.isSome(preview.edit)).toBe(true);

    const refused = failureOf(yield* planOf(role, cells));
    expect(refused.code).toBe('access_changes_sensitive_requires_individual_decision');
  }),
);

it.effect('needs no per-cell confirmation for a routine widening, and names an approve cell as dangerous', () =>
  Effect.gen(function* routineVersusApprove() {
    const routine = succeeded(yield* planOf(headRole([]), [cell(READ)]));
    expect(routine.dangerous).toEqual([]);

    const approve = succeeded(
      yield* planOf(headRole([]), [cell(PAY, 'approve')], {
        confirmedEffects: [
          { effect: roleCellEffect(payEntrySelectors, cell(PAY, 'approve')), slot: `${PAY} approve all` },
        ],
      }),
    );
    expect(approve.dangerous.map(({ slot }) => slot)).toEqual([`${PAY} approve all`]);
  }),
);

it.effect('answers a different preview token when only the exact target records differ', () =>
  Effect.gen(function* previewTargets() {
    const role = headRole([targetCell(READ, [fixedId(80), fixedId(81)])], LEGAL_ENTITY);
    const preview = function* preview(cells: readonly ReturnType<typeof targetCell>[]) {
      const plan = yield* editablePlan(role, cells);
      return previewRoleRevision({ assignments: [], at: AT, cells, plan, role, targetRevisionId }).fingerprint;
    };
    const narrowed = yield* preview([targetCell(READ, [fixedId(80)])]);
    const replaced = yield* preview([targetCell(READ, [fixedId(82)])]);
    expect(replaced).not.toBe(narrowed);
    expect(yield* preview([targetCell(READ, [fixedId(80)])])).toBe(narrowed);
  }),
);

it.effect('answers the same preview token for the same intent and a different one when holding changes', () =>
  Effect.gen(function* previewToken() {
    const role = headRole([cell(READ)]);
    const plan = yield* editablePlan(role, [cell(READ), cell(NOTE)]);
    const preview = (assignments: readonly ReturnType<typeof assignment>[]) =>
      previewRoleRevision({ assignments, at: AT, cells: [cell(READ), cell(NOTE)], plan, role, targetRevisionId });

    const held = preview([assignment({ incarnationId: fixedId(50) })]);
    expect(preview([assignment({ incarnationId: fixedId(50) })]).fingerprint).toBe(held.fingerprint);
    expect(preview([assignment({ incarnationId: fixedId(51) })]).fingerprint).not.toBe(held.fingerprint);
    expect(preview([]).fingerprint).not.toBe(held.fingerprint);
    expect(held.affectedHolders.map(({ assignmentIncarnationId }) => assignmentIncarnationId)).toEqual([fixedId(50)]);
    expect(held.affectedHolders.every(({ roleId }) => roleId === ROLE)).toBe(true);
  }),
);

it.effect('names only live holders: a revoked or not-yet-started assignment reaches nobody yet', () =>
  Effect.gen(function* liveHoldersOnly() {
    const role = headRole([cell(READ)]);
    const plan = yield* editablePlan(role, [cell(READ), cell(NOTE)]);
    const preview = (assignments: readonly ReturnType<typeof assignment>[]) =>
      previewRoleRevision({ assignments, at: AT, cells: [cell(READ), cell(NOTE)], plan, role, targetRevisionId });

    const empty = preview([]);
    expect(preview([assignment({ incarnationId: fixedId(52), status: 'revoked' })]).fingerprint).toBe(
      empty.fingerprint,
    );
    expect(preview([assignment({ incarnationId: fixedId(53), validFrom: instant(20) })]).fingerprint).toBe(
      empty.fingerprint,
    );
    expect(empty.holderCount).toBe(0);
  }),
);

it.effect('separates the people an edit reaches from the agents it reaches', () =>
  Effect.gen(function* holdersByKind() {
    const role = headRole([cell(READ)]);
    const plan = yield* editablePlan(role, [cell(READ), cell(NOTE)]);
    const preview = previewRoleRevision({
      assignments: [
        assignment({ holder: principalHolder(), incarnationId: fixedId(54) }),
        assignment({ holder: decodeWith('agent holder', HolderSchema, { _tag: 'Agent', agentId: fixedId(7) }) }),
      ],
      at: AT,
      cells: [cell(READ), cell(NOTE)],
      plan,
      role,
      targetRevisionId,
    });
    expect(preview.holderCount).toBe(2);
    expect(preview.humanCount).toBe(1);
    expect(preview.agentCount).toBe(1);
  }),
);

it.effect('summarizes a role with its own scope, its head revision and its live holders', () =>
  Effect.sync(() => {
    const tenantRole = headRole([cell(READ)]);
    expect(roleSummaryOf(tenantRole, [assignment({ incarnationId: fixedId(55) })], AT)).toEqual({
      cells: [cell(READ)],
      headRevision: {
        catalogSnapshotId: CATALOG,
        cells: [cell(READ)],
        createdAt: tenantRole.revision.createdAt,
        createdBy: PERSON,
        provenance: 'manual',
        revision: 1,
        roleRevisionId: fixedId(40),
      },
      holderCount: 1,
      name: tenantRole.role.name,
      roleId: ROLE,
      scope: 'tenant',
    });

    const company = headRole([], LEGAL_ENTITY);
    const companySummary = roleSummaryOf(company, [], AT);
    expect(companySummary.scope).toBe('company');
    expect(companySummary.legalEntityId).toBe(LEGAL_ENTITY);
    expect(companySummary.holderCount).toBe(0);
  }),
);

it.effect('finds only a role the tenant actually holds, and never invents one', () =>
  Effect.sync(() => {
    const role = headRole([cell(READ)]);
    expect(Option.isSome(findEditableRole([role], role.role.id))).toBe(true);
    expect(Option.isNone(findEditableRole([role], RoleIdSchema.make(fixedId(78))))).toBe(true);
    expect(Option.isNone(templateKeyOf(role.revision))).toBe(true);
  }),
);

const scopeOf = (principalId: string): OperationalScope =>
  Object.freeze({
    authBindingId: 'binding-1',
    authContextRef: 'session-1',
    authMethod: 'session' as const,
    correlationId: 'p2-roles',
    principalId: PrincipalIdSchema.make(principalId),
    tenantId: TenantIdSchema.make(TENANT),
  });

const scope = scopeOf(PERSON);

const unusedCall = () => Effect.die('this test never calls it');

const projection: TenantProjectionWrite = {
  deletions: 1,
  digest: CommandDigestSchema.make('a'.repeat(64)),
  operationId: AccessOperationIdSchema.make(fixedId(90)),
  projectionToken: 'projected:1',
  resumed: false,
  scopeId: AccessScopeIdSchema.make(SCOPE),
  touches: 4,
  units: ['tenant'],
  verified: true,
};

const changesOf = (roles: readonly RoleWithRevision[]): AccessChangesState => ({
  decisions: [],
  items: [],
  revisions: roles.map(({ revision }) => revision),
  roles: [...roles],
});

const storeService = (
  record: AccessChangesStoreService['recordRoleRevision'],
  roles: readonly RoleWithRevision[] = [headRole([cell(READ)])],
): AccessChangesStoreService => ({
  loadPublishedCatalog: () => Effect.succeed(Option.some(catalog)),
  loadTenantChanges: () => Effect.succeed(changesOf(roles)),
  publishCatalog: unusedCall,
  recordAdoption: unusedCall,
  recordChangeItems: unusedCall,
  recordDecline: unusedCall,
  recordRole: unusedCall,
  recordRoleRevision: record,
  recordUndo: unusedCall,
});

/** The live intent a write is authorised against: the holders of the tenant and the author's bases. */
const loaderService = (
  input: {
    readonly assignments?: readonly Assignment[];
    readonly bases?: readonly AccessConfigureBasis[];
  } = {},
): TenantIntentLoaderService => ({
  loadAuthorityCells: unusedCall,
  loadConfigureBases: () => Effect.succeed(input.bases ?? [ownerBasis()]),
  loadConnection: unusedCall,
  loadProjection: () =>
    Effect.succeed({
      catalogEntries: [],
      coverage: 'complete',
      legalEntities: [],
      // The grantor of every fixture delegation is a live tenant member.
      members: [{ holder: principalHolder(PERSON) }],
      owners: [],
      principals: [],
      scopes: [
        {
          assignments: [...(input.assignments ?? [assignment()])],
          connections: [],
          delegations: [],
          installations: [],
          roleRevisions: [],
          scope: tenantScopeRecord(),
        },
      ],
      suspended: [],
      tenantId: TenantIdSchema.make(TENANT),
    }),
  loadScope: unusedCall,
  loadTeamIds: unusedCall,
  loadTenantContextScopeId: unusedCall,
});

const reconciled = (calls: string[]) => ({
  reconcileTenant: (request: { readonly scope: OperationalScope }) =>
    Effect.sync(() => {
      calls.push(`reconcile:${request.scope.tenantId}`);
      return projection;
    }),
});

it.effect('writes the revision in the caller scope and reconciles before reporting success', () =>
  Effect.gen(function* writeAndReconcile() {
    const calls: string[] = [];
    const plan = yield* editablePlan(headRole([cell(READ)]), [cell(READ), cell(NOTE)]);
    const edit = editOf(plan);
    const written = yield* writeRoleRevision({
      catalogSnapshotId: catalog.id,
      decidedAt: AT,
      edit,
      scope,
    }).pipe(
      Effect.provideService(
        AccessChangesStore,
        storeService((input) =>
          Effect.sync(() => {
            calls.push(
              `store:${input.scope.principalId}:${String(input.catalogSnapshotId)}:${input.edit.targetRevisionId}`,
            );
          }),
        ),
      ),
      Effect.provideService(TenantIntentLoader, loaderService()),
      Effect.provideService(AccessProjectionWriter, reconciled(calls)),
    );
    expect(calls).toEqual([`store:${PERSON}:${catalog.id}:${targetRevisionId}`, `reconcile:${TENANT}`]);
    expect(written.roleRevisionId).toBe(targetRevisionId);
    expect(written.projection).toEqual(projection);
  }),
);

it.effect('never reconciles when the store refuses the write', () =>
  Effect.gen(function* noReconcileOnConflict() {
    const calls: string[] = [];
    const plan = yield* editablePlan(headRole([cell(READ)]), [cell(READ), cell(NOTE)]);
    const failure = yield* writeRoleRevision({
      catalogSnapshotId: catalog.id,
      decidedAt: AT,
      edit: editOf(plan),
      scope,
    }).pipe(
      Effect.provideService(
        AccessChangesStore,
        storeService(() => Effect.fail(storeConflict('access_changes_revision_stale', 'the role moved on'))),
      ),
      Effect.provideService(TenantIntentLoader, loaderService()),
      Effect.provideService(AccessProjectionWriter, reconciled(calls)),
      Effect.flip,
    );
    expect(calls).toEqual([]);
    expect(failure.code).toBe('access_changes_revision_stale');
  }),
);

it.effect('reports a refused projection as retryable unavailability, not as an accepted edit', () =>
  Effect.gen(function* projectionRefused() {
    const plan = yield* editablePlan(headRole([cell(READ)]), [cell(READ), cell(NOTE)]);
    const failure = yield* writeRoleRevision({
      catalogSnapshotId: catalog.id,
      decidedAt: AT,
      edit: editOf(plan),
      scope,
    }).pipe(
      Effect.provideService(
        AccessChangesStore,
        storeService(() => Effect.void),
      ),
      Effect.provideService(TenantIntentLoader, loaderService()),
      Effect.provideService(AccessProjectionWriter, {
        reconcileTenant: () =>
          Effect.fail(projectionWriteRefusal('access_projection_write_unavailable', 'the engine was unreachable')),
      }),
      Effect.flip,
    );
    expect(failure.code).toBe('access_projection_write_unavailable');
  }),
);

it.effect('replays a save whose reconcile failed after commit: the retry reconciles and succeeds', () =>
  Effect.gen(function* replayAfterFailedReconcile() {
    const calls: string[] = [];
    const cells = [cell(READ), cell(NOTE)];
    let roles: readonly RoleWithRevision[] = [headRole([cell(READ)])];
    let reconcileFails = true;
    const store: AccessChangesStoreService = {
      ...storeService(unusedCall),
      loadTenantChanges: () => Effect.succeed(changesOf(roles)),
      recordRoleRevision: (input) =>
        Effect.sync(() => {
          calls.push(`store:${input.edit.targetRevisionId}`);
          roles = [roleState({ cells: input.edit.cells, revisionId: input.edit.targetRevisionId })];
        }),
    };
    const projectionWriter = {
      reconcileTenant: () =>
        Effect.suspend(() => {
          calls.push(reconcileFails ? 'reconcile:failed' : 'reconcile');
          return reconcileFails
            ? Effect.fail(projectionWriteRefusal('access_projection_write_unavailable', 'the engine was unreachable'))
            : Effect.succeed(projection);
        }),
    };
    // Each attempt plans against the role it reads now and echoes the revision the editor first read.
    const save = Effect.gen(function* saveAttempt() {
      const [role] = roles;
      const plan = yield* planRoleRevision({
        catalog,
        cells,
        confirmedEffects: [],
        expectedRoleRevisionId: RoleRevisionIdSchema.make(fixedId(40)),
        role: role ?? headRole([]),
        targetRevisionId,
      });
      const written = yield* writeRoleRevision({
        catalogSnapshotId: catalog.id,
        decidedAt: AT,
        edit: editOf(plan),
        scope,
      });
      return { plan, written };
    }).pipe(
      Effect.provideService(AccessChangesStore, store),
      Effect.provideService(TenantIntentLoader, loaderService()),
      Effect.provideService(AccessProjectionWriter, projectionWriter),
    );

    const first = yield* Effect.flip(save);
    expect(first.code).toBe('access_projection_write_unavailable');
    reconcileFails = false;
    const retried = yield* save;
    expect(retried.plan.replayed).toBe(true);
    expect(retried.written).toEqual({ projection, roleRevisionId: targetRevisionId });
    // The revision is recorded once; only the reconcile runs again.
    expect(calls).toEqual([`store:${targetRevisionId}`, 'reconcile:failed', 'reconcile']);

    // Negative control: the same key reused for other cells is still a stale save, never a replay.
    const reused = yield* planOf(roles[0] ?? headRole([]), [cell(READ)], {
      expectedRoleRevisionId: RoleRevisionIdSchema.make(fixedId(40)),
    });
    expect(failureOf(reused).code).toBe('access_changes_preview_stale');
  }),
);

/*
 * Configuration authority is the write's own check (P8, D10): passing the gate for the save key admits
 * a delegated manager to the editor, never to every role of the tenant. Each refusal writes nothing.
 */

const otherRole = roleState({ cells: [cell(READ)], revisionId: fixedId(42), roleId: OTHER_ROLE });

/** The grantor's own role: running the note capability on every record, which the delegate hands on. */
const grantorRole = roleState({ cells: [cell(NOTE)], revisionId: fixedId(45), roleId: fixedId(46) });
const grantorHolds = (grantor: RoleWithRevision = grantorRole) =>
  assignment({
    holder: principalHolder(PERSON),
    incarnationId: fixedId(51),
    roleId: grantor.role.id,
    roleRevisionId: grantor.revision.id,
  });

/** A tenant-context delegation over `ROLE` and the note capability, for `OTHER_PERSON` only. */
const managerBasis = () =>
  delegatedBasis(delegation({ capabilityKeys: [NOTE], people: [OTHER_PERSON], roleIds: [ROLE] }));

const authorisedWrite = (input: {
  readonly actor: string;
  readonly assignments: readonly Assignment[];
  readonly bases: readonly AccessConfigureBasis[];
  readonly cells: readonly Cell[];
  readonly grantor?: RoleWithRevision;
  readonly role?: RoleWithRevision;
}) =>
  Effect.gen(function* authorisedWriteEffect() {
    const recorded: string[] = [];
    const role = input.role ?? headRole([cell(READ)]);
    const plan = yield* editablePlan(role, input.cells);
    const outcome = yield* Effect.result(
      writeRoleRevision({
        catalogSnapshotId: catalog.id,
        decidedAt: AT,
        edit: editOf(plan),
        scope: scopeOf(input.actor),
      }).pipe(
        Effect.provideService(
          AccessChangesStore,
          storeService(
            (request) =>
              Effect.sync(() => {
                recorded.push(request.edit.roleId);
              }),
            [headRole([cell(READ)]), otherRole, input.grantor ?? grantorRole],
          ),
        ),
        Effect.provideService(
          TenantIntentLoader,
          loaderService({ assignments: input.assignments, bases: input.bases }),
        ),
        Effect.provideService(AccessProjectionWriter, reconciled([])),
      ),
    );
    return { outcome, recorded };
  });

it.effect('lets the owner edit any role, including one they hold themselves', () =>
  Effect.gen(function* ownerEdits() {
    const { outcome, recorded } = yield* authorisedWrite({
      actor: PERSON,
      assignments: [assignment({ holder: principalHolder(PERSON) })],
      bases: [ownerBasis()],
      cells: [cell(READ), cell(BUDGET)],
    });
    expect(succeeded(outcome).roleRevisionId).toBe(targetRevisionId);
    expect(recorded).toEqual([ROLE]);
  }),
);

it.effect('lets a delegated manager edit a role of their envelope with a capability of their envelope', () =>
  Effect.gen(function* delegateWithinEnvelope() {
    const { outcome, recorded } = yield* authorisedWrite({
      actor: MANAGER,
      assignments: [assignment({ holder: principalHolder(OTHER_PERSON) }), grantorHolds()],
      bases: [managerBasis()],
      cells: [cell(READ), cell(NOTE)],
    });
    expect(succeeded(outcome).roleRevisionId).toBe(targetRevisionId);
    expect(recorded).toEqual([ROLE]);
  }),
);

it.effect('refuses a delegated manager a cell that reaches more than the grantor holds now', () =>
  Effect.gen(function* delegateBeyondGrantor() {
    // The grantor only proposes notes, so the delegate never adds running them ...
    const proposing = roleState({ cells: [cell(NOTE, 'propose')], revisionId: fixedId(45), roleId: fixedId(46) });
    const { outcome, recorded } = yield* authorisedWrite({
      actor: MANAGER,
      assignments: [assignment({ holder: principalHolder(OTHER_PERSON) }), grantorHolds(proposing)],
      bases: [managerBasis()],
      cells: [cell(READ), cell(NOTE)],
      grantor: proposing,
    });
    expect(failureOf(outcome).code).toBe('access_changes_delegation_out_of_envelope');
    expect(failureOf(outcome).reason).toContain('reaches more than grantor');
    expect(recorded).toEqual([]);
    // ... and a grantor who holds nothing in the scope leaves the delegate nothing to add.
    const empty = yield* authorisedWrite({
      actor: MANAGER,
      assignments: [assignment({ holder: principalHolder(OTHER_PERSON) })],
      bases: [managerBasis()],
      cells: [cell(READ), cell(NOTE)],
    });
    expect(failureOf(empty.outcome).code).toBe('access_changes_delegation_out_of_envelope');
    expect(empty.recorded).toEqual([]);
  }),
);

it.effect('refuses a delegated manager a role outside the delegation roleIds', () =>
  Effect.gen(function* delegateOutsideRole() {
    const { outcome, recorded } = yield* authorisedWrite({
      actor: MANAGER,
      assignments: [assignment({ holder: principalHolder(OTHER_PERSON), roleId: OTHER_ROLE })],
      bases: [managerBasis()],
      cells: [cell(READ), cell(NOTE)],
      role: otherRole,
    });
    const failure = failureOf(outcome);
    expect(failure.code).toBe('access_changes_authority_missing');
    expect(recorded).toEqual([]);
  }),
);

it.effect('refuses a delegated manager a cell outside the delegation capabilities', () =>
  Effect.gen(function* delegateOutsideCapability() {
    const { outcome, recorded } = yield* authorisedWrite({
      actor: MANAGER,
      assignments: [assignment({ holder: principalHolder(OTHER_PERSON) })],
      bases: [managerBasis()],
      cells: [cell(READ), cell(BUDGET)],
    });
    const failure = failureOf(outcome);
    expect(failure.code).toBe('access_changes_delegation_out_of_envelope');
    expect(failure.reason).toContain(BUDGET);
    expect(recorded).toEqual([]);
  }),
);

it.effect('refuses a delegated manager a role they hold themselves', () =>
  Effect.gen(function* delegateSelfHeld() {
    const { outcome, recorded } = yield* authorisedWrite({
      actor: MANAGER,
      assignments: [assignment({ holder: principalHolder(MANAGER) })],
      bases: [managerBasis()],
      cells: [cell(READ), cell(NOTE)],
    });
    // A delegation never names its own manager among its people, so a role they hold is out of reach.
    const failure = failureOf(outcome);
    expect(failure.code).toBe('access_changes_delegation_out_of_envelope');
    expect(failure.reason).toContain(MANAGER);
    expect(recorded).toEqual([]);
  }),
);

it.effect('refuses a person with no configure basis even when the gate admitted the save', () =>
  Effect.gen(function* noBasis() {
    const { outcome, recorded } = yield* authorisedWrite({
      actor: OTHER_PERSON,
      assignments: [assignment()],
      bases: [],
      cells: [cell(READ), cell(NOTE)],
    });
    expect(failureOf(outcome).code).toBe('access_changes_authority_missing');
    expect(recorded).toEqual([]);
  }),
);
