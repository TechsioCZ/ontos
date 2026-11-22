import { computeActionRequestHash } from '@app/core-runtime/access/enforcement';
import { NodeCrypto } from '@effect/platform-node';
import { Array as EffectArray, DateTime, Duration, Effect, Option, Schema, Struct } from 'effect';
import { TestClock } from 'effect/testing';
import { assert, describe, expect, it } from 'effect-rstest';

import {
  SourceStockItemProvisioningReceiptRequestSchema,
  SourceStockItemProvisioningReceiptResponseSchema,
} from '../../shared/apis/source-stock-item-provisioning-receipt.ts';
import {
  SourceStockPositionResolutionRequestSchema,
  SourceStockPositionResolutionResponseSchema,
} from '../../shared/apis/source-stock-position-resolution.ts';
import { makeCatalogToStockBindingLifecycle } from '../../shared/domain/catalog-to-stock-binding.ts';
import type {
  CatalogToStockBinding,
  CatalogToStockBindingPersistence,
} from '../../shared/domain/catalog-to-stock-binding.ts';
import {
  ExternalStockCorrelationSchema,
  makeExternalStockCorrelationLifecycle,
} from '../../shared/domain/external-stock-correlation.ts';
import type {
  ExternalStockCorrelation,
  ExternalStockCorrelationPersistence,
  ExternalStockKey,
} from '../../shared/domain/external-stock-correlation.ts';
import { InventoryBackendConfigurationSchema } from '../../shared/domain/inventory-backend-configuration.ts';
import type { InventoryBackendConfiguration } from '../../shared/domain/inventory-backend-configuration.ts';
import { SourceProvisioningPolicyRejected } from '../../shared/domain/source-provisioning-policy-rejected.ts';
import { SourceStockItemProvisioningRejected } from '../../shared/domain/source-stock-item-provisioning-rejected.ts';
import {
  ProvisionSourceStockItemInputSchema,
  ProvisionSourceStockItemPayloadSchema,
  SourceProvisioningPolicySchema,
  SourceProvisioningExpectedPolicySchema,
  SourceStockItemProvisioningInvocationIdSchema,
} from '../../shared/domain/source-provisioning.ts';
import type {
  ProvisionSourceStockItemInput,
  SourceProvisioningPolicy,
  SourceStockItemProvisioningReceipt,
} from '../../shared/domain/source-provisioning.ts';
import { StockItemRejected, StockItemSchema } from '../../shared/domain/stock-item.ts';
import type { StockItem } from '../../shared/domain/stock-item.ts';
import { StockLocationSchema } from '../../shared/domain/stock-location.ts';
import type { StockPosition } from '../../shared/domain/stock-position.ts';
import { DefineSourceProvisioningPolicyPayloadSchema } from '../../shared/actions/define-source-provisioning-policy.ts';
import { defineSourceProvisioningPolicyAction } from '../../src/actions/define-source-provisioning-policy.action.ts';
import { provisionSourceStockItemAction } from '../../src/actions/provision-source-stock-item.action.ts';
import {
  sourceStockItemProvisioningReceiptHandler,
  sourceStockItemProvisioningReceiptRead,
} from '../../src/api/source-stock-item-provisioning-receipt.read.ts';
import {
  sourceStockPositionResolutionHandler,
  sourceStockPositionResolutionRead,
} from '../../src/api/source-stock-position-resolution.read.ts';
import type { SourceStockPositionResolutionServices } from '../../src/api/source-stock-position-resolution.read.ts';
import type { StockPositionPersistence } from '../../src/persistence/stock-position-repository.ts';
import {
  provisionSourceStockItem,
  recordSourceProvisioningPolicy,
  sourceProvisioningPolicyHasCurrentOwner,
} from '../../src/services/source-provisioning.service.ts';
import type {
  SourceProvisioningCorrelations,
  SourceProvisioningPolicyPorts,
  SourceStockItemProvisioningPorts,
} from '../../src/services/source-provisioning.service.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const configurationId = '22222222-2222-4222-8222-222222222222';
const unitId = '33333333-3333-4333-8333-333333333333';
const otherUnitId = '33333333-3333-4333-8333-333333333334';
const policyId = '44444444-4444-4444-8444-444444444444';
const warehouseId = '55555555-5555-4555-8555-555555555551';
const outletId = '55555555-5555-4555-8555-555555555552';
const variantId = '66666666-6666-4666-8666-666666666661';
const customerConfigurationId = 'akros';
const issuer = { backendId: 'akros-erp', backendKind: 'external_business_system' } as const;

const unitRef = (resourceId = unitId) =>
  ({
    moduleId: 'commerce.catalog',
    resourceId,
    resourceType: 'commerce.catalog.product-unit',
    tenantId,
  }) as const;
const locationRef = (resourceId: string) =>
  ({
    moduleId: 'commerce.inventory',
    resourceId,
    resourceType: 'commerce.inventory.stock-location',
    tenantId,
  }) as const;
const ownerConfigurationRef = {
  moduleId: 'commerce.inventory',
  resourceId: configurationId,
  resourceType: 'commerce.inventory.inventory-backend-configuration',
  tenantId,
};

const configuration = (backend: 'external_business_system' | 'ontos_wms' = 'external_business_system') =>
  Schema.decodeUnknownSync(InventoryBackendConfigurationSchema)({
    configurationId,
    customerConfigurationId,
    revision: 1,
    selectedAt: '2026-11-20T08:00:00.000Z',
    selection: {
      backend,
      backendId: issuer.backendId,
      exactReservationCapability: backend === 'ontos_wms' ? 'SUPPORTED' : 'UNSUPPORTED',
      stockCorrectionCapability: backend === 'ontos_wms' ? 'SUPPORTED' : 'UNSUPPORTED',
    },
    tenantId,
  });

const outletLocation = { locationKey: 'AKROS-PRODEJNA', stockLocationRef: locationRef(outletId) };
const warehouseLocation = { locationKey: 'AKROS-SKLAD-1', stockLocationRef: locationRef(warehouseId) };

const policy: SourceProvisioningPolicy = Schema.decodeUnknownSync(SourceProvisioningPolicySchema)({
  customerConfigurationId,
  definedAt: '2026-11-20T09:00:00.000Z',
  effectiveFrom: '2026-11-20T08:00:00.000Z',
  externalScope: 'akros',
  issuer,
  locations: [outletLocation, warehouseLocation],
  namespace: 'akros-erp',
  ownerConfigurationRef,
  policyRef: {
    moduleId: 'commerce.inventory',
    resourceId: policyId,
    resourceType: 'commerce.inventory.source-provisioning-policy',
    tenantId,
  },
  unitRef: unitRef(),
});

const expectedPolicy = Schema.decodeUnknownSync(SourceProvisioningExpectedPolicySchema)(policy);

const selection = (selectedVariantId = variantId) =>
  ({
    productRef: {
      moduleId: 'commerce.catalog',
      resourceId: '66666666-6666-4666-8666-666666666660',
      resourceType: 'commerce.catalog.product',
      tenantId,
    },
    variantRef: {
      moduleId: 'commerce.catalog',
      resourceId: selectedVariantId,
      resourceType: 'commerce.catalog.variant',
      tenantId,
    },
  }) as const;

type ProvisionInputOverrides = Partial<typeof ProvisionSourceStockItemInputSchema.Encoded>;

const provisionInput = (overrides: ProvisionInputOverrides = {}): ProvisionSourceStockItemInput =>
  Schema.decodeUnknownSync(ProvisionSourceStockItemInputSchema)({
    catalogSelection: selection(),
    exactSelectionMeaning: { id: `catalog-variant:${variantId}`, kind: 'PRODUCT_VARIANT' },
    expectedPolicy,
    itemKey: 'AKROS-10001-V1',
    policyRef: policy.policyRef,
    ...overrides,
  });

const reversedLocationInput = () =>
  provisionInput({ expectedPolicy: { ...expectedPolicy, locations: EffectArray.reverse(expectedPolicy.locations) } });
const movedLocationInput = () =>
  provisionInput({
    expectedPolicy: {
      ...expectedPolicy,
      locations: [
        { ...outletLocation, stockLocationRef: warehouseLocation.stockLocationRef },
        { ...warehouseLocation, stockLocationRef: outletLocation.stockLocationRef },
      ],
    },
  });

const invocation = (suffix: string) =>
  SourceStockItemProvisioningInvocationIdSchema.make(`77777777-7777-4777-8777-${suffix.padStart(12, '0')}`);

const sameKey = (left: ExternalStockKey, right: ExternalStockKey) =>
  left.customerConfigurationId === right.customerConfigurationId &&
  left.externalScope === right.externalScope &&
  left.externalValue === right.externalValue &&
  left.identifierKind === right.identifierKind &&
  left.issuer.backendId === right.issuer.backendId &&
  left.issuer.backendKind === right.issuer.backendKind &&
  left.namespace === right.namespace &&
  left.tenantId === right.tenantId;

const notExercised = Effect.die('This owner operation is not exercised by provisioning');

/** In-memory owner state standing in for the Inventory tables one transaction sees. */
const makeOwnerState = (selected: InventoryBackendConfiguration = configuration()) => {
  const stockItems = new Map<string, StockItem>();
  const positions = new Map<string, StockPosition>();
  const correlations: ExternalStockCorrelation[] = policy.locations.map((location, index) =>
    Schema.decodeUnknownSync(ExternalStockCorrelationSchema)({
      confirmedAt: policy.definedAt,
      correlationRef: {
        moduleId: 'commerce.inventory',
        resourceId: `99999999-9999-4999-8999-${String(index + 1).padStart(12, '0')}`,
        resourceType: 'commerce.inventory.external-stock-correlation',
        tenantId,
      },
      effectivePeriod: { from: policy.effectiveFrom, to: null },
      externalKey: {
        customerConfigurationId,
        externalScope: policy.externalScope,
        externalValue: location.locationKey,
        identifierKind: 'LOCATION',
        issuer,
        namespace: policy.namespace,
        tenantId,
      },
      lifecycle: 'CURRENT',
      ownerEvidenceRef: `seed:${location.locationKey}`,
      revision: 1,
      target: { _tag: 'STOCK_LOCATION', ref: location.stockLocationRef },
    }),
  );
  const bindings: CatalogToStockBinding[] = [];
  const receipts: SourceStockItemProvisioningReceipt[] = [];
  const policies = new Map<string, SourceProvisioningPolicy>([[policyId, policy]]);
  const currentItem = (meaningId: string) =>
    [...stockItems.values()].find(
      (item) => item.exactSelectionMeaning.id === meaningId && item.lifecycle === 'CURRENT',
    );

  const positionPersistence: StockPositionPersistence = {
    create: (position) => Effect.sync(() => positions.set(position.ref.resourceId, position)).pipe(Effect.as(position)),
    findCurrent: (scope) =>
      Effect.succeed(
        Option.fromNullishOr(
          [...positions.values()].find(
            (position) =>
              position.lifecycle === 'CURRENT' &&
              position.scope.customerConfigurationId === scope.customerConfigurationId &&
              position.scope.stockItemRef.resourceId === scope.stockItemRef.resourceId &&
              position.scope.stockLocationRef.resourceId === scope.stockLocationRef.resourceId,
          ),
        ),
      ),
    lockEstablishmentTargets: () => Effect.void,
    read: (ref) => Effect.succeed(Option.fromNullishOr(positions.get(ref.resourceId))),
    save: ({ next }) => Effect.succeed(next),
  };
  const correlationPersistence: ExternalStockCorrelationPersistence = {
    endCurrent: () => notExercised,
    findByRef: () => notExercised,
    findEffective: (key, asOf) =>
      Effect.succeed(
        correlations.filter(
          (correlation) =>
            sameKey(correlation.externalKey, key) &&
            correlation.effectivePeriod.from <= asOf &&
            (correlation.effectivePeriod.to === null || correlation.effectivePeriod.to > asOf),
        ),
      ),
    insertCurrent: (correlation) => Effect.sync(() => correlations.push(correlation)).pipe(Effect.as(correlation)),
    replaceCurrent: () => notExercised,
    saveConfirmation: () => notExercised,
  };
  const correlationPorts: SourceProvisioningCorrelations = {
    current: correlationPersistence,
    lifecycle: {
      establish: ({ correlationResourceId, input }) =>
        makeExternalStockCorrelationLifecycle(correlationPersistence, {
          makeCorrelationId: () => correlationResourceId,
        }).establish(input),
    },
  };
  const bindingPersistence: CatalogToStockBindingPersistence = {
    endCurrent: () => notExercised,
    findCurrentByExactSelectionMeaning: (_tenantId, meaning) =>
      Effect.succeed(
        bindings.filter(
          ({ exactSelectionMeaning }) =>
            exactSelectionMeaning.id === meaning.id && exactSelectionMeaning.kind === meaning.kind,
        ),
      ),
    findCurrentByStockItem: (ref) =>
      Effect.succeed(
        Option.fromNullishOr(bindings.find((binding) => binding.stockItemRef.resourceId === ref.resourceId)),
      ),
    insertCurrent: (binding) => Effect.sync(() => bindings.push(binding)).pipe(Effect.as(binding)),
    readHistory: () => notExercised,
    replaceCurrent: () => notExercised,
  };
  const configurations = { findCurrent: () => Effect.succeed(Option.some(selected)) };
  const provisioningPorts: SourceStockItemProvisioningPorts = {
    bindingLifecycle: {
      establish: ({ bindingId, candidate }) =>
        makeCatalogToStockBindingLifecycle(bindingPersistence, {
          makeBindingId: () => bindingId,
          now: Effect.succeed('2026-11-21T10:00:00.000Z'),
        }).establish(candidate),
    },
    bindings: bindingPersistence,
    configurations,
    correlations: correlationPorts,
    policies: {
      findByRef: (ref) => Effect.succeed(Option.fromNullishOr(policies.get(ref.resourceId))),
      lockOwnerConfiguration: () => Effect.void,
    },
    positions: positionPersistence,
    receipts: {
      append: (receipt) => Effect.sync(() => receipts.push(receipt)).pipe(Effect.as(receipt)),
      findByInvocation: (id) =>
        Effect.sync(() => Option.fromNullishOr(receipts.find((receipt) => receipt.actionInvocationId === id))),
    },
    stockItems: {
      findByExactSelectionMeaning: (_tenantId, meaningId) =>
        Effect.succeed(Option.fromNullishOr(currentItem(meaningId))),
      findById: (_tenantId, stockItemId) => Effect.succeed(Option.fromNullishOr(stockItems.get(stockItemId))),
      insert: (item) => {
        const existing = currentItem(item.exactSelectionMeaning.id);
        return existing === undefined
          ? Effect.sync(() => stockItems.set(item.stockItemRef.resourceId, item)).pipe(Effect.as(item))
          : Effect.fail(
              new StockItemRejected({
                code: 'stock_item_rejected',
                exactSelectionMeaningId: existing.exactSelectionMeaning.id,
                reason: 'exact_selection_meaning_already_registered',
                stockItemId: existing.stockItemRef.resourceId,
              }),
            );
      },
    },
  };
  const locations = new Map(
    [warehouseId, outletId].map((id) => [
      id,
      Schema.decodeUnknownSync(StockLocationSchema)({
        displayName: `Location ${id}`,
        lifecycle: { _tag: 'ACTIVE' },
        operationalScope: { _tag: 'PHYSICAL_SITE', physicalSiteKeys: [`site:${id}`] },
        ref: locationRef(id),
        revision: 1,
      }),
    ]),
  );
  const policyPorts: SourceProvisioningPolicyPorts = {
    configurations,
    correlations: correlationPorts,
    locations: { read: (ref) => Effect.succeed(Option.fromNullishOr(locations.get(ref.resourceId))) },
    policies: {
      findByOwnerConfiguration: (ownerId) =>
        Effect.succeed(
          Option.fromNullishOr(
            [...policies.values()].find(({ ownerConfigurationRef: ref }) => ref.resourceId === ownerId),
          ),
        ),
      insert: (candidate) =>
        Effect.sync(() => policies.set(candidate.policyRef.resourceId, candidate)).pipe(
          Effect.as({ outcome: 'INSERTED' as const, policy: candidate }),
        ),
      lockOwnerConfiguration: () => Effect.void,
    },
  };
  return {
    bindings,
    configurations,
    correlations,
    define: (locationsInput: readonly (typeof outletLocation)[]) =>
      recordSourceProvisioningPolicy(policyPorts, {
        input: Schema.decodeUnknownSync(DefineSourceProvisioningPolicyPayloadSchema)({
          customerConfigurationId,
          externalScope: 'akros',
          locations: locationsInput,
          namespace: 'akros-erp',
          ownerConfigurationRef,
          unitRef: unitRef(),
        }),
        tenantId,
      }),
    policies,
    positions,
    provision: (suffix: string, input = provisionInput()) =>
      provisionSourceStockItem(provisioningPorts, { actionInvocationId: invocation(suffix), input }),
    receipts,
    stockItems,
  };
};

const existingItem = (overrides: Partial<typeof StockItemSchema.Encoded> = {}) =>
  Schema.decodeUnknownSync(StockItemSchema)({
    createdAt: '2026-11-20T09:30:00.000Z',
    exactSelectionMeaning: { id: `catalog-variant:${variantId}`, kind: 'PRODUCT_VARIANT' },
    lifecycle: 'CURRENT',
    retiredAt: null,
    revision: 1,
    stockItemRef: {
      moduleId: 'commerce.inventory',
      resourceId: '88888888-8888-4888-8888-888888888881',
      resourceType: 'commerce.inventory.stock-item',
      tenantId,
    },
    unitRef: unitRef(),
    ...overrides,
  });

const isProvisioningRejected = Schema.is(SourceStockItemProvisioningRejected);
const isPolicyRejected = Schema.is(SourceProvisioningPolicyRejected);

describe('Inventory source stock item provisioning', () => {
  it.live('provisions maximum-length ERP keys with distinct bounded evidence and stable replay', () =>
    Effect.gen(function* boundedItemEvidence() {
      const state = makeOwnerState();
      const originalInput = provisionInput({ itemKey: 'A'.repeat(300) });
      const first = yield* state.provision('1', originalInput);
      const otherVariant = '66666666-6666-4666-8666-666666666662';
      yield* state.provision(
        '2',
        provisionInput({
          catalogSelection: selection(otherVariant),
          exactSelectionMeaning: { id: `catalog-variant:${otherVariant}`, kind: 'PRODUCT_VARIANT' },
          itemKey: 'B'.repeat(300),
        }),
      );
      const correlations = state.correlations.filter(({ externalKey }) => externalKey.identifierKind === 'ITEM');
      expect(correlations.map(({ externalKey }) => externalKey.externalValue)).toEqual([
        'A'.repeat(300),
        'B'.repeat(300),
      ]);
      expect(correlations.every(({ ownerEvidenceRef }) => ownerEvidenceRef.length <= 300)).toBe(true);
      expect(new Set(correlations.map(({ ownerEvidenceRef }) => ownerEvidenceRef)).size).toBe(2);
      const replay = yield* state.provision('3', originalInput);
      expect(replay.itemCorrelation.ref).toEqual(first.itemCorrelation.ref);
      expect(state.correlations.filter(({ externalKey }) => externalKey.identifierKind === 'ITEM')).toEqual(
        correlations,
      );
    }).pipe(Effect.provide(NodeCrypto.layer)),
  );

  it('requires canonical policy references at provisioning and receipt recovery boundaries', () => {
    const nativeId = 'abcdef01-2345-4678-9abc-def012345678';
    const reference = { ...policy.policyRef, resourceId: nativeId, tenantId: nativeId };
    const referenceSchema = ProvisionSourceStockItemInputSchema.fields.policyRef;
    expect(Schema.is(referenceSchema)(reference)).toBe(true);
    for (const field of ['resourceId', 'tenantId'] as const) {
      expect(Schema.is(referenceSchema)({ ...reference, [field]: nativeId.toUpperCase() })).toBe(false);
    }
    const input = provisionInput({
      policyRef: { ...policy.policyRef, resourceId: nativeId },
    });
    const receiptRequest = { actionInvocationId: invocation('1'), input };
    expect(Schema.is(ProvisionSourceStockItemInputSchema)(input)).toBe(true);
    expect(Schema.is(SourceStockItemProvisioningReceiptRequestSchema)(receiptRequest)).toBe(true);
    const noncanonical = {
      ...input,
      policyRef: { ...input.policyRef, resourceId: nativeId.toUpperCase() },
    };
    expect(Schema.is(ProvisionSourceStockItemInputSchema)(noncanonical)).toBe(false);
    expect(Schema.is(SourceStockItemProvisioningReceiptRequestSchema)({ ...receiptRequest, input: noncanonical })).toBe(
      false,
    );
  });

  it('rejects noncanonical native policy identifiers without changing case-sensitive ERP keys', () => {
    const nativeId = 'abcdef01-2345-4678-9abc-def012345678';
    const payload = {
      customerConfigurationId,
      externalScope: 'Akros',
      locations: [
        {
          locationKey: 'Akros-Warehouse',
          stockLocationRef: { ...locationRef(nativeId), tenantId: nativeId },
        },
      ],
      namespace: 'Akros-ERP',
      ownerConfigurationRef: { ...ownerConfigurationRef, resourceId: nativeId, tenantId: nativeId },
      unitRef: { ...unitRef(nativeId), tenantId: nativeId },
    };
    expect(Schema.decodeUnknownSync(DefineSourceProvisioningPolicyPayloadSchema)(payload)).toEqual(payload);
    const uppercaseId = nativeId.toUpperCase();
    for (const field of ['resourceId', 'tenantId'] as const) {
      for (const reference of ['ownerConfigurationRef', 'unitRef'] as const) {
        expect(
          Schema.is(DefineSourceProvisioningPolicyPayloadSchema)({
            ...payload,
            [reference]: { ...payload[reference], [field]: uppercaseId },
          }),
        ).toBe(false);
      }
      expect(
        Schema.is(DefineSourceProvisioningPolicyPayloadSchema)({
          ...payload,
          locations: payload.locations.map((location) => ({
            ...location,
            stockLocationRef: { ...location.stockLocationRef, [field]: uppercaseId },
          })),
        }),
      ).toBe(false);
    }
  });

  it('validates the shared Tenant authority and backend selection without coercing incompatible brands', () => {
    const now = '2026-11-22T10:00:00.000Z';
    expect(sourceProvisioningPolicyHasCurrentOwner(policy, configuration(), now)).toBe(true);
    expect(sourceProvisioningPolicyHasCurrentOwner(policy, configuration('ontos_wms'), now)).toBe(false);
    expect(sourceProvisioningPolicyHasCurrentOwner(policy, configuration(), '2026-11-19T10:00:00.000Z')).toBe(false);
    const otherTenant = Schema.decodeUnknownSync(InventoryBackendConfigurationSchema)({
      ...configuration(),
      tenantId: '11111111-1111-4111-8111-111111111112',
    });
    expect(sourceProvisioningPolicyHasCurrentOwner(policy, otherTenant, now)).toBe(false);
  });

  it('encodes the same Core action payload for the same allowed-location set', () => {
    const encode = Schema.encodeSync(provisionSourceStockItemAction.descriptor.payloadSchema);
    expect(provisionSourceStockItemAction.descriptor.payloadSchema).toBe(ProvisionSourceStockItemPayloadSchema);
    expect(encode(reversedLocationInput())).toEqual(encode(provisionInput()));
    expect(encode(movedLocationInput())).not.toEqual(encode(provisionInput()));
    const decoded = Schema.decodeUnknownSync(ProvisionSourceStockItemPayloadSchema)(reversedLocationInput());
    expect(decoded.expectedPolicy.locations).toEqual(provisionInput().expectedPolicy.locations);
    const foreignTenant = {
      ...provisionInput(),
      policyRef: Schema.decodeUnknownSync(ProvisionSourceStockItemInputSchema.fields.policyRef)({
        ...policy.policyRef,
        tenantId: '11111111-1111-4111-8111-111111111112',
      }),
    };
    expect(() => Schema.decodeUnknownSync(ProvisionSourceStockItemPayloadSchema)(foreignTenant)).toThrow();
    expect(() => encode(foreignTenant)).toThrow();
  });

  it('publishes the exact canonical owner request identity without changing receipt input order', () => {
    const principal = { principalId: '11111111-1111-4111-8111-111111111113', tenantId };
    const { actionKey, owningModuleKey, payloadSchema, schemaVersion } = provisionSourceStockItemAction.descriptor;
    const ownerHash = computeActionRequestHash({
      actionKey,
      normalizedPayload: Schema.encodeSync(payloadSchema)(provisionInput()),
      owningModuleKey,
      principal,
      schemaVersion,
      target: {},
    });
    for (const input of [provisionInput(), reversedLocationInput()]) {
      expect(
        computeActionRequestHash({
          actionKey,
          normalizedPayload: Schema.encodeSync(ProvisionSourceStockItemPayloadSchema)(input),
          owningModuleKey,
          principal,
          schemaVersion,
          target: {},
        }),
      ).toBe(ownerHash);
      const receipt = Schema.decodeUnknownSync(SourceStockItemProvisioningReceiptRequestSchema)({
        actionInvocationId: invocation('1'),
        input,
      });
      expect(receipt.input.expectedPolicy.locations).toEqual(input.expectedPolicy.locations);
    }
    expect(
      computeActionRequestHash({
        actionKey,
        normalizedPayload: Schema.encodeSync(ProvisionSourceStockItemPayloadSchema)(movedLocationInput()),
        owningModuleKey,
        principal,
        schemaVersion,
        target: {},
      }),
    ).not.toBe(ownerHash);
  });

  it.live('replays the original invocation across reordered locations but rejects a moved location', () =>
    Effect.gen(function* stableInvocationReplay() {
      const state = makeOwnerState();
      const original = yield* state.provision('1', reversedLocationInput());
      expect(yield* state.provision('1', provisionInput())).toEqual(original);
      const different = yield* state.provision('1', movedLocationInput()).pipe(Effect.flip);
      assert(isProvisioningRejected(different));
      expect(different.reason).toBe('POLICY_TERMS_MISMATCH');
      expect(state.receipts[0]?.input).toEqual(reversedLocationInput());
      expect(state.receipts).toHaveLength(1);
      expect(state.receipts[0]?.provisioning.stockItem.disposition).toBe('ESTABLISHED');
    }).pipe(Effect.provide(NodeCrypto.layer)),
  );

  it('does not admit a bare policy reference', () => {
    expect(Schema.is(ProvisionSourceStockItemInputSchema)(Struct.omit(provisionInput(), ['expectedPolicy']))).toBe(
      false,
    );
  });

  it.live('rejects any mismatched enrolled term before mutating Inventory', () =>
    Effect.gen(function* refusesForeignTerms() {
      const state = makeOwnerState();
      const originalCorrelations = [...state.correlations];
      for (const mismatch of [
        { customerConfigurationId: 'another-customer' },
        { issuer: { ...issuer, backendId: 'another-erp' } },
        { issuer: { ...issuer, backendKind: 'ontos_wms' } },
        { namespace: 'another-namespace' },
        { externalScope: 'another-scope' },
        { unitRef: unitRef(otherUnitId) },
        { locations: [outletLocation] },
        { locations: [...policy.locations, { locationKey: 'extra', stockLocationRef: locationRef(otherUnitId) }] },
        { locations: [outletLocation, { ...warehouseLocation, locationKey: 'renamed' }] },
        {
          locations: [
            { ...outletLocation, stockLocationRef: warehouseLocation.stockLocationRef },
            { ...warehouseLocation, stockLocationRef: outletLocation.stockLocationRef },
          ],
        },
      ] as const) {
        const input = provisionInput({ expectedPolicy: { ...expectedPolicy, ...mismatch } });
        const failure = yield* Effect.flip(state.provision('1', input));
        assert(isProvisioningRejected(failure));
        expect(failure.reason).toBe('POLICY_TERMS_MISMATCH');
        expect(failure.conflictRef).toEqual(policy.policyRef);
        expect([state.stockItems.size, state.positions.size, state.bindings.length, state.receipts.length]).toEqual([
          0, 0, 0, 0,
        ]);
        expect(state.correlations).toEqual(originalCorrelations);
      }
      const reordered = provisionInput({
        expectedPolicy: { ...expectedPolicy, locations: EffectArray.reverse(expectedPolicy.locations) },
      });
      const first = yield* state.provision('1', reordered);
      expect(yield* state.provision('1', reordered)).toEqual(first);
      expect(state.receipts).toHaveLength(1);
    }).pipe(Effect.provide(NodeCrypto.layer)),
  );

  it.live('does not recreate a revoked LOCATION correlation or provision through a different backend', () =>
    Effect.gen(function* revokedAuthority() {
      const state = makeOwnerState();
      state.correlations.splice(0, 1);
      const revoked = yield* state.provision('1').pipe(Effect.flip);
      assert(isProvisioningRejected(revoked));
      expect(revoked.reason).toBe('STOCK_LOCATION_NOT_ACTIVE');
      expect(state.stockItems.size).toBe(0);
      expect(state.receipts).toHaveLength(0);
      const wrongOwner = makeOwnerState(configuration('ontos_wms'));
      const rejected = yield* wrongOwner.provision('1').pipe(Effect.flip);
      assert(isProvisioningRejected(rejected));
      expect(rejected.reason).toBe('BACKEND_CONFLICT');
      expect(wrongOwner.stockItems.size).toBe(0);
    }).pipe(Effect.provide(NodeCrypto.layer)),
  );

  it.live('establishes the Stock Item, one Position per allowed location, the ITEM correlation and the binding', () =>
    Effect.gen(function* establishesEverything() {
      const state = makeOwnerState();
      const result = yield* state.provision('1');

      expect(result.stockItem.disposition).toBe('ESTABLISHED');
      expect(result.itemCorrelation.disposition).toBe('ESTABLISHED');
      expect(result.binding.disposition).toBe('ESTABLISHED');
      expect(result.positions.map(({ disposition, locationKey }) => [locationKey, disposition])).toEqual([
        ['AKROS-PRODEJNA', 'ESTABLISHED'],
        ['AKROS-SKLAD-1', 'ESTABLISHED'],
      ]);
      expect(state.stockItems.size).toBe(1);
      expect(state.positions.size).toBe(2);
      const correlation = state.correlations.find(({ externalKey }) => externalKey.identifierKind === 'ITEM');
      expect(correlation?.externalKey).toMatchObject({
        customerConfigurationId,
        externalScope: 'akros',
        externalValue: 'AKROS-10001-V1',
        identifierKind: 'ITEM',
        issuer,
        namespace: 'akros-erp',
      });
      expect(correlation?.effectivePeriod.from).toBe(policy.effectiveFrom);
      expect(correlation?.target.ref).toEqual(result.stockItem.ref);
      expect(state.bindings[0]?.stockItemRef).toEqual(result.stockItem.ref);
      for (const position of state.positions.values()) {
        expect(position.onHand).toMatchObject({ meaning: 'ON_HAND', ownerConfigurationRef });
        expect(position.scope.unitRef).toEqual(unitRef());
      }
      expect(state.receipts).toHaveLength(1);
      expect(state.receipts[0]?.provisioning).toEqual(result);
    }).pipe(Effect.provide(NodeCrypto.layer)),
  );

  it.live('changes nothing on a repeat and returns the same refs, every part adopted', () =>
    Effect.gen(function* replays() {
      const state = makeOwnerState();
      const first = yield* state.provision('1');
      const second = yield* state.provision('2');

      expect(second.stockItem).toEqual({ disposition: 'ADOPTED', ref: first.stockItem.ref });
      expect(second.itemCorrelation).toEqual({ disposition: 'ADOPTED', ref: first.itemCorrelation.ref });
      expect(second.binding).toEqual({ disposition: 'ADOPTED', ref: first.binding.ref });
      expect(second.positions).toEqual(first.positions.map((position) => ({ ...position, disposition: 'ADOPTED' })));
      expect([state.stockItems.size, state.positions.size, state.correlations.length, state.bindings.length]).toEqual([
        1, 2, 3, 1,
      ]);
      expect(state.receipts.map(({ actionInvocationId }) => actionInvocationId)).toEqual([
        invocation('1'),
        invocation('2'),
      ]);
    }).pipe(Effect.provide(NodeCrypto.layer)),
  );

  it.live('adopts a Stock Item an operator registered by hand in the policy Unit', () =>
    Effect.gen(function* adoptsManualItem() {
      const state = makeOwnerState();
      const manual = existingItem();
      state.stockItems.set(manual.stockItemRef.resourceId, manual);
      const result = yield* state.provision('1');

      expect(result.stockItem).toEqual({ disposition: 'ADOPTED', ref: manual.stockItemRef });
      expect(result.positions.every(({ disposition }) => disposition === 'ESTABLISHED')).toBe(true);
    }).pipe(Effect.provide(NodeCrypto.layer)),
  );

  it.live('refuses a Stock Item of the meaning in another Unit', () =>
    Effect.gen(function* refusesUnit() {
      const state = makeOwnerState();
      const manual = existingItem({ unitRef: unitRef(otherUnitId) });
      state.stockItems.set(manual.stockItemRef.resourceId, manual);
      const failure = yield* Effect.flip(state.provision('1'));

      assert(isProvisioningRejected(failure));
      expect(failure.reason).toBe('STOCK_UNIT_CONFLICT');
      expect(failure.conflictRef).toEqual(manual.stockItemRef);
      expect(state.positions.size).toBe(0);
    }).pipe(Effect.provide(NodeCrypto.layer)),
  );

  it.live('refuses a meaning id registered with another selection kind', () =>
    Effect.gen(function* refusesKind() {
      const state = makeOwnerState();
      const manual = existingItem({
        exactSelectionMeaning: { id: `catalog-variant:${variantId}`, kind: 'SET_VARIANT' },
      });
      state.stockItems.set(manual.stockItemRef.resourceId, manual);
      const failure = yield* Effect.flip(state.provision('1'));

      assert(isProvisioningRejected(failure));
      expect(failure.reason).toBe('EXACT_SELECTION_MEANING_CONFLICT');
    }).pipe(Effect.provide(NodeCrypto.layer)),
  );

  it.live('refuses an ERP item key that already correlates to another Stock Item', () =>
    Effect.gen(function* refusesCorrelation() {
      const state = makeOwnerState();
      const first = yield* state.provision('1');
      const otherVariant = '66666666-6666-4666-8666-666666666662';
      const failure = yield* Effect.flip(
        state.provision(
          '2',
          provisionInput({
            catalogSelection: selection(otherVariant),
            exactSelectionMeaning: { id: `catalog-variant:${otherVariant}`, kind: 'PRODUCT_VARIANT' },
          }),
        ),
      );

      assert(isProvisioningRejected(failure));
      expect(failure.reason).toBe('ITEM_CORRELATION_CONFLICT');
      expect(failure.conflictRef).toEqual(first.itemCorrelation.ref);
    }).pipe(Effect.provide(NodeCrypto.layer)),
  );

  it.live('refuses a meaning already bound to another Catalog selection', () =>
    Effect.gen(function* refusesBinding() {
      const state = makeOwnerState();
      const first = yield* state.provision('1');
      const failure = yield* Effect.flip(
        state.provision('2', provisionInput({ catalogSelection: selection('66666666-6666-4666-8666-666666666669') })),
      );

      assert(isProvisioningRejected(failure));
      expect(failure.reason).toBe('BINDING_CONFLICT');
      expect(failure.conflictRef).toEqual(first.binding.ref);
    }).pipe(Effect.provide(NodeCrypto.layer)),
  );

  it.live('refuses an unknown provisioning policy before touching any owner record', () =>
    Effect.gen(function* refusesPolicy() {
      const state = makeOwnerState();
      state.policies.clear();
      const failure = yield* Effect.flip(state.provision('1'));

      assert(isProvisioningRejected(failure));
      expect(failure.reason).toBe('POLICY_NOT_FOUND');
      expect(state.stockItems.size).toBe(0);
    }).pipe(Effect.provide(NodeCrypto.layer)),
  );
});

describe('Inventory source provisioning policy', () => {
  it.live('defines a maximum-length ERP location key without truncation or oversized evidence', () =>
    Effect.gen(function* boundedLocationEvidence() {
      const state = makeOwnerState();
      state.policies.clear();
      const locationKey = 'L'.repeat(300);
      const result = yield* state.define([{ ...warehouseLocation, locationKey }]);
      expect(result.outcome).toBe('DEFINED');
      expect(result.policy.locations.map((location) => location.locationKey)).toEqual([locationKey]);
      const correlation = state.correlations.find(({ externalKey }) => externalKey.externalValue === locationKey);
      assert(correlation !== undefined);
      expect(correlation.ownerEvidenceRef.length).toBeLessThanOrEqual(300);
    }).pipe(Effect.provide(NodeCrypto.layer)),
  );

  it.live('defines the policy once, correlates each location key, and replays identical content exactly', () =>
    Effect.gen(function* definesOnce() {
      const state = makeOwnerState();
      state.policies.clear();
      state.correlations.length = 0;
      const defined = yield* state.define([warehouseLocation, outletLocation]);
      expect(defined.outcome).toBe('DEFINED');
      expect(defined.policy).toMatchObject({ effectiveFrom: '2026-11-20T08:00:00.000Z', issuer });
      expect(
        state.correlations.map(({ externalKey, target }) => [
          externalKey.identifierKind,
          externalKey.externalValue,
          target.ref.resourceId,
        ]),
      ).toEqual([
        ['LOCATION', 'AKROS-PRODEJNA', outletId],
        ['LOCATION', 'AKROS-SKLAD-1', warehouseId],
      ]);

      expect(yield* state.define([outletLocation, warehouseLocation])).toEqual({
        outcome: 'EXACT_REPLAY',
        policy: defined.policy,
      });
      expect(state.correlations).toHaveLength(2);

      const changed = yield* Effect.flip(state.define([outletLocation]));
      assert(isPolicyRejected(changed));
      expect(changed.reason).toBe('POLICY_ALREADY_DEFINED');
      expect(changed.conflictRef).toEqual(defined.policy.policyRef);
    }).pipe(Effect.provide(NodeCrypto.layer)),
  );

  it.live('refuses a backend that is not an external business system', () =>
    Effect.gen(function* refusesWms() {
      const state = makeOwnerState(configuration('ontos_wms'));
      state.policies.clear();
      const failure = yield* Effect.flip(state.define([warehouseLocation]));
      assert(isPolicyRejected(failure));
      expect(failure.reason).toBe('OWNER_CONFIGURATION_NOT_EXTERNAL');
    }).pipe(Effect.provide(NodeCrypto.layer)),
  );

  it.live('refuses an unknown Stock Location and a location key that names another Stock Location', () =>
    Effect.gen(function* refusesLocations() {
      const state = makeOwnerState();
      state.policies.clear();
      const unknown = yield* Effect.flip(
        state.define([
          { locationKey: 'AKROS-SKLAD-9', stockLocationRef: locationRef('55555555-5555-4555-8555-555555555559') },
        ]),
      );
      assert(isPolicyRejected(unknown));
      expect(unknown.reason).toBe('STOCK_LOCATION_NOT_FOUND');

      yield* state.define([warehouseLocation]);
      state.policies.clear();
      const moved = yield* Effect.flip(
        state.define([{ locationKey: warehouseLocation.locationKey, stockLocationRef: locationRef(outletId) }]),
      );
      assert(isPolicyRejected(moved));
      expect(moved.reason).toBe('LOCATION_CORRELATION_CONFLICT');
    }).pipe(Effect.provide(NodeCrypto.layer)),
  );
});

const isResolved = Schema.is(SourceStockPositionResolutionResponseSchema.members[0]);
const isUnresolved = Schema.is(SourceStockPositionResolutionResponseSchema.members[1]);
const isRecorded = Schema.is(SourceStockItemProvisioningReceiptResponseSchema.members[0]);
const isIndeterminate = Schema.is(SourceStockItemProvisioningReceiptResponseSchema.members[1]);

describe('Inventory source Stock Position resolution and provisioning receipt', () => {
  it.effect('never combines LOCATION and ITEM authority from opposite sides of an effective boundary', () =>
    Effect.gen(function* singleResolutionInstant() {
      const boundary = '2026-11-22T10:00:00.000Z';
      yield* TestClock.setTime(DateTime.toEpochMillis(DateTime.makeUnsafe(boundary)) - 1);
      const state = makeOwnerState();
      yield* state.provision('1');
      const item = state.correlations.find(({ externalKey }) => externalKey.identifierKind === 'ITEM');
      assert.isDefined(item);
      const services: SourceStockPositionResolutionServices = {
        findItemCorrelations: (_request, asOf?: string) =>
          Effect.gen(function* itemAtInstant() {
            const instant = asOf ?? DateTime.formatIso(yield* DateTime.now);
            return instant >= boundary ? [item] : [];
          }),
        findPolicy: () => Effect.succeedSome(policy),
        findPosition: () => Effect.succeed(Option.fromNullishOr(state.positions.values().next().value)),
        isLocationAllowed: (_policy, _key, asOf?: string) =>
          Effect.gen(function* locationAtInstant() {
            const instant = asOf ?? DateTime.formatIso(yield* DateTime.now);
            yield* TestClock.adjust(Duration.millis(2));
            return instant < boundary;
          }),
      };
      const response = yield* sourceStockPositionResolutionHandler(
        Schema.decodeUnknownSync(SourceStockPositionResolutionRequestSchema)({
          customerConfigurationId,
          externalScope: policy.externalScope,
          issuer,
          itemKey: 'AKROS-10001-V1',
          locationKey: warehouseLocation.locationKey,
          namespace: policy.namespace,
        }),
        { services },
      );
      assert(isUnresolved(response.result));
      expect(response.result.reason).toBe('ITEM_NOT_PROVISIONED');
    }).pipe(Effect.provide(NodeCrypto.layer)),
  );

  it.live('resolves the exact provisioned Position and names every miss', () =>
    Effect.gen(function* resolves() {
      const state = makeOwnerState();
      const provisioned = yield* state.provision('1');
      const services: SourceStockPositionResolutionServices = {
        findItemCorrelations: (request) =>
          Effect.succeed(state.correlations.filter(({ externalKey }) => externalKey.externalValue === request.itemKey)),
        findPolicy: () => Effect.succeed(Option.fromNullishOr(state.policies.get(policyId))),
        findPosition: (scope) =>
          Effect.succeed(
            Option.fromNullishOr(
              [...state.positions.values()].find(
                (position) =>
                  position.scope.stockItemRef.resourceId === scope.stockItemRef.resourceId &&
                  position.scope.stockLocationRef.resourceId === scope.stockLocationRef.resourceId,
              ),
            ),
          ),
        isLocationAllowed: (_policy, locationKey) =>
          Effect.succeed(
            state.correlations.some(
              ({ externalKey }) =>
                externalKey.identifierKind === 'LOCATION' && externalKey.externalValue === locationKey,
            ),
          ),
      };
      const resolve = (keys: { readonly itemKey: string; readonly locationKey: string }) =>
        sourceStockPositionResolutionHandler(
          Schema.decodeUnknownSync(SourceStockPositionResolutionRequestSchema)({
            customerConfigurationId,
            externalScope: 'akros',
            issuer,
            namespace: 'akros-erp',
            ...keys,
          }),
          { services },
        ).pipe(Effect.map(({ result }) => result));

      const resolved = yield* resolve({ itemKey: 'AKROS-10001-V1', locationKey: 'AKROS-SKLAD-1' });
      assert(isResolved(resolved));
      expect(resolved.positionRef).toEqual(
        provisioned.positions.find(({ locationKey }) => locationKey === 'AKROS-SKLAD-1')?.positionRef,
      );
      expect(resolved.stockItemRef).toEqual(provisioned.stockItem.ref);
      expect(resolved.stockLocationRef).toEqual(locationRef(warehouseId));

      const otherLocation = yield* resolve({ itemKey: 'AKROS-10001-V1', locationKey: 'AKROS-SKLAD-9' });
      assert(isUnresolved(otherLocation));
      expect(otherLocation.reason).toBe('LOCATION_NOT_ALLOWED');
      const otherItem = yield* resolve({ itemKey: 'AKROS-99999', locationKey: 'AKROS-SKLAD-1' });
      assert(isUnresolved(otherItem));
      expect(otherItem.reason).toBe('ITEM_NOT_PROVISIONED');
    }).pipe(Effect.provide(NodeCrypto.layer)),
  );

  it.live('answers a receipt only for the exact original input', () =>
    Effect.gen(function* recovers() {
      const state = makeOwnerState();
      yield* state.provision('1', reversedLocationInput());
      const [receipt] = state.receipts;
      assert(receipt !== undefined);
      const context = {
        scope: { tenantId },
        services: { findOriginal: () => Effect.succeed(Option.some(receipt)) },
      };
      const recorded = yield* sourceStockItemProvisioningReceiptHandler(
        { actionInvocationId: invocation('1'), input: provisionInput() },
        context,
      );
      assert(isRecorded(recorded.result));
      expect(recorded.result.receipt).toEqual(receipt);
      expect(recorded.result.receipt.input).toEqual(reversedLocationInput());
      const moved = yield* sourceStockItemProvisioningReceiptHandler(
        { actionInvocationId: invocation('1'), input: movedLocationInput() },
        context,
      );
      assert(isIndeterminate(moved.result));
      const other = yield* sourceStockItemProvisioningReceiptHandler(
        { actionInvocationId: invocation('1'), input: provisionInput({ itemKey: 'AKROS-10002-V1' }) },
        context,
      );
      assert(isIndeterminate(other.result));
      expect(other.result.retryCommand).toBe(true);
    }).pipe(Effect.provide(NodeCrypto.layer)),
  );

  it('admits the provisioning workload without requiring staff, and keeps Inventory tenant-scoped', () => {
    expect(provisionSourceStockItemAction.descriptor.accessWorkload?.workloads).toEqual([
      'commerce.inventory.source-provision',
    ]);
    expect(defineSourceProvisioningPolicyAction.descriptor.accessWorkload).toBeUndefined();
    for (const descriptor of [
      provisionSourceStockItemAction.descriptor,
      defineSourceProvisioningPolicyAction.descriptor,
      sourceStockItemProvisioningReceiptRead.descriptor,
      sourceStockPositionResolutionRead.descriptor,
    ]) {
      expect(descriptor.legalEntityScope).toBe('forbidden');
    }
    for (const read of [sourceStockItemProvisioningReceiptRead, sourceStockPositionResolutionRead]) {
      expect(read.descriptor.accessWorkload?.workloads).toEqual([
        'commerce.inventory.source-provision',
        'commerce.inventory.source-read',
      ]);
    }
  });
});
