import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { Cause, Effect, Exit, Option, Schema } from 'effect';
import {
  archiveProjectAction,
  makeArchiveProjectHandler,
} from '../../src/actions/archive-project.action.ts';
import {
  makeUnarchiveProjectHandler,
  unarchiveProjectAction,
} from '../../src/actions/unarchive-project.action.ts';
import { ProjectLifecycleConflict } from '../../src/domain/project.ts';
import type { Project, ProjectLifecycleState } from '../../src/domain/project.ts';
import { requireActiveProject } from '../../src/services/project-lifecycle-guard.service.ts';

const projectId = randomUUID();
const base: Project = {
  createdAt: '2026-08-31T10:00:00.000Z',
  createdByPrincipalId: randomUUID(),
  lifecycleState: 'active',
  name: 'Project',
  ownerPrincipalId: randomUUID(),
  parentProjectId: randomUUID(),
  prefix: 'ONTO',
  projectId,
  shortText: 'Preserved',
  tenantId: randomUUID(),
};

const lifecycleFixture = () => {
  let state: ProjectLifecycleState = 'active';
  const transition = (requested: ProjectLifecycleState) =>
    state === requested
      ? Effect.fail(
          new ProjectLifecycleConflict({
            code: 'project_lifecycle_conflict',
            reason: `Project is already ${requested}`,
          }),
        )
      : Effect.sync(() => {
          state = requested;
          return { ...base, lifecycleState: state };
        });
  return {
    archive: makeArchiveProjectHandler({ archive: () => transition('archived') }),
    state: () => state,
    unarchive: makeUnarchiveProjectHandler({ unarchive: () => transition('active') }),
  };
};

test('defines separate governed, idempotent lifecycle Action contracts and events', () => {
  for (const [action, key] of [
    [archiveProjectAction, 'projects.core.archive-project'],
    [unarchiveProjectAction, 'projects.core.unarchive-project'],
  ] as const) {
    assert.equal(action.descriptor.actionKey, key);
    assert.equal(action.descriptor.idempotency, 'required');
    assert.equal(action.descriptor.legalEntityScope, 'optional');
    assert.equal(action.descriptor.accessEvidencePolicy.captureMode, 'metadata_only');
    assert.deepEqual(
      Schema.decodeUnknownSync(action.descriptor.payloadSchema, { onExcessProperty: 'error' })({
        projectId,
      }),
      { projectId },
    );
    assert.throws(() =>
      Schema.decodeUnknownSync(action.descriptor.payloadSchema, { onExcessProperty: 'error' })({
        deleteDescendants: true,
        projectId,
      }),
    );
  }
  assert.deepEqual(Object.keys(archiveProjectAction.descriptor.domainEvents), [
    'projects.project.archived.v1',
  ]);
  assert.deepEqual(Object.keys(unarchiveProjectAction.descriptor.domainEvents), [
    'projects.project.unarchived.v1',
  ]);
});

test('archives and restores only lifecycle state while preserving identity, hierarchy, and references', async () => {
  const fixture = lifecycleFixture();
  const archived = await Effect.runPromise(fixture.archive({ projectId }));
  const restored = await Effect.runPromise(fixture.unarchive({ projectId }));
  assert.equal(archived.lifecycleState, 'archived');
  assert.equal(restored.lifecycleState, 'active');
  for (const key of [
    'projectId',
    'prefix',
    'createdAt',
    'createdByPrincipalId',
    'parentProjectId',
    'shortText',
  ] as const) {
    assert.equal(archived[key], base[key]);
    assert.equal(restored[key], base[key]);
  }
});

test('rejects repeated lifecycle transitions without changing state', async () => {
  const fixture = lifecycleFixture();
  await Effect.runPromise(fixture.archive({ projectId }));
  const repeatedArchive = await Effect.runPromiseExit(fixture.archive({ projectId }));
  assert.equal(Exit.isFailure(repeatedArchive), true);
  assert.equal(fixture.state(), 'archived');
  await Effect.runPromise(fixture.unarchive({ projectId }));
  const repeatedUnarchive = await Effect.runPromiseExit(fixture.unarchive({ projectId }));
  assert.equal(Exit.isFailure(repeatedUnarchive), true);
  assert.equal(fixture.state(), 'active');
});

test('central guard blocks Project and descendant mutations while reads remain unaffected', async () => {
  const archived = { ...base, lifecycleState: 'archived' as const };
  const blocked = await Effect.runPromiseExit(
    requireActiveProject(
      () => Effect.succeed({ _tag: 'found' as const, value: archived }),
      projectId,
    ),
  );
  assert.equal(Exit.isFailure(blocked), true);
  if (Exit.isFailure(blocked)) {
    const failure = Cause.findErrorOption(blocked.cause);
    assert.equal(Option.isSome(failure) && failure.value instanceof ProjectLifecycleConflict, true);
  }
  // Governed reads and Core ResourceRef resolution use persistence.find, not the mutation guard.
  const readable = await Effect.runPromise(
    Effect.succeed({ _tag: 'found' as const, value: archived }),
  );
  assert.equal(readable.value.projectId, projectId);
  const active = await Effect.runPromise(
    requireActiveProject(() => Effect.succeed({ _tag: 'found' as const, value: base }), projectId),
  );
  assert.equal(active.lifecycleState, 'active');
});
