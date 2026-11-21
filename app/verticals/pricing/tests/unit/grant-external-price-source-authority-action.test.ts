import { PriceSourceAssertionInputSchema } from '@app/pricing-contracts/domain/price-source-provenance';
import { DateTime, Effect, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import {
  ExternalPriceSourceAuthorityGrantConflict,
  ExternalPriceSourceAuthorityGrantRejected,
  GrantExternalPriceSourceAuthorityPayloadSchema,
  applyExternalPriceSourceAuthorityGrant,
  grantExternalPriceSourceAuthorityAction,
  handleGrantExternalPriceSourceAuthority,
} from '../../src/actions/grant-external-price-source-authority.action.ts';
import type { ExternalPriceSourceAuthorityPersistence } from '../../src/persistence/external-price-source-authority-persistence.ts';
import { makeExternalPriceInputBoundary } from '../../src/services/external-price-input-boundary.service.ts';
import type { ExternalPriceSourceAuthorityGrant } from '../../src/services/external-price-input-boundary.service.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const legalEntityId = '22222222-2222-4222-8222-222222222222';
const otherLegalEntityId = '33333333-3333-4333-8333-333333333333';
const actorPrincipalId = '44444444-4444-4444-8444-444444444444';
const operationAt = '2026-11-20T10:00:00.000Z';
const trustedOperationAt = DateTime.toDateUtc(DateTime.makeUnsafe(operationAt));
const unitBasis = {
  quantity: '1',
  unitRef: {
    moduleId: 'commerce.catalog' as const,
    resourceId: '55555555-5555-4555-8555-555555555555',
    resourceType: 'commerce.catalog.product-unit' as const,
    tenantId,
  },
};
const exactIdentityKey = {
  catalogSelection: {
    productRef: {
      moduleId: 'commerce.catalog' as const,
      resourceId: '66666666-6666-4666-8666-666666666666',
      resourceType: 'commerce.catalog.product' as const,
      tenantId,
    },
    variantRef: {
      moduleId: 'commerce.catalog' as const,
      resourceId: '77777777-7777-4777-8777-777777777777',
      resourceType: 'commerce.catalog.variant' as const,
      tenantId,
    },
  },
  commercialScope: { channelId: 'B2B' as const, marketId: 'cz-market', sellingLegalEntityId: legalEntityId },
  currencyCode: 'CZK',
  priceGroupSelector: { kind: 'NO_GROUP' as const },
  unitBasis,
};
const authority = { sourceAuthorityRef: 'erp-price-owner', sourceAuthorityVersion: '1' };
const mapping = { mappingContractRef: 'erp-price-exact-key', mappingContractVersion: '1' };
const payload = Schema.decodeSync(GrantExternalPriceSourceAuthorityPayloadSchema)({
  authority,
  effectivePeriod: { effectiveFrom: '2026-11-01T00:00:00.000Z' },
  exactIdentityKey,
  mapping,
  reason: 'The ERP is the verified owner of this exact Price.',
  verificationRef: 'operator-verification-1',
});
const trusted = { legalEntityId, tenantId, trustedOperationAt };
const expectedGrant: ExternalPriceSourceAuthorityGrant = {
  authority,
  effectivePeriod: payload.effectivePeriod,
  exactIdentityKey: payload.exactIdentityKey,
  family: 'PRICE',
  mapping,
  ownerModuleId: 'commerce.pricing',
  schemaVersion: '1',
  verificationRef: 'operator-verification-1',
  verifiedAt: operationAt,
};

const sourceAssertion = Schema.decodeSync(PriceSourceAssertionInputSchema)({
  lineage: { kind: 'INITIAL' },
  mapping,
  originalAssertion: {
    monetaryAmount: { amount: '125.50', currencyCode: 'CZK' },
    monetaryBoundary: 'PRE_TAX',
    unitBasis,
  },
  sourceAssertionId: '88888888-8888-4888-8888-888888888888',
  sourceAuthority: authority,
  sourceRecord: {
    sourceChangeCorrelation: 'erp-change-1',
    sourceRecordRef: 'erp-price-row-1',
    sourceRecordVersion: '1',
    sourceSystem: { ownerModuleId: 'external.erp', sourceSystemRef: 'erp' },
  },
  timing: {
    importedAt: '2026-11-21T09:00:00.000Z',
    ownerBusinessEffectiveAt: '2026-11-21T08:00:00.000Z',
    sourceEffectiveAt: '2026-11-21T08:00:00.000Z',
  },
});

const foreignLegalEntity = Schema.decodeSync(GrantExternalPriceSourceAuthorityPayloadSchema)({
  ...payload,
  exactIdentityKey: {
    ...exactIdentityKey,
    commercialScope: { ...exactIdentityKey.commercialScope, sellingLegalEntityId: otherLegalEntityId },
  },
});
const unusedStore: ExternalPriceSourceAuthorityPersistence['store'] = () => Effect.die('store must not run');

describe('Grant external Price Source Authority Action', () => {
  it('is an idempotent, critical, Selling Legal Entity scoped Pricing Action', () => {
    expect(grantExternalPriceSourceAuthorityAction.descriptor).toMatchObject({
      accessDeclaration: { key: 'commerce.pricing.external-price-source-authority.grant', risk: 'critical' },
      actionKey: 'commerce.pricing.grant-external-price-source-authority',
      idempotency: 'required',
      legalEntityScope: 'required',
      owningModuleKey: 'commerce.pricing',
    });
  });

  it('lets no caller date, reshape or reverse a grant', () => {
    const decode = Schema.decodeUnknownSync(GrantExternalPriceSourceAuthorityPayloadSchema, {
      onExcessProperty: 'error',
    });
    for (const forbidden of [
      { verifiedAt: operationAt },
      { family: 'PRICE' },
      { ownerModuleId: 'commerce.pricing' },
      { tenantId },
    ]) {
      expect(() => decode({ ...payload, ...forbidden })).toThrow();
    }
    expect(() =>
      decode({
        ...payload,
        effectivePeriod: { effectiveFrom: '2026-11-01T00:00:00.000Z', effectiveTo: '2026-11-01T00:00:00.000Z' },
      }),
    ).toThrow();
  });

  it.effect('stores the exact grant with the trusted verification time', () =>
    Effect.gen(function* storesExactGrant() {
      const stored: ExternalPriceSourceAuthorityGrant[] = [];
      const result = yield* applyExternalPriceSourceAuthorityGrant(payload, trusted, (grant) => {
        stored.push(grant);
        return Effect.succeed({ outcome: 'STORED' as const });
      });

      expect(result).toEqual({ outcome: 'STORED', verifiedAt: operationAt });
      expect(stored).toEqual([expectedGrant]);
    }),
  );

  it.effect('the stored grant is exactly what the external Price input boundary accepts for that key', () =>
    Effect.gen(function* boundaryAcceptsGrant() {
      const stored: ExternalPriceSourceAuthorityGrant[] = [];
      yield* applyExternalPriceSourceAuthorityGrant(payload, trusted, (grant) => {
        stored.push(grant);
        return Effect.succeed({ outcome: 'STORED' as const });
      });
      const boundary = makeExternalPriceInputBoundary({
        assess: () =>
          Effect.succeed(
            stored.length === 1 && stored[0] !== undefined
              ? { grant: stored[0], outcome: 'AUTHORITY_GRANTED' as const }
              : { outcome: 'AUTHORITY_UNRESOLVED' as const, reason: 'AUTHORITY' as const },
          ),
      });
      const assessed = yield* boundary.assess({
        actingPrincipalId: actorPrincipalId,
        effectiveFrom: sourceAssertion.timing.ownerBusinessEffectiveAt,
        identityKey: payload.exactIdentityKey,
        monetaryAmount: { amount: '125.50', currencyCode: 'CZK' },
        sourceAssertion,
        tenantId,
        trustedOperationAt: DateTime.toDateUtc(DateTime.makeUnsafe('2026-11-21T09:00:00.000Z')),
      });

      expect(assessed.outcome).toBe('READY_FOR_CANONICAL_WRITE');
    }),
  );

  it.effect('refuses a key outside the trusted Tenant or Selling Legal Entity without storing anything', () =>
    Effect.gen(function* refusesForeignKey() {
      for (const [selectedPayload, selectedTrusted] of [
        [foreignLegalEntity, trusted],
        [payload, { ...trusted, legalEntityId: otherLegalEntityId }],
        [payload, { ...trusted, tenantId: '99999999-9999-4999-8999-999999999999' }],
      ] as const) {
        const failure = yield* applyExternalPriceSourceAuthorityGrant(
          selectedPayload,
          selectedTrusted,
          unusedStore,
        ).pipe(Effect.flip);
        expect(failure).toBeInstanceOf(ExternalPriceSourceAuthorityGrantRejected);
      }
    }),
  );

  it.effect('never replaces an existing grant of the same key, authority, mapping and start', () =>
    Effect.gen(function* conflictingGrant() {
      const failure = yield* applyExternalPriceSourceAuthorityGrant(payload, trusted, () =>
        Effect.succeed({ outcome: 'CONFLICT' as const, reason: 'GRANT_IDENTITY_ALREADY_BOUND' as const }),
      ).pipe(Effect.flip);

      expect(failure).toBeInstanceOf(ExternalPriceSourceAuthorityGrantConflict);
      expect(failure).toMatchObject({ code: 'external_price_source_authority_already_granted' });
    }),
  );

  it.effect('records the operator reason, verification reference and the Legal Entity it acted on', () =>
    Effect.gen(function* governedEvidence() {
      let audit: unknown;
      let access: unknown;
      const result = yield* handleGrantExternalPriceSourceAuthority(payload, {
        actionInvocationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        addDomainEvent: () => Effect.die('unused'),
        addOutboxMessage: () => Effect.die('unused'),
        compositionRevision: 'a'.repeat(64),
        recordAuditEvidence: (evidence) => {
          audit = evidence;
          return Effect.void;
        },
        recordDataAccess: (evidence) => {
          access = evidence;
          return Effect.void;
        },
        scope: {
          authBindingId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
          authContextRef: 'session:grant-external-price-source-authority',
          authMethod: 'session',
          correlationId: 'grant-external-price-source-authority-unit',
          legalEntityId,
          principalId: actorPrincipalId,
          tenantId,
        },
        services: {
          assess: () => Effect.die('unused'),
          store: () => Effect.succeed({ outcome: 'STORED' as const }),
        },
      });

      expect(result.outcome).toBe('STORED');
      expect(audit).toEqual({ reason: payload.reason, verificationRef: payload.verificationRef });
      expect(access).toMatchObject({
        accessKind: 'read',
        resultCount: 1,
        targetModuleKey: 'commerce.pricing',
        targetResourceId: legalEntityId,
        targetResourceType: 'commerce.pricing.external-price-source-authority',
      });
    }),
  );
});
