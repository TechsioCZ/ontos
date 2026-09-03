/* eslint-disable curly, no-await-in-loop -- Table-driven Effect assertions are intentionally sequential and compact. */
// oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- Test-only collector stubs use opaque runtime references.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { Cause, Effect, Exit, Option, Schema } from 'effect';
import {
  CreateProjectPayloadSchema,
  ProjectOwnerEligibilityUnavailable,
  ProjectOwnerNotEligible,
  createProjectAction,
  handleCreateProject,
  makeCreateProjectHandler,
} from '../../src/actions/create-project.action.ts';
import type { Project } from '../../src/domain/project.ts';
import { makeReadProjectHandler, readProjectRead } from '../../src/api/read-project.read.ts';
import {
  ReadProjectAuthenticationProblemSchema,
  ReadProjectForbiddenProblemSchema,
  ReadProjectInternalProblemSchema,
  ReadProjectInvalidProblemSchema,
  ReadProjectNotFoundProblemSchema,
  ReadProjectPolicyConflictProblemSchema,
  ReadProjectPolicyProblemSchema,
  ReadProjectUnavailableProblemSchema,
  ReadProjectRequestSchema,
} from '../../shared/apis/read-project.ts';
import {
  ProjectsReadinessSchema,
  projectsApiContract,
  projectsOperationContexts,
} from '../../shared/api.ts';
import { projectsCorsAllowedHeaders, projectsCorsAllowedOrigins } from '../../shared/cors.ts';

const tenantId = randomUUID();
const ownerPrincipalId = randomUUID();
const creatorPrincipalId = randomUUID();
const project: Project = {
  createdAt: '2026-08-31T10:00:00.000Z',
  createdByPrincipalId: creatorPrincipalId,
  lifecycleState: 'active',
  name: 'OntOS',
  ownerPrincipalId,
  parentProjectId: null,
  prefix: 'ONTO',
  projectId: randomUUID(),
  shortText: 'Governed projects',
  tenantId,
};
const payload = {
  name: 'OntOS',
  ownerPrincipalId,
  parentProjectId: null,
  prefix: 'onto',
  shortText: 'Governed projects',
} as const;

test('defines strict Create and governed Read contracts without trusted metadata inputs', () => {
  const decode = Schema.decodeUnknownSync(CreateProjectPayloadSchema, {
    onExcessProperty: 'error',
  });
  assert.deepEqual(decode(payload), payload);
  for (const invalid of [
    { ...payload, prefix: 'A' },
    { ...payload, name: '  ' },
    { ...payload, ownerPrincipalId: 'free text' },
    { ...payload, shortText: '😀'.repeat(256) },
    { ...payload, createdAt: project.createdAt },
    { ...payload, tenantId },
  ])
    assert.throws(() => decode(invalid));
  assert.deepEqual(
    Schema.decodeUnknownSync(ReadProjectRequestSchema)({ projectId: project.projectId }),
    { projectId: project.projectId },
  );
  assert.equal(createProjectAction.descriptor.idempotency, 'required');
  assert.equal(createProjectAction.descriptor.legalEntityScope, 'optional');
  assert.deepEqual(Object.keys(createProjectAction.descriptor.domainEvents), [
    'projects.project.created.v1',
  ]);
  assert.equal(readProjectRead.descriptor.accessKind, 'detail');
  assert.equal(readProjectRead.descriptor.permissionTarget, 'tenant');
  assert.equal(readProjectRead.descriptor.legalEntityScope, 'optional');
});

test('declares exhaustive typed HTTP Problem Details status mappings', () => {
  for (const [schema, tag, status] of [
    [ReadProjectInvalidProblemSchema, 'ReadProjectInvalidProblem', 400],
    [ReadProjectAuthenticationProblemSchema, 'ReadProjectAuthenticationProblem', 401],
    [ReadProjectForbiddenProblemSchema, 'ReadProjectForbiddenProblem', 403],
    [ReadProjectNotFoundProblemSchema, 'ReadProjectNotFoundProblem', 404],
    [ReadProjectPolicyConflictProblemSchema, 'ReadProjectPolicyConflictProblem', 409],
    [ReadProjectPolicyProblemSchema, 'ReadProjectPolicyProblem', 422],
    [ReadProjectInternalProblemSchema, 'ReadProjectInternalProblem', 500],
  ] as const)
    assert.equal(
      Schema.is(schema)({ _tag: tag, detail: 'x', status, title: 'x', type: 'x' }),
      true,
    );
  assert.equal(
    Schema.is(ReadProjectUnavailableProblemSchema)({
      _tag: 'ReadProjectUnavailableProblem',
      detail: 'x',
      retryable: true,
      status: 503,
      title: 'x',
      type: 'x',
    }),
    true,
  );
  assert.equal(
    createProjectAction.descriptor.accessEvidencePolicy.policyKey,
    'projects.core.create-project.access.v1',
  );
  assert.equal(
    readProjectRead.descriptor.evidencePolicy.policyKey,
    'projects.core.api.read-project.evidence.v1',
  );
});

test('publishes the deployable BFF paths, readiness contract, and browser headers', () => {
  assert.equal(projectsApiContract.apiPrefix, '/projects-api');
  assert.equal(projectsApiContract.readinessPath, '/projects-api/projects/readiness');
  assert.equal(projectsOperationContexts.readProject.routePath, '/reads/read-project');
  assert.equal(projectsOperationContexts.createProject.routePath, '/projects/create');
  assert.equal(Schema.is(ProjectsReadinessSchema)({ appId: 'projects', status: 'ready' }), true);
  assert.ok(projectsCorsAllowedHeaders.includes('Authorization'));
  assert.ok(projectsCorsAllowedHeaders.includes('Idempotency-Key'));
  assert.deepEqual(projectsCorsAllowedOrigins('http://localhost:3020'), [
    'http://localhost:3020',
    'http://127.0.0.1:3020',
  ]);
});

test('emits durable domain and Data Access evidence with trusted actor metadata', async () => {
  const events: unknown[] = [];
  const accesses: unknown[] = [];
  const result = await Effect.runPromise(
    handleCreateProject(payload, {
      actionInvocationId: randomUUID(),
      addDomainEvent: (event) => {
        events.push(event);
        return Effect.succeed({} as never);
      },
      addOutboxMessage: () => Effect.void,
      recordAuditEvidence: () => Effect.void,
      recordDataAccess: (event) => {
        accesses.push(event);
        return Effect.void;
      },
      scope: { principalId: creatorPrincipalId, tenantId } as never,
      services: {
        create: (_input, createdBy) =>
          Effect.succeed({ ...project, createdByPrincipalId: createdBy }),
        ownerEligibility: () => Effect.succeed('allowed'),
      },
    }),
  );
  assert.equal(result.createdByPrincipalId, creatorPrincipalId);
  assert.equal(accesses.length, 1);
  assert.match(JSON.stringify(accesses[0]), /projects-owner-eligibility/u);
  assert.equal(events.length, 1);
  assert.match(JSON.stringify(events[0]), /projects\.project\.created\.v1/u);
});

test('creates only after Owner eligibility and passes trusted creator metadata', async () => {
  const calls: unknown[] = [];
  const result = await Effect.runPromise(
    makeCreateProjectHandler(
      {
        create: (input, createdBy) => {
          calls.push({ createdBy, input });
          return Effect.succeed(project);
        },
        ownerEligibility: () => Effect.succeed('allowed'),
      },
      creatorPrincipalId,
    )(payload),
  );
  assert.equal(result, project);
  assert.deepEqual(calls, [{ createdBy: creatorPrincipalId, input: payload }]);
});

test('fails closed for denied and unavailable Owner eligibility without writing', async () => {
  for (const [decision, expected] of [
    ['denied', ProjectOwnerNotEligible],
    ['unavailable', ProjectOwnerEligibilityUnavailable],
  ] as const) {
    let writes = 0;
    const exit = await Effect.runPromiseExit(
      makeCreateProjectHandler(
        {
          create: () => {
            writes += 1;
            return Effect.succeed(project);
          },
          ownerEligibility: () => Effect.succeed(decision),
        },
        creatorPrincipalId,
      )(payload),
    );
    assert.equal(Exit.isFailure(exit), true);
    if (Exit.isFailure(exit)) {
      const error = Cause.findErrorOption(exit.cause);
      assert.equal(Option.isSome(error) && error.value instanceof expected, true);
    }
    assert.equal(writes, 0);
  }
});

test('returns only an owner-local tenant result and makes missing, foreign-tenant, and non-owner IDs indistinguishable', async () => {
  const read = makeReadProjectHandler(
    { find: () => Effect.succeed({ _tag: 'found', value: project }) },
    ownerPrincipalId,
    tenantId,
  );
  assert.equal(await Effect.runPromise(read(project.projectId)), project);
  const hiddenCases = [
    { _tag: 'not_found' as const },
    { _tag: 'found' as const, value: { ...project, tenantId: randomUUID() } },
    { _tag: 'found' as const, value: { ...project, ownerPrincipalId: randomUUID() } },
  ];
  for (const lookup of hiddenCases) {
    const exit = await Effect.runPromiseExit(
      makeReadProjectHandler(
        { find: () => Effect.succeed(lookup) },
        ownerPrincipalId,
        tenantId,
      )(project.projectId),
    );
    assert.equal(Exit.isFailure(exit), true);
    if (Exit.isFailure(exit)) assert.match(String(exit.cause), /ReadHandlerNotFound/u);
  }
});
