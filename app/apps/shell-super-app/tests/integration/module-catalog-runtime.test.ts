// @effect-diagnostics asyncFunction:off preferSchemaOverJson:off
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import {
  defineAction,
  defineOntosModuleManifest,
  defineOutboxWorker,
  defineTenantModuleEntrypoint,
  defineVerticalRuntimeRegistration,
  extractVerticalRuntimeSafeDescriptors,
  getVerticalRuntimeActions,
  getVerticalRuntimeOutboxWorkers,
} from '@app/core-runtime';
import { Effect, Schema } from 'effect';
import { HttpApi, HttpApiEndpoint, HttpApiGroup } from 'effect/unstable/httpapi';
import { makeEffectHttpApiClient } from '@modern-js/plugin-bff/effect-client';
import { deriveDeploymentAllowlist } from '../../api/modules/deployment-allowlist.ts';
import { makeInstalledModuleCatalogLoader } from '../../api/modules/installed-module-catalog.ts';
import { matchInstalledOutboxMessagesOnce } from '../../api/modules/installed-outbox-matcher.ts';

const contract = (
  appId: string,
  moduleId: string,
  overrides: {
    readonly actions?: readonly object[];
    readonly api?: readonly object[];
    readonly components?: readonly object[];
    readonly outboxSubscriptions?: readonly object[];
    readonly shellContributions?: object;
  } = {},
) => ({
  deployment: { appId, buildMarker: `${appId}-independent-build` },
  manifest: {
    activation: {
      defaultState: 'inactive',
      preservesHistoryWhenInactive: true,
      scope: 'tenant',
      supportedStates: [
        'inactive',
        'active',
        'read_only',
        'suspended',
        'quarantined',
        'deprecated',
        'archived',
      ],
    },
    module: {
      description: `${moduleId} independently deployed module`,
      displayName: moduleId,
      id: moduleId,
      implementedAs: 'ultramodern_microvertical',
      kind: 'business_module',
    },
    publicSurface: {
      actions: overrides.actions ?? [],
      api: overrides.api ?? [{ key: `${moduleId}.api`, operationKeys: ['read'] }],
      components: overrides.components ?? [
        {
          expose: './Dashboard',
          key: `${moduleId}.dashboard`,
          mfBoundaryId:
            appId === 'property-registry' ? 'verticalPropertyRegistry' : 'verticalDocumentsCenter',
        },
      ],
      events: [],
      reports: [],
      resourceTypes: [],
      search: [],
      shellContributions: overrides.shellContributions ?? {
        mediaAttachments: [],
        navigation: [],
        pages: [],
        publicComponents: [],
        reports: [],
        resourceDetails: [],
        search: [],
        timelines: [],
      },
    },
  },
  runtime: { outboxSubscriptions: overrides.outboxSubscriptions ?? [] },
  schemaVersion: '2',
});

const PropertyApi = HttpApi.make('PropertyApi').add(
  HttpApiGroup.make('property').add(HttpApiEndpoint.get('listUnits', '/units')),
);

const PropertyAction = defineAction(
  {
    accessEvidencePolicy: {
      captureMode: 'metadata_only',
      policyKey: 'property.registry.rename-unit.access.v1',
    },
    actionKey: 'property.registry.rename-unit',
    auditProfile: 'standard',
    domainErrorSchema: Schema.Never,
    domainEvents: {},
    entrypoint: defineTenantModuleEntrypoint({
      access: 'write',
      entrypointKey: 'property.registry.rename-unit',
      moduleKey: 'property.registry',
      role: 'action',
    }),
    idempotency: 'required',
    owningModuleKey: 'property.registry',
    payloadSchema: Schema.Struct({ unitId: Schema.String }),
    policies: [],
    resultSchema: Schema.Struct({ renamed: Schema.Boolean }),
    schemaVersion: '1',
  },
  () => Effect.succeed({ renamed: true }),
);

const PropertyOutboxWorker = defineOutboxWorker(
  {
    consumerModuleKey: 'property.registry',
    entrypoint: defineTenantModuleEntrypoint({
      access: 'background',
      entrypointKey: 'property.registry.index-document',
      moduleKey: 'property.registry',
      role: 'worker',
    }),
    leaseDurationMs: 30_000,
    payloadSchema: Schema.Struct({ documentId: Schema.String }),
    producerModuleKey: 'documents.center',
    retryPolicy: {
      initialBackoffMs: 1000,
      maxAttempts: 5,
      maxBackoffMs: 60_000,
      multiplier: 2,
    },
    topic: 'documents.center.document-created',
    workerKey: 'property.registry.index-document',
  },
  () => Effect.void,
);

const PropertyDashboard = () => null;

const propertyManifest = defineOntosModuleManifest({
  activation: {
    defaultState: 'inactive',
    preservesHistoryWhenInactive: true,
    scope: 'tenant',
    supportedStates: ['inactive', 'active'],
  },
  module: {
    description: 'Property registry independently deployed module',
    displayName: 'Property Registry',
    id: 'property.registry',
    implementedAs: 'ultramodern_microvertical',
    kind: 'business_module',
  },
  publicSurface: {
    actions: [PropertyAction],
    api: { PropertyClient: PropertyApi },
    components: { PropertyDashboard },
    events: [],
    reports: [],
    resourceTypes: [],
    search: [],
    shellContributions: {
      mediaAttachments: [],
      navigation: [],
      pages: [],
      publicComponents: [],
      reports: [],
      resourceDetails: [],
      search: [],
      timelines: [],
    },
  },
});

const propertyRuntimeRegistration = defineVerticalRuntimeRegistration({
  actions: [PropertyAction],
  manifest: propertyManifest,
  outboxWorkers: [PropertyOutboxWorker],
});

const propertySafeRuntime = extractVerticalRuntimeSafeDescriptors(propertyRuntimeRegistration);

const serve = async (document: unknown) => {
  let requests = 0;
  const server = createServer((_request, response) => {
    requests += 1;
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify(document));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address() as AddressInfo;
  return {
    close: async () => {
      const closed = once(server, 'close');
      server.close();
      await closed;
    },
    get requests() {
      return requests;
    },
    url: `http://127.0.0.1:${port}/.well-known/ontos-module-manifest.json`,
  };
};

test('keeps discovered metadata separate from one complete owner-local runtime', async () => {
  const property = await serve(
    contract('property-registry', 'property.registry', {
      actions: propertySafeRuntime.actions,
      api: [{ key: 'property.registry.api', operationKeys: ['property.listUnits'] }],
      components: [
        {
          expose: './Dashboard',
          key: 'property.registry.dashboard',
          mfBoundaryId: 'verticalPropertyRegistry',
        },
      ],
      outboxSubscriptions: propertySafeRuntime.outboxSubscriptions,
    }),
  );
  const documents = await serve(contract('documents-center', 'documents.center'));
  try {
    const allowlist = await Effect.runPromise(
      deriveDeploymentAllowlist({
        environment: 'development',
        overlay: {
          environment: 'development',
          ontosModuleManifests: {
            'documents-center': documents.url,
            'property-registry': property.url,
          },
          schemaVersion: 1,
        },
        topology: {
          verticals: [
            { id: 'property-registry', kind: 'vertical' },
            { id: 'documents-center', kind: 'vertical' },
          ],
        },
      }),
    );
    const loader = makeInstalledModuleCatalogLoader(allowlist);
    const first = await Effect.runPromise(loader);
    const second = await Effect.runPromise(loader);

    assert.strictEqual(first, second);
    assert.equal(property.requests, 1);
    assert.equal(documents.requests, 1);
    assert.equal(
      first.getByDeploymentAppId('property-registry')?.manifest.module.id,
      'property.registry',
    );
    assert.equal(first.getByModuleId('property.registry')?.deployment.appId, 'property-registry');
    assert.deepEqual(first.moduleIds, ['documents.center', 'property.registry']);
    const tenantStates = [
      { moduleKey: 'property.registry', state: 'active' },
      { moduleKey: 'documents.center', state: 'inactive' },
    ] as const;
    assert.deepEqual(
      tenantStates
        .filter(({ moduleKey, state }) => state === 'active' && first.moduleIds.includes(moduleKey))
        .map(({ moduleKey }) => moduleKey),
      ['property.registry'],
    );

    assert.strictEqual(getVerticalRuntimeActions(propertyRuntimeRegistration)[0], PropertyAction);
    assert.strictEqual(
      getVerticalRuntimeOutboxWorkers(propertyRuntimeRegistration)[0],
      PropertyOutboxWorker,
    );
    assert.deepEqual(Object.keys(propertyRuntimeRegistration), ['moduleId']);

    let matchedSubscriptions: readonly object[] = [];
    await Effect.runPromise(
      matchInstalledOutboxMessagesOnce(first, (input) => {
        matchedSubscriptions = input.subscriptions;
        return Effect.succeed({ deliveriesCreated: 1, messagesMatched: 1 });
      }),
    );
    assert.deepEqual(matchedSubscriptions, propertySafeRuntime.outboxSubscriptions);

    const propertyClientReference = makeEffectHttpApiClient(PropertyApi, {
      baseUrl: new URL('/api', property.url),
    });
    assert.equal(Effect.isEffect(propertyClientReference), true);
    assert.deepEqual(first.getByModuleId('property.registry')?.manifest.publicSurface.components, [
      {
        expose: './Dashboard',
        key: 'property.registry.dashboard',
        mfBoundaryId: 'verticalPropertyRegistry',
      },
    ]);

    const serialized = JSON.stringify(first.getByModuleId('property.registry'));
    assert.equal(serialized.includes('payloadSchema'), false);
    assert.equal(serialized.includes('leaseDurationMs'), false);
    assert.equal(serialized.includes('PropertyDashboard'), false);
    assert.equal(serialized.includes('handler'), false);
  } finally {
    await Promise.all([property.close(), documents.close()]);
  }
});
