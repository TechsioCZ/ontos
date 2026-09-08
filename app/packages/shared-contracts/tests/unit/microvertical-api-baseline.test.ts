import assert from 'node:assert/strict';
import test from 'node:test';

import { Schema } from 'effect';

import {
  MicroVerticalBuildMarkerSchema,
  MicroVerticalReadinessSchema,
  createMicroVerticalOperationContext,
  microVerticalOperationAttributes,
} from '../../src/microvertical-api-baseline.ts';

const generatedBuildMetadata = {
  appId: 'inventory-stock',
  build: 'inventory-build',
  buildMarker: 'inventory-build',
  deployProfile: 'cloudflare-ssr-mf-effect-v1',
  kind: 'microvertical-delivery-unit' as const,
  packageName: '@app/inventory-stock',
  schemaVersion: 1 as const,
  sourceRevision: 'revision-123',
  surface: 'api',
  unitId: 'app/inventory-stock',
  version: '0.1.0',
};

const marker = {
  appId: generatedBuildMetadata.appId,
  build: generatedBuildMetadata.build,
  buildMarker: generatedBuildMetadata.buildMarker,
  deployProfile: generatedBuildMetadata.deployProfile,
  packageName: generatedBuildMetadata.packageName,
  sourceRevision: generatedBuildMetadata.sourceRevision,
  surface: generatedBuildMetadata.surface,
  unitId: generatedBuildMetadata.unitId,
  version: generatedBuildMetadata.version,
};

test('marker and readiness schemas preserve the generated wire representation', () => {
  const readiness = {
    checks: {
      api: 'ready' as const,
      moduleFederation: 'ready' as const,
      ssr: 'ready' as const,
      translations: 'ready' as const,
    },
    marker,
    status: 'ready' as const,
    versionSkew: 'none' as const,
  };

  assert.deepEqual(
    Schema.decodeUnknownSync(MicroVerticalBuildMarkerSchema)(generatedBuildMetadata),
    marker,
  );
  assert.deepEqual(Schema.encodeSync(MicroVerticalBuildMarkerSchema)(marker), marker);
  assert.deepEqual(Schema.decodeUnknownSync(MicroVerticalReadinessSchema)(readiness), readiness);
  assert.deepEqual(Schema.encodeSync(MicroVerticalReadinessSchema)(readiness), readiness);
});

test('constructs generated-client operation metadata with and without trace identity', () => {
  const inputWithSensitiveExtras = {
    credential: 'must-not-pass',
    method: 'GET',
    operationId: 'InventoryApi:inventory:readiness',
    payload: { secret: 'must-not-pass' },
    principalId: 'must-not-pass',
    routePath: '/inventory/readiness',
    tenantId: 'must-not-pass',
  };
  assert.deepEqual(createMicroVerticalOperationContext(inputWithSensitiveExtras), {
    method: 'GET',
    operationId: 'InventoryApi:inventory:readiness',
    routePath: '/inventory/readiness',
    source: 'generated-client',
  });
  assert.deepEqual(
    createMicroVerticalOperationContext({
      method: 'POST',
      operationId: 'InventoryApi:inventory:create',
      routePath: '/inventory',
      traceId: 'trace-123',
    }),
    {
      method: 'POST',
      operationId: 'InventoryApi:inventory:create',
      routePath: '/inventory',
      source: 'generated-client',
      traceId: 'trace-123',
    },
  );
});

test('projects only standard operation telemetry attributes', () => {
  const operationContext = {
    ...createMicroVerticalOperationContext({
      method: 'POST',
      operationId: 'InventoryApi:inventory:create',
      routePath: '/inventory',
      traceId: 'trace-123',
    }),
    authorization: 'must-not-pass',
    credential: 'must-not-pass',
    legalEntityId: 'must-not-pass',
    payload: { secret: 'must-not-pass' },
    principalId: 'must-not-pass',
    tenantId: 'must-not-pass',
  };

  assert.deepEqual(microVerticalOperationAttributes(operationContext), {
    'modernjs.operation.id': 'InventoryApi:inventory:create',
    'modernjs.operation.method': 'POST',
    'modernjs.operation.route': '/inventory',
    'modernjs.operation.source': 'generated-client',
    'modernjs.trace.id': 'trace-123',
  });
  assert.deepEqual(
    microVerticalOperationAttributes(
      createMicroVerticalOperationContext({
        method: 'GET',
        operationId: 'InventoryApi:inventory:list',
        routePath: '/inventory',
      }),
    ),
    {
      'modernjs.operation.id': 'InventoryApi:inventory:list',
      'modernjs.operation.method': 'GET',
      'modernjs.operation.route': '/inventory',
      'modernjs.operation.source': 'generated-client',
    },
  );
});
