import { InventoryBackendConfigurationSchema } from '@app/inventory/backend-configuration';
import { Effect, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';
import {
  AvailabilityInventoryPositionEvidenceSchema,
  AvailabilityStockInputSchema,
} from '../../shared/domain/availability-source-authority.ts';
import { validateAvailabilitySourceAuthority } from '../../src/domain/availability-source-authority.ts';
import {
  configuration,
  configurationRef,
  operationTime,
  position,
  stockInput,
  subject,
  tenantId,
  unitRef,
} from '../support/availability-decision.ts';

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
