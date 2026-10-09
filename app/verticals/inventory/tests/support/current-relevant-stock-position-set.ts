import { trustVerifiedGatewayPrincipalContext } from '@app/core-runtime';
import { CatalogSelectionSchema } from '@app/catalog/domain/catalog-selection-evidence';
import { Schema } from 'effect';

import { RelevantStockPositionSetRequestSchema } from '../../shared/domain/current-relevant-stock-position-set.ts';
import type { RelevantStockPositionSetObservation } from '../../src/persistence/current-relevant-stock-position-set-repository.ts';

const CATALOG_MODULE_ID = 'commerce.catalog';
const STOCK_UNIT_RESOURCE_TYPE = 'commerce.catalog.product-unit';
export const tenantId = '11111111-1111-4111-8111-111111111111';
const itemId = '22222222-2222-4222-8222-222222222222';
const backendId = '33333333-3333-4333-8333-333333333333';
const unitId = '44444444-4444-4444-8444-444444444444';
const sellerId = '55555555-5555-4555-8555-555555555555';
const principalId = '66666666-6666-4666-8666-666666666666';
const locationId = '77777777-7777-4777-8777-777777777777';
const positionId = '88888888-8888-4888-8888-888888888888';
const time = new Date('2026-10-05T12:00:00.000Z');
export const scope = {
  ...trustVerifiedGatewayPrincipalContext(
    {
      authBindingId: principalId,
      authContextRef: 'better-auth-session:test',
      authMethod: 'session',
      legalEntityId: sellerId,
      principalId,
      tenantId,
      trustedStorefrontId: 'storefront',
    },
    'a'.repeat(64),
  ),
  correlationId: 'test',
};
export const request = Schema.decodeUnknownSync(RelevantStockPositionSetRequestSchema)({
  commerceVerificationRequest: {
    actor: { kind: 'AUTHENTICATED_CUSTOMER', principalId },
    operationTime: time.toISOString(),
    purchasingContext: {
      channelId: 'B2C',
      contextRef: 'context',
      contextRevision: 'revision',
      marketId: 'market',
      sellingLegalEntityId: sellerId,
    },
    subject: {
      authorizationSubject: { kind: 'RETAIL' },
      kind: 'PROFILE',
      profileRef: {
        moduleId: 'commerce.customer-context',
        resourceId: principalId,
        resourceType: 'commerce.customer-context.retail-customer-profile',
        tenantId,
      },
    },
    tenantId,
  },
  mode: 'EXACT_COMMERCE_SCOPE',
  scope: {
    customerConfigurationId: 'customer',
    ownerConfigurationRef: {
      moduleId: 'commerce.inventory',
      resourceId: backendId,
      resourceType: 'commerce.inventory.inventory-backend-configuration',
      tenantId,
    },
    stockItemRef: {
      moduleId: 'commerce.inventory',
      resourceId: itemId,
      resourceType: 'commerce.inventory.stock-item',
      tenantId,
    },
    unitRef: {
      moduleId: CATALOG_MODULE_ID,
      resourceId: unitId,
      resourceType: STOCK_UNIT_RESOURCE_TYPE,
      tenantId,
    },
  },
});
export const position = {
  createdAt: time,
  customerConfigurationId: 'customer',
  endedAt: null,
  lifecycleState: 'CURRENT',
  onHandAmount: null,
  onHandEvidenceRef: null,
  onHandObservedAt: null,
  onHandState: 'UNKNOWN',
  ownerConfigurationId: backendId,
  revision: 1,
  stockItemId: itemId,
  stockLocationId: locationId,
  stockPositionId: positionId,
  stockUnitModuleId: CATALOG_MODULE_ID,
  stockUnitResourceId: unitId,
  stockUnitResourceType: STOCK_UNIT_RESOURCE_TYPE,
  stockUnitTenantId: tenantId,
  tenantId,
  updatedAt: time,
};
export const sharing = {
  channel: 'B2C',
  commerceMarketId: 'market',
  commerceValidationEvidenceRef: 'commerce-owner-proof',
  commerceValidationObservedAt: time,
  createdAt: time,
  currentRevision: 1,
  customerConfigurationId: 'customer',
  effectiveFrom: new Date('2026-10-01T00:00:00Z'),
  effectiveTo: null,
  eligibilityId: positionId,
  lifecycleState: 'CURRENT',
  ownerConfigurationId: backendId,
  sellingLegalEntityId: sellerId,
  stockPositionId: positionId,
  storefrontAppId: 'storefront',
  tenantId,
  updatedAt: time,
};
export const observation = {
  backendConfigurations: [
    {
      backendId: 'wms',
      backendKind: 'ontos_wms',
      configurationId: backendId,
      customerConfigurationId: 'customer',
      exactReservationCapability: 'SUPPORTED',
      revision: 1,
      selectedAt: time,
      stockCorrectionCapability: 'SUPPORTED',
      tenantId,
    },
  ],
  bindingHistory: [],
  bindings: [
    {
      bindingId: itemId,
      catalogSelection: Schema.decodeUnknownSync(CatalogSelectionSchema)({
        productRef: {
          moduleId: CATALOG_MODULE_ID,
          resourceId: itemId,
          resourceType: 'commerce.catalog.product',
          tenantId,
        },
        variantRef: {
          moduleId: CATALOG_MODULE_ID,
          resourceId: positionId,
          resourceType: 'commerce.catalog.variant',
          tenantId,
        },
      }),
      currentRevision: 1,
      effectiveFrom: time,
      exactSelectionKind: 'PRODUCT_VARIANT',
      exactSelectionMeaningId: 'meaning',
      stockItemId: itemId,
      stockUnitModuleId: CATALOG_MODULE_ID,
      stockUnitResourceId: unitId,
      stockUnitResourceType: STOCK_UNIT_RESOURCE_TYPE,
      stockUnitTenantId: tenantId,
      tenantId,
    },
  ],
  items: [
    {
      createdAt: time,
      exactSelectionKind: 'PRODUCT_VARIANT',
      exactSelectionMeaningId: 'meaning',
      lifecycleState: 'CURRENT',
      retiredAt: null,
      revision: 1,
      stockItemId: itemId,
      stockUnitModuleId: CATALOG_MODULE_ID,
      stockUnitResourceId: unitId,
      stockUnitResourceType: STOCK_UNIT_RESOURCE_TYPE,
      stockUnitTenantId: tenantId,
      tenantId,
    },
  ],
  locations: [
    {
      addressEvidence: null,
      createdAt: time,
      currentRevision: 1,
      displayName: 'Warehouse',
      lifecycleState: 'ACTIVE',
      physicalSiteKeys: ['site'],
      scopeKind: 'PHYSICAL_SITE',
      stockLocationId: locationId,
      successorStockLocationId: null,
      tenantId,
      transitionedAt: null,
      transitionReason: null,
      updatedAt: time,
    },
  ],
  observedAt: time,
  positions: [position],
  sharing: [sharing],
  sharingHistory: [],
} satisfies RelevantStockPositionSetObservation;

/** Raw aggregate driver row in the real SELECT order; production decoders restore dates. */
const aggregate = (rows: readonly object[]) =>
  Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Json))(JSON.stringify(rows));

export const positionSetDriverRows = (positions: RelevantStockPositionSetObservation['positions']) => [
  {
    backendConfigurations: aggregate(observation.backendConfigurations),
    bindingHistory: aggregate(observation.bindingHistory),
    bindings: aggregate(observation.bindings),
    ...Object.fromEntries(Object.entries(observation.items[0]).map(([name, value]) => [`item.${name}`, value])),
    locations: aggregate(positions.length === 0 ? [] : observation.locations),
    observedAt: observation.observedAt,
    positions: aggregate(positions),
    sharing: aggregate([]),
    sharingHistory: aggregate([]),
  },
];
