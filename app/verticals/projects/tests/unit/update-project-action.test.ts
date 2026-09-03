/* eslint-disable no-await-in-loop -- Matrix cases intentionally execute independently for clearer failure attribution. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { Cause, Effect, Exit, Option, Schema } from 'effect';
import type { Project } from '../../src/domain/project.ts';
import {
  ProjectOwnerIneligible,
  UpdateProjectPayloadSchema,
  makeUpdateProjectHandler,
  updateProjectAction,
} from '../../src/actions/update-project.action.ts';

const projectId = randomUUID();
const originalOwner = randomUUID();
const replacementOwner = randomUUID();
const original: Project = {
  createdAt: '2026-08-31T10:00:00.000Z',
  createdByPrincipalId: randomUUID(),
  lifecycleState: 'active',
  name: 'Original',
  ownerPrincipalId: originalOwner,
  parentProjectId: randomUUID(),
  prefix: 'ONTO',
  projectId,
  shortText: 'Original text',
  tenantId: randomUUID(),
};

const fixture = (
  overrides: {
    readonly archived?: boolean;
    readonly eligibility?: 'eligible' | 'ineligible' | 'unavailable';
  } = {},
) => {
  const updates: unknown[] = [];
  const current = {
    ...original,
    lifecycleState: overrides.archived ? ('archived' as const) : ('active' as const),
  };
  const handler = makeUpdateProjectHandler({
    findForLifecycleGuard: () => Effect.succeed({ _tag: 'found' as const, value: current }),
    ownerEligibility: () => Effect.succeed(overrides.eligibility ?? 'eligible'),
    update: (values) => {
      updates.push(values);
      return Effect.succeed({
        ...current,
        name: values.name,
        ownerPrincipalId: values.owner.principalId,
        shortText: values.shortText,
      });
    },
  });
  return { handler, updates };
};

test('defines an exact partial-update contract and required Action governance', () => {
  const decode = Schema.decodeUnknownSync(UpdateProjectPayloadSchema, {
    onExcessProperty: 'error',
  });
  assert.deepEqual(decode({ name: 'Renamed', projectId }), { name: 'Renamed', projectId });
  assert.deepEqual(decode({ projectId, shortText: null }), { projectId, shortText: null });
  assert.throws(() => decode({ projectId }));
  assert.throws(() => decode({ name: '   ', projectId }));
  assert.throws(() => decode({ projectId, shortText: '😀'.repeat(256) }));
  assert.throws(() => decode({ prefix: 'NEW', projectId }));
  assert.equal(updateProjectAction.descriptor.actionKey, 'projects.core.update-project');
  assert.equal(updateProjectAction.descriptor.idempotency, 'required');
  assert.equal(updateProjectAction.descriptor.legalEntityScope, 'optional');
  assert.equal(updateProjectAction.descriptor.accessEvidencePolicy.captureMode, 'metadata_only');
});

test('updates each editable field independently while preserving omitted and immutable values', async () => {
  for (const [patch, expected] of [
    [{ name: 'Renamed' }, { name: 'Renamed', owner: originalOwner, shortText: 'Original text' }],
    [
      { ownerPrincipalId: replacementOwner },
      { name: 'Original', owner: replacementOwner, shortText: 'Original text' },
    ],
    [
      { shortText: 'Replacement' },
      { name: 'Original', owner: originalOwner, shortText: 'Replacement' },
    ],
    [{ shortText: null }, { name: 'Original', owner: originalOwner, shortText: null }],
  ] as const) {
    const { handler } = fixture();
    const updated = await Effect.runPromise(handler({ projectId, ...patch }));
    assert.equal(updated.name, expected.name);
    assert.equal(updated.ownerPrincipalId, expected.owner);
    assert.equal(updated.shortText, expected.shortText);
    assert.equal(updated.prefix, original.prefix);
    assert.equal(updated.createdAt, original.createdAt);
    assert.equal(updated.createdByPrincipalId, original.createdByPrincipalId);
    assert.equal(updated.parentProjectId, original.parentProjectId);
  }
});

test('fails closed for an ineligible or unverifiable Owner without writing', async () => {
  for (const eligibility of ['ineligible', 'unavailable'] as const) {
    const { handler, updates } = fixture({ eligibility });
    const exit = await Effect.runPromiseExit(
      handler({ ownerPrincipalId: replacementOwner, projectId }),
    );
    assert.equal(Exit.isFailure(exit), true);
    if (Exit.isFailure(exit)) {
      const failure = Cause.findErrorOption(exit.cause);
      assert.equal(Option.isSome(failure) && failure.value instanceof ProjectOwnerIneligible, true);
    }
    assert.equal(updates.length, 0);
  }
});

test('blocks archived Projects atomically before Owner checks or persistence updates', async () => {
  const { handler, updates } = fixture({ archived: true });
  const exit = await Effect.runPromiseExit(handler({ name: 'Forbidden', projectId }));
  assert.equal(Exit.isFailure(exit), true);
  if (Exit.isFailure(exit)) {
    assert.match(String(exit.cause), /ProjectLifecycleConflict/u);
  }
  assert.equal(updates.length, 0);
});
