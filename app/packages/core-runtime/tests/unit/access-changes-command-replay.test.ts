import { Context, Effect, Option } from 'effect';
import { expect, it } from 'effect-rstest';
import { TestClock } from 'effect/testing';

import { makeAccessChangesCommands } from '../../src/access/changes/commands.ts';
import type { AccessChangesState, AccessChangesStoreService } from '../../src/access/changes/persistence/store.ts';
import { AccessChangesStore } from '../../src/access/changes/persistence/store.ts';
import type { RoleCellEdit, RoleWithRevision } from '../../src/access/changes/role-edits.ts';
import type { TenantProjectionIntent } from '../../src/access/compiler/intent.ts';
import {
  AccessOperationIdSchema,
  AccessScopeIdSchema,
  CommandDigestSchema,
  PrincipalIdSchema,
  TenantIdSchema,
} from '../../src/access/ids.ts';
import { AccessMembershipSchema, AccessMembershipStore } from '../../src/access/intent/memberships.ts';
import type { AccessMembershipStoreService } from '../../src/access/intent/memberships.ts';
import { projectionWriteRefusal } from '../../src/access/intent/projection-write-error.ts';
import { AccessProjectionWriter } from '../../src/access/intent/projection-writer.ts';
import type {
  AccessProjectionWriterService,
  TenantProjectionWrite,
} from '../../src/access/intent/projection-writer.ts';
import { TenantIntentLoader } from '../../src/access/intent/tenant-intent-loader.ts';
import type { TenantIntentLoaderService } from '../../src/access/intent/tenant-intent-loader.ts';
import type { AccessChangeItem } from '../../src/access/model.ts';
import type { OperationalScope } from '../../src/operations/context.ts';
import {
  PERSON,
  SCOPE,
  TENANT,
  changeItem,
  decodeWith,
  entry,
  fixedId,
  instant,
  principalHolder,
  roleRevision,
  roleState,
  snapshot,
  tenantScopeRecord,
} from './access-changes-fixtures.ts';

/*
 * A decision is recorded before the tenant is reconciled, so a projection failure leaves a recorded
 * batch whose grants are not projected yet. Retrying the same request must repair that projection:
 * the replay of a recorded batch reconciles before it answers, and a replay of a healthy batch does
 * the same harmless, idempotent reconcile.
 */

const KEY = 'test.party.add-note';
const RELEASE = snapshot([entry({ key: KEY })]);

const scope: OperationalScope = Object.freeze({
  authBindingId: 'binding-1',
  authContextRef: 'session-1',
  authMethod: 'session' as const,
  correlationId: 'command-replay',
  principalId: PrincipalIdSchema.make(PERSON),
  tenantId: TenantIdSchema.make(TENANT),
});

const intent: TenantProjectionIntent = {
  catalogEntries: [],
  coverage: 'complete',
  legalEntities: [],
  members: [],
  owners: [PrincipalIdSchema.make(PERSON)],
  principals: [],
  scopes: [
    {
      assignments: [],
      connections: [],
      delegations: [],
      installations: [],
      roleRevisions: [],
      scope: tenantScopeRecord(),
    },
  ],
  suspended: [],
  tenantId: TenantIdSchema.make(TENANT),
};

const membership = decodeWith('membership', AccessMembershipSchema, {
  createdAt: instant(0),
  holder: principalHolder(),
  id: fixedId(95),
  kind: 'member',
  recordedBy: PERSON,
  scopeId: SCOPE,
  status: 'active',
  tenantId: TENANT,
  validFrom: instant(0),
});

const projected: TenantProjectionWrite = {
  deletions: 0,
  digest: CommandDigestSchema.make('b'.repeat(64)),
  operationId: AccessOperationIdSchema.make(fixedId(90)),
  projectionToken: 'projected:1',
  resumed: false,
  scopeId: AccessScopeIdSchema.make(SCOPE),
  touches: 1,
  units: ['tenant'],
  verified: true,
};

const unused = () => Effect.die('the commands never call this method');

interface RecordedPlan {
  readonly decisions: AccessChangesState['decisions'];
  readonly items: readonly AccessChangeItem[];
  readonly roleEdits: readonly RoleCellEdit[];
}

/** The state after one plan is written: its decisions appended, its items moved, its revisions current. */
const applied = (state: AccessChangesState, plan: RecordedPlan): AccessChangesState => {
  const items = new Map(plan.items.map((item) => [item.id, item]));
  const edits = new Map(plan.roleEdits.map((edit) => [edit.roleId, edit]));
  const revisions = [...state.revisions];
  const roles: RoleWithRevision[] = [];
  for (const current of state.roles) {
    const edit = edits.get(current.role.id);
    if (edit === undefined) {
      roles.push(current);
    } else {
      const next = roleRevision({
        cells: edit.cells,
        createdAt: instant(6),
        id: edit.targetRevisionId,
        revision: current.revision.revision + 1,
        roleId: current.role.id,
      });
      revisions.push(next);
      roles.push({ revision: next, role: current.role });
    }
  }
  return {
    decisions: [...state.decisions, ...plan.decisions],
    items: state.items.map((item) => items.get(item.id) ?? item),
    revisions,
    roles,
  };
};

/** An in-memory store that records exactly what a plan writes, as the Drizzle store would. */
const memoryStore = (calls: string[]): AccessChangesStoreService => {
  let state: AccessChangesState = {
    decisions: [],
    items: [changeItem({ capabilityKey: KEY })],
    revisions: [roleRevision({})],
    roles: [roleState({})],
  };
  const record = (plan: RecordedPlan) =>
    Effect.sync(() => {
      state = applied(state, plan);
      calls.push('store:record');
    });
  return {
    loadPublishedCatalog: () => Effect.succeed(Option.some(RELEASE)),
    loadTenantChanges: () => Effect.sync(() => state),
    publishCatalog: unused,
    recordAdoption: ({ plan }) => record(plan),
    recordChangeItems: unused,
    recordDecline: unused,
    recordRole: unused,
    recordRoleRevision: unused,
    recordUndo: ({ plan }) => record(plan),
  };
};

/** A projection writer that fails its next reconciles on demand, as an unreachable engine would. */
const flakyProjection = (calls: string[], faults: { remaining: number }): AccessProjectionWriterService => ({
  reconcileTenant: () =>
    Effect.suspend(() => {
      calls.push('reconcile');
      if (faults.remaining > 0) {
        faults.remaining -= 1;
        return Effect.fail(projectionWriteRefusal('access_projection_write_unavailable', 'engine unreachable'));
      }
      return Effect.succeed(projected);
    }),
});

const harness = () => {
  const calls: string[] = [];
  const faults = { remaining: 0 };
  const memberships: AccessMembershipStoreService = {
    loadTenantMemberships: () => Effect.succeed([membership]),
    recordMembership: unused,
    recordMemberships: unused,
    setMembershipStatus: unused,
  };
  const loader: TenantIntentLoaderService = {
    loadAuthorityCells: unused,
    loadAuthorityCellsMany: unused,
    loadConfigureBases: unused,
    loadConnection: unused,
    loadProjection: () => Effect.succeed(intent),
    loadScope: unused,
    loadTeamIds: unused,
    loadTenantContextScopeId: unused,
  };
  const commands = makeAccessChangesCommands(
    Context.make(AccessChangesStore, memoryStore(calls)).pipe(
      Context.add(AccessMembershipStore, memberships),
      Context.add(AccessProjectionWriter, flakyProjection(calls, faults)),
      Context.add(TenantIntentLoader, loader),
    ),
  );
  return { calls, commands, faults };
};

const ITEM_ID = changeItem({ capabilityKey: KEY }).id;

const adoptInput = (previewToken: string) => ({
  catalogSnapshotId: RELEASE.id,
  idempotencyKey: 'adopt-1',
  itemIds: [ITEM_ID],
  previewToken,
});

it.effect('a retried adoption reconciles the projection its first attempt failed to write', () =>
  Effect.gen(function* adoptionRetryReconciles() {
    yield* TestClock.setTime(instant(6).getTime());
    const { calls, commands, faults } = harness();
    const { token } = yield* commands.preview(scope, { itemIds: [ITEM_ID], mode: 'adopt' });
    faults.remaining = 1;
    const failed = yield* Effect.flip(commands.adopt(scope, adoptInput(token)));
    expect(failed.code).toBe('access_changes_command_unavailable');
    const retried = yield* commands.adopt(scope, adoptInput(token));
    expect(retried.decisionIds).toHaveLength(1);
    expect(calls).toEqual(['store:record', 'reconcile', 'reconcile']);
  }),
);

it.effect('a retried undo reconciles the projection its first attempt failed to write', () =>
  Effect.gen(function* undoRetryReconciles() {
    yield* TestClock.setTime(instant(6).getTime());
    const { calls, commands, faults } = harness();
    const adoptPreview = yield* commands.preview(scope, { itemIds: [ITEM_ID], mode: 'adopt' });
    yield* commands.adopt(scope, adoptInput(adoptPreview.token));
    const undoPreview = yield* commands.preview(scope, { itemIds: [ITEM_ID], mode: 'undo' });
    expect(undoPreview.removedCells).toHaveLength(1);
    const input = {
      catalogSnapshotId: RELEASE.id,
      idempotencyKey: 'undo-1',
      itemIds: [ITEM_ID],
      previewToken: undoPreview.token,
    };
    calls.length = 0;
    faults.remaining = 1;
    const failed = yield* Effect.flip(commands.undo(scope, input));
    expect(failed.code).toBe('access_changes_command_unavailable');
    const retried = yield* commands.undo(scope, input);
    expect(retried.decisionIds).toHaveLength(1);
    expect(calls).toEqual(['store:record', 'reconcile', 'reconcile']);
  }),
);

it.effect('a replay of a healthy adoption reconciles again and records nothing new', () =>
  Effect.gen(function* healthyReplayReconciles() {
    yield* TestClock.setTime(instant(6).getTime());
    const { calls, commands } = harness();
    const { token } = yield* commands.preview(scope, { itemIds: [ITEM_ID], mode: 'adopt' });
    const first = yield* commands.adopt(scope, adoptInput(token));
    const replayed = yield* commands.adopt(scope, adoptInput(token));
    expect(replayed.decisionIds).toEqual(first.decisionIds);
    expect(calls).toEqual(['store:record', 'reconcile', 'reconcile']);
  }),
);
