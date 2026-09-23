import { ReadHandlerNotFound } from '@app/core-runtime';
import { Effect, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import {
  PriceGroupDefinitionRequestSchema,
  PriceGroupDefinitionResponseSchema,
} from '../../shared/apis/price-group-definition.ts';
import { PriceGroupDefinitionRevisionSchema, PriceGroupIdentitySchema } from '../../shared/domain/price-group.ts';
import {
  PriceGroupCurrentnessFailure,
  PriceGroupNotFound,
  PriceGroupPersistenceUnavailable,
} from '../../shared/domain/price-group-errors.ts';
import { pricingPriceGroupReadPermission } from '../../shared/permissions/pricing-price-group-read.ts';
import {
  priceGroupDefinitionPermissionTarget,
  priceGroupDefinitionRead,
  readPriceGroupDefinition,
} from '../../src/api/price-group-definition.read.ts';
import type { PriceGroupCatalogPersistence } from '../../src/persistence/price-group-catalog-persistence.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const otherTenantId = '22222222-2222-4222-8222-222222222222';
const priceGroupId = '33333333-3333-4333-8333-333333333333';
const definitionRevisionId = '44444444-4444-4444-8444-444444444444';
const historicalRevisionId = '55555555-5555-4555-8555-555555555555';
const trustedOperationAt = '2026-09-23T10:00:00.000Z';

const priceGroupRef = {
  moduleId: 'pricing.price-group-catalog',
  resourceId: priceGroupId,
  resourceType: 'pricing.price-group-catalog.price-group',
  tenantId,
} as const;

const definition = Schema.decodeUnknownSync(PriceGroupDefinitionRevisionSchema)({
  acceptedCatalogRevision: 7,
  classificationPurpose: 'Classify customers for canonical price selection.',
  compatibilityContracts: [{ contractId: 'commerce.customer-price-group', version: 1 }],
  created: {
    actionInvocationId: '66666666-6666-4666-8666-666666666666',
    actorPrincipalId: '77777777-7777-4777-8777-777777777777',
    reason: 'Create the approved definition.',
    trustedAt: '2026-09-01T00:00:00.000Z',
  },
  definitionRevisionId,
  description: 'Canonical dealer classification.',
  displayName: 'Dealer',
  effectivePeriod: {
    effectiveFrom: '2026-09-01T00:00:00.000Z',
    effectiveTo: '2026-10-01T00:00:00.000Z',
  },
  meaningFingerprint: 'a'.repeat(64),
  previousDefinitionRevisionId: null,
  priceGroupRef,
  revisionNumber: 1,
});

const identity = Schema.decodeUnknownSync(PriceGroupIdentitySchema)({
  businessCode: 'DEALER',
  classificationPurpose: definition.classificationPurpose,
  created: definition.created,
  createdAtCatalogRevision: 1,
  lifecycle: {
    activeFrom: definition.effectivePeriod.effectiveFrom,
    retiredAt: null,
    state: 'ACTIVE',
  },
  meaningFingerprint: definition.meaningFingerprint,
  priceGroupRef,
});

const currentSnapshot = { catalogRevision: 11, definition, identity } as const;
const historicalSnapshot = { definition, identity } as const;

const request = Schema.decodeUnknownSync(PriceGroupDefinitionRequestSchema)({
  priceGroupRef,
  trustedOperationAt,
});

const makeServices = (
  overrides: Partial<Pick<PriceGroupCatalogPersistence, 'readCurrentDefinition' | 'readDefinitionRevision'>> = {},
): PriceGroupCatalogPersistence => ({
  createDefinitionRevision: () => Effect.die('unexpected createDefinitionRevision call'),
  createPriceGroup: () => Effect.die('unexpected createPriceGroup call'),
  readCurrentDefinition: overrides.readCurrentDefinition ?? (() => Effect.succeed(currentSnapshot)),
  readDefinitionRevision: overrides.readDefinitionRevision ?? (() => Effect.succeed(historicalSnapshot)),
  retirePriceGroup: () => Effect.die('unexpected retirePriceGroup call'),
  validateCompatibility: () => Effect.die('unexpected validateCompatibility call'),
});

describe('Price Group Definition governed Read', () => {
  it.effect('reads the exact Current definition at the trusted half-open instant with bounded evidence', () =>
    Effect.gen(function* readsCurrentDefinition() {
      let selectedAt: Date | undefined;
      const result = yield* readPriceGroupDefinition(
        request,
        tenantId,
        makeServices({
          readCurrentDefinition: (_ref, at) => {
            selectedAt = at;
            return Effect.succeed(currentSnapshot);
          },
        }),
      );

      expect(selectedAt?.toISOString()).toBe(trustedOperationAt);
      expect(Schema.is(PriceGroupDefinitionResponseSchema)(result)).toBe(true);
      expect(result).toMatchObject({
        currentEvidence: {
          catalogRevision: currentSnapshot.catalogRevision,
          definitionEffectivePeriod: definition.effectivePeriod,
          definitionRevisionId,
          definitionRevisionNumber: 1,
          meaningFingerprint: definition.meaningFingerprint,
          observedAt: trustedOperationAt,
          priceGroupRef,
        },
        definition,
        identity,
        selection: 'CURRENT',
      });
      expect(Object.keys(result)).toEqual(['currentEvidence', 'definition', 'identity', 'observedAt', 'selection']);
    }),
  );

  it.effect('reads one exact historical revision without Current evidence', () =>
    Effect.gen(function* readsHistoricalDefinition() {
      const historical = Schema.decodeUnknownSync(PriceGroupDefinitionRevisionSchema)({
        ...definition,
        definitionRevisionId: historicalRevisionId,
      });
      const retiredIdentity = Schema.decodeUnknownSync(PriceGroupIdentitySchema)({
        ...identity,
        lifecycle: {
          activeFrom: identity.lifecycle.activeFrom,
          retiredAt: '2026-09-22T00:00:00.000Z',
          state: 'RETIRED',
        },
      });
      let requestedRevisionId: string | undefined;
      const result = yield* readPriceGroupDefinition(
        Schema.decodeUnknownSync(PriceGroupDefinitionRequestSchema)({
          definitionRevisionId: historicalRevisionId,
          priceGroupRef,
          trustedOperationAt,
        }),
        tenantId,
        makeServices({
          readCurrentDefinition: () => Effect.die('historical reads must not select Current'),
          readDefinitionRevision: (_ref, revisionId) => {
            requestedRevisionId = revisionId;
            return Effect.succeed({ definition: historical, identity: retiredIdentity });
          },
        }),
      );

      expect(requestedRevisionId).toBe(historicalRevisionId);
      expect(result.selection).toBe('HISTORICAL');
      expect(result.definition.definitionRevisionId).toBe(historicalRevisionId);
      expect(result.identity.lifecycle).toEqual({
        activeFrom: identity.lifecycle.activeFrom,
        retiredAt: '2026-09-22T00:00:00.000Z',
        state: 'RETIRED',
      });
      expect('currentEvidence' in result).toBe(false);
    }),
  );

  it.effect('returns final pre-retirement R2 as ACTIVE before retirement and RETIRED at its exact boundary', () =>
    Effect.gen(function* preservesScheduledRetirement() {
      const retiredAt = '2026-09-25T00:00:00.000Z';
      const immediatelyBeforeRetirement = '2026-09-24T23:59:59.999Z';
      const finalPreRetirementDefinition = Schema.decodeUnknownSync(PriceGroupDefinitionRevisionSchema)({
        ...definition,
        acceptedCatalogRevision: 12,
        definitionRevisionId: historicalRevisionId,
        effectivePeriod: {
          effectiveFrom: '2026-09-24T00:00:00.000Z',
          effectiveTo: retiredAt,
        },
        previousDefinitionRevisionId: definitionRevisionId,
        revisionNumber: 2,
      });
      const retiredIdentity = Schema.decodeUnknownSync(PriceGroupIdentitySchema)({
        ...identity,
        lifecycle: {
          activeFrom: identity.lifecycle.activeFrom,
          retiredAt,
          state: 'RETIRED',
        },
      });
      const selectedInstants: string[] = [];
      const services = makeServices({
        readCurrentDefinition: (_ref, at) => {
          selectedInstants.push(at.toISOString());
          return Effect.succeed({
            catalogRevision: finalPreRetirementDefinition.acceptedCatalogRevision,
            definition: finalPreRetirementDefinition,
            identity: at.toISOString() < retiredAt ? identity : retiredIdentity,
          });
        },
      });
      const beforeRetirement = yield* readPriceGroupDefinition(
        Schema.decodeUnknownSync(PriceGroupDefinitionRequestSchema)({
          priceGroupRef,
          trustedOperationAt: immediatelyBeforeRetirement,
        }),
        tenantId,
        services,
      );
      const atRetirement = yield* readPriceGroupDefinition(
        Schema.decodeUnknownSync(PriceGroupDefinitionRequestSchema)({
          priceGroupRef,
          trustedOperationAt: retiredAt,
        }),
        tenantId,
        services,
      );

      expect(beforeRetirement).toMatchObject({
        currentEvidence: {
          definitionRevisionId: historicalRevisionId,
          definitionRevisionNumber: 2,
          observedAt: immediatelyBeforeRetirement,
        },
        definition: { definitionRevisionId: historicalRevisionId, revisionNumber: 2 },
        identity: { lifecycle: { retiredAt: null, state: 'ACTIVE' } },
        selection: 'CURRENT',
      });
      expect(atRetirement).toMatchObject({
        currentEvidence: {
          definitionRevisionId: historicalRevisionId,
          definitionRevisionNumber: 2,
          observedAt: retiredAt,
        },
        definition: { definitionRevisionId: historicalRevisionId, revisionNumber: 2 },
        identity: { lifecycle: { retiredAt, state: 'RETIRED' } },
        selection: 'CURRENT',
      });
      expect(selectedInstants).toEqual([immediatelyBeforeRetirement, retiredAt]);
      expect('kind' in beforeRetirement).toBe(false);
      expect('kind' in atRetirement).toBe(false);
      expect('compatibilityEvidence' in atRetirement).toBe(false);
    }),
  );

  it.effect('projects exact historical lifecycle before and at a scheduled retirement boundary', () =>
    Effect.gen(function* projectsHistoricalScheduledRetirement() {
      const retiredAt = '2026-09-25T00:00:00.000Z';
      const historical = Schema.decodeUnknownSync(PriceGroupDefinitionRevisionSchema)({
        ...definition,
        definitionRevisionId: historicalRevisionId,
      });
      const retiredIdentity = Schema.decodeUnknownSync(PriceGroupIdentitySchema)({
        ...identity,
        lifecycle: {
          activeFrom: identity.lifecycle.activeFrom,
          retiredAt,
          state: 'RETIRED',
        },
      });
      const selectedInstants: string[] = [];
      const services = makeServices({
        readCurrentDefinition: () => Effect.die('historical reads must not select Current'),
        readDefinitionRevision: (_ref, revisionId, at) => {
          expect(revisionId).toBe(historicalRevisionId);
          selectedInstants.push(at.toISOString());
          return Effect.succeed({
            definition: historical,
            identity: at.toISOString() < retiredAt ? identity : retiredIdentity,
          });
        },
      });
      const historicalRequest = (at: string) =>
        Schema.decodeUnknownSync(PriceGroupDefinitionRequestSchema)({
          definitionRevisionId: historicalRevisionId,
          priceGroupRef,
          trustedOperationAt: at,
        });
      const beforeRetirement = yield* readPriceGroupDefinition(
        historicalRequest('2026-09-24T23:59:59.999Z'),
        tenantId,
        services,
      );
      const atRetirement = yield* readPriceGroupDefinition(historicalRequest(retiredAt), tenantId, services);

      expect(beforeRetirement).toMatchObject({
        identity: { lifecycle: { retiredAt: null, state: 'ACTIVE' } },
        selection: 'HISTORICAL',
      });
      expect(atRetirement).toMatchObject({
        identity: { lifecycle: { retiredAt, state: 'RETIRED' } },
        selection: 'HISTORICAL',
      });
      expect(selectedInstants).toEqual(['2026-09-24T23:59:59.999Z', retiredAt]);
      expect('currentEvidence' in beforeRetirement).toBe(false);
      expect('currentEvidence' in atRetirement).toBe(false);
    }),
  );

  it.effect('rejects a retired Current snapshot whose selected definition does not end at retiredAt', () =>
    Effect.gen(function* rejectsMismatchedTerminalDefinition() {
      const retiredAt = '2026-09-25T00:00:00.000Z';
      const retiredIdentity = Schema.decodeUnknownSync(PriceGroupIdentitySchema)({
        ...identity,
        lifecycle: {
          activeFrom: identity.lifecycle.activeFrom,
          retiredAt,
          state: 'RETIRED',
        },
      });
      const failure = yield* Effect.flip(
        readPriceGroupDefinition(
          Schema.decodeUnknownSync(PriceGroupDefinitionRequestSchema)({ priceGroupRef, trustedOperationAt: retiredAt }),
          tenantId,
          makeServices({
            readCurrentDefinition: () => Effect.succeed({ ...currentSnapshot, identity: retiredIdentity }),
          }),
        ),
      );

      expect(Schema.is(PriceGroupCurrentnessFailure)(failure)).toBe(true);
      expect(failure).toMatchObject({
        candidateDefinitionRevisionIds: [definitionRevisionId],
        reason: 'UNVERIFIABLE_CURRENTNESS',
      });
    }),
  );

  it.effect('maps authoritative absence to ReadHandlerNotFound', () =>
    Effect.gen(function* mapsNotFound() {
      const failure = yield* Effect.flip(
        readPriceGroupDefinition(
          request,
          tenantId,
          makeServices({
            readCurrentDefinition: () =>
              Effect.fail(
                new PriceGroupNotFound({
                  code: 'price_group_not_found',
                  reason: 'The Price Group does not exist in this tenant',
                }),
              ),
          }),
        ),
      );

      expect(Schema.is(ReadHandlerNotFound)(failure)).toBe(true);
    }),
  );

  it.effect('rejects a cross-tenant reference before owner persistence', () =>
    Effect.gen(function* rejectsCrossTenant() {
      let persistenceCalls = 0;
      const failure = yield* Effect.flip(
        readPriceGroupDefinition(
          Schema.decodeUnknownSync(PriceGroupDefinitionRequestSchema)({
            priceGroupRef: { ...priceGroupRef, tenantId: otherTenantId },
            trustedOperationAt,
          }),
          tenantId,
          makeServices({
            readCurrentDefinition: () => {
              persistenceCalls += 1;
              return Effect.succeed(currentSnapshot);
            },
          }),
        ),
      );

      expect(Schema.is(ReadHandlerNotFound)(failure)).toBe(true);
      expect(persistenceCalls).toBe(0);
    }),
  );

  it.effect('fails Current selection when owner data does not contain the trusted instant', () =>
    Effect.gen(function* rejectsUnverifiableCurrent() {
      const outsidePeriod = Schema.decodeUnknownSync(PriceGroupDefinitionRevisionSchema)({
        ...definition,
        effectivePeriod: {
          effectiveFrom: '2026-08-01T00:00:00.000Z',
          effectiveTo: '2026-09-23T10:00:00.000Z',
        },
      });
      const failure = yield* Effect.flip(
        readPriceGroupDefinition(
          request,
          tenantId,
          makeServices({
            readCurrentDefinition: () => Effect.succeed({ ...currentSnapshot, definition: outsidePeriod }),
          }),
        ),
      );

      expect(Schema.is(PriceGroupCurrentnessFailure)(failure)).toBe(true);
      if (Schema.is(PriceGroupCurrentnessFailure)(failure)) {
        expect(failure.reason).toBe('UNVERIFIABLE_CURRENTNESS');
      }
    }),
  );

  it.effect('fails closed when the authoritative identity does not match the selected definition', () =>
    Effect.gen(function* rejectsMismatchedIdentity() {
      const mismatchedIdentity = Schema.decodeUnknownSync(PriceGroupIdentitySchema)({
        ...identity,
        meaningFingerprint: 'b'.repeat(64),
      });
      const failure = yield* Effect.flip(
        readPriceGroupDefinition(
          request,
          tenantId,
          makeServices({
            readCurrentDefinition: () => Effect.succeed({ ...currentSnapshot, identity: mismatchedIdentity }),
          }),
        ),
      );

      expect(Schema.is(PriceGroupCurrentnessFailure)(failure)).toBe(true);
    }),
  );

  it.effect('preserves Currentness and owner outage as declared domain failures', () =>
    Effect.gen(function* mapsDomainFailures() {
      const currentness = new PriceGroupCurrentnessFailure({
        candidateDefinitionRevisionIds: [definition.definitionRevisionId],
        code: 'price_group_currentness_failure',
        priceGroupRef,
        reason: 'MULTIPLE_CURRENT_DEFINITIONS',
      });
      const unavailable = new PriceGroupPersistenceUnavailable({
        code: 'price_group_persistence_unavailable',
        reason: 'private database host detail',
        retryable: true,
      });
      const currentnessFailure = yield* Effect.flip(
        readPriceGroupDefinition(
          request,
          tenantId,
          makeServices({ readCurrentDefinition: () => Effect.fail(currentness) }),
        ),
      );
      const unavailableFailure = yield* Effect.flip(
        readPriceGroupDefinition(
          request,
          tenantId,
          makeServices({ readCurrentDefinition: () => Effect.fail(unavailable) }),
        ),
      );

      expect(currentnessFailure).toBe(currentness);
      expect(unavailableFailure).toBe(unavailable);
    }),
  );

  it('declares forbidden legal-entity scope and the exact Price Group permission target', () => {
    expect(priceGroupDefinitionRead.descriptor.legalEntityScope).toBe('forbidden');
    expect(priceGroupDefinitionRead.descriptor.permissionTarget).toBe('business_permission');
    expect(pricingPriceGroupReadPermission.allowedScopeKinds).toEqual(['pricing_catalog', 'price_group']);
    expect(
      priceGroupDefinitionPermissionTarget(request, {
        authContextRef: 'job:price-group-read:run-1',
        authMethod: 'system',
        correlationId: 'price-group-definition-read',
        principalId: '88888888-8888-4888-8888-888888888888',
        tenantId,
      }),
    ).toEqual({
      businessPermission: {
        permission: 'pricing.price_group.read',
        target: {
          kind: 'price_group',
          priceGroupId,
          pricingCatalogId: tenantId,
          tenantId,
        },
      },
      kind: 'business_permission',
    });
  });
});
