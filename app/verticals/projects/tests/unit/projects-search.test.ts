import {
  ContextAccess,
  CoreSearchProjectionHitSchema,
  CoreSearchProjectionUnavailable,
  CoreSearchQueryRuntime,
  ReadHandlerUnavailable,
  ReadInputValidationError,
  ReadPermissionDenied,
  ReadPermissionUnavailable,
} from '@app/core-runtime';
import type { ContextAccessDecision, ContextAccessService, OperationalScope } from '@app/core-runtime';
import { makeReadTestHarness } from '@app/core-runtime/testing/reads';
import { NodeCrypto } from '@effect/platform-node';
import { Effect, Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import { ProjectsProviderRequestSchema, ProjectsProviderResponseSchema } from '../../shared/apis/projects-search.ts';
import { projectsRead } from '../../src/search/projects.provider.ts';
import type { ProjectSearchMetadata } from '../../src/services/project-search-projection.ts';
import { projectsManifest } from '../../vertical.manifest.ts';
import { creatorId, tenantId } from '../support/project.ts';

const companyId = '50000000-0000-4000-8000-000000000001';
const foreignTenantId = '10000000-0000-4000-8000-000000000002';
const operationTime = new Date('2026-11-03T00:00:00.000Z');
const readScope = {
  authBindingId: '40000000-0000-4000-8000-000000000001',
  authContextRef: 'better-auth-session:projects-search',
  authMethod: 'session',
  correlationId: 'projects-search',
  principalId: creatorId,
  tenantId,
} as const;
const input = { query: 'Current' };
const row = (index: number): ProjectSearchMetadata => ({
  lifecycleState: 'active',
  name: `Current Project ${index}`,
  prefix: `P${String.fromCodePoint(65 + Math.floor(index / 26))}${String.fromCodePoint(65 + (index % 26))}`,
  projectId: `30000000-0000-4000-8000-${index.toString(16).padStart(12, '0')}`,
  tenantId,
});
const decodeHits = (rows: readonly ProjectSearchMetadata[]) =>
  Schema.decodeUnknownEffect(Schema.Array(CoreSearchProjectionHitSchema))(
    rows.map((project) => ({
      archived: false,
      facets: [],
      metadata: [{ key: 'project.name', kind: 'string', value: 'Obsolete indexed name' }],
      ref: { moduleId: 'projects.core', resourceId: project.projectId, resourceType: 'projects.project', tenantId },
      title: 'Obsolete indexed name',
    })),
  );
const access = (decision: ContextAccessDecision, key = tenantId): ContextAccessService => ({
  legalEntities: () => Effect.die('Project finish must not invent company permissions'),
  modules: () => Effect.die('Project finish must not substitute module permissions'),
  resources: () => Effect.die('Project finish must not invent resource permissions'),
  tenants: (request) => {
    expect(request).toEqual({ permission: 'access', principalId: creatorId, tenantIds: [tenantId] });
    return Effect.succeed([{ decision, key }]);
  },
});
const harnessFor = (rows: readonly ProjectSearchMetadata[], scope: OperationalScope = readScope) =>
  makeReadTestHarness({
    executeOwnerQuery: ({ params, scope: installed, sql }) => {
      expect(installed).toEqual({ legalEntityId: scope.legalEntityId ?? '', tenantId });
      expect(sql).toContain('from "projects"."projects"');
      expect(sql).toMatch(/^select "lifecycle_state", "name", "prefix", "project_id", "tenant_id" from/u);
      expect(sql).toContain('"projects"."projects"."tenant_id" =');
      expect(params).toContain(tenantId);
      expect(sql).not.toMatch(/limit|short_text|owner_principal_id|created_by|parent_project|for update/iu);
      for (const project of rows) {
        if (project.tenantId === tenantId) {
          expect(params).toContain(project.projectId);
        }
      }
      return Effect.succeed(rows);
    },
    operationTime,
    ownerAuthorizationDecision: 'allowed',
    permissionDecision: 'allowed',
    scope,
  });
type Harness = Effect.Success<ReturnType<typeof harnessFor>>;
interface SearchTestInput {
  readonly includeArchived?: boolean;
  readonly query: string;
  readonly selectedLegalEntityId?: string;
  readonly tenantId?: string;
}
const run = (harness: Harness, payload: SearchTestInput = input, scope: OperationalScope = readScope) =>
  harness.runtime.runRead({
    input: payload,
    principal: scope,
    registration: projectsRead,
    transport: { correlationId: scope.correlationId },
  });

it('keeps canonical tenant read admission, actual resource identity and metadata-only evidence', () => {
  expect(projectsRead.descriptor).toMatchObject({
    entrypoint: { authorization: { kind: 'authenticated_principal' }, scope: 'tenant' },
    evidencePolicy: { captureMode: 'metadata_only' },
    legalEntityScope: 'optional',
    owningModuleKey: 'projects.core',
    permissionTarget: 'tenant',
  });
  expect(projectsManifest.publicSurface.search).toEqual([
    {
      accessFiltering: 'tenant_scope',
      key: 'projects.core.projects',
      owningModuleId: 'projects.core',
      requestFilters: ['includeArchived'],
      resourceType: 'projects.project',
      tenantPermission: 'access',
    },
  ]);
  expect(projectsManifest.publicSurface.resourceTypes[0]?.capabilities.searchable).toBe(false);
  expect(projectsManifest.publicSurface.shellContributions.search).toHaveLength(1);
  expect(projectsManifest.publicSurface.shellContributions.resourceDetails).toEqual([]);
});

it.layer(NodeCrypto.layer)('Projects current-owner indexed search (injected candidates, not a live corpus)', (test) => {
  test.effect(
    'queries the same genuine Tenant scope with or without a selected company and returns only safe current metadata',
    () =>
      Effect.gen(function* tenantAndCompany() {
        const rows = [row(1)];
        const hits = yield* decodeHits(rows);
        const views = [];
        for (const scope of [readScope, { ...readScope, legalEntityId: companyId }]) {
          const harness = yield* harnessFor(rows, scope);
          let queries = 0;
          const result = yield* run(harness, input, scope).pipe(
            Effect.provideService(CoreSearchQueryRuntime, {
              search: (query, actualScope) => {
                queries += 1;
                expect(query).toEqual({
                  includeArchived: true,
                  moduleId: 'projects.core',
                  query: 'Current',
                  resourceType: 'projects.project',
                  tenantId,
                });
                expect(actualScope).toEqual(scope);
                expect(harness.snapshot().ownerQueries).toEqual([]);
                return Effect.succeed(hits);
              },
            }),
            Effect.provide(harness.layer),
          );
          views.push(result);
          expect(queries).toBe(1);
          expect(result).toMatchObject([
            {
              archived: false,
              lifecycleState: 'active',
              prefix: rows[0]?.prefix,
              ref: { moduleId: 'projects.core', resourceType: 'projects.project', tenantId },
              subtitle: rows[0]?.prefix,
              title: 'Current Project 1',
            },
          ]);
          expect(Object.keys(result[0] ?? {})).toEqual([
            'archived',
            'lifecycleState',
            'prefix',
            'ref',
            'relevance',
            'subtitle',
            'title',
          ]);
          expect(Object.keys(result[0]?.ref ?? {})).toEqual(['moduleId', 'resourceId', 'resourceType', 'tenantId']);
          expect(JSON.stringify(result)).not.toMatch(/selectedLegalEntityId|Obsolete|project.name/u);
          expect(harness.snapshot().ownerQueries).toHaveLength(1);
          expect(harness.snapshot().evidenceWrites).toBe(1);
          expect(harness.snapshot().stages).toContain('evidence_persisted');
        }
        expect(views[0]).toEqual(views[1]);
      }),
  );

  test.effect('rematches 257 current names after Core shortlist without a hidden 200 result cap or cache', () =>
    Effect.gen(function* meaningfulCandidateSet() {
      const rows = Array.from({ length: 257 }, (_, index) => row(index + 1));
      const hits = yield* decodeHits(rows);
      const harness = yield* harnessFor(rows);
      let calls = 0;
      const runtime = {
        search: () => {
          calls += 1;
          return Effect.succeed(hits);
        },
      };
      for (const _attempt of [1, 2]) {
        const result = yield* run(harness).pipe(
          Effect.provideService(CoreSearchQueryRuntime, runtime),
          Effect.provide(harness.layer),
        );
        expect(result).toHaveLength(257);
        expect(new Set(result.map((item) => item.ref.resourceId)).size).toBe(257);
        expect(result.every((item) => item.title.startsWith('Current Project '))).toBe(true);
      }
      expect(calls).toBe(2);
      expect(harness.snapshot().ownerQueries).toHaveLength(2);
    }),
  );

  test.effect('uses normalized current name and prefix together and recomputes relevance from current evidence', () =>
    Effect.gen(function* currentPrefixAndName() {
      const project = { ...row(1), name: 'Žluťoučký kůň', prefix: 'ONTO' };
      const hits = yield* decodeHits([project]);
      const harness = yield* harnessFor([project]);
      const result = yield* run(harness, { query: 'zlutoucky onto' }).pipe(
        Effect.provideService(CoreSearchQueryRuntime, { search: () => Effect.succeed(hits) }),
        Effect.provide(harness.layer),
      );
      expect(result).toMatchObject([
        { prefix: 'ONTO', relevance: { score: 100, version: '1' }, title: 'Žluťoučký kůň' },
      ]);
    }),
  );

  test.effect('drops deleted and renamed stale candidates and never treats stale index text as matching evidence', () =>
    Effect.gen(function* staleAndDeleted() {
      const candidates = [row(1), row(2), row(3)];
      const hits = yield* decodeHits(candidates);
      const current = [row(1), { ...row(2), name: 'Renamed Project' }];
      const harness = yield* harnessFor(current);
      const result = yield* run(harness).pipe(
        Effect.provideService(CoreSearchQueryRuntime, { search: () => Effect.succeed(hits) }),
        Effect.provide(harness.layer),
      );
      expect(result.map((item) => item.ref.resourceId)).toEqual([row(1).projectId]);
    }),
  );

  test.effect('uses current archive state for includeArchived, including stale archive/unarchive index flags', () =>
    Effect.gen(function* currentArchive() {
      const active = row(1);
      const archived: ProjectSearchMetadata = { ...row(2), lifecycleState: 'archived' };
      const decoded = yield* decodeHits([active, archived]);
      const hits = decoded.map((hit) => ({ ...hit, archived: hit.ref.resourceId === active.projectId }));
      for (const includeArchived of [false, true]) {
        const harness = yield* harnessFor([active, archived]);
        const result = yield* run(harness, { ...input, includeArchived }).pipe(
          Effect.provideService(CoreSearchQueryRuntime, { search: () => Effect.succeed(hits) }),
          Effect.provide(harness.layer),
        );
        expect(result.map((item) => item.lifecycleState)).toEqual(
          includeArchived ? ['active', 'archived'] : ['active'],
        );
        expect(result.map((item) => item.archived)).toEqual(includeArchived ? [false, true] : [false]);
        for (const item of result) {
          expect(item.subtitle).toBe(item.prefix);
        }
      }
    }),
  );

  test.effect('denies initial unavailable or forbidden tenant access before Core or owner queries', () =>
    Effect.gen(function* admissionFailures() {
      for (const permissionDecision of ['denied', 'unavailable'] as const) {
        const harness = yield* makeReadTestHarness({
          executeOwnerQuery: () => Effect.die('Denied read must not load Projects'),
          operationTime,
          ownerAuthorizationDecision: 'allowed',
          permissionDecision,
          scope: readScope,
        });
        const failure = yield* run(harness).pipe(
          Effect.provideService(CoreSearchQueryRuntime, {
            search: () => Effect.die('Denied read must not query index'),
          }),
          Effect.provide(harness.layer),
          Effect.flip,
        );
        expect(
          Schema.is(permissionDecision === 'denied' ? ReadPermissionDenied : ReadPermissionUnavailable)(failure),
        ).toBe(true);
        expect(harness.snapshot().ownerQueries).toEqual([]);
        expect(harness.snapshot().stages).not.toContain('handler_executed');
      }
    }),
  );

  test.effect(
    'rechecks current tenant access after owner load and refuses revoked, unavailable or mismatched decisions',
    () =>
      Effect.gen(function* freshCurrentAccess() {
        const rows = [row(1)];
        const hits = yield* decodeHits(rows);
        for (const decision of ['denied', 'unavailable', 'allowed'] as const) {
          const harness = yield* harnessFor(rows);
          const key = decision === 'allowed' ? foreignTenantId : tenantId;
          const currentAccess = access(decision, key);
          const failure = yield* run(harness).pipe(
            Effect.provideService(CoreSearchQueryRuntime, { search: () => Effect.succeed(hits) }),
            Effect.provideService(ContextAccess, {
              ...currentAccess,
              tenants: (request) => {
                expect(harness.snapshot().ownerQueries).toHaveLength(1);
                return currentAccess.tenants(request);
              },
            }),
            Effect.provide(harness.layer),
            Effect.flip,
          );
          expect(Schema.is(decision === 'denied' ? ReadPermissionDenied : ReadHandlerUnavailable)(failure)).toBe(true);
          expect(harness.snapshot().stages).not.toContain('evidence_persisted');
        }
      }),
  );

  test.effect(
    'refuses foreign tenant, foreign resource, company or alternate-reference candidates before owner SQL',
    () =>
      Effect.gen(function* invalidCandidateIdentity() {
        const [hit] = yield* decodeHits([row(1)]);
        if (hit === undefined) {
          return yield* Effect.die('Fixture candidate missing');
        }
        const candidates = yield* Schema.decodeUnknownEffect(Schema.Array(CoreSearchProjectionHitSchema))([
          { ...hit, ref: { ...hit.ref, tenantId: foreignTenantId } },
          { ...hit, ref: { ...hit.ref, moduleId: 'other.module' } },
          { ...hit, ref: { ...hit.ref, resourceType: 'projects.core.project' } },
          { ...hit, selectedLegalEntityId: companyId },
          { ...hit, subjectRef: hit.ref },
          { ...hit, matchedRef: hit.ref },
          { ...hit, matchedSubjectRef: hit.ref },
        ]);
        for (const candidate of candidates) {
          const harness = yield* harnessFor([]);
          const failure = yield* run(harness).pipe(
            Effect.provideService(CoreSearchQueryRuntime, { search: () => Effect.succeed([candidate]) }),
            Effect.provide(harness.layer),
            Effect.flip,
          );
          expect(Schema.is(ReadHandlerUnavailable)(failure)).toBe(true);
          expect(harness.snapshot().ownerQueries).toEqual([]);
        }
        return yield* Effect.void;
      }),
  );

  test.effect('rejects current-owner tenant/candidate mismatch rather than releasing foreign or unexpected rows', () =>
    Effect.gen(function* currentOwnerMismatch() {
      const hits = yield* decodeHits([row(1)]);
      for (const current of [[{ ...row(1), tenantId: foreignTenantId }], [row(1), row(1)]]) {
        const harness = yield* harnessFor(current);
        const failure = yield* run(harness).pipe(
          Effect.provideService(CoreSearchQueryRuntime, { search: () => Effect.succeed(hits) }),
          Effect.provide(harness.layer),
          Effect.flip,
        );
        expect(Schema.is(ReadHandlerUnavailable)(failure)).toBe(true);
        expect(harness.snapshot().stages).not.toContain('evidence_persisted');
      }
    }),
  );

  test.effect('propagates Core readiness/floor unavailability without fabricating an empty corpus', () =>
    Effect.gen(function* unavailableIndex() {
      const harness = yield* harnessFor([]);
      const failure = yield* run(harness).pipe(
        Effect.provideService(CoreSearchQueryRuntime, {
          search: () =>
            Effect.fail(
              new CoreSearchProjectionUnavailable({
                code: 'core_search_projection_unavailable',
                reason: 'Private readiness detail',
              }),
            ),
        }),
        Effect.provide(harness.layer),
        Effect.flip,
      );
      expect(Schema.is(ReadHandlerUnavailable)(failure)).toBe(true);
      expect(failure).toMatchObject({ reason: 'Project search is temporarily unavailable' });
      expect(harness.snapshot().ownerQueries).toEqual([]);
    }),
  );

  test.effect('empty candidates perform no owner SQL but still recheck current tenant access', () =>
    Effect.gen(function* noCandidates() {
      const harness = yield* harnessFor([]);
      const result = yield* run(harness).pipe(
        Effect.provideService(CoreSearchQueryRuntime, { search: () => Effect.succeed([]) }),
        Effect.provideService(ContextAccess, access('allowed')),
        Effect.provide(harness.layer),
      );
      expect(result).toEqual([]);
      expect(harness.snapshot().ownerQueries).toEqual([]);
      expect(harness.snapshot().evidenceWrites).toBe(1);
    }),
  );

  test.effect(
    'rejects empty/normalization-only queries and caller-selected tenant/company fields before querying',
    () =>
      Effect.gen(function* invalidQueries() {
        for (const payload of [
          { query: '' },
          { query: '\u0301' },
          { ...input, tenantId: foreignTenantId },
          { ...input, selectedLegalEntityId: companyId },
        ]) {
          const harness = yield* harnessFor([]);
          const failure = yield* run(harness, payload).pipe(
            Effect.provideService(CoreSearchQueryRuntime, {
              search: () => Effect.die('Invalid input must not query index'),
            }),
            Effect.provide(harness.layer),
            Effect.flip,
          );
          expect(Schema.is(ReadInputValidationError)(failure)).toBe(true);
          expect(harness.snapshot().ownerQueries).toEqual([]);
        }
      }),
  );
});

it.effect('public DTO validates canonical Tenant identity without adding a selected company', () =>
  Effect.gen(function* tenantDto() {
    const response = [
      {
        lifecycleState: 'active',
        prefix: 'ONTO',
        ref: { moduleId: 'projects.core', resourceId: row(1).projectId, resourceType: 'projects.project', tenantId },
        title: 'Current Project',
      },
    ];
    const decoded = yield* Schema.decodeUnknownEffect(ProjectsProviderResponseSchema, { onExcessProperty: 'error' })(
      response,
    );
    expect(decoded).toEqual(response);
    const wrong = yield* Schema.decodeUnknownEffect(ProjectsProviderResponseSchema, { onExcessProperty: 'error' })([
      { ...response[0], selectedLegalEntityId: companyId },
    ]).pipe(Effect.flip);
    expect(wrong).toBeDefined();
    expect(
      yield* Schema.decodeUnknownEffect(ProjectsProviderRequestSchema)({ includeArchived: true, query: 'ONTO' }),
    ).toEqual({ includeArchived: true, query: 'ONTO' });
  }),
);
