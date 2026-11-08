import { Effect, Option, Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import { CreateProjectPayloadSchema } from '../../shared/actions/create-project.ts';
import { ProjectOwnerNotEligible, makeCreateProjectHandler } from '../../src/actions/create-project.action.ts';
import { projectOwnerCandidatesRead } from '../../src/api/project-owner-candidates.read.ts';
import { makeReadProjectHandler, readProjectRead } from '../../src/api/read-project.read.ts';
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

it('classifies both governed reads as v2 protected and declares their sensitive field classes (O83, O58)', () => {
  // R5c-4/O83: a tenant member without a project role must not enumerate identity candidates or read
  // any Project, so both reads are decided by the one access gate and never by tenant membership.
  expect(readProjectRead.descriptor.entrypoint.authorization).toEqual({ kind: 'protected' });
  expect(readProjectRead.descriptor.accessDeclaration?.key).toBe('projects.core.project.read');
  // O83: scope-wide in tenant context, so it names no record and carries no accessTarget.
  expect(readProjectRead.descriptor.accessDeclaration?.selectors).toEqual([]);
  expect(readProjectRead.descriptor.accessTarget).toBeUndefined();
  expect(readProjectRead.descriptor.legalEntityScope).toBe('optional');
  expect(
    readProjectRead.descriptor.accessFieldGroups?.map((group) => [group.key, group.fieldClass, group.fields]),
  ).toEqual([
    ['projects.core.project.authority.read', 'authority_metadata', ['createdByPrincipalId', 'ownerPrincipalId']],
  ]);

  expect(projectOwnerCandidatesRead.descriptor.entrypoint.authorization).toEqual({ kind: 'protected' });
  expect(projectOwnerCandidatesRead.descriptor.accessDeclaration?.key).toBe(
    'projects.core.project.owner-candidates.read',
  );
  // A candidate search has no single record; its field class rides its own scope-wide declaration (O74).
  expect(projectOwnerCandidatesRead.descriptor.accessDeclaration?.selectors).toEqual([]);
  expect(
    projectOwnerCandidatesRead.descriptor.accessFieldGroups?.map((group) => [
      group.key,
      group.fieldClass,
      group.fields,
    ]),
  ).toEqual([['projects.core.project.owner-candidates.personal.read', 'personal_data', ['candidates.displayName']]]);
});

it.effect('names exactly the sensitive result fields, and nothing else (R5c, O58, O83)', () =>
  Effect.gen(function* declaredFields() {
    const project = yield* projectFixture;
    // The governed fields are the owner and the creator, and the result really carries them.
    expect(project.ownerPrincipalId).toBeDefined();
    expect(project.createdByPrincipalId).toBeDefined();
    expect((readProjectRead.descriptor.accessFieldGroups ?? []).flatMap((group) => group.fields)).toEqual([
      'createdByPrincipalId',
      'ownerPrincipalId',
    ]);
    expect((projectOwnerCandidatesRead.descriptor.accessFieldGroups ?? []).flatMap((group) => group.fields)).toEqual([
      'candidates.displayName',
    ]);
    // The opaque principal id is not part of the personal_data group (O2): only the name is.
    expect(
      (projectOwnerCandidatesRead.descriptor.accessFieldGroups ?? []).flatMap((group) => group.fields),
    ).not.toContain('candidates.principalId');
  }),
);
