import type { ContextAccessService } from '@app/core-runtime';
import { Effect, Result, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { compileShellSearchPresentation } from '../../api/modules/shell-search-presentation.ts';
import { makeShellSearch, ShellProviderUnavailableError } from '../../api/modules/shell-resources.ts';
import { makeInstalledModuleCatalogLoader } from '../../api/modules/installed-module-catalog.ts';
import { ShellSearchPresentationInventorySchema, ShellSearchResponseSchema } from '../../shared/api.ts';
import { makeCompositionSnapshot } from '../fixtures/application-composition.ts';

const ownerModuleId = 'sample.owner';
const searchKey = 'sample.owner.records';
const resourceType = 'sample.owner.record';
const pageKey = 'sample.owner.page.record';
const admitted = [{ ownerModuleId, resourceType, searchKey }];
const metadata = {
  family: { icon: 'icon-[mdi--folder]', key: 'work', label: { cs: 'Práce', en: 'Work' }, order: 1 },
  group: { icon: 'icon-[mdi--file]', key: 'record', label: { cs: 'Záznamy', en: 'Records' }, order: 1 },
};
const entrypoint = (role: 'page' | 'search', key: string) => ({
  access: 'read',
  authorization: { kind: 'authenticated_principal' },
  entrypointKey: key,
  moduleKey: ownerModuleId,
  role,
  scope: 'tenant',
});

const contract = (tenant = false) => ({
  deployment: { appId: 'sample-owner', buildMarker: 'test' },
  manifest: {
    activation: {
      defaultState: 'inactive',
      preservesHistoryWhenInactive: true,
      scope: 'tenant',
      supportedStates: ['inactive', 'active'],
    },
    module: {
      description: 'Public presentation fixture.',
      displayName: 'Sample',
      id: ownerModuleId,
      implementedAs: 'ultramodern_microvertical',
      kind: 'business_module',
    },
    publicSurface: {
      actions: [],
      api: [],
      components: [{ expose: './Record', key: 'sample.owner.record-page', mfBoundaryId: 'sampleOwner' }],
      events: [],
      reports: [],
      resourceTypes: [
        {
          capabilities: {
            graphVisible: false,
            linkable: false,
            mediaAttachable: false,
            searchable: true,
            timelineVisible: false,
          },
          description: 'A record.',
          key: resourceType,
          label: 'Record',
          owningModuleId: ownerModuleId,
        },
      ],
      search: [
        tenant
          ? {
              accessFiltering: 'tenant_scope',
              key: searchKey,
              owningModuleId: ownerModuleId,
              resourceType,
              tenantPermission: 'access',
            }
          : { accessFiltering: 'resource_permission', key: searchKey, owningModuleId: ownerModuleId, resourceType },
      ],
      shellContributions: {
        mediaAttachments: [],
        navigation: [],
        pages: [
          {
            componentKey: 'sample.owner.record-page',
            contributionKey: pageKey,
            entrypoint: entrypoint('page', pageKey),
            expose: './Record',
            routePath: '/sample/records/:recordId',
          },
        ],
        publicComponents: [],
        reports: [],
        resourceDetails: [],
        search: [
          {
            contributionKey: 'sample.owner.search.records',
            entrypoint: entrypoint('search', searchKey),
            presentation: {
              ...metadata,
              record: {
                pageKey,
                selector: { idEncoding: 'native', idFormat: 'opaque', kind: 'path', parameterName: 'recordId' },
              },
              scope: tenant ? 'tenant' : 'company',
            },
            searchKey,
          },
        ],
        timelines: [],
      },
    },
  },
  runtime: { outboxSubscriptions: [] },
  schemaVersion: '2',
});

const installed = (tenant = false) => makeInstalledModuleCatalogLoader(makeCompositionSnapshot([contract(tenant)]));
const tenantId = '10000000-0000-4000-8000-000000000001';
const legalEntityId = '20000000-0000-4000-8000-000000000001';
const principalId = '30000000-0000-4000-8000-000000000001';
const tenantContext = { authMethod: 'system', correlationId: 'presentation-test', principalId, tenantId } as const;
const contextAccess = (allowed = true): ContextAccessService => ({
  legalEntities: () => Effect.succeed([]),
  modules: ({ moduleIds }) =>
    Effect.succeed(moduleIds.map((key) => ({ decision: allowed ? 'allowed' : 'denied', key }))),
  resources: ({ resources }) =>
    Effect.succeed(
      resources.map((ref) => ({
        decision: allowed ? 'allowed' : 'denied',
        key: `${ref.moduleId}:${ref.resourceType}:${ref.resourceId}`,
      })),
    ),
  tenants: ({ tenantIds }) =>
    Effect.succeed(tenantIds.map((key) => ({ decision: allowed ? 'allowed' : 'denied', key }))),
});
const dependencies = (tenant = false, allowed = true) => ({
  catalog: installed(tenant),
  contextAccess: contextAccess(allowed),
  issueAssertion: () => Effect.succeed('Bearer test-admitted-owner'),
  moduleStates: {
    getTenantModuleStates: (_tenantId: string, moduleIds: readonly string[]) =>
      Effect.succeed(moduleIds.map((moduleKey) => ({ moduleKey, state: 'active' as const }))),
  },
});

it.effect('compiles the admitted owner route and metadata from the captured public contract', () =>
  Effect.gen(function* compile() {
    const catalog = yield* installed();
    const result = compileShellSearchPresentation({
      admitted,
      catalog,
      compositionRevision: catalog.composition.revision,
    });
    expect(Result.isSuccess(result)).toBe(true);
    if (Result.isFailure(result)) {
      throw new Error(result.failure.message);
    }
    expect(result.success.business.entries).toHaveLength(1);
    expect(result.success.business.entries[0]).toMatchObject({
      ownerModuleId,
      presentation: metadata,
      resourceType,
      searchKey,
    });
    expect(result.success.pages).toEqual([{ ownerModuleId, pageKey, routePath: '/sample/records/:recordId' }]);
    const encoded = Schema.encodeSync(Schema.fromJsonString(ShellSearchPresentationInventorySchema))(result.success);
    expect(Schema.decodeUnknownSync(Schema.fromJsonString(ShellSearchPresentationInventorySchema))(encoded)).toEqual(
      result.success,
    );
    const [page] = result.success.pages;
    if (page === undefined) {
      throw new Error('The declared record page must resolve');
    }
    for (const pages of [
      [],
      [{ ...page, ownerModuleId: 'foreign.owner' }],
      [{ ...page, routePath: '/sample/records/:otherId' }],
      [...result.success.pages, page],
      [...result.success.pages, { ...page, pageKey: 'sample.owner.unbound-page' }],
    ]) {
      expect(
        Result.isFailure(
          Schema.decodeUnknownResult(ShellSearchPresentationInventorySchema)({ ...result.success, pages }),
        ),
      ).toBe(true);
    }
  }),
);

it.effect('does not expose installed metadata when no provider has been admitted', () =>
  Effect.gen(function* noAdmission() {
    const catalog = yield* installed();
    const result = compileShellSearchPresentation({
      admitted: [],
      catalog,
      compositionRevision: catalog.composition.revision,
    });
    expect(Result.isSuccess(result)).toBe(true);
    if (Result.isFailure(result)) {
      throw new Error(result.failure.message);
    }
    expect(result.success.business.entries).toEqual([]);
    expect(result.success.pages).toEqual([]);
  }),
);

it.effect('refuses stale revision and duplicate provider bindings, and degrades a foreign binding alone', () =>
  Effect.gen(function* refuse() {
    const catalog = yield* installed();
    expect(
      Result.isFailure(compileShellSearchPresentation({ admitted, catalog, compositionRevision: 'f'.repeat(64) })),
    ).toBe(true);
    // A binding that does not match the captured contract gets no presentation; it never fails the whole answer.
    const foreign = compileShellSearchPresentation({
      admitted: [{ ...admitted[0], ownerModuleId, resourceType: 'sample.owner.foreign', searchKey }],
      catalog,
      compositionRevision: catalog.composition.revision,
    });
    expect(Result.isSuccess(foreign) && foreign.success.business.entries).toEqual([]);
    expect(Result.isSuccess(foreign) && foreign.success.pages).toEqual([]);
    expect(
      Result.isFailure(
        compileShellSearchPresentation({
          admitted: [...admitted, ...admitted],
          catalog,
          compositionRevision: catalog.composition.revision,
        }),
      ),
    ).toBe(true);
  }),
);

it.effect('returns real tenant-scoped owner results and presentation through the governed search producer', () =>
  Effect.gen(function* governedTenant() {
    const response = yield* makeShellSearch(dependencies(true), {
      search: () =>
        Effect.succeed([
          { ref: { moduleId: ownerModuleId, resourceId: 'record-1', resourceType, tenantId }, title: 'Record 1' },
        ]),
    }).search(tenantContext, 'Record');
    expect(response.results).toHaveLength(1);
    expect(response.results[0]).not.toHaveProperty('selectedLegalEntityId');
    expect(response.presentation?.business.entries[0]?.presentation.scope).toBe('tenant');
    expect(Schema.decodeUnknownSync(ShellSearchResponseSchema)(response)).toEqual(response);
    const selectedCompanyResponse = yield* makeShellSearch(dependencies(true), {
      search: () =>
        Effect.succeed([
          { ref: { moduleId: ownerModuleId, resourceId: 'record-1', resourceType, tenantId }, title: 'Record 1' },
        ]),
    }).search({ ...tenantContext, legalEntityId }, 'Record');
    expect(selectedCompanyResponse.results).toEqual(response.results);
    expect(selectedCompanyResponse.results[0]).not.toHaveProperty('selectedLegalEntityId');
    expect(Schema.decodeUnknownSync(ShellSearchResponseSchema)(selectedCompanyResponse)).toEqual(
      selectedCompanyResponse,
    );
    expect(
      Result.isFailure(
        Schema.decodeUnknownResult(ShellSearchResponseSchema)({ partial: false, results: response.results }),
      ),
    ).toBe(true);
    expect(
      Result.isFailure(
        Schema.decodeUnknownResult(ShellSearchResponseSchema)({
          ...response,
          results: response.results.map((row) => ({ ...row, selectedLegalEntityId: legalEntityId })),
        }),
      ),
    ).toBe(true);
  }),
);

it.effect('keeps selected-company ownership while attaching the compiled presentation to a real result', () =>
  Effect.gen(function* governedCompany() {
    const response = yield* makeShellSearch(dependencies(), {
      search: () =>
        Effect.succeed([
          {
            ref: { moduleId: ownerModuleId, resourceId: 'record-1', resourceType, tenantId },
            selectedLegalEntityId: legalEntityId,
            title: 'Record 1',
          },
        ]),
    }).search({ ...tenantContext, legalEntityId }, 'Record');
    expect(response.results).toHaveLength(1);
    expect(response.presentation?.pages).toEqual([{ ownerModuleId, pageKey, routePath: '/sample/records/:recordId' }]);
    expect(Schema.decodeUnknownSync(ShellSearchResponseSchema)(response)).toEqual(response);
  }),
);

it.effect('projects an admitted owner DTO onto shared hit fields without leaking owner-only data', () =>
  Effect.gen(function* publicOwnerProjection() {
    const response = yield* makeShellSearch(dependencies(true), {
      search: () =>
        Effect.succeed([
          {
            archived: true,
            lifecycleState: 'archived',
            prefix: 'PRJ-42',
            privateNotes: 'PRIVATE-OWNER-DATA-NOT-A-SHELL-FIELD',
            ref: { moduleId: ownerModuleId, resourceId: 'record-1', resourceType, tenantId },
            subtitle: 'PRJ-42',
            title: 'Record 1',
          },
        ]),
    }).search(tenantContext, 'Record');
    expect(response.results).toEqual([
      {
        archived: true,
        kind: 'resource',
        ref: { moduleId: ownerModuleId, resourceId: 'record-1', resourceType, tenantId },
        subtitle: 'PRJ-42',
        title: 'Record 1',
      },
    ]);
    expect(JSON.stringify(response)).not.toContain('PRIVATE-OWNER-DATA');
    expect(response.results[0]).not.toHaveProperty('prefix');
    expect(response.results[0]).not.toHaveProperty('lifecycleState');
    expect(Schema.decodeUnknownSync(ShellSearchResponseSchema)(response)).toEqual(response);
  }),
);

it.effect('rejects undeclared refinement metadata instead of accepting it through a generic resource DTO', () =>
  Effect.gen(function* unsupportedRefinement() {
    const failure = yield* makeShellSearch(dependencies(), {
      search: () =>
        Effect.succeed([
          {
            matchedVariant: { id: 'variant-1', name: 'Variant', sku: 'SKU-1' },
            ref: { moduleId: ownerModuleId, resourceId: `${legalEntityId}.record-1`, resourceType, tenantId },
            selectedLegalEntityId: legalEntityId,
            title: 'Record 1',
          },
        ]),
    })
      .search({ ...tenantContext, legalEntityId }, 'Record')
      .pipe(Effect.flip);
    expect(Schema.is(ShellProviderUnavailableError)(failure)).toBe(true);
  }),
);

it.effect('rejects a tenant provider manufacturing selected-company identity', () =>
  Effect.gen(function* manufacturedCompany() {
    const failure = yield* makeShellSearch(dependencies(true), {
      search: () =>
        Effect.succeed([
          {
            ref: { moduleId: ownerModuleId, resourceId: 'record-1', resourceType, tenantId },
            selectedLegalEntityId: legalEntityId,
            title: 'Record 1',
          },
        ]),
    })
      .search({ ...tenantContext, legalEntityId }, 'Record')
      .pipe(Effect.flip);
    expect(Schema.is(ShellProviderUnavailableError)(failure)).toBe(true);
  }),
);

it.effect('does not call or publish an installed provider denied by current access', () =>
  Effect.gen(function* governedDenied() {
    const response = yield* makeShellSearch(dependencies(true, false), {
      search: () => Effect.die('Denied providers must not run'),
    }).search(tenantContext, 'Record');
    expect(response.results).toEqual([]);
    expect(response.presentation?.business.entries).toEqual([]);
    expect(response.presentation?.pages).toEqual([]);
  }),
);

it.effect('keeps canonical tenant presentation without manufacturing a selected company', () =>
  Effect.gen(function* tenantScope() {
    const catalog = yield* installed(true);
    const result = compileShellSearchPresentation({
      admitted,
      catalog,
      compositionRevision: catalog.composition.revision,
    });
    expect(Result.isSuccess(result)).toBe(true);
    if (Result.isFailure(result)) {
      throw new Error(result.failure.message);
    }
    expect(result.success.business.entries[0]?.presentation.scope).toBe('tenant');
    expect(JSON.stringify(result.success)).not.toContain('selectedLegalEntityId');
  }),
);
