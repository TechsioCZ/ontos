import { Effect, Option, Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import { CreateProjectPayloadSchema } from '../../shared/actions/create-project.ts';
import { ProjectOwnerNotEligible, makeCreateProjectHandler } from '../../src/actions/create-project.action.ts';
import { makeReadProjectHandler } from '../../src/api/read-project.read.ts';
import { creatorId, ownerId, projectFixture, projectId, tenantId } from '../support/project.ts';

it.effect('creates without optional text/hierarchy and uses the trusted creator independently of Owner', () =>
  Effect.gen(function* createOptionalFields() {
    const payload = yield* Schema.decodeUnknownEffect(CreateProjectPayloadSchema)({
      name: 'Project',
      ownerPrincipalId: ownerId,
      prefix: 'onto',
    });
    const project = yield* projectFixture;
    let recordedCreator = '';
    const result = yield* makeCreateProjectHandler(
      {
        create: (_input, creator) => {
          recordedCreator = creator;
          return Effect.succeed(project);
        },
        ownerEligibility: () => Effect.succeed('allowed'),
      },
      creatorId,
    )(payload);
    expect(recordedCreator).toBe(creatorId);
    expect(result.ownerPrincipalId).toBe(ownerId);
    expect(payload.shortText).toBeUndefined();
  }),
);
it.effect('rejects an unauthorized Owner before performing a write', () =>
  Effect.gen(function* rejectOwner() {
    const project = yield* projectFixture;
    let writes = 0;
    const payload = yield* Schema.decodeUnknownEffect(CreateProjectPayloadSchema)({
      name: 'Project',
      ownerPrincipalId: ownerId,
      prefix: 'ONTO',
    });
    const failure = yield* makeCreateProjectHandler(
      {
        create: () => {
          writes += 1;
          return Effect.succeed(project);
        },
        ownerEligibility: () => Effect.succeed('denied'),
      },
      creatorId,
    )(payload).pipe(Effect.flip);
    expect(Schema.is(ProjectOwnerNotEligible)(failure)).toBe(true);
    expect(writes).toBe(0);
  }),
);
it.effect('returns a governed same-tenant Project even when creator differs from Owner', () =>
  Effect.gen(function* readNonOwner() {
    const project = yield* projectFixture;
    const result = yield* makeReadProjectHandler(
      { find: () => Effect.succeed({ _tag: 'found', value: project }) },
      tenantId,
    )(projectId);
    expect(result.ownerPrincipalId).not.toBe(creatorId);
    expect(Option.getOrNull(result.shortText)).toBe('Original');
  }),
);
