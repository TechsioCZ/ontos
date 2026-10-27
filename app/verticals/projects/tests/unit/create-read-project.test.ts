import { Effect, Option, Schema } from 'effect';
import { NodeCrypto } from '@effect/platform-node';
import { ContextAccess, ReadHandlerNotFound, ReadHandlerUnavailable, ReadPermissionDenied } from '@app/core-runtime';
import type { ContextAccessService } from '@app/core-runtime';
import { makeReadTestHarness } from '@app/core-runtime/testing/reads';
import { expect, it } from 'effect-rstest';
import { CreateProjectPayloadSchema } from '../../shared/actions/create-project.ts';
import { ProjectPersistenceUnavailable } from '../../shared/domain/project-persistence-unavailable.ts';
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

const readScope = {
  authBindingId: '40000000-0000-4000-8000-000000000001',
  authContextRef: 'better-auth-session:projects-read',
  authMethod: 'session',
  correlationId: 'projects-read',
  principalId: creatorId,
  tenantId,
} as const;
const operationTime = new Date('2026-10-27T00:00:00.000Z');
const readTransport = { correlationId: readScope.correlationId };
const candidateAccess = (tenantResources: ContextAccessService['tenantResources']): ContextAccessService => ({
  legalEntities: () => Effect.succeed([]),
  modules: () => Effect.succeed([]),
  resources: () => Effect.succeed([]),
  tenantResources,
  tenants: () => Effect.succeed([]),
});

it('preserves tenant access, optional legal entity scope and metadata-only evidence for both reads', () => {
  for (const registration of [readProjectRead, projectOwnerCandidatesRead]) {
    expect(registration.descriptor).toMatchObject({
      entrypoint: { authorization: { kind: 'authenticated_principal' }, scope: 'tenant' },
      evidencePolicy: {
        captureMode: 'metadata_only',
        policyKey: `${registration.descriptor.readKey}.evidence.v1`,
      },
      legalEntityScope: 'optional',
      owningModuleKey: 'projects.core',
      permissionTarget: 'tenant',
      policies: [],
    });
  }
});

it.layer(NodeCrypto.layer)('Projects governed reads', (test) => {
  test.effect('runs the Project load pipeline with scoped persistence and commits read evidence', () =>
    Effect.gen(function* governedProjectRead() {
      const project = yield* projectFixture;
      const encoded = yield* Schema.encodeEffect(readProjectRead.descriptor.resultSchema)(project);
      const harness = yield* makeReadTestHarness({
        executeOwnerQuery: ({ params, scope, sql }) => {
          expect(scope).toEqual({ legalEntityId: '', tenantId });
          expect(sql).toContain('from "projects"."projects"');
          expect(params).toContain(tenantId);
          expect(params).toContain(projectId);
          return Effect.succeed([{ ...encoded, updatedAt: encoded.createdAt }]);
        },
        operationTime,
        ownerAuthorizationDecision: 'allowed',
        permissionDecision: 'allowed',
        scope: readScope,
      });
      const result = yield* harness.runtime
        .runRead({
          input: { projectId },
          principal: readScope,
          registration: readProjectRead,
          transport: readTransport,
        })
        .pipe(Effect.provide(harness.layer));
      expect(result).toEqual(project);
      expect(harness.snapshot().ownerQueries).toHaveLength(1);
      expect(harness.snapshot().evidenceWrites).toBe(1);
      expect(harness.snapshot().stages).toContain('evidence_persisted');
    }),
  );

  test.effect('denies both reads before constructing owner services or querying owner data', () =>
    Effect.gen(function* deniedProjectReads() {
      const harness = yield* makeReadTestHarness({
        executeOwnerQuery: () => Effect.die('Denied reads must not query owner data'),
        operationTime,
        permissionDecision: 'denied',
        scope: readScope,
      });
      const projectFailure = yield* harness.runtime
        .runRead({
          input: { projectId },
          principal: readScope,
          registration: readProjectRead,
          transport: readTransport,
        })
        .pipe(Effect.provide(harness.layer), Effect.flip);
      const candidatesFailure = yield* harness.runtime
        .runRead({
          input: { prefix: 'ONTO', query: '' },
          principal: readScope,
          registration: projectOwnerCandidatesRead,
          transport: readTransport,
        })
        .pipe(Effect.provide(harness.layer), Effect.flip);
      expect(Schema.is(ReadPermissionDenied)(projectFailure)).toBe(true);
      expect(Schema.is(ReadPermissionDenied)(candidatesFailure)).toBe(true);
      expect(harness.snapshot().ownerQueries).toEqual([]);
      expect(harness.snapshot().stages).not.toContain('handler_executed');
    }),
  );

  test.effect('keeps missing and foreign-tenant Projects indistinguishable and persistence failures unavailable', () =>
    Effect.gen(function* projectReadFailures() {
      const project = yield* projectFixture;
      const missing = yield* makeReadProjectHandler(
        { find: () => Effect.succeed({ _tag: 'not_found' }) },
        tenantId,
      )(projectId).pipe(Effect.flip);
      const foreign = yield* makeReadProjectHandler(
        { find: () => Effect.succeed({ _tag: 'found', value: { ...project, tenantId: 'foreign-tenant' } }) },
        tenantId,
      )(projectId).pipe(Effect.flip);
      const unavailable = yield* makeReadProjectHandler(
        {
          find: () =>
            Effect.fail(
              new ProjectPersistenceUnavailable({
                code: 'project_persistence_unavailable',
                reason: 'Private persistence diagnostic',
              }),
            ),
        },
        tenantId,
      )(projectId).pipe(Effect.flip);
      expect(Schema.is(ReadHandlerNotFound)(missing)).toBe(true);
      expect(foreign).toEqual(missing);
      expect(Schema.is(ReadHandlerUnavailable)(unavailable)).toBe(true);
      expect(unavailable.reason).toBe('Project persistence is unavailable');
    }),
  );

  test.effect('loads eligible human Owners and checks assign permission for the exact normalized Project prefix', () =>
    Effect.gen(function* governedCandidatesRead() {
      const harness = yield* makeReadTestHarness({
        executeOwnerQuery: ({ params, scope, sql }) => {
          expect(scope).toEqual({ legalEntityId: '', tenantId });
          expect(sql).toContain('from "core"."principals"');
          expect(params).toContain(tenantId);
          expect(params).toContain('active');
          expect(params).toContain('human');
          expect(params).toContain('%Owner%');
          return Effect.succeed([
            { displayName: 'Allowed Owner', principalId: ownerId },
            { displayName: 'Denied Owner', principalId: creatorId },
          ]);
        },
        operationTime,
        ownerAuthorizationDecision: 'allowed',
        permissionDecision: 'allowed',
        scope: readScope,
      });
      const checkedPrincipals: string[] = [];
      const result = yield* harness.runtime
        .runRead({
          input: { prefix: 'onto', query: 'Owner' },
          principal: readScope,
          registration: projectOwnerCandidatesRead,
          transport: readTransport,
        })
        .pipe(
          Effect.provideService(
            ContextAccess,
            candidateAccess(({ permission, principalId, resources, tenantId: checkedTenantId }) => {
              expect(permission).toBe('assign');
              expect(checkedTenantId).toBe(tenantId);
              expect(resources).toEqual([
                { moduleId: 'projects.core', resourceId: 'ONTO', resourceType: 'projects.project-owner-eligibility' },
              ]);
              checkedPrincipals.push(principalId);
              return Effect.succeed([
                {
                  decision: principalId === ownerId ? 'allowed' : 'denied',
                  key: 'projects.core:projects.project-owner-eligibility:ONTO',
                },
              ]);
            }),
          ),
          Effect.provide(harness.layer),
        );
      expect(result.candidates).toEqual([{ displayName: 'Allowed Owner', principalId: ownerId }]);
      expect(checkedPrincipals).toHaveLength(2);
      expect(checkedPrincipals).toEqual(expect.arrayContaining([creatorId, ownerId]));
      expect(harness.snapshot().evidenceWrites).toBe(1);
      expect(harness.snapshot().stages).toContain('evidence_persisted');
    }),
  );

  test.effect('fails the complete candidate read closed on unavailable or mismatched assignment evidence', () =>
    Effect.gen(function* unavailableCandidatesRead() {
      for (const key of ['projects.core:projects.project-owner-eligibility:ONTO', 'wrong-project']) {
        const harness = yield* makeReadTestHarness({
          executeOwnerQuery: () => Effect.succeed([{ displayName: 'Owner', principalId: ownerId }]),
          operationTime,
          ownerAuthorizationDecision: 'allowed',
          permissionDecision: 'allowed',
          scope: readScope,
        });
        const failure = yield* harness.runtime
          .runRead({
            input: { prefix: 'ONTO', query: '' },
            principal: readScope,
            registration: projectOwnerCandidatesRead,
            transport: readTransport,
          })
          .pipe(
            Effect.provideService(
              ContextAccess,
              candidateAccess(() =>
                Effect.succeed([{ decision: key === 'wrong-project' ? 'allowed' : 'unavailable', key }]),
              ),
            ),
            Effect.provide(harness.layer),
            Effect.flip,
          );
        expect(Schema.is(ReadHandlerUnavailable)(failure)).toBe(true);
        expect(harness.snapshot().evidenceWrites).toBe(0);
        expect(harness.snapshot().stages).not.toContain('evidence_persisted');
      }
    }),
  );
});
