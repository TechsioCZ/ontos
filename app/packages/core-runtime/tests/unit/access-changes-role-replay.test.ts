import { Effect, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { AccessChangesStoreConflictError } from '../../src/access/changes/persistence/errors/conflict-error.ts';
import { storeConflict } from '../../src/access/changes/persistence/errors/index.ts';
import { isReplayedRole, isReplayedRoleRevision } from '../../src/access/changes/persistence/role-replay.ts';
import type { AccessChangesStoreService } from '../../src/access/changes/persistence/store.ts';
import { AccessChangesStore } from '../../src/access/changes/persistence/store.ts';
import type { RoleCreation } from '../../src/access/changes/role-revision.ts';
import { writeRoleCreation } from '../../src/access/changes/role-revision.ts';
import {
  AccessOperationIdSchema,
  AccessScopeIdSchema,
  CatalogSnapshotIdSchema,
  CommandDigestSchema,
  LegalEntityIdSchema,
  PrincipalIdSchema,
  RoleIdSchema,
  RoleRevisionIdSchema,
  TenantIdSchema,
} from '../../src/access/ids.ts';
import type { Role, RoleRevision } from '../../src/access/model.ts';
import { RoleRevisionSchema, RoleSchema } from '../../src/access/model.ts';
import { AccessProjectionWriter } from '../../src/access/intent/projection-writer.ts';
import type { TenantProjectionWrite } from '../../src/access/intent/projection-writer.ts';
import type { OperationalScope } from '../../src/operations/context.ts';
import {
  CATALOG,
  LEGAL_ENTITY,
  PERSON,
  ROLE,
  SCOPE,
  TENANT,
  cell,
  decodeWith,
  fixedId,
  instant,
} from './access-changes-fixtures.ts';

/*
 * A creation is retried with the IDs its idempotency key derives. The store must treat the identical
 * replay as already recorded (so reconciliation still runs) and refuse the same IDs with other content
 * as its typed conflict, never a raw key violation.
 */

const REVISION = fixedId(40);
const CREATED_AT = instant(9);
const RETRIED_AT = instant(10);

const roleOf = (overrides: Partial<Role> = {}): Role =>
  decodeWith('role', RoleSchema, {
    createdAt: CREATED_AT,
    createdBy: PERSON,
    id: ROLE,
    name: 'Accounts clerk',
    tenantId: TENANT,
    ...overrides,
  });

const revisionOf = (overrides: Partial<RoleRevision> = {}): RoleRevision =>
  decodeWith('role revision', RoleRevisionSchema, {
    catalogSnapshotId: CATALOG,
    cells: [cell('test.party.read')],
    createdAt: CREATED_AT,
    createdBy: PERSON,
    id: REVISION,
    provenance: 'manual',
    revision: 1,
    roleId: ROLE,
    tenantId: TENANT,
    ...overrides,
  });

it('treats the identical creation, written again at a later instant, as already recorded', () => {
  const stored = roleOf();
  const planned = roleOf({ createdAt: RETRIED_AT });
  expect(isReplayedRole(stored, planned)).toBe(true);
  const storedRevision = revisionOf();
  expect(isReplayedRoleRevision(storedRevision, revisionOf({ createdAt: RETRIED_AT }))).toBe(true);
});

it('treats a role with a different name, creator, legal entity or tenant as a different creation', () => {
  const stored = roleOf({ legalEntityId: LegalEntityIdSchema.make(LEGAL_ENTITY) });
  expect(isReplayedRole(stored, roleOf({ name: 'Accounts manager' }))).toBe(false);
  expect(isReplayedRole(stored, roleOf({ createdBy: PrincipalIdSchema.make(fixedId(5)) }))).toBe(false);
  expect(isReplayedRole(stored, roleOf())).toBe(false);
  expect(isReplayedRole(roleOf(), roleOf({ tenantId: TenantIdSchema.make(fixedId(11)) }))).toBe(false);
});

it('treats a revision with different cells, provenance or catalog release as a different creation', () => {
  const stored = revisionOf();
  expect(isReplayedRoleRevision(stored, revisionOf({ cells: [cell('test.party.note')] }))).toBe(false);
  expect(isReplayedRoleRevision(stored, revisionOf({ cells: [] }))).toBe(false);
  expect(isReplayedRoleRevision(stored, revisionOf({ provenance: 'imported' }))).toBe(false);
  expect(
    isReplayedRoleRevision(stored, revisionOf({ catalogSnapshotId: CatalogSnapshotIdSchema.make(fixedId(12)) })),
  ).toBe(false);
});

const scope: OperationalScope = Object.freeze({
  authBindingId: 'binding-1',
  authContextRef: 'session-1',
  authMethod: 'session' as const,
  correlationId: 'role-replay',
  principalId: PrincipalIdSchema.make(PERSON),
  tenantId: TenantIdSchema.make(TENANT),
});

const request: RoleCreation = {
  catalogSnapshotId: CatalogSnapshotIdSchema.make(CATALOG),
  cells: [],
  decidedAt: CREATED_AT,
  name: 'Accounts clerk',
  scope,
  targetRevisionId: RoleRevisionIdSchema.make(REVISION),
  targetRoleId: RoleIdSchema.make(ROLE),
};

const unusedStoreCall = () => Effect.die('the creation never calls this store method');

const storeService = (recordRole: AccessChangesStoreService['recordRole']): AccessChangesStoreService => ({
  loadPublishedCatalog: unusedStoreCall,
  loadTenantChanges: unusedStoreCall,
  publishCatalog: unusedStoreCall,
  recordAdoption: unusedStoreCall,
  recordChangeItems: unusedStoreCall,
  recordDecline: unusedStoreCall,
  recordRole,
  recordRoleRevision: unusedStoreCall,
  recordUndo: unusedStoreCall,
});

const projection: TenantProjectionWrite = {
  deletions: 0,
  digest: CommandDigestSchema.make('b'.repeat(64)),
  operationId: AccessOperationIdSchema.make(fixedId(90)),
  projectionToken: 'projected:2',
  resumed: true,
  scopeId: AccessScopeIdSchema.make(SCOPE),
  touches: 0,
  units: ['tenant'],
  verified: true,
};

it.effect('reconciles the tenant once the store accepts a replayed creation', () =>
  Effect.gen(function* replayReconciles() {
    const calls: string[] = [];
    const created = yield* writeRoleCreation(request).pipe(
      Effect.provideService(
        AccessChangesStore,
        storeService(() =>
          Effect.sync(() => {
            // The store finds the identical role and revision already recorded and returns without writing.
            calls.push('store:replay');
          }),
        ),
      ),
      Effect.provideService(AccessProjectionWriter, {
        reconcileTenant: (reconcile) =>
          Effect.sync(() => {
            calls.push(`reconcile:${reconcile.scope.tenantId}`);
            return projection;
          }),
      }),
    );
    expect(calls).toEqual(['store:replay', `reconcile:${TENANT}`]);
    expect(created.roleId).toBe(ROLE);
    expect(created.roleRevisionId).toBe(REVISION);
    expect(created.projection).toEqual(projection);
  }),
);

it.effect('surfaces the typed conflict of a same-ID creation with other content and never reconciles', () =>
  Effect.gen(function* conflictSkipsReconcile() {
    const calls: string[] = [];
    const failure = yield* writeRoleCreation({ ...request, name: 'Different name' }).pipe(
      Effect.flip,
      Effect.provideService(
        AccessChangesStore,
        storeService(() =>
          Effect.fail(storeConflict('access_changes_record_conflict', `role ${ROLE} is already recorded differently`)),
        ),
      ),
      Effect.provideService(AccessProjectionWriter, {
        reconcileTenant: () =>
          Effect.sync(() => {
            calls.push('reconcile');
            return projection;
          }),
      }),
    );
    expect(Schema.is(AccessChangesStoreConflictError)(failure)).toBe(true);
    expect(failure.code).toBe('access_changes_record_conflict');
    expect(calls).toEqual([]);
  }),
);
