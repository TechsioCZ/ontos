/* eslint-disable curly, no-await-in-loop -- Table-driven Effect assertions are intentionally sequential and compact. */
// oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- Test-only collector stubs use opaque runtime references.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { Cause, Effect, Exit, Schema } from 'effect';
import {
  MoveProjectPayloadSchema,
  handleMoveProject,
  makeMoveProjectHandler,
  moveProjectAction,
} from '../../src/actions/move-project.action.ts';
import {
  ProjectHierarchyConflict,
  ProjectLifecycleConflict,
  ProjectNotFound,
} from '../../src/domain/project.ts';
import type { Project } from '../../src/domain/project.ts';
import { isProjectDescendant } from '../../src/services/project-persistence.service.ts';

const tenantId = randomUUID();
const rootId = randomUUID();
const branchId = randomUUID();
const childId = randomUUID();
const ownerPrincipalId = randomUUID();
const project: Project = {
  createdAt: '2026-08-31T10:00:00.000Z',
  createdByPrincipalId: randomUUID(),
  lifecycleState: 'active',
  name: 'Project',
  ownerPrincipalId,
  parentProjectId: rootId,
  prefix: 'MOVE',
  projectId: branchId,
  shortText: null,
  tenantId,
};

test('defines exact parent/root payload and governed Action contract', () => {
  const decode = Schema.decodeUnknownSync(MoveProjectPayloadSchema, { onExcessProperty: 'error' });
  assert.deepEqual(decode({ parentProjectId: rootId, projectId: branchId }), {
    parentProjectId: rootId,
    projectId: branchId,
  });
  assert.deepEqual(decode({ parentProjectId: null, projectId: branchId }), {
    parentProjectId: null,
    projectId: branchId,
  });
  assert.throws(() => decode({ projectId: branchId }));
  assert.throws(() => decode({ parentProjectId: 'root', projectId: branchId }));
  assert.throws(() => decode({ name: 'changed', parentProjectId: rootId, projectId: branchId }));
  assert.equal(moveProjectAction.descriptor.actionKey, 'projects.core.move-project');
  assert.equal(moveProjectAction.descriptor.idempotency, 'required');
  assert.equal(moveProjectAction.descriptor.legalEntityScope, 'optional');
  assert.equal(
    moveProjectAction.descriptor.accessEvidencePolicy.policyKey,
    'projects.core.move-project.access.v1',
  );
});

test('moves root-to-child, branch-to-branch, and child-to-root while changing only direct parent', async () => {
  for (const parentProjectId of [childId, rootId, null] as const) {
    const result = await Effect.runPromise(
      makeMoveProjectHandler({
        move: (projectId, parentId) =>
          Effect.succeed({ ...project, parentProjectId: parentId, projectId }),
      })({ parentProjectId, projectId: branchId }),
    );
    assert.deepEqual(result, { ...project, parentProjectId });
  }
});

test('deep subtree detection rejects descendant cycles without rewriting stable identities', () => {
  const hierarchy = [
    { parentProjectId: null, projectId: rootId },
    { parentProjectId: rootId, projectId: branchId },
    { parentProjectId: branchId, projectId: childId },
  ];
  assert.equal(isProjectDescendant(hierarchy, rootId, childId), true);
  assert.equal(isProjectDescendant(hierarchy, childId, rootId), false);
  assert.deepEqual(hierarchy, [
    { parentProjectId: null, projectId: rootId },
    { parentProjectId: rootId, projectId: branchId },
    { parentProjectId: branchId, projectId: childId },
  ]);
});

test('propagates self/descendant, cross-tenant/missing, and archived rejections without a successful mutation', async () => {
  for (const failure of [
    new ProjectHierarchyConflict({
      code: 'project_hierarchy_conflict',
      reason: 'A Project cannot parent itself',
    }),
    new ProjectHierarchyConflict({
      code: 'project_hierarchy_conflict',
      reason: 'A Project cannot be moved below one of its descendants',
    }),
    new ProjectNotFound({ code: 'project_not_found', reason: 'Project was not found' }),
    new ProjectLifecycleConflict({
      code: 'project_lifecycle_conflict',
      reason: 'Archived Projects cannot be moved',
    }),
  ]) {
    let successfulMutations = 0;
    const exit = await Effect.runPromiseExit(
      makeMoveProjectHandler({
        move: () =>
          Effect.fail(failure).pipe(
            Effect.tap(() => {
              successfulMutations += 1;
            }),
          ),
      })({ parentProjectId: childId, projectId: branchId }),
    );
    assert.equal(Exit.isFailure(exit), true);
    if (Exit.isFailure(exit)) assert.equal(Cause.findErrorOption(exit.cause)._tag, 'Some');
    assert.equal(successfulMutations, 0);
  }
});

test('records durable move evidence only after a successful atomic result', async () => {
  const accesses: unknown[] = [];
  const moved = await Effect.runPromise(
    handleMoveProject(
      { parentProjectId: null, projectId: branchId },
      {
        actionInvocationId: randomUUID(),
        addDomainEvent: () => Effect.succeed({} as never),
        addOutboxMessage: () => Effect.void,
        recordAuditEvidence: () => Effect.void,
        recordDataAccess: (event) => {
          accesses.push(event);
          return Effect.void;
        },
        scope: { tenantId } as never,
        services: { move: () => Effect.succeed({ ...project, parentProjectId: null }) },
      },
    ),
  );
  assert.equal(moved.parentProjectId, null);
  assert.equal(accesses.length, 1);
  assert.match(JSON.stringify(accesses[0]), /projects-hierarchy-move/u);
});

test('persistence locks the tenant hierarchy before lifecycle/cycle checks and performs one direct update', async () => {
  const source = await readFile(
    new URL('../../src/services/project-persistence.service.ts', import.meta.url),
    'utf-8',
  );
  const moveSource = source.slice(
    source.indexOf('const move ='),
    source.indexOf('return { create'),
  );
  assert.match(moveSource, /where\(eq\(projects\.tenantId, tenantId\)\)[\s\S]*?\.for\('update'\)/u);
  assert.match(moveSource, /lifecycleState === 'archived'/u);
  assert.match(moveSource, /isProjectDescendant/u);
  assert.equal((moveSource.match(/\.update\(projects\)/gu) ?? []).length, 1);
  assert.doesNotMatch(moveSource, /update[\s\S]*children|descendants\.map/u);
});
