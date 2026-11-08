import { Effect, Option, Result, Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import { UpdateProjectPayloadSchema } from '../../shared/actions/update-project.ts';
import { makeUpdateProjectHandler } from '../../src/actions/update-project.action.ts';
import { projectFixture, projectId } from '../support/project.ts';

it.effect('updates Name independently while preserving Prefix, Owner, hierarchy, and creation metadata', () =>
  Effect.gen(function* updateIndependentField() {
    const original = yield* projectFixture;
    const written: unknown[] = [];
    const updated = yield* makeUpdateProjectHandler({
      findForLifecycleGuard: () => Effect.succeed({ _tag: 'found', value: original }),
      update: (values) => {
        written.push(values);
        return Effect.succeed({ ...original, name: values.name, shortText: Option.fromNullOr(values.shortText) });
      },
    })({ name: 'Renamed', projectId });
    expect(updated).toEqual({ ...original, name: 'Renamed' });
    // Reassignment is a separate capability (O10, R5c-1): an update never receives the owner at all.
    expect(written).toEqual([{ name: 'Renamed', projectId, shortText: Option.getOrNull(original.shortText) }]);
    expect(updated.ownerPrincipalId).toBe(original.ownerPrincipalId);
  }),
);
// R5c-1 negative control: the payload cannot even express an owner change, so a caller holding only
// `projects.core.project.update` has no path to transfer a Project to somebody else.
it('cannot express an owner change at all', () => {
  const fields = Object.keys(UpdateProjectPayloadSchema.fields);
  expect(fields).toHaveLength(3);
  expect(fields).toContain('name');
  expect(fields).toContain('projectId');
  expect(fields).toContain('shortText');
  expect(fields).not.toContain('ownerPrincipalId');
});
it.effect('removes Short text explicitly and preserves omitted Name', () =>
  Effect.gen(function* removeShortText() {
    const original = yield* projectFixture;
    const updated = yield* makeUpdateProjectHandler({
      findForLifecycleGuard: () => Effect.succeed({ _tag: 'found', value: original }),
      update: (values) =>
        Effect.succeed({ ...original, name: values.name, shortText: Option.fromNullOr(values.shortText) }),
    })({ projectId, shortText: Option.none() });
    expect(Option.isNone(updated.shortText)).toBe(true);
    expect(updated.name).toBe(original.name);
  }),
);
it.effect('rejects trusted immutable metadata and Prefix in an Update payload', () =>
  Effect.gen(function* rejectImmutableFields() {
    const result = yield* Schema.decodeUnknownEffect(UpdateProjectPayloadSchema, { onExcessProperty: 'error' })({
      createdByPrincipalId: projectId,
      prefix: 'NEW',
      projectId,
    }).pipe(Effect.result);
    expect(Result.isFailure(result)).toBe(true);
  }),
);
