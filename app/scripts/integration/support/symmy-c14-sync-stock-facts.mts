import { createHash, randomUUID } from 'node:crypto';

import type { ProductUnitRefSchema } from '@app/catalog-selection-contracts/resources/product-unit';
import { SelectInventoryBackendPayloadSchema } from '@app/inventory/backend-configuration';
import { DefineSourceProvisioningPolicyPayloadSchema } from '@app/inventory/actions/define-source-provisioning-policy';
import {
  executeCreateStockLocationWithAuthorization,
  executeDefineSourceProvisioningPolicyWithAuthorization,
  executeSelectInventoryBackendWithAuthorization,
} from '@app/inventory/api/client';
import type { makeApiKeyGatewayNativeFixture } from '@app/shell-super-app/testing/api-key-gateway-native';
import { SymmyRouteExecutionConfigurationSchema } from '@app/symmy-integration/symmy-internal-contracts';
import { Effect, Schema } from 'effect';

import { internalSyncSource } from './symmy-c14-sync-plans.mts';
import { SymmyC14ProductFixtureUnavailable } from './symmy-c14-product-runtime.mts';

const inventoryModule = 'commerce.inventory';
export const internalStockBackendId = 'INTERNAL_C14_DECLARED_EXTERNAL_STOCK';
export const internalStockConfigurationId = 'INTERNAL_C14_DECLARED_CUSTOMER_CONFIGURATION';
export const internalStockItemKeys = ['INTERNAL_C14_UNSEEN_A', 'INTERNAL_C14_UNSEEN_B'] as const;
const locationKey = 'INTERNAL_C14_LOCATION';

/** One-time public operator setup. No Item, Position, item correlation or Catalog binding is seeded. */
export const makeInternalStockSetup = Effect.fn('InternalC14Stock.setup')(function* setup(input: {
  readonly apiBaseUrl: string;
  readonly compositionRevision: string;
  readonly shell: Pick<Effect.Success<ReturnType<typeof makeApiKeyGatewayNativeFixture>>, 'issueFixtureSetupGateway'>;
  readonly tenantId: string;
  readonly unitRef: typeof ProductUnitRefSchema.Encoded;
}) {
  const authorization = input.shell
    .issueFixtureSetupGateway({ audience: 'inventory' })
    .pipe(Effect.map(({ token }) => `Bearer ${token}`));
  const options = {
    baseUrl: input.apiBaseUrl,
    compositionRevision: input.compositionRevision,
    idempotencyKey: randomUUID(),
  };
  const selected = yield* executeSelectInventoryBackendWithAuthorization(
    yield* Schema.decodeUnknownEffect(SelectInventoryBackendPayloadSchema)({
      authorizationTargetRef: {
        moduleId: inventoryModule,
        resourceId: randomUUID(),
        resourceType: 'commerce.inventory.inventory-backend-configuration',
        tenantId: input.tenantId,
      },
      customerConfigurationId: internalStockConfigurationId,
      selection: {
        backend: 'external_business_system',
        backendId: internalStockBackendId,
        exactReservationCapability: 'UNSUPPORTED',
        stockCorrectionCapability: 'UNSUPPORTED',
      },
    }),
    yield* authorization,
    randomUUID(),
    options,
  );
  if (!('configuration' in selected) || 'conflictRef' in selected) {
    return yield* new SymmyC14ProductFixtureUnavailable({
      message: 'Public Inventory backend selection did not commit',
    });
  }
  const created = yield* executeCreateStockLocationWithAuthorization(
    {
      displayName: 'Internal source policy physical site',
      operationalScope: { _tag: 'PHYSICAL_SITE', physicalSiteKeys: ['INTERNAL_C14_EXPLICIT_SITE'] },
    },
    yield* authorization,
    randomUUID(),
    { ...options, idempotencyKey: randomUUID() },
  );
  if (!('stockLocation' in created)) {
    return yield* new SymmyC14ProductFixtureUnavailable({ message: 'Public Inventory location setup did not commit' });
  }
  const defined = yield* executeDefineSourceProvisioningPolicyWithAuthorization(
    yield* Schema.decodeUnknownEffect(DefineSourceProvisioningPolicyPayloadSchema)({
      customerConfigurationId: internalStockConfigurationId,
      externalScope: 'INTERNAL_C14_EXPLICIT_STOCK_SCOPE',
      locations: [{ locationKey, stockLocationRef: created.stockLocation.ref }],
      namespace: 'INTERNAL_C14_STOCK',
      ownerConfigurationRef: {
        moduleId: inventoryModule,
        resourceId: selected.configuration.configurationId,
        resourceType: 'commerce.inventory.inventory-backend-configuration',
        tenantId: input.tenantId,
      },
      unitRef: input.unitRef,
    }),
    yield* authorization,
    randomUUID(),
    { ...options, idempotencyKey: randomUUID() },
  );
  if (!('policy' in defined)) {
    return yield* new SymmyC14ProductFixtureUnavailable({
      message: 'Public Inventory source policy setup did not commit',
    });
  }
  return { policy: defined.policy };
});

type InternalStockSetup = Effect.Success<ReturnType<typeof makeInternalStockSetup>>;
const operation = (entrypointKey: string, moduleId = inventoryModule, schemaVersion = '1') => ({
  entrypointKey,
  moduleId,
  schemaVersion,
});
const enrollment = (input: {
  readonly product: boolean;
  readonly setup: InternalStockSetup;
  readonly sourceRouteId: string;
}) => {
  const operations = input.product
    ? [
        operation('commerce.catalog.create-product', 'commerce.catalog', '2'),
        operation('commerce.inventory.provision-source-stock-item'),
      ]
    : [
        operation('commerce.inventory.import-source-assertion'),
        operation('commerce.inventory.api.source-stock-position-resolution'),
      ];
  return Schema.decodeUnknownEffect(SymmyRouteExecutionConfigurationSchema)({
    inventoryBackendId: internalStockBackendId,
    inventorySource: input.setup.policy,
    items: [
      {
        effects: operations.map((owner, index) => ({ effectKey: `authority-${index}`, operation: owner })),
        itemKey: 'source',
        source: {
          entityKind: input.product ? 'PRODUCT' : 'STOCK',
          issuerId: internalSyncSource.issuerId,
          sourceNamespace: internalSyncSource.namespace,
          sourceRecordId: 'INTERNAL_C14_SOURCE_ENROLLMENT',
        },
      },
    ],
    sourceRouteId: input.sourceRouteId,
  }).pipe(Effect.flatMap(Schema.encodeEffect(SymmyRouteExecutionConfigurationSchema)));
};

/** Both routes pin the same integration-wide policy, never the SKUs they will later receive. */
export const makeInternalStockEnrollment = (input: {
  readonly setup: InternalStockSetup;
  readonly sourceRouteId: string;
}) => enrollment({ ...input, product: false });
export const makeInternalStockProductEnrollment = (input: {
  readonly setup: InternalStockSetup;
  readonly sourceRouteId: string;
}) => enrollment({ ...input, product: true });

export const makeInternalStockRow = (input: {
  readonly amount: string;
  readonly businessObservedAt: string;
  readonly itemKey: string;
  readonly revision: string;
  readonly sourceReference: string;
  readonly unitRef: typeof ProductUnitRefSchema.Encoded;
}) => ({
  businessObservedAt: input.businessObservedAt,
  itemKey: input.itemKey,
  locationKey,
  quantity: { amount: input.amount, unitRef: input.unitRef },
  revision: input.revision,
  sourceReference: input.sourceReference,
});

/** The assertion identity the route derives from the Idempotency-Key and the row index. */
export const deriveInternalStockAssertionId = (idempotencyKey: string, index: number) => {
  const digest = createHash('sha256').update(`assertion\u0000${idempotencyKey}\u0000${index}`).digest('hex');
  return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-5${digest.slice(13, 16)}-${'89ab'.charAt(Number.parseInt(digest.charAt(16), 16) % 4)}${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
};
