import { Effect, Option, Result, Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import { UpdateProjectPayloadSchema } from '../../shared/actions/update-project.ts';
import { makeUpdateProjectHandler } from '../../src/actions/update-project.action.ts';
import { projectFixture, projectId } from '../support/project.ts';

it.effect('updates Name independently while preserving Prefix, Owner, hierarchy, and creation metadata', () =>
  Effect.gen(function* updateIndependentField() {
    const original = yield* projectFixture;
    const updated = yield* makeUpdateProjectHandler({
      findForLifecycleGuard: () => Effect.succeed({ _tag: 'found', value: original }),
      ownerEligibility: () => Effect.succeed('denied'),
      update: (values) =>
        Effect.succeed({
          ...original,
          name: values.name,
          ownerPrincipalId: values.owner.principalId,
          shortText: Option.fromNullOr(values.shortText),
        }),
    })({ name: 'Renamed', projectId });
    expect(updated).toEqual({ ...original, name: 'Renamed' });
  }),
);
it.effect('removes Short text explicitly and preserves omitted Name', () =>
  Effect.gen(function* removeShortText() {
    const original = yield* projectFixture;
    const updated = yield* makeUpdateProjectHandler({
      findForLifecycleGuard: () => Effect.succeed({ _tag: 'found', value: original }),
      ownerEligibility: () => Effect.succeed('denied'),
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
