import { InventoryBackendConfigurationSchema } from '@app/inventory/backend-configuration';
import { Effect, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';
import {
  AvailabilityInventoryPositionEvidenceSchema,
  AvailabilityStockInputSchema,
} from '../../shared/domain/availability-source-authority.ts';
import { AvailabilitySubjectSchema } from '../../shared/domain/availability-subject.ts';
import { validateAvailabilitySourceAuthority } from '../../src/domain/availability-source-authority.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const operationTime = '2026-10-05T12:00:00.000Z';
const ref = (resourceType: string, resourceId: string) => ({
  moduleId: 'commerce.catalog',
  resourceId,
  resourceType,
  tenantId,
});
const productRef = ref('commerce.catalog.product', '22222222-2222-4222-8222-222222222222');
const variantRef = ref('commerce.catalog.variant', '33333333-3333-4333-8333-333333333333');
const unitRef = ref('commerce.catalog.product-unit', '44444444-4444-4444-8444-444444444444');
const guestSubject = { guestEvidenceRef: 'guest-evidence', guestSessionRef: 'guest-session', kind: 'GUEST' };
const purchasingContext = {
  contextVerification: {
    evidence: {
      currentness: { evaluatedAt: operationTime, observedAt: operationTime, validFrom: operationTime, validTo: null },
      ownerRef: 'purchase-context',
      ownerRevisionRef: 'revision-1',
      subjectAuthority: {
        guestEvidenceAuthorityRef: 'guest-evidence-authority',
        guestSessionAuthorityRef: 'guest-session-authority',
        kind: 'GUEST',
        subject: guestSubject,
        subjectAuthorityRevisionRef: 'guest-revision-1',
      },
      verificationRef: 'verification-1',
      verifiedScope: { channelId: 'b2c', legalEntityId: 'seller', marketId: 'cz', tenantId },
    },
    outcome: 'PURCHASE_CONTEXT_VERIFIED',
    request: {
      actor: { kind: 'GUEST' },
      operationTime,
      purchasingContext: {
        channelId: 'b2c',
        contextRef: 'purchase-context',
        contextRevision: 'revision-1',
        marketId: 'cz',
        sellingLegalEntityId: 'seller',
      },
      subject: guestSubject,
      tenantId,
    },
  },
};
const input = {
  purchasingContext,
  quantity: { amount: '2.00', unitRef },
  selection: { productRef, variantRef },
};
const subject = Schema.decodeUnknownSync(AvailabilitySubjectSchema)(input);
const configuration = Schema.decodeUnknownSync(InventoryBackendConfigurationSchema)({
  configurationId: '55555555-5555-4555-8555-555555555555',
  customerConfigurationId: 'customer',
  revision: 1,
  selectedAt: operationTime,
  selection: {
    backend: 'ontos_wms',
    backendId: 'wms',
    exactReservationCapability: 'SUPPORTED',
    stockCorrectionCapability: 'SUPPORTED',
  },
  tenantId,
});
const inventoryRef = (resourceType: string, resourceId: string) => ({
  moduleId: 'commerce.inventory',
  resourceId,
  resourceType,
  tenantId,
});
const stockItemRef = inventoryRef('commerce.inventory.stock-item', '66666666-6666-4666-8666-666666666666');
const stockLocationRef = inventoryRef('commerce.inventory.stock-location', '77777777-7777-4777-8777-777777777777');
const configurationRef = inventoryRef(
  'commerce.inventory.inventory-backend-configuration',
  configuration.configurationId,
);
const onHand = {
  _tag: 'CURRENT',
  evidenceRef: 'stock-proof',
  meaning: 'ON_HAND',
  observedAt: operationTime,
  ownerConfigurationRef: configurationRef,
  quantity: { amount: '0', unitRef },
};
const exactSelectionMeaning = { id: 'variant-meaning', kind: 'PRODUCT_VARIANT' };
const rawPosition = {
  binding: {
    bindingRef: inventoryRef('commerce.inventory.catalog-to-stock-binding', '88888888-8888-4888-8888-888888888888'),
    catalogSelection: subject.selection,
    effectiveFrom: operationTime,
    exactSelectionMeaning,
    revision: 1,
    stockItemRef,
    unitRef,
  },
  committedObligations: [],
  customerFacingAvailabilityPublished: false,
  position: {
    createdAt: operationTime,
    endedAt: null,
    lifecycle: 'CURRENT',
    onHand,
    ref: inventoryRef('commerce.inventory.stock-position', '99999999-9999-4999-8999-999999999999'),
    revision: 1,
    scope: { customerConfigurationId: 'customer', stockItemRef, stockLocationRef, unitRef },
  },
  provisionalReserved: {
    allocationCount: 0,
    currentness: 'CURRENT',
    derivation: 'CURRENT_SUCCESSFUL_RESERVATION_ALLOCATIONS',
    meaning: 'RESERVED',
    owner: 'INVENTORY',
    quantity: { amount: '0', unitRef },
  },
  purpose: 'STOCK_EVIDENCE_ONLY',
  sourceEvidence: {
    _tag: 'OWNER_MANAGED',
    onHand,
    ownerConfiguration: configuration,
    physicalOnHandReusableProof: 'NOT_PROVIDED',
  },
  stockItem: {
    createdAt: operationTime,
    exactSelectionMeaning,
    lifecycle: 'CURRENT',
    retiredAt: null,
    revision: 1,
    stockItemRef,
    unitRef,
  },
  stockLocation: {
    displayName: 'Warehouse',
    lifecycle: { _tag: 'ACTIVE' },
    operationalScope: { _tag: 'PHYSICAL_SITE', physicalSiteKeys: ['site'] },
    ref: stockLocationRef,
    revision: 1,
  },
  unresolvedReservationEffectConstraints: [],
};
const rawStockInput = {
  authorityPath: 'INVENTORY_PUBLIC_BOUNDARY',
  fallbackApplied: false,
  positions: [rawPosition],
  selectedBackendConfiguration: configuration,
};
const position = Schema.decodeUnknownSync(AvailabilityInventoryPositionEvidenceSchema)(rawPosition);
const stockInput = Schema.decodeUnknownSync(AvailabilityStockInputSchema)(rawStockInput);
const validate = (value: typeof AvailabilityStockInputSchema.Encoded) =>
  validateAvailabilitySourceAuthority(Schema.decodeUnknownSync(AvailabilityStockInputSchema)(value), {
    configuration,
    subject,
  });
const expectRejection = (value: typeof AvailabilityStockInputSchema.Encoded, reason: string) =>
  Effect.gen(function* checkRejection() {
    const result = yield* validate(value).pipe(Effect.flip);
    expect(result.reason).toBe(reason);
  });

describe('Inventory source authority', () => {
  it('fixture is published owner evidence', () => {
    Schema.decodeUnknownSync(AvailabilityStockInputSchema, { onExcessProperty: 'error' })(stockInput);
  });
  it.effect('preserves current zero without publishing a business negative', () =>
    Effect.gen(function* verifyAuthority() {
      const result = yield* validate(stockInput);
      expect(result).toEqual(stockInput);
      expect(result).not.toHaveProperty('outcome');
    }),
  );
  it.effect('refuses alternate backend or Customer Configuration', () =>
    Effect.gen(function* verifyAuthority() {
      for (const selectedBackendConfiguration of [
        { ...configuration, selection: { ...configuration.selection, backendId: 'alternate' } },
        { ...configuration, customerConfigurationId: 'other' },
      ]) {
        yield* expectRejection({ ...stockInput, selectedBackendConfiguration }, 'SELECTED_AUTHORITY_MISMATCH');
      }
    }),
  );
  it('rejects direct EBS, fallback and raw provider data at the schema boundary', () => {
    for (const value of [
      { ...stockInput, authorityPath: 'DIRECT_EBS' },
      { ...stockInput, fallbackApplied: true },
      { ...stockInput, rawProviderPayload: { available: true } },
    ]) {
      expect(() =>
        Schema.decodeUnknownSync(AvailabilityStockInputSchema, { onExcessProperty: 'error' })(value),
      ).toThrow();
    }
  });
  it.effect('binds exact Selection and Position configuration', () =>
    Effect.gen(function* verifyAuthority() {
      yield* expectRejection(
        {
          ...stockInput,
          positions: [
            {
              ...position,
              binding: {
                ...position.binding,
                catalogSelection: {
                  ...subject.selection,
                  variantRef: {
                    moduleId: 'commerce.catalog',
                    resourceId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
                    resourceType: 'commerce.catalog.variant',
                    tenantId,
                  },
                },
              },
            },
          ],
        },
        'EVIDENCE_SCOPE_MISMATCH',
      );
      yield* expectRejection(
        {
          ...stockInput,
          positions: [
            {
              ...position,
              position: {
                ...position.position,
                scope: { ...position.position.scope, customerConfigurationId: 'other' },
              },
            },
          ],
        },
        'EVIDENCE_SCOPE_MISMATCH',
      );
    }),
  );
  it.effect('preserves unknown, missing, stale and conflict uncertainty', () =>
    Effect.gen(function* verifyAuthority() {
      const uncertain = ['MISSING', 'UNKNOWN', 'INDETERMINATE'].map((_tag) => ({
        _tag,
        meaning: 'ON_HAND',
        ownerConfigurationRef: configurationRef,
        unitRef,
      }));
      const stale = {
        _tag: 'STALE',
        evidenceRef: 'old-proof',
        lastKnownQuantity: { amount: '10', unitRef },
        lastObservedAt: operationTime,
        meaning: 'ON_HAND',
        ownerConfigurationRef: configurationRef,
      };
      for (const ownerOnHand of [...uncertain, stale]) {
        const result = yield* validate({
          ...stockInput,
          positions: [
            {
              ...position,
              position: {
                ...position.position,
                onHand: Schema.decodeUnknownSync(
                  AvailabilityInventoryPositionEvidenceSchema.fields.position.fields.onHand,
                )(ownerOnHand),
              },
              sourceEvidence: {
                _tag: 'OWNER_MANAGED',
                onHand: Schema.decodeUnknownSync(
                  AvailabilityInventoryPositionEvidenceSchema.fields.position.fields.onHand,
                )(ownerOnHand),
                ownerConfiguration: configuration,
                physicalOnHandReusableProof: 'NOT_PROVIDED',
              },
            },
          ],
        });
        expect(result.positions[0]?.position.onHand).toEqual(ownerOnHand);
        expect(result).not.toHaveProperty('outcome');
      }
    }),
  );
  it.effect('an outage is no stock fact and cannot reclassify retained evidence', () =>
    Effect.gen(function* verifyAuthority() {
      expect(() => Schema.decodeUnknownSync(AvailabilityStockInputSchema)({ status: 'SOURCE_UNAVAILABLE' })).toThrow();
      const result = yield* validate(stockInput);
      expect(result).toEqual(stockInput);
    }),
  );
  it.effect('does not treat an empty set as completeness or absent stock', () =>
    Effect.gen(function* verifyAuthority() {
      const result = yield* validate({ ...stockInput, positions: [] });
      expect(result.positions).toEqual([]);
      expect(result).not.toHaveProperty('complete');
      expect(result).not.toHaveProperty('outcome');
    }),
  );
  it.effect('external backend evidence stays behind Inventory and retains missing evidence', () =>
    Effect.gen(function* verifyExternal() {
      const external = Schema.decodeUnknownSync(InventoryBackendConfigurationSchema)({
        ...configuration,
        selection: { ...configuration.selection, backend: 'external_business_system', backendId: 'erp' },
      });
      const missing = Schema.decodeUnknownSync(AvailabilityStockInputSchema)({
        ...stockInput,
        positions: [
          {
            ...position,
            sourceEvidence: {
              _tag: 'MISSING',
              meaning: 'EXTERNAL_SOURCE_ASSERTION',
              onHand: position.position.onHand,
              ownerConfiguration: external,
              physicalOnHandReusableProof: 'NOT_PROVIDED',
            },
          },
        ],
        selectedBackendConfiguration: external,
      });
      const result = yield* validateAvailabilitySourceAuthority(missing, { configuration: external, subject });
      expect(result).toEqual(missing);
      const unselected = yield* validate(missing).pipe(Effect.flip);
      expect(unselected.reason).toBe('SELECTED_AUTHORITY_MISMATCH');
      const syntheticWms = Schema.decodeUnknownSync(AvailabilityStockInputSchema)({
        ...missing,
        positions: [
          {
            ...position,
            sourceEvidence: {
              _tag: 'OWNER_MANAGED',
              onHand: position.position.onHand,
              ownerConfiguration: external,
              physicalOnHandReusableProof: 'NOT_PROVIDED',
            },
          },
        ],
      });
      const rejected = yield* validateAvailabilitySourceAuthority(syntheticWms, {
        configuration: external,
        subject,
      }).pipe(Effect.flip);
      expect(rejected.reason).toBe('SELECTED_AUTHORITY_MISMATCH');
    }),
  );

  it.effect('rejects conflicting copies of owner ON_HAND without choosing the last response', () =>
    Effect.gen(function* verifyConflictingFacts() {
      const conflicting = Schema.decodeUnknownSync(AvailabilityStockInputSchema)({
        ...stockInput,
        positions: [
          {
            ...position,
            sourceEvidence: {
              _tag: 'OWNER_MANAGED',
              onHand: { _tag: 'UNKNOWN', meaning: 'ON_HAND', ownerConfigurationRef: configurationRef, unitRef },
              ownerConfiguration: configuration,
              physicalOnHandReusableProof: 'NOT_PROVIDED',
            },
          },
        ],
      });
      yield* expectRejection(conflicting, 'EVIDENCE_SCOPE_MISMATCH');
    }),
  );
});
