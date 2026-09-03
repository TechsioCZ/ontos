// @effect-diagnostics processEnv:off
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { drizzle } from 'drizzle-orm/node-postgres';
import { sql } from 'drizzle-orm';
import { Effect, Exit } from 'effect';
import { Pool } from 'pg';
import { projectsDatabaseSchema } from '../../src/db/schema.ts';
import { makeProjectPersistenceService } from '../../src/services/project-persistence.service.ts';

const adminUrl = process.env['DATABASE_ADMIN_URL']?.trim();
const runtimeUrl = process.env['DATABASE_URL']?.trim();
const enabled = adminUrl !== undefined && runtimeUrl !== undefined;

const createValues = (prefix: string, ownerPrincipalId: string, createdByPrincipalId: string) => ({
  createdByPrincipalId,
  name: `Project ${prefix}`,
  owner: { eligibilityChecked: true as const, principalId: ownerPrincipalId },
  parentProjectId: null,
  prefix,
  shortText: null,
});

test(
  'Projects persistence composes create/read/update/move/archive with tenant isolation and concurrency safety',
  { skip: enabled ? false : 'DATABASE_ADMIN_URL and DATABASE_URL are required' },
  async () => {
    assert.ok(adminUrl);
    assert.ok(runtimeUrl);
    const admin = new Pool({ connectionString: adminUrl });
    const runtime = new Pool({ connectionString: runtimeUrl });
    const db = drizzle({ client: runtime, schema: projectsDatabaseSchema });
    const tenantA = randomUUID();
    const tenantB = randomUUID();
    const owner = randomUUID();
    const creator = randomUUID();
    await admin.query('delete from projects.projects where tenant_id = any($1::uuid[])', [
      [tenantA, tenantB],
    ]);
    const scoped = <Value>(
      tenantId: string,
      operation: (
        service: ReturnType<typeof makeProjectPersistenceService>,
      ) => Effect.Effect<Value, unknown>,
    ) =>
      db.transaction(async (transaction) => {
        await transaction.execute(sql`select set_config('ontos.tenant_id', ${tenantId}, true)`);
        return Effect.runPromise(
          operation(
            makeProjectPersistenceService(transaction, { operationId: randomUUID(), tenantId }),
          ),
        );
      });
    try {
      const root = await scoped(tenantA, (service) =>
        service.create(createValues('ROOT', owner, creator)),
      );
      const branch = await scoped(tenantA, (service) =>
        service.create({
          ...createValues('BRAN', owner, creator),
          parentProjectId: root.projectId,
        }),
      );
      const leaf = await scoped(tenantA, (service) =>
        service.create({
          ...createValues('LEAF', owner, creator),
          parentProjectId: branch.projectId,
        }),
      );
      const foreign = await scoped(tenantB, (service) =>
        service.create(createValues('OTHR', owner, creator)),
      );

      const hidden = await scoped(tenantA, (service) => service.find(foreign.projectId));
      assert.deepEqual(hidden, { _tag: 'not_found' });
      const moved = await scoped(tenantA, (service) => service.move(branch.projectId, null));
      assert.equal(moved.parentProjectId, null);
      const stableLeaf = await scoped(tenantA, (service) => service.find(leaf.projectId));
      assert.equal(stableLeaf._tag, 'found');
      if (stableLeaf._tag === 'found') {
        assert.equal(stableLeaf.value.parentProjectId, branch.projectId);
        assert.equal(stableLeaf.value.projectId, leaf.projectId);
      }
      const cycle = await scoped(tenantA, (service) =>
        Effect.exit(service.move(branch.projectId, leaf.projectId)),
      );
      assert.equal(Exit.isFailure(cycle), true);

      const archived = await scoped(tenantA, (service) =>
        service.transitionLifecycle(branch.projectId, 'archived'),
      );
      assert.equal(archived.lifecycleState, 'archived');
      const blockedMove = await scoped(tenantA, (service) =>
        Effect.exit(service.move(branch.projectId, root.projectId)),
      );
      const blockedUpdate = await scoped(tenantA, (service) =>
        Effect.exit(
          service.update({
            name: 'Blocked',
            owner: { eligibilityChecked: true, principalId: owner },
            projectId: branch.projectId,
            shortText: null,
          }),
        ),
      );
      assert.equal(Exit.isFailure(blockedMove), true);
      assert.equal(Exit.isFailure(blockedUpdate), true);
      const restored = await scoped(tenantA, (service) =>
        service.transitionLifecycle(branch.projectId, 'active'),
      );
      assert.equal(restored.lifecycleState, 'active');
      assert.equal(restored.prefix, branch.prefix);
      assert.equal(restored.createdAt, branch.createdAt);
      assert.equal(restored.createdByPrincipalId, branch.createdByPrincipalId);

      const collision = await Promise.allSettled([
        scoped(tenantA, (service) => service.create(createValues('RACE', owner, creator))),
        scoped(tenantA, (service) => service.create(createValues('race', owner, creator))),
      ]);
      assert.equal(collision.filter((result) => result.status === 'fulfilled').length, 1);
      assert.equal(collision.filter((result) => result.status === 'rejected').length, 1);

      const first = await scoped(tenantA, (service) =>
        service.create(createValues('ONE', owner, creator)),
      );
      const second = await scoped(tenantA, (service) =>
        service.create(createValues('TWO', owner, creator)),
      );
      const conflictingMoves = await Promise.allSettled([
        scoped(tenantA, (service) => service.move(first.projectId, second.projectId)),
        scoped(tenantA, (service) => service.move(second.projectId, first.projectId)),
      ]);
      assert.equal(conflictingMoves.filter((result) => result.status === 'fulfilled').length, 1);
      const firstAfter = await scoped(tenantA, (service) => service.find(first.projectId));
      const secondAfter = await scoped(tenantA, (service) => service.find(second.projectId));
      assert.equal(firstAfter._tag, 'found');
      assert.equal(secondAfter._tag, 'found');
      if (firstAfter._tag === 'found' && secondAfter._tag === 'found') {
        assert.equal(
          firstAfter.value.parentProjectId === secondAfter.value.projectId &&
            secondAfter.value.parentProjectId === firstAfter.value.projectId,
          false,
        );
      }
    } finally {
      await admin.query('delete from projects.projects where tenant_id = any($1::uuid[])', [
        [tenantA, tenantB],
      ]);
      await Promise.all([admin.end(), runtime.end()]);
    }
  },
);
